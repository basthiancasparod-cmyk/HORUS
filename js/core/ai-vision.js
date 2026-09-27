/**
 * HORUS — js/core/ai-vision.js
 * Lectura de cuadrantes con IA de visión (fotos, capturas, PDF escaneados).
 *
 * Contrato completo y hallazgos medidos sobre la API real: docs/AI-IMPORT.md
 *
 * La idea de fondo: la IA sirve para ENTENDER el documento (mes, personas,
 * códigos) y para localizar las casillas, pero no para decidir fechas ni para
 * dar por buena una casilla. Todo lo que devuelve pasa por una verificación
 * determinista contra el calendario real antes de llegar a la pantalla de
 * revisión.
 *
 * Reglas del módulo:
 *  - Sin DOM, sin red propia (el `fetch` se inyecta) y sin módulos de Node.
 *  - Nunca lanza: los fallos se devuelven como `{ ok: false, reason }`.
 *  - Nunca registra ni devuelve la clave en un mensaje de error: además de no
 *    escribirla a propósito, `limpiarSecreto()` borra cualquier rastro antes de
 *    que un motivo salga del módulo (una respuesta de error o un fallo de red
 *    podrían repetir la cabecera de autenticación).
 *  - `buildParseResult` y `verifyParse` devuelven la MISMA forma que
 *    `schedule-import.js`, para que la revisión, el volcado y el deshacer
 *    funcionen sin cambios.
 *  - `verifyParse` es puro: devuelve un resultado nuevo y no toca el suyo.
 */

import { dateKey, fromKey, daysInMonth, MONTHS, DOW_FULL } from './date.js';
// Una sola lista de códigos para los dos caminos de importación (PDF e IA): si
// se duplicara aquí, cualquier cambio del catálogo dejaría a uno de los dos
// caminos mintiendo.
import { KNOWN_CODES } from './schedule-import.js';

/* ------------------------------------------------------------------ *
 * Proveedores
 * ------------------------------------------------------------------ */

export const AI_PROVIDERS = Object.freeze({
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.1-flash-lite',
    needsKey: true,
    acceptsPdf: true,
    note: 'Gratis con capa gratuita. En ella, Google puede usar las peticiones para mejorar sus productos.',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'google/gemma-4-31b-it:free',
    needsKey: true,
    acceptsPdf: false,
    note: 'Una sola clave para muchos modelos; los gratuitos pueden exigir compartir datos.',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral OCR',
    keyUrl: 'https://console.mistral.ai/api-keys',
    defaultModel: 'mistral-ocr-latest',
    needsKey: true,
    acceptsPdf: true,
    note: 'Empresa europea. El OCR devuelve texto; se necesita una segunda llamada para estructurarlo.',
  },
});

/** Modelos por los que se prueba cuando el preferido está saturado (503). */
export const AI_FALLBACK_MODELS = Object.freeze({
  gemini: Object.freeze([
    'gemini-3.1-flash-lite',
    'gemini-flash-lite-latest',
    'gemini-3.5-flash-lite',
    'gemini-flash-latest',
  ]),
  openrouter: Object.freeze(['google/gemma-4-31b-it:free']),
  mistral: Object.freeze(['mistral-ocr-latest']),
});

/* ------------------------------------------------------------------ *
 * Constantes de red
 * ------------------------------------------------------------------ */

const URL_GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const URL_OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const URL_MISTRAL_OCR = 'https://api.mistral.ai/v1/ocr';
const URL_MISTRAL_CHAT = 'https://api.mistral.ai/v1/chat/completions';

/**
 * Mistral necesita DOS modelos distintos: el de OCR (`mistral-ocr-latest`) y uno
 * de chat para estructurar el texto. Si la cuenta no tiene el de chat, el 404 lo
 * dirá con su nombre; se puede fijar con `chatModel`.
 */
const MODELO_CHAT_MISTRAL = 'mistral-small-latest';

/** Como mucho dos intentos por modelo (docs/AI-IMPORT.md §4). */
const INTENTOS_POR_MODELO = 2;
/** Espera creciente entre intentos; en las pruebas se inyecta un `sleep` que no espera. */
const ESPERA_BASE_MS = 400;
const ESPERA_MAXIMA_MS = 5000;

/** `Date.getDay()` → letra de la cabecera del cuadrante. */
const LETRAS_DIA = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

/** Avisos de la IA que significan «no se lee bien»: obligan a revisar todo. */
const RE_ILEGIBLE = /ilegib|no se (?:lee|leen|ha podido leer|puede leer)|borros|manch|tachad|poco nítid|mala calidad|calidad baja/i;

/* ------------------------------------------------------------------ *
 * Utilidades pequeñas
 * ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');
const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function texto(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function numeroEntero(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function listaTextos(v, max = 400) {
  if (!Array.isArray(v)) return [];
  return v.map(texto).filter(Boolean).slice(0, max);
}

/** Días 1..31 sin repetir y en orden, tal y como vienen de la IA. */
function diasValidos(v) {
  const out = new Set();
  for (const raw of Array.isArray(v) ? v : []) {
    const d = numeroEntero(raw);
    if (d >= 1 && d <= 31) out.add(d);
  }
  return [...out].sort((a, b) => a - b);
}

/** Solo se aceptan las letras de la cabecera del cuadrante (L M X J V S D). */
function letraDeColumna(v) {
  const s = texto(v).toUpperCase();
  return /^[LMXJVSD]$/.test(s) ? s : '';
}

/** Confianza declarada por la IA: lo que no se reconoce se trata como baja. */
function normalizarConfianza(v) {
  const s = texto(v).toLowerCase();
  return s === 'high' || s === 'medium' || s === 'low' ? s : 'low';
}

/** El mismo resultado vacío que devuelve `schedule-import.js`, con `meta`. */
function resultadoVacio(reason) {
  return {
    ok: false,
    reason,
    monthKey: null,
    monthConfidence: 'low',
    monthCandidates: [],
    page: { width: 0, height: 0 },
    people: [],
    unknownCodes: {},
    issues: [],
    stats: { people: 0, entries: 0, high: 0, low: 0, outsideMonth: 0 },
    meta: {},
  };
}

const sleepPorDefecto = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

/**
 * Borra la clave de cualquier texto que vaya a salir del módulo.
 *
 * No basta con no escribirla: una respuesta de error del servidor o el mensaje
 * de un `fetch` fallido pueden repetir la cabecera de autenticación, y ese texto
 * acaba en un aviso visible para el usuario. Se limpia por si acaso.
 */
function limpiarSecreto(motivo, apiKey) {
  let out = String(motivo ?? '');
  const secreto = texto(apiKey);
  if (secreto) out = out.split(secreto).join('«clave oculta»');
  out = out.replace(/([?&](?:key|api_key|apikey)=)[^&\s"']+/gi, '$1«clave oculta»');
  out = out.replace(/((?:x-goog-api-key|authorization)"?\s*[:=]\s*)(?:Bearer\s+)?\S+/gi, '$1«clave oculta»');
  return out;
}

/** Devuelve un fallo con el motivo ya limpio de secretos. */
function fallo(motivo, apiKey) {
  return { ok: false, reason: limpiarSecreto(motivo, apiKey) };
}

/* ------------------------------------------------------------------ *
 * Prompts (en español, como el resto del producto)
 * ------------------------------------------------------------------ */

/**
 * Paso 1: ENTENDER el documento. No se le pide que transcriba nada: cuando se le
 * pide todo a la vez, rellena huecos e inventa códigos.
 */
function promptInterpretacion() {
  return [
    'Eres un experto en leer cuadrantes de turnos de personal (horarios de trabajo) a partir de una foto,'
    + ' una captura o un PDF escaneado.',
    '',
    'Mira el documento y DEVUELVE SOLO un objeto JSON con esta forma exacta:',
    '{',
    '  "month": <número del 1 al 12 del mes principal del cuadrante>,',
    '  "year": <año con CUATRO cifras; si en la hoja solo aparece "26", devuelve 2026>,',
    '  "monthNameRaw": "<el texto de la cabecera tal cual, por ejemplo \\"OCTUBRE 26\\">",',
    '  "leadingPreviousMonthDays": [<días que, AL PRINCIPIO de la rejilla, son del MES ANTERIOR>],',
    '  "trailingNextMonthDays": [<días que, AL FINAL de la rejilla, son del MES SIGUIENTE>],',
    '  "people": ["<etiqueta de cada fila de persona, en el orden en que aparece>"],',
    '  "codes": [{"code":"<código impreso>","meaning":"<qué significa según la leyenda, o cadena vacía>","count":<cuántas casillas crees que hay, aproximado>}],',
    '  "weekdayHeader": "<las letras de la cabecera de días, por ejemplo \\"L M X J V S D\\">",',
    '  "grid": {"columns": <nº de columnas>, "rows": <nº de filas de personas>},',
    '  "confidence": "high" | "medium" | "low",',
    '  "warnings": ["<lo que no se lee bien, lo que no cuadra, lo que has tenido que suponer>"]',
    '}',
    '',
    'Reglas:',
    '- Fíjate MUY BIEN en los días del mes anterior que van al principio de la rejilla (por ejemplo 28, 29 y 30'
    + ' justo antes del 1) y en los del mes siguiente que van al final. Son los que más se fallan y van en'
    + ' "leadingPreviousMonthDays" y "trailingNextMonthDays".',
    '- "people" son las etiquetas de la columna de la izquierda, en orden y tal cual están escritas: no inventes'
    + ' filas ni completes las que no se lean.',
    '- NO transcribas las casillas ni los turnos de cada persona en este paso.',
    '- "count" es solo orientativo: no lo calcules a mano ni te preocupes por que cuadre.',
    '- Si el año aparece con dos cifras, complétalo a cuatro (26 → 2026) y dilo en "warnings".',
    '- Si algo no se lee con seguridad, dilo en "warnings" y baja "confidence". No lo inventes.',
    '- No escribas nada fuera del JSON.',
  ].join('\n');
}

/**
 * Paso 2: TRANSCRIBIR las casillas. Recibe la interpretación como contexto para
 * que no tenga que volver a adivinar el mes, las personas ni los códigos.
 */
function promptTranscripcion(interpretacion) {
  const mes = `${MONTHS[(numeroEntero(interpretacion?.month) ?? 1) - 1]} ${numeroEntero(interpretacion?.year) ?? ''}`.trim();
  const personas = Array.isArray(interpretacion?.people) ? interpretacion.people.join(', ') : '';
  const codigos = Array.isArray(interpretacion?.codes)
    ? interpretacion.codes.map((c) => `${c?.code}${c?.meaning ? ` (${c.meaning})` : ''}`).join(', ')
    : '';
  const anterior = diasValidos(interpretacion?.leadingPreviousMonthDays);
  const siguiente = diasValidos(interpretacion?.trailingNextMonthDays);

  return [
    'Ahora TRANSCRIBE las casillas del cuadrante de la imagen.',
    '',
    'Contexto ya interpretado (úsalo como guía; no lo repitas en la respuesta):',
    `- Mes: ${mes}`,
    `- Texto de la cabecera del cuadrante: ${texto(interpretacion?.monthNameRaw) || mes}`,
    `- Cabecera del cuadrante: ${texto(interpretacion?.weekdayHeader) || 'L M X J V S D'}`,
    `- Días del MES ANTERIOR al principio de la rejilla: ${anterior.length ? anterior.join(', ') : 'ninguno'}`,
    `- Días del MES SIGUIENTE al final de la rejilla: ${siguiente.length ? siguiente.join(', ') : 'ninguno'}`,
    `- Personas, en orden: ${personas || 'las de la columna de la izquierda'}`,
    `- Códigos impresos: ${codigos || 'los que veas, tal cual están escritos'}`,
    '',
    'DEVUELVE SOLO un objeto JSON con esta forma exacta:',
    '{',
    '  "cells": [',
    '    { "label": "<etiqueta EXACTA de la persona, copiada de la lista de arriba>",',
    '      "entries": [ { "day": <día del mes, 1..31>, "code": "<código impreso>", "column": "<letra L M X J V S D de la columna de esa casilla>" } ] }',
    '  ],',
    '  "uncertainPeople": ["<etiquetas de las personas cuya fila no has podido leer bien>"],',
    '  "warnings": ["<avisos>"]',
    '}',
    '',
    'Reglas:',
    '- Una entrada por casilla CON CONTENIDO. No rellenes las casillas vacías y NO repitas el código anterior'
    + ' para tapar un hueco: un hueco se deja vacío.',
    '- No deduzcas la letra del día de la semana a partir del número: léela de la cabecera. Si no la ves, omite el campo "column".',
    '- Omite toda casilla que no leas con seguridad: es mejor dejar un hueco que inventar un turno.',
    '- Usa el código tal y como está impreso (M, T, VC, AF…), sin traducirlo ni completarlo.',
    '- "day" es el número que hay en la cabecera de columnas de esa casilla, no su posición.',
    '- No escribas nada fuera del JSON.',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Esquemas de salida estructurada (formato de la API de Gemini)
 * ------------------------------------------------------------------ */

const ESQUEMA_INTERPRETACION = Object.freeze({
  type: 'OBJECT',
  properties: {
    month: { type: 'INTEGER' },
    year: { type: 'INTEGER' },
    monthNameRaw: { type: 'STRING' },
    leadingPreviousMonthDays: { type: 'ARRAY', items: { type: 'INTEGER' } },
    trailingNextMonthDays: { type: 'ARRAY', items: { type: 'INTEGER' } },
    people: { type: 'ARRAY', items: { type: 'STRING' } },
    codes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          code: { type: 'STRING' },
          meaning: { type: 'STRING' },
          count: { type: 'INTEGER' },
        },
        required: ['code'],
      },
    },
    weekdayHeader: { type: 'STRING' },
    grid: {
      type: 'OBJECT',
      properties: { columns: { type: 'INTEGER' }, rows: { type: 'INTEGER' } },
    },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
    warnings: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['month', 'year', 'people', 'codes', 'confidence'],
});

const ESQUEMA_TRANSCRIPCION = Object.freeze({
  type: 'OBJECT',
  properties: {
    cells: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          entries: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                day: { type: 'INTEGER' },
                code: { type: 'STRING' },
                column: { type: 'STRING' },
              },
              required: ['day', 'code'],
            },
          },
        },
        required: ['label', 'entries'],
      },
    },
    uncertainPeople: { type: 'ARRAY', items: { type: 'STRING' } },
    warnings: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['cells'],
});

/* ------------------------------------------------------------------ *
 * Adaptadores por proveedor: construir la petición y leer la respuesta
 * ------------------------------------------------------------------ */

function peticionGemini({ apiKey, modelo, prompt, responseSchema, file }) {
  return {
    url: `${URL_GEMINI}/${encodeURIComponent(modelo)}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: {
      contents: [{
        parts: [
          { inline_data: { mime_type: file.mimeType, data: file.data } },
          { text: prompt },
        ],
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema,
      },
    },
  };
}

function peticionOpenRouter({ apiKey, modelo, prompt, file }) {
  return {
    url: URL_OPENROUTER,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: {
      model: modelo,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${file.mimeType};base64,${file.data}` } },
        ],
      }],
      temperature: 0,
      // `json_object` y no `json_schema`: los modelos gratuitos de OpenRouter
      // rechazan el esquema estricto, y las claves ya van descritas en el prompt.
      response_format: { type: 'json_object' },
    },
  };
}

function peticionMistralOcr({ apiKey, modelo, file }) {
  const dataUrl = `data:${file.mimeType};base64,${file.data}`;
  return {
    url: URL_MISTRAL_OCR,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: {
      model: modelo,
      // El OCR de Mistral distingue imagen de documento; el PDF va como documento.
      document: file.mimeType.startsWith('image/')
        ? { type: 'image_url', image_url: dataUrl }
        : { type: 'document_url', document_url: dataUrl },
    },
  };
}

function peticionMistralChat({ apiKey, modelo, prompt, ocrTexto }) {
  return {
    url: URL_MISTRAL_CHAT,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: {
      model: modelo,
      messages: [{
        role: 'user',
        content: `${prompt}\n\n--- TEXTO DEL OCR DEL CUADRANTE ---\n${ocrTexto}`,
      }],
      temperature: 0,
      response_format: { type: 'json_object' },
    },
  };
}

/** Texto útil de una respuesta de Gemini (`candidates[0].content.parts[].text`). */
function textoDeGemini(cuerpo) {
  const partes = cuerpo?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(partes)) return '';
  return partes.map((p) => texto(p?.text)).filter(Boolean).join('');
}

/** Texto útil de una respuesta compatible con OpenAI (chat completions). */
function textoDeChat(cuerpo) {
  const contenido = cuerpo?.choices?.[0]?.message?.content;
  if (typeof contenido === 'string') return contenido.trim();
  if (Array.isArray(contenido)) return contenido.map((p) => texto(p?.text)).filter(Boolean).join('');
  return '';
}

/** Markdown de todas las páginas del OCR de Mistral. */
function textoDeOcrMistral(cuerpo) {
  const paginas = cuerpo?.pages;
  if (!Array.isArray(paginas)) return '';
  return paginas.map((p) => texto(p?.markdown)).filter(Boolean).join('\n\n');
}

/* ------------------------------------------------------------------ *
 * Lectura de respuestas HTTP
 * ------------------------------------------------------------------ */

function intentarJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Extrae el JSON de un texto. Los modelos con salida estructurada devuelven JSON
 * limpio, pero los de reserva a veces lo envuelven en un bloque markdown o le
 * añaden una frase delante: se aceptan las tres formas antes de rendirse.
 */
function extraerJson(bruto) {
  const s = texto(bruto);
  if (!s) return null;
  const directo = intentarJson(s);
  if (directo !== undefined) return directo;
  const valla = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (valla) {
    const dentro = intentarJson(valla[1].trim());
    if (dentro !== undefined) return dentro;
  }
  const ini = s.indexOf('{');
  const fin = s.lastIndexOf('}');
  if (ini >= 0 && fin > ini) {
    const recorte = intentarJson(s.slice(ini, fin + 1));
    if (recorte !== undefined) return recorte;
  }
  return null;
}

async function leerCuerpo(res) {
  try {
    if (typeof res?.text === 'function') return await res.text();
    if (typeof res?.json === 'function') return JSON.stringify(await res.json());
  } catch {
    return '';
  }
  return '';
}

/**
 * Traduce un código HTTP a un fallo, o a `null` si la respuesta se puede leer.
 * Los mensajes son los del contrato (docs/AI-IMPORT.md §4) y nunca llevan clave.
 */
function clasificarEstado(status, modelo) {
  if (status === 429 || status >= 500) {
    return { ok: false, reintentable: true, reason: `El servicio de IA no responde (error ${status}).` };
  }
  if (status === 400 || status === 401 || status === 403) {
    return {
      ok: false,
      reintentable: false,
      reason: `La clave no es válida o no tiene permiso para este modelo (error ${status}).`,
    };
  }
  if (status === 404) {
    return {
      ok: false,
      reintentable: false,
      reason: `Ese modelo no está disponible en tu cuenta: «${modelo}». Elige otro modelo en Ajustes.`,
    };
  }
  if (status >= 400) {
    return { ok: false, reintentable: false, reason: `El servicio de IA ha rechazado la petición (error ${status}).` };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Tubería de red (una sola, con adaptador por proveedor)
 * ------------------------------------------------------------------ */

/**
 * Prepara lo común a las dos llamadas: proveedor, clave, archivo y conectores
 * inyectados. Devuelve `{ ok:false, reason }` sin tocar la red cuando falta algo.
 */
function prepararEntorno(opts) {
  const id = texto(opts?.provider);
  if (!id) {
    return { ok: false, reason: 'No se ha elegido ningún proveedor de IA: elige uno en Ajustes.' };
  }
  const proveedor = AI_PROVIDERS[id];
  if (!proveedor) {
    return { ok: false, reason: `Proveedor de IA no reconocido: «${id}». Elige uno en Ajustes.` };
  }
  const apiKey = texto(opts?.apiKey);
  if (proveedor.needsKey && !apiKey) {
    return {
      ok: false,
      reason: `Falta la clave de ${proveedor.label}. Añádela en Ajustes para poder importar con IA.`,
    };
  }
  const data = texto(opts?.file?.data);
  if (!data) return { ok: false, reason: 'No hay ningún archivo que enviar a la IA.' };
  const mimeType = texto(opts?.file?.mimeType);
  if (!mimeType) {
    return { ok: false, reason: 'El archivo no dice de qué tipo es (image/png, application/pdf…).' };
  }

  const inyectado = opts?.fetchImpl;
  const fetchImpl = typeof inyectado === 'function'
    ? inyectado
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!fetchImpl) {
    return { ok: false, reason: 'Este entorno no tiene conexión de red: no se puede hablar con la IA.' };
  }

  const preferido = texto(opts?.model) || proveedor.defaultModel;
  const modelos = [];
  for (const m of [preferido, ...(AI_FALLBACK_MODELS[proveedor.id] || [])]) {
    if (m && !modelos.includes(m)) modelos.push(m);
  }

  return {
    ok: true,
    proveedor: proveedor.id,
    apiKey,
    modelos,
    file: { data, mimeType, name: texto(opts?.file?.name) },
    fetchImpl,
    sleepImpl: typeof opts?.sleepImpl === 'function' ? opts.sleepImpl : sleepPorDefecto,
    chatModel: texto(opts?.chatModel) || MODELO_CHAT_MISTRAL,
  };
}

/** Una petición ya construida, con su clasificación de estado y su JSON. */
async function enviar(peticion, { fetchImpl, modelo }) {
  let res;
  try {
    res = await fetchImpl(peticion.url, {
      method: 'POST',
      headers: peticion.headers,
      body: JSON.stringify(peticion.body),
    });
  } catch {
    // Error de red: no se reintenta, se explica (docs/AI-IMPORT.md §4).
    return { ok: false, reintentable: false, reason: 'No se ha podido conectar con el servicio de IA. Revisa tu conexión e inténtalo de nuevo.' };
  }

  const status = numeroEntero(res?.status) ?? 0;
  const bruto = await leerCuerpo(res);
  const estado = clasificarEstado(status, modelo);
  if (estado) return estado;
  if (status === 0 && res?.ok !== true) {
    return { ok: false, reintentable: false, reason: 'El servicio de IA no ha respondido.' };
  }

  const cuerpo = extraerJson(bruto);
  if (!cuerpo) {
    return { ok: false, reintentable: false, reason: 'El servicio de IA ha respondido algo que no es JSON legible.' };
  }
  return { ok: true, cuerpo };
}

/** OCR de Mistral: la primera de sus dos llamadas. */
async function llamarOcrMistral(entorno, modelo) {
  const peticion = peticionMistralOcr({ apiKey: entorno.apiKey, modelo, file: entorno.file });
  const res = await enviar(peticion, { fetchImpl: entorno.fetchImpl, modelo });
  if (!res.ok) return res;
  const ocrTexto = textoDeOcrMistral(res.cuerpo);
  if (!ocrTexto) {
    return { ok: false, reintentable: false, reason: 'El OCR de Mistral no ha devuelto texto legible: prueba con otro proveedor.' };
  }
  return { ok: true, texto: ocrTexto };
}

/**
 * Pide al proveedor el JSON del prompt, probando modelos de reserva ante
 * saturación (503/429), con espera creciente y como mucho dos intentos por
 * modelo. Devuelve `{ ok:true, datos, usage, modelo }` o `{ ok:false, reason }`.
 */
async function pedirAlProveedor(entorno, { prompt, responseSchema }) {
  let espera = ESPERA_BASE_MS;
  let primerIntento = true;

  for (const modelo of entorno.modelos) {
    let ocrTexto = '';
    if (entorno.proveedor === 'mistral') {
      if (!primerIntento) {
        await entorno.sleepImpl(espera);
        espera = Math.min(espera * 2, ESPERA_MAXIMA_MS);
      }
      primerIntento = false;
      const ocr = await llamarOcrMistral(entorno, modelo);
      if (!ocr.ok) {
        if (ocr.reintentable) continue; // se prueba el siguiente modelo
        return ocr;
      }
      ocrTexto = ocr.texto;
    }

    for (let intento = 1; intento <= INTENTOS_POR_MODELO; intento++) {
      if (!primerIntento) {
        await entorno.sleepImpl(espera);
        espera = Math.min(espera * 2, ESPERA_MAXIMA_MS);
      }
      primerIntento = false;

      const peticion = entorno.proveedor === 'gemini'
        ? peticionGemini({ apiKey: entorno.apiKey, modelo, prompt, responseSchema, file: entorno.file })
        : entorno.proveedor === 'openrouter'
          ? peticionOpenRouter({ apiKey: entorno.apiKey, modelo, prompt, file: entorno.file })
          : peticionMistralChat({ apiKey: entorno.apiKey, modelo: entorno.chatModel, prompt, ocrTexto });

      const res = await enviar(peticion, { fetchImpl: entorno.fetchImpl, modelo: peticion.body.model || modelo });
      if (!res.ok) {
        if (res.reintentable) continue; // otro intento de este modelo, o el siguiente
        return res;
      }

      const contenido = entorno.proveedor === 'gemini' ? textoDeGemini(res.cuerpo) : textoDeChat(res.cuerpo);
      if (!contenido) {
        return { ok: false, reintentable: false, reason: 'La respuesta de la IA no traía ningún texto.' };
      }
      const datos = extraerJson(contenido);
      if (!datos) {
        return { ok: false, reintentable: false, reason: 'La IA no ha devuelto el JSON que se le ha pedido.' };
      }
      return {
        ok: true,
        datos,
        usage: res.cuerpo?.usageMetadata ?? res.cuerpo?.usage ?? null,
        modelo: peticion.body.model || modelo,
      };
    }
  }

  return {
    ok: false,
    reintentable: true,
    reason: 'El servicio de IA está saturado: no ha respondido ningún modelo tras varios intentos. Reinténtalo en unos minutos.',
  };
}

/* ------------------------------------------------------------------ *
 * Normalización de las respuestas de la IA
 * ------------------------------------------------------------------ */

function listaCodigos(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const code = texto(item?.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) continue;
    out.push({ code, meaning: texto(item?.meaning), count: numeroEntero(item?.count) });
  }
  return out;
}

function normalizarInterpretacion(salida, entorno) {
  const datos = salida.datos;
  if (!esObjeto(datos)) return fallo('La IA no ha devuelto la interpretación del cuadrante.', entorno.apiKey);

  const month = numeroEntero(datos.month);
  if (!(month >= 1 && month <= 12)) {
    return fallo('La IA no ha sabido decir de qué mes es el cuadrante.', entorno.apiKey);
  }
  let year = numeroEntero(datos.year);
  // La IA devuelve a veces el año con dos cifras («26»): se completa.
  if (year !== null && year >= 0 && year < 100) year += 2000;
  if (!(year >= 1900 && year <= 2200)) {
    return fallo('La IA no ha sabido decir de qué año es el cuadrante.', entorno.apiKey);
  }

  const grid = esObjeto(datos.grid) ? datos.grid : {};
  return {
    ok: true,
    month,
    year,
    monthNameRaw: texto(datos.monthNameRaw),
    leadingPreviousMonthDays: diasValidos(datos.leadingPreviousMonthDays),
    trailingNextMonthDays: diasValidos(datos.trailingNextMonthDays),
    people: listaTextos(datos.people),
    // El `count` que da la IA no se usa nunca para los recuentos: se conserva
    // solo como pista de la leyenda. Los recuentos se recalculan del resultado.
    codes: listaCodigos(datos.codes),
    weekdayHeader: texto(datos.weekdayHeader),
    grid: { columns: numeroEntero(grid.columns), rows: numeroEntero(grid.rows) },
    confidence: normalizarConfianza(datos.confidence),
    warnings: listaTextos(datos.warnings),
    // Extras admitidos por el contrato (como `usage`): sirven para trazar de
    // dónde viene la lectura y para que la revisión enseñe el modelo usado.
    provider: entorno.proveedor,
    model: salida.modelo,
    usage: salida.usage ?? null,
  };
}

function normalizarTranscripcion(salida, entorno) {
  const datos = salida.datos;
  const bruto = Array.isArray(datos?.cells) ? datos.cells : [];
  const avisos = listaTextos(datos?.warnings);
  const porEtiqueta = new Map();
  let descartadas = 0;

  for (const celda of bruto) {
    const label = texto(celda?.label).replace(/\s+/g, ' ');
    if (!label) {
      avisos.push('La IA ha devuelto una fila sin nombre: se ignora.');
      continue;
    }
    const entradas = [];
    for (const item of Array.isArray(celda?.entries) ? celda.entries : []) {
      const day = numeroEntero(item?.day);
      const code = texto(item?.code).toUpperCase().replace(/[^A-Z]/g, '');
      if (!(day >= 1 && day <= 31) || !code) {
        descartadas++;
        continue;
      }
      const columna = letraDeColumna(item?.column);
      if (texto(item?.column) && !columna) {
        avisos.push(`La IA ha dado una letra de columna que no es de la cabecera («${texto(item.column)}»): se trata como si no la hubiera dado.`);
      }
      entradas.push({ day, code, ...(columna ? { column: columna } : {}) });
    }
    if (!entradas.length) continue;
    // La IA parte a veces una fila en dos: se unen por etiqueta, conservando el
    // orden en que aparecen.
    const previa = porEtiqueta.get(label);
    if (previa) previa.entries.push(...entradas);
    else porEtiqueta.set(label, { label, entries: entradas });
  }

  const cells = [...porEtiqueta.values()];
  if (!cells.length) {
    return {
      ok: false,
      reason: 'La IA no ha reconocido ninguna casilla legible en el cuadrante. Prueba con una foto más nítida o con otro modelo.',
    };
  }
  if (descartadas) {
    avisos.push(`Se han descartado ${descartadas} ${descartadas === 1 ? 'casilla' : 'casillas'} con el día o el código ilegibles.`);
  }

  return {
    ok: true,
    cells,
    uncertainPeople: listaTextos(datos?.uncertainPeople),
    warnings: avisos,
    provider: entorno.proveedor,
    model: salida.modelo,
    usage: salida.usage ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * API: interpretar y transcribir
 * ------------------------------------------------------------------ */

/** @param {{provider:string, apiKey:string, model?:string, file:{data:string,mimeType:string}, fetchImpl:Function}} opts */
export async function interpretSchedule(opts) {
  const entorno = prepararEntorno(opts);
  if (!entorno.ok) return fallo(entorno.reason, opts?.apiKey);
  try {
    const salida = await pedirAlProveedor(entorno, {
      prompt: promptInterpretacion(),
      responseSchema: ESQUEMA_INTERPRETACION,
    });
    if (!salida.ok) return fallo(salida.reason, entorno.apiKey);
    return normalizarInterpretacion(salida, entorno);
  } catch (err) {
    return fallo(`No se ha podido interpretar el cuadrante: ${err?.message || 'error desconocido'}.`, entorno.apiKey);
  }
}

/** @param {{..., interpretation:object}} opts */
export async function transcribeSchedule(opts) {
  const entorno = prepararEntorno(opts);
  if (!entorno.ok) return fallo(entorno.reason, opts?.apiKey);
  const interpretacion = opts?.interpretation;
  if (!esObjeto(interpretacion)) {
    return fallo('Falta la interpretación del cuadrante: sin ella no se sabe qué hay que transcribir.', entorno.apiKey);
  }
  try {
    const salida = await pedirAlProveedor(entorno, {
      prompt: promptTranscripcion(interpretacion),
      responseSchema: ESQUEMA_TRANSCRIPCION,
    });
    if (!salida.ok) return fallo(salida.reason, entorno.apiKey);
    return normalizarTranscripcion(salida, entorno);
  } catch (err) {
    return fallo(`No se ha podido transcribir el cuadrante: ${err?.message || 'error desconocido'}.`, entorno.apiKey);
  }
}

/* ------------------------------------------------------------------ *
 * Verificación determinista (compartida por buildParseResult y verifyParse)
 * ------------------------------------------------------------------ */

function normalizarCatalogo(knownCodes) {
  if (esObjeto(knownCodes) && Object.keys(knownCodes).length) return knownCodes;
  return KNOWN_CODES;
}

/** Avisos que obligan a bajar TODAS las casillas a dudosas. */
function motivosGlobales(interpretacion, transcripcion) {
  const motivos = [];
  const confianza = interpretacion?.confidence;
  if (confianza && confianza !== 'high') {
    motivos.push(`la interpretación del cuadrante no es segura (confianza «${confianza}») y hay que revisarla`);
  }
  const avisos = [...listaTextos(interpretacion?.warnings), ...listaTextos(transcripcion?.warnings)];
  if (avisos.some((a) => RE_ILEGIBLE.test(a))) {
    motivos.push('la IA ha avisado de que hay partes del cuadrante que no se leen bien');
  }
  return motivos;
}

/**
 * Comprueba la letra de la columna de cada casilla contra el calendario real.
 *
 * Es la misma idea que `evaluarCandidato` de `schedule-import.js`: se prueban
 * los meses del año indicado y los de los años vecinos y se cuenta cuántas
 * letras no cuadran. Si el mes que dice la IA no cuadra al 100 %, la confianza
 * baja y la revisión pregunta. Nunca se cambia el mes en silencio.
 */
function evaluarMes({ entradas, year, month }) {
  const baseMonthKey = `${year}-${pad2(month)}`;
  const conColumna = entradas.filter((e) => e && e.column);
  if (!conColumna.length) {
    return { comprobadas: 0, fallos: 0, confianza: 'low', candidatos: [], sinEvidencia: true };
  }

  const anios = [...new Set([year, year - 1, year + 1])];
  const candidatos = [];
  for (const y of anios) {
    for (let m = 1; m <= 12; m++) {
      let fallos = 0;
      for (const e of conColumna) {
        const dia = numeroEntero(e.day) ?? Number(String(e.date).slice(8, 10));
        const claveMes = `${y}-${pad2(m)}`;
        const fecha = dia >= 1 && dia <= daysInMonth(claveMes) ? dateKey(y, m - 1, dia) : null;
        const dt = fecha ? fromKey(fecha) : null;
        if (!dt || LETRAS_DIA[dt.getDay()] !== e.column) fallos++;
      }
      candidatos.push({ monthKey: `${y}-${pad2(m)}`, year: y, month: m, mismatches: fallos });
    }
  }
  candidatos.sort((a, b) => a.mismatches - b.mismatches
    || (a.monthKey === baseMonthKey ? 0 : 1) - (b.monthKey === baseMonthKey ? 0 : 1)
    || a.year - b.year
    || a.month - b.month);

  const base = candidatos.find((c) => c.monthKey === baseMonthKey);
  const fallos = base ? base.mismatches : conColumna.length;
  let confianza = 'low';
  if (fallos === 0) confianza = 'high';
  else if (fallos <= Math.max(1, Math.round(conColumna.length * 0.2))) confianza = 'medium';

  return {
    comprobadas: conColumna.length,
    fallos,
    confianza,
    sinEvidencia: false,
    candidatos: candidatos.slice(0, 6).map((c) => ({ year: c.year, month: c.month, mismatches: c.mismatches })),
  };
}

/** Motivos propios de una casilla (código y columna), sin los globales. */
function evaluarCasilla({ date, code, column, catalogo }) {
  const motivos = [];
  const conocido = Object.prototype.hasOwnProperty.call(catalogo, code);
  if (!conocido) {
    motivos.push(`el código «${code}» no es conocido: se enseña para que lo asignes, no se ha inventado nada`);
  }
  let falloColumna = false;
  if (!column) {
    motivos.push('la IA no ha dado la letra de la columna: la casilla no se puede comprobar con el calendario');
  } else {
    const dt = fromKey(date);
    const letra = dt ? LETRAS_DIA[dt.getDay()] : '';
    if (!letra || letra !== column) {
      falloColumna = true;
      // `DOW_FULL` empieza en lunes y `getDay()` en domingo: hay que girar el índice.
      const nombre = dt ? DOW_FULL[(dt.getDay() + 6) % 7].toLowerCase() : '';
      motivos.push(`la letra de la columna («${column}») no cuadra con el día de la semana real${nombre ? ` (${nombre})` : ''}`);
    }
  }
  return { conocido, motivos, falloColumna };
}

/** Avisos del resultado: los mismos textos en los dos caminos. */
function construirIssues({
  monthKey, unknownCodes, fueraDeMes, duplicados, fallosColumna,
  sinColumna, bajas, monthConfianza, fallosMes, motivos,
}) {
  const issues = [];
  for (const [codigo, n] of Object.entries(unknownCodes)) {
    issues.push({
      kind: 'unknown-code',
      code: codigo,
      count: n,
      message: `El código «${codigo}» aparece ${n} ${n === 1 ? 'vez' : 'veces'} y no está en el catálogo. `
        + 'Asígnalo (o déjalo sin turno) antes de importar.',
    });
  }
  if (fueraDeMes) {
    issues.push({
      kind: 'outside-month',
      count: fueraDeMes,
      message: `${fueraDeMes} ${fueraDeMes === 1 ? 'casilla cae' : 'casillas caen'} fuera de ${monthKey} `
        + '(finales del mes anterior o principios del siguiente): no se importan.',
    });
  }
  if (duplicados) {
    issues.push({
      kind: 'duplicate-day',
      count: duplicados,
      message: `${duplicados} ${duplicados === 1 ? 'día está repetido' : 'días están repetidos'} en la misma persona: `
        + 'se queda el primero de cada uno.',
    });
  }
  if (fallosColumna) {
    issues.push({
      kind: 'column-mismatch',
      count: fallosColumna,
      message: `En ${fallosColumna} ${fallosColumna === 1 ? 'casilla' : 'casillas'} la letra de la columna que dio la IA `
        + 'no cuadra con el día de la semana real de esa fecha. Revísalas.',
    });
  }
  if (sinColumna) {
    issues.push({
      kind: 'missing-column',
      count: sinColumna,
      message: `${sinColumna} ${sinColumna === 1 ? 'casilla no trae' : 'casillas no traen'} la letra de la columna: `
        + 'no se pueden comprobar con el calendario y quedan como dudosas.',
    });
  }
  if (monthConfianza !== 'high') {
    issues.push({
      kind: 'month-uncertain',
      count: fallosMes,
      message: 'El mes no se ha podido confirmar con el calendario a partir de las letras de las columnas. '
        + 'Comprueba el mes antes de importar.',
    });
  }
  if (motivos.length) {
    issues.push({
      kind: 'interpretation-uncertain',
      count: motivos.length,
      message: `La IA no da la lectura por segura: ${motivos.join('; ')}.`,
    });
  }
  if (bajas) {
    issues.push({
      kind: 'low-confidence',
      count: bajas,
      message: `${bajas} ${bajas === 1 ? 'casilla queda' : 'casillas quedan'} como dudosas: revísalas antes de importar.`,
    });
  }
  return issues;
}

/** Recuentos por código, siempre recalculados a partir de las entradas. */
function contarPorCodigo(entradas) {
  const out = {};
  for (const e of entradas) out[e.code] = (out[e.code] || 0) + 1;
  return out;
}

/* ------------------------------------------------------------------ *
 * API: montar el ParseResult
 * ------------------------------------------------------------------ */

/**
 * Monta el ParseResult que ya consumen la revisión y el volcado.
 *
 * Reparto de tareas: aquí se COLOCA cada día en su fecha (con la regla de los
 * días del mes anterior y del siguiente) y se comprueba el mes con las letras de
 * columna; `verifyParse` vuelve a comprobarlo todo sobre el resultado montado.
 * Los recuentos salen siempre de las entradas, nunca de `codes[].count`.
 *
 * @param {{interpretation:object, transcription:object, knownCodes?:object}} opts
 */
export function buildParseResult(opts) {
  try {
    const interpretacion = opts?.interpretation;
    const transcripcion = opts?.transcription;
    const catalogo = normalizarCatalogo(opts?.knownCodes);

    if (!esObjeto(interpretacion)) {
      return resultadoVacio('Falta la interpretación del cuadrante: sin ella no se sabe de qué mes son los días.');
    }
    const month = numeroEntero(interpretacion.month);
    const year = numeroEntero(interpretacion.year);
    if (!(month >= 1 && month <= 12) || !(year >= 1900 && year <= 2200)) {
      return resultadoVacio('La interpretación no trae un mes y un año utilizables.');
    }
    const monthKey = `${year}-${pad2(month)}`;
    const celdas = Array.isArray(transcripcion?.cells) ? transcripcion.cells : [];
    if (!celdas.length) return resultadoVacio('La IA no ha transcrito ninguna casilla del cuadrante.');

    const totalDias = daysInMonth(monthKey);
    const mesAnteriorKey = month === 1 ? `${year - 1}-12` : `${year}-${pad2(month - 1)}`;
    const diasMesAnterior = daysInMonth(mesAnteriorKey);
    const leading = new Set(diasValidos(interpretacion.leadingPreviousMonthDays));
    const trailing = new Set(diasValidos(interpretacion.trailingNextMonthDays));
    const inciertas = new Set(listaTextos(transcripcion?.uncertainPeople).map((s) => s.toUpperCase()));
    const globales = motivosGlobales(interpretacion, transcripcion);

    /* --- 1. Colocar cada día en su fecha --------------------------- */
    const detalle = { previousMonth: 0, nextMonth: 0, invalidDay: 0, total: 0 };
    const crudas = []; // { label, incierta, entries: [{date, day, code, column}] }
    const diasVistos = new Set();

    for (const celda of celdas) {
      const label = texto(celda?.label).replace(/\s+/g, ' ');
      if (!label) continue;
      const items = [];
      for (const item of Array.isArray(celda?.entries) ? celda.entries : []) {
        const day = numeroEntero(item?.day);
        const code = texto(item?.code).toUpperCase().replace(/[^A-Z]/g, '');
        if (!(day >= 1 && day <= 31) || !code) continue;
        items.push({ day, code, column: letraDeColumna(item?.column) });
      }
      if (!items.length) continue;

      // El orden de la rejilla manda: los días del mes anterior van al principio
      // y los del siguiente al final, así que cada retroceso del número de día
      // marca un cambio de mes (igual que la tirada de números del PDF). Un día
      // REPETIDO no es un cambio de mes: es una casilla duplicada de la IA.
      const bloques = [];
      for (const item of items) {
        const actual = bloques[bloques.length - 1];
        if (!actual || item.day < actual[actual.length - 1].day) bloques.push([item]);
        else actual.push(item);
      }

      // El primer bloque es del mes anterior solo si TODOS sus días están en la
      // lista que dio la IA Y existen en ese mes: un bloque «30, 31» no puede ser
      // de septiembre (allí el 31 no existe), así que es de octubre. Una casilla
      // suelta y ambigua (p. ej. un único «30» con 28,29,30 en la lista) NO se
      // importa: es preferible perder una casilla dudosa que inventar un turno.
      const empiezaEnMesAnterior = bloques[0].every((it) => leading.has(it.day) && it.day <= diasMesAnterior);
      const base = empiezaEnMesAnterior ? 1 : 0;

      const entries = [];
      for (let i = 0; i < bloques.length; i++) {
        const desplazamiento = i - base;
        for (const item of bloques[i]) {
          diasVistos.add(item.day);
          if (desplazamiento !== 0) {
            // Los días del mes anterior y del siguiente NO se importan: solo se
            // cuentan (docs/AI-IMPORT.md §3).
            if (desplazamiento < 0) detalle.previousMonth++;
            else detalle.nextMonth++;
            continue;
          }
          if (!(item.day >= 1 && item.day <= totalDias)) {
            detalle.invalidDay++;
            continue;
          }
          entries.push({ date: dateKey(year, month - 1, item.day), day: item.day, code: item.code, column: item.column });
        }
      }
      if (!entries.length) continue;

      // Un día repetido en la misma persona se cuenta una sola vez.
      const vistos = new Set();
      const unicas = [];
      for (const e of entries) {
        if (vistos.has(e.date)) continue;
        vistos.add(e.date);
        unicas.push(e);
      }
      const duplicadosPersona = entries.length - unicas.length;
      unicas.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      crudas.push({ label, incierta: inciertas.has(label.toUpperCase()), entries: unicas, duplicados: duplicadosPersona });
    }

    if (!crudas.length) {
      return resultadoVacio(`La IA ha transcrito casillas, pero ninguna cae dentro de ${MONTHS[month - 1]} de ${year}.`);
    }

    /* --- 2. El mes, contra el calendario real ---------------------- */
    const mes = evaluarMes({ entradas: crudas.flatMap((p) => p.entries), year, month });

    /* --- 3. Confianza por casilla y avisos ------------------------- */
    const people = [];
    const unknownCodes = {};
    let altas = 0;
    let bajas = 0;
    let entradasTotales = 0;
    let duplicados = 0;
    let fallosColumna = 0;
    let sinColumna = 0;

    for (const persona of crudas) {
      duplicados += persona.duplicados;
      const motivosPersona = [...globales];
      if (persona.incierta) motivosPersona.push('la IA ha avisado de que no lee bien esta fila');
      if (mes.confianza !== 'high') motivosPersona.push('el mes no se ha podido verificar con seguridad');

      const entries = [];
      for (const e of persona.entries) {
        const evaluada = evaluarCasilla({ ...e, catalogo });
        if (!evaluada.conocido) unknownCodes[e.code] = (unknownCodes[e.code] || 0) + 1;
        if (evaluada.falloColumna) fallosColumna++;
        else if (!e.column) sinColumna++;

        const motivos = [...evaluada.motivos, ...motivosPersona];
        const confidence = motivos.length ? 'low' : 'high';
        if (confidence === 'high') altas++;
        else bajas++;
        entradasTotales++;
        entries.push({
          date: e.date,
          day: e.day,
          code: e.code,
          confidence,
          // `column` no está en el contrato mínimo de la entrada, pero es lo que
          // permite que verifyParse compruebe la letra sin volver a llamar a la
          // IA. `buildEntriesFromParse` lo ignora.
          ...(e.column ? { column: e.column } : {}),
          ...(motivos.length ? { reason: motivos.join('; ') } : {}),
        });
      }

      people.push({
        label: persona.label,
        matchedMemberId: null, // lo rellena la UI al emparejar con el equipo
        memberId: null,
        entries,
      });
    }

    const fueraDeMes = detalle.previousMonth + detalle.nextMonth + detalle.invalidDay;
    detalle.total = fueraDeMes;

    return {
      ok: true,
      reason: null,
      monthKey,
      monthConfidence: mes.confianza,
      monthCandidates: mes.candidatos,
      page: { width: 0, height: 0 }, // la IA no mide la página; la revisión no lo usa
      people,
      unknownCodes,
      issues: construirIssues({
        monthKey,
        unknownCodes,
        fueraDeMes,
        duplicados,
        fallosColumna,
        sinColumna,
        bajas,
        monthConfianza: mes.confianza,
        fallosMes: mes.fallos,
        motivos: globales,
      }),
      stats: {
        people: people.length,
        entries: entradasTotales,
        high: altas,
        low: bajas,
        outsideMonth: fueraDeMes,
      },
      meta: {
        source: 'ai',
        header: texto(interpretacion.monthNameRaw) || `${MONTHS[month - 1]} ${year}`,
        columns: numeroEntero(interpretacion.grid?.columns),
        rows: numeroEntero(interpretacion.grid?.rows),
        days: diasVistos.size,
        checkedColumns: mes.comprobadas,
        columnMismatches: mes.fallos,
        // La interpretación completa se guarda para que verifyParse (y la
        // revisión) puedan comprobar el resultado sin volver a llamar a la IA.
        interpretation: interpretacion,
        transcription: {
          uncertainPeople: listaTextos(transcripcion?.uncertainPeople),
          warnings: listaTextos(transcripcion?.warnings),
        },
        outsideMonthDetail: detalle,
        // El día repetido ya se ha quitado de `people`, así que el número viaja
        // aquí para que verifyParse pueda volver a contar sin perderlo.
        duplicateDays: duplicados,
        codeTotals: contarPorCodigo(people.flatMap((p) => p.entries)),
      },
    };
  } catch (err) {
    return resultadoVacio(`No se ha podido montar el resultado: ${err?.message || 'error desconocido'}.`);
  }
}

/* ------------------------------------------------------------------ *
 * API: verificar
 * ------------------------------------------------------------------ */

/**
 * Verificación determinista del resultado (docs/AI-IMPORT.md §3).
 *
 * Es pura: devuelve un objeto NUEVO y no toca el `parseResult` que recibe (la
 * revisión puede seguir enseñando el original) y es idempotente (verificar dos
 * veces da lo mismo). Aplica todas las reglas de la tabla: día dentro del mes,
 * letra de columna contra el día de la semana real, casilla sin columna, día
 * repetido, códigos desconocidos, mes contra el calendario y confianza global;
 * los recuentos se recalculan aquí, nunca se copian de la IA.
 *
 * @param {object} parseResult
 * @param {{year?:number, month?:number}} [opts] mes con el que se comprueba (1..12)
 */
export function verifyParse(parseResult, opts = {}) {
  try {
    if (!esObjeto(parseResult)) return resultadoVacio('No hay ningún resultado que verificar.');
    if (parseResult.ok !== true) return { ...parseResult };

    const ctx = esObjeto(parseResult.meta?.interpretation) ? parseResult.meta.interpretation : null;
    const month = numeroEntero(opts?.month)
      ?? numeroEntero(ctx?.month)
      ?? numeroEntero(String(parseResult.monthKey || '').slice(5, 7));
    const year = numeroEntero(opts?.year)
      ?? numeroEntero(ctx?.year)
      ?? numeroEntero(String(parseResult.monthKey || '').slice(0, 4));
    if (!(month >= 1 && month <= 12) || !(year >= 1900 && year <= 2200)) {
      return resultadoVacio('El resultado no dice de qué mes es: no se puede verificar.');
    }
    const monthKey = `${year}-${pad2(month)}`;
    const totalDias = daysInMonth(monthKey);
    const catalogo = normalizarCatalogo(opts?.knownCodes);
    const inciertas = new Set(listaTextos(parseResult.meta?.transcription?.uncertainPeople).map((s) => s.toUpperCase()));
    const globales = ctx
      ? motivosGlobales(ctx, { warnings: parseResult.meta?.transcription?.warnings })
      : [];
    const detalle = esObjeto(parseResult.meta?.outsideMonthDetail)
      ? { ...parseResult.meta.outsideMonthDetail }
      : { previousMonth: 0, nextMonth: 0, invalidDay: 0, total: 0 };

    /* --- 1. Qué casillas siguen en pie ----------------------------- */
    const crudas = [];
    let fueraNuevos = 0;
    let duplicadosNuevos = 0;

    for (const persona of Array.isArray(parseResult.people) ? parseResult.people : []) {
      if (!esObjeto(persona) || !Array.isArray(persona.entries)) continue;
      const label = texto(persona.label);
      if (!label) continue;

      const vistos = new Set();
      const entries = [];
      for (const e of persona.entries) {
        if (!esObjeto(e)) continue;
        const code = texto(e.code).toUpperCase();
        const date = texto(e.date);
        if (!code) continue;
        // Día dentro del mes: la fecha tiene que ser real y del mes que se está
        // importando, y el día declarado tiene que coincidir con ella.
        const dt = /^\d{4}-\d{2}-\d{2}$/.test(date) ? fromKey(date) : null;
        if (!dt || date.slice(0, 7) !== monthKey) { fueraNuevos++; continue; }
        const dia = dt.getDate();
        if (!(dia >= 1 && dia <= totalDias)) { fueraNuevos++; continue; }
        const diaDeclarado = numeroEntero(e.day);
        if (diaDeclarado !== null && diaDeclarado !== dia) { fueraNuevos++; continue; }
        if (vistos.has(date)) { duplicadosNuevos++; continue; } // se queda el primero
        vistos.add(date);
        entries.push({ date, day: dia, code, column: letraDeColumna(e.column) });
      }
      if (!entries.length) continue;
      entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      crudas.push({ label, incierta: inciertas.has(label.toUpperCase()), entries });
    }

    if (!crudas.length) {
      return resultadoVacio(`No queda ninguna casilla dentro de ${monthKey}: no hay nada que importar.`);
    }

    /* --- 2. El mes, contra el calendario real ---------------------- */
    const mes = evaluarMes({ entradas: crudas.flatMap((p) => p.entries), year, month });

    /* --- 3. Confianza por casilla y avisos ------------------------- */
    const people = [];
    const unknownCodes = {};
    let altas = 0;
    let bajas = 0;
    let entradasTotales = 0;
    let fallosColumna = 0;
    let sinColumna = 0;

    for (const persona of crudas) {
      const motivosPersona = [...globales];
      if (persona.incierta) motivosPersona.push('la IA ha avisado de que no lee bien esta fila');
      if (mes.confianza !== 'high') motivosPersona.push('el mes no se ha podido verificar con seguridad');

      const entries = [];
      for (const e of persona.entries) {
        const evaluada = evaluarCasilla({ ...e, catalogo });
        if (!evaluada.conocido) unknownCodes[e.code] = (unknownCodes[e.code] || 0) + 1;
        if (evaluada.falloColumna) fallosColumna++;
        else if (!e.column) sinColumna++;

        const motivos = [...evaluada.motivos, ...motivosPersona];
        const confidence = motivos.length ? 'low' : 'high';
        if (confidence === 'high') altas++;
        else bajas++;
        entradasTotales++;
        entries.push({
          date: e.date,
          day: e.day,
          code: e.code,
          confidence,
          ...(e.column ? { column: e.column } : {}),
          ...(motivos.length ? { reason: motivos.join('; ') } : {}),
        });
      }

      people.push({
        label: persona.label,
        matchedMemberId: persona.matchedMemberId ?? null,
        memberId: persona.memberId ?? null,
        entries,
      });
    }

    const fueraDeMes = (numeroEntero(detalle.total) ?? (detalle.previousMonth + detalle.nextMonth + detalle.invalidDay))
      + fueraNuevos;
    // Los días repetidos ya se quitaron al montar el resultado: el número viene
    // apuntado en `meta` y aquí solo se le suman los que aparezcan de nuevo.
    const duplicados = (numeroEntero(parseResult.meta?.duplicateDays) ?? 0) + duplicadosNuevos;

    return {
      ok: true,
      reason: null,
      monthKey,
      monthConfidence: mes.confianza,
      monthCandidates: mes.candidatos,
      page: esObjeto(parseResult.page) ? { ...parseResult.page } : { width: 0, height: 0 },
      people,
      unknownCodes,
      issues: construirIssues({
        monthKey,
        unknownCodes,
        fueraDeMes,
        duplicados,
        fallosColumna,
        sinColumna,
        bajas,
        monthConfianza: mes.confianza,
        fallosMes: mes.fallos,
        motivos: globales,
      }),
      stats: {
        people: people.length,
        entries: entradasTotales,
        high: altas,
        low: bajas,
        outsideMonth: fueraDeMes,
      },
      meta: {
        ...(esObjeto(parseResult.meta) ? parseResult.meta : {}),
        source: parseResult.meta?.source || 'ai',
        header: parseResult.meta?.header || `${MONTHS[month - 1]} ${year}`,
        days: new Set(crudas.flatMap((p) => p.entries.map((e) => e.day))).size,
        checkedColumns: mes.comprobadas,
        columnMismatches: mes.fallos,
        outsideMonthDetail: { ...detalle, total: fueraDeMes },
        duplicateDays: duplicados,
        codeTotals: contarPorCodigo(people.flatMap((p) => p.entries)),
      },
    };
  } catch (err) {
    return resultadoVacio(`No se ha podido verificar el resultado: ${err?.message || 'error desconocido'}.`);
  }
}

/* ------------------------------------------------------------------ *
 * API: la cadena completa
 * ------------------------------------------------------------------ */

/**
 * Orquesta interpretar → transcribir → montar → verificar.
 * Devuelve el ParseResult verificado o `{ ok:false, reason }`. Nunca lanza.
 */
export async function readScheduleWithAI(opts) {
  try {
    const interpretacion = await interpretSchedule(opts);
    if (!interpretacion.ok) return resultadoVacio(interpretacion.reason);

    const transcripcion = await transcribeSchedule({ ...opts, interpretation: interpretacion });
    if (!transcripcion.ok) return resultadoVacio(transcripcion.reason);

    const bruto = buildParseResult({
      interpretation: interpretacion,
      transcription: transcripcion,
      knownCodes: opts?.knownCodes,
    });
    if (!bruto.ok) return bruto;

    return verifyParse(bruto, { year: interpretacion.year, month: interpretacion.month });
  } catch (err) {
    return resultadoVacio(limpiarSecreto(
      `La lectura con IA ha fallado: ${err?.message || 'error desconocido'}.`,
      opts?.apiKey,
    ));
  }
}
