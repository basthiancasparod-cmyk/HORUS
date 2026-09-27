/**
 * HORUS — tests/ai.mjs
 * Pruebas de la importación de cuadrantes con IA de visión (js/core/ai-vision.js).
 *
 * No se toca la red de verdad: el `fetch` SIEMPRE se inyecta con respuestas
 * falsas (y un `sleep` que no espera), porque lo que se prueba aquí es la
 * tubería, la verificación determinista y los mensajes de error, no la API.
 *
 * Ejecutar: node tests/ai.mjs
 */

/* --- Arnés (el mismo estilo que tests/import.mjs) -------------------- */

let passed = 0;
let failed = 0;
const failures = [];
let suiteName = '';

function describe(name) { suiteName = name; console.log(`\n\x1b[1m\x1b[36m${name}\x1b[0m`); }

async function it(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push({ suite: suiteName, name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${String(err.message).split('\n').join('\n      ')}\x1b[0m`);
  }
}

function ok(v, label = 'valor falsy') { if (!v) throw new Error(`se esperaba verdadero: ${label}`); }
function notOk(v, label = 'valor truthy') { if (v) throw new Error(`se esperaba falso: ${label}`); }
function is(a, b, label = '') {
  if (a !== b) throw new Error(`${label} esperado ${JSON.stringify(b)}, recibido ${JSON.stringify(a)}`);
}
function eq(a, b, label = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${label}\n      esperado: ${y}\n      recibido: ${x}`);
}

/* --- Módulos -------------------------------------------------------- */

const date = await import('../js/core/date.js');
const vision = await import('../js/core/ai-vision.js');
const importer = await import('../js/core/schedule-import.js');

/* --- Utilidades de prueba ------------------------------------------- */

const CLAVE = 'clave-de-prueba-no-real-1234';
const ARCHIVO = { data: 'Zm90by1mYWxzYQ==', mimeType: 'image/jpeg', name: 'cuadrante.jpg' };
const LETRAS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

/** Respuesta HTTP falsa con cuerpo de texto. */
function respuestaTexto(cuerpo, status = 200) {
  return {
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Error',
    text: async () => cuerpo,
    json: async () => JSON.parse(cuerpo),
  };
}
const respuestaJson = (cuerpo, status = 200) => respuestaTexto(JSON.stringify(cuerpo), status);
/** Respuesta de error sin cuerpo, como las de verdad. */
const respuestaError = (status) => respuestaTexto('', status);

/** Envoltura de Gemini: el JSON va como texto en `candidates[0].content.parts[].text`. */
function gemini(datos) {
  return respuestaJson({ candidates: [{ content: { parts: [{ text: JSON.stringify(datos) }] } }] });
}
/** Envoltura compatible con OpenAI (OpenRouter y el chat de Mistral). */
function openai(datos) {
  return respuestaJson({ choices: [{ message: { content: JSON.stringify(datos) } }] });
}

/** `fetch` falso que va sirviendo respuestas de una cola y las apunta. */
function fetchEnCola(respuestas) {
  const llamadas = [];
  const impl = async (url, opts = {}) => {
    llamadas.push({ url, opts, cuerpo: opts.body ? JSON.parse(opts.body) : null });
    if (!respuestas.length) throw new Error('la prueba ha pedido más respuestas de las preparadas');
    const siguiente = respuestas.shift();
    return typeof siguiente === 'function' ? siguiente(url, opts) : siguiente;
  };
  impl.llamadas = llamadas;
  return impl;
}

/** `fetch` falso que devuelve siempre lo mismo (y apunta las llamadas). */
function fetchFijo(respuesta, llamadas = []) {
  const impl = async (url, opts = {}) => {
    llamadas.push({ url, opts, cuerpo: opts.body ? JSON.parse(opts.body) : null });
    return typeof respuesta === 'function' ? respuesta(url, opts) : respuesta;
  };
  impl.llamadas = llamadas;
  return impl;
}

/** Prompt que se le ha enviado a Gemini (la imagen va en `parts[0]`). */
const promptDe = (llamada) => llamada.cuerpo.contents[0].parts[1].text;

const sleepFalso = (registro = []) => async (ms) => { registro.push(ms); };

/** Letra real de la cabecera para un día de un mes (por defecto octubre de 2026). */
function letraReal(day, monthKey = '2026-10') {
  const dt = date.fromKey(`${monthKey}-${String(day).padStart(2, '0')}`);
  if (!dt) throw new Error(`fecha imposible en la prueba: ${monthKey}-${day}`);
  return LETRAS[dt.getDay()];
}

/** Casilla transcrita, tal y como la devuelve la IA. */
function casilla(day, code, column) {
  return column === undefined ? { day, code } : { day, code, column };
}

const opciones = (fetchImpl, extra = {}) => ({
  provider: 'gemini',
  apiKey: CLAVE,
  file: ARCHIVO,
  fetchImpl,
  ...extra,
});

/* --- Fixtures: el cuadrante de octubre de 2026 (medido en docs/) ----- */

function interpretacionOctubre(extra = {}) {
  return {
    month: 10,
    year: 2026,
    monthNameRaw: 'OCTUBRE 26',
    leadingPreviousMonthDays: [28, 29, 30],
    trailingNextMonthDays: [1],
    people: ['JAVIER', 'WILLIAM'],
    codes: [
      { code: 'M', meaning: 'Turno mañana', count: 75 },
      { code: 'VC', meaning: 'Vacaciones', count: 9 },
    ],
    weekdayHeader: 'L M X J V S D',
    grid: { columns: 35, rows: 6 },
    confidence: 'high',
    warnings: ['El año indicado es 26, interpretado como 2026.'],
    ...extra,
  };
}

function transcripcion(cells, extra = {}) {
  return { cells, uncertainPeople: [], warnings: [], ...extra };
}

/** Lee el cuadrante completo con una interpretación y una transcripción dadas. */
async function leer(interpretacion, transcripcionUsada, extra = {}) {
  const fetchImpl = fetchEnCola([gemini(interpretacion), gemini(transcripcionUsada)]);
  const resultado = await vision.readScheduleWithAI(opciones(fetchImpl, extra));
  resultado.__llamadas = fetchImpl.llamadas;
  return resultado;
}

/* ==================================================================== *
 * 1. El camino completo con una respuesta bien formada
 * ==================================================================== */

describe('readScheduleWithAI con una respuesta bien formada');

await it('devuelve un ParseResult verificado con las personas y los días correctos', async () => {
  const t = transcripcion([
    {
      label: 'JAVIER',
      entries: [
        casilla(1, 'M', letraReal(1)),
        casilla(2, 'VC', letraReal(2)),
        casilla(5, 'M', letraReal(5)),
      ],
    },
    {
      label: 'WILLIAM',
      entries: [casilla(3, 'M', letraReal(3)), casilla(4, 'VC', letraReal(4))],
    },
  ]);

  const r = await leer(interpretacionOctubre(), t);
  ok(r.ok, `la lectura debe ir bien (motivo: ${r.reason || '—'})`);
  is(r.monthKey, '2026-10', 'el mes del cuadrante');
  is(r.monthConfidence, 'high', 'las letras de columna cuadran con el calendario real');
  is(r.people.length, 2, 'las dos personas de la hoja');

  const javier = r.people.find((p) => p.label === 'JAVIER');
  ok(javier, 'JAVIER está');
  eq(javier.entries.map((e) => e.date), ['2026-10-01', '2026-10-02', '2026-10-05'], 'las fechas');
  eq(javier.entries.map((e) => e.code), ['M', 'VC', 'M'], 'los códigos');
  eq(javier.entries.map((e) => e.confidence), ['high', 'high', 'high'], 'todas seguras');
  for (const e of javier.entries) notOk(e.reason, `sin motivo en una casilla segura (${e.date})`);

  is(r.stats.people, 2);
  is(r.stats.entries, 5);
  is(r.stats.high, 5, 'ninguna dudosa');
  is(r.stats.low, 0);
  is(r.meta.source, 'ai');
  is(r.__llamadas.length, 2, 'una llamada para interpretar y otra para transcribir');
});

await it('la petición a Gemini lleva la imagen, el esquema y la clave fuera de la URL', async () => {
  const fetchImpl = fetchFijo(gemini(interpretacionOctubre()));
  const r = await vision.interpretSchedule(opciones(fetchImpl));
  ok(r.ok, `motivo: ${r.reason || '—'}`);

  const [llamada] = fetchImpl.llamadas;
  is(llamada.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
  is(llamada.opts.method, 'POST');
  is(llamada.opts.headers['x-goog-api-key'], CLAVE, 'la clave va en la cabecera');
  notOk(llamada.url.includes(CLAVE), 'la clave nunca puede ir en la URL');

  const [imagen, instruccion] = llamada.cuerpo.contents[0].parts;
  is(imagen.inline_data.mime_type, 'image/jpeg');
  is(imagen.inline_data.data, ARCHIVO.data);
  is(llamada.cuerpo.generationConfig.temperature, 0, 'temperatura 0: nada de creatividad');
  is(llamada.cuerpo.generationConfig.responseMimeType, 'application/json');
  ok(llamada.cuerpo.generationConfig.responseSchema, 'se pide salida estructurada');
  ok(instruccion.text.includes('leadingPreviousMonthDays'), 'el prompt pide los días del mes anterior');
  ok(instruccion.text.includes('trailingNextMonthDays'), 'y los del mes siguiente');
});

await it('un año con dos cifras se completa a cuatro', async () => {
  const fetchImpl = fetchFijo(gemini(interpretacionOctubre({ year: 26 })));
  const r = await vision.interpretSchedule(opciones(fetchImpl));
  ok(r.ok, `motivo: ${r.reason || '—'}`);
  is(r.year, 2026);
  is(r.month, 10);
});

await it('la interpretación normaliza personas, códigos y rejilla', async () => {
  const fetchImpl = fetchFijo(gemini({
    month: '10',
    year: '2026',
    people: [' JAVIER ', 'JAVIER', '', 'WILLIAM'],
    codes: [{ code: 'm', meaning: 'Mañana', count: '3' }, { code: '', meaning: 'nada' }],
    leadingPreviousMonthDays: [30, 28, 28, 0, 99],
    grid: { columns: '35', rows: 6 },
    confidence: 'ALTA',
  }));
  const r = await vision.interpretSchedule(opciones(fetchImpl));
  ok(r.ok, `motivo: ${r.reason || '—'}`);
  eq(r.people, ['JAVIER', 'JAVIER', 'WILLIAM'], 'se conservan tal cual vienen (la UI decide después)');
  eq(r.codes, [{ code: 'M', meaning: 'Mañana', count: 3 }], 'los códigos se normalizan');
  eq(r.leadingPreviousMonthDays, [28, 30], 'días válidos, sin repetir y en orden');
  is(r.grid.columns, 35);
  is(r.confidence, 'low', 'una confianza que no se reconoce se trata como baja');
});

/* ==================================================================== *
 * 2. La trampa del mes anterior (la regla que más importa)
 * ==================================================================== */

describe('La trampa del mes anterior');

await it('los días del mes anterior no se convierten en entradas y suman a outsideMonth', async () => {
  const t = transcripcion([
    {
      label: 'JAVIER',
      entries: [
        // 28, 29 y 30 de septiembre: van al principio de la rejilla y NO son de octubre.
        casilla(28, 'M', letraReal(28, '2026-09')),
        casilla(29, 'M', letraReal(29, '2026-09')),
        casilla(30, 'VC', letraReal(30, '2026-09')),
        casilla(1, 'M', letraReal(1)),
        casilla(2, 'VC', letraReal(2)),
      ],
    },
  ]);

  const r = await leer(interpretacionOctubre(), t);
  ok(r.ok, `motivo: ${r.reason || '—'}`);
  const persona = r.people[0];
  eq(persona.entries.map((e) => e.date), ['2026-10-01', '2026-10-02'], 'solo se importan los días de octubre');
  notOk(
    r.people.some((p) => p.entries.some((e) => e.day >= 28)),
    'ningún día del mes anterior se cuela como día de octubre',
  );
  is(r.stats.outsideMonth, 3, 'las tres casillas se cuentan como fuera de mes');
  const fuera = r.issues.find((i) => i.kind === 'outside-month');
  ok(fuera, 'aparece el aviso outside-month');
  is(fuera.count, 3);
  is(r.monthConfidence, 'high', 'quitando las del mes anterior, las columnas de octubre cuadran');
});

await it('los días del mes siguiente tampoco se importan', async () => {
  const t = transcripcion([
    {
      label: 'JAVIER',
      entries: [
        casilla(30, 'M', letraReal(30)),
        casilla(31, 'M', letraReal(31)),
        // Reinicio: el 1 y el 2 ya son de noviembre.
        casilla(1, 'VC', letraReal(1, '2026-11')),
        casilla(2, 'VC', letraReal(2, '2026-11')),
      ],
    },
  ]);
  const r = await leer(interpretacionOctubre(), t);
  ok(r.ok, `motivo: ${r.reason || '—'}`);
  eq(r.people[0].entries.map((e) => e.date), ['2026-10-30', '2026-10-31']);
  is(r.stats.outsideMonth, 2);
  ok(r.issues.some((i) => i.kind === 'outside-month'));
});

/* ==================================================================== *
 * 3. Las reglas de verificación, una a una
 * ==================================================================== */

describe('Verificación de las casillas');

await it('una letra de columna mentirosa deja la casilla en low y genera column-mismatch', async () => {
  // El 1 de octubre de 2026 es JUEVES (J); la IA se lo inventa y dice «X».
  is(date.fromKey('2026-10-01').getDay(), 4, 'el 1 de octubre de 2026 es jueves');
  const t = transcripcion([
    {
      label: 'JAVIER',
      entries: [casilla(1, 'M', 'X'), casilla(2, 'M', letraReal(2)), casilla(3, 'M', letraReal(3))],
    },
  ]);

  const r = await leer(interpretacionOctubre(), t);
  ok(r.ok, `motivo: ${r.reason || '—'}`);
  const casillaDia1 = r.people[0].entries.find((e) => e.day === 1);
  ok(casillaDia1, 'la casilla del día 1 sigue ahí: no se descarta en silencio');
  is(casillaDia1.confidence, 'low', 'queda como dudosa');
  ok(casillaDia1.reason.includes('X'), `el motivo nombra la letra mentirosa: ${casillaDia1.reason}`);
  ok(/jueves/i.test(casillaDia1.reason), `y el día real: ${casillaDia1.reason}`);
  const issue = r.issues.find((i) => i.kind === 'column-mismatch');
  ok(issue, 'aparece el aviso column-mismatch');
  ok(issue.count >= 1, `casillas señaladas: ${issue.count}`);
  notOk(r.monthConfidence === 'high', 'con una letra que no cuadra, el mes ya no se da por seguro al 100 %');
});

await it('una casilla sin columna queda en low', async () => {
  const t = transcripcion([
    { label: 'JAVIER', entries: [casilla(1, 'M', letraReal(1)), casilla(2, 'M')] },
  ]);
  const r = await leer(interpretacionOctubre(), t);
  ok(r.ok, `motivo: ${r.reason || '—'}`);

  const con = r.people[0].entries.find((e) => e.day === 1);
  const sin = r.people[0].entries.find((e) => e.day === 2);
  is(con.confidence, 'high', 'la que trae la letra correcta se da por segura');
  is(sin.confidence, 'low', 'sin letra no se puede comprobar');
  ok(/columna/i.test(sin.reason), `el motivo lo explica: ${sin.reason}`);
  is(r.monthConfidence, 'high', 'el mes sí se puede comprobar con la otra casilla');
  ok(r.issues.some((i) => i.kind === 'missing-column'));
});

await it('un código desconocido va a unknownCodes y baja a low sin descartarse', async () => {
  const t = transcripcion([
    { label: 'JAVIER', entries: [casilla(5, 'ZZ', letraReal(5))] },
  ]);
  const r = await leer(interpretacionOctubre(), t);
  ok(r.ok, `motivo: ${r.reason || '—'}`);

  const entrada = r.people[0].entries[0];
  is(entrada.code, 'ZZ', 'el código se conserva tal cual');
  is(entrada.confidence, 'low', 'queda dudoso');
  is(r.unknownCodes.ZZ, 1, 'se cuenta como desconocido');
  ok(r.issues.some((i) => i.kind === 'unknown-code' && i.code === 'ZZ'), 'y se avisa');
  // Sin decisión del usuario no se inventa un turno.
  eq(importer.buildEntriesFromParse(r, {}).filter((e) => e.typeCode === 'ZZ'), []);
});

await it('un día repetido en la misma persona se cuenta una vez y genera aviso', async () => {
  const t = transcripcion([
    {
      label: 'JAVIER',
      entries: [casilla(6, 'M', letraReal(6)), casilla(6, 'VC', letraReal(6))],
    },
  ]);
  const r = await leer(interpretacionOctubre(), t);
  ok(r.ok, `motivo: ${r.reason || '—'}`);

  const persona = r.people[0];
  is(persona.entries.length, 1, 'el día 6 aparece una sola vez');
  is(persona.entries[0].code, 'M', 'se queda la primera casilla');
  is(r.stats.entries, 1);
  ok(r.issues.some((i) => i.kind === 'duplicate-day'), 'se avisa del día repetido');
  is(r.monthConfidence, 'high');
});

await it('monthConfidence baja si las letras de columna no cuadran con ningún mes', async () => {
  // Los días 1, 2 y 3 no pueden ser los tres lunes en ningún mes del calendario.
  const t = transcripcion([
    {
      label: 'JAVIER',
      entries: [casilla(1, 'M', 'L'), casilla(2, 'M', 'L'), casilla(3, 'M', 'L')],
    },
  ]);
  const r = await leer(interpretacionOctubre(), t);
  ok(r.ok, `motivo: ${r.reason || '—'}`);

  is(r.monthConfidence, 'low', 'ningún mes cuadra al 100 %');
  ok(r.issues.some((i) => i.kind === 'month-uncertain'), 'se avisa de que el mes hay que confirmarlo');
  ok(r.monthCandidates.length > 0, 'se ofrecen meses candidatos para que el usuario elija');
  ok(r.monthCandidates.every((c) => c.mismatches > 0), 'y ninguno cuadra del todo');
  ok(
    r.people[0].entries.every((e) => e.confidence === 'low'),
    'si el mes no es seguro, ninguna casilla se da por buena',
  );
});

await it('si la IA no da ninguna letra de columna, el mes no se puede comprobar', async () => {
  const t = transcripcion([
    { label: 'JAVIER', entries: [casilla(1, 'M'), casilla(2, 'M')] },
  ]);
  const r = await leer(interpretacionOctubre(), t);
  ok(r.ok, `motivo: ${r.reason || '—'}`);
  is(r.monthConfidence, 'low', 'sin letras no hay evidencia para comprobar el mes');
  ok(r.issues.some((i) => i.kind === 'month-uncertain'));
  ok(r.people[0].entries.every((e) => e.confidence === 'low'));
});

await it('si la IA avisa de que no se lee bien, todas las casillas bajan a dudosas', async () => {
  const interpretacion = interpretacionOctubre({
    confidence: 'medium',
    warnings: ['La foto está borrosa: la segunda fila no se lee bien.'],
  });
  const t = transcripcion([
    { label: 'JAVIER', entries: [casilla(1, 'M', letraReal(1))] },
    { label: 'WILLIAM', entries: [casilla(2, 'M', letraReal(2))] },
  ]);
  const r = await leer(interpretacion, t);
  ok(r.ok, `motivo: ${r.reason || '—'}`);
  is(r.stats.high, 0, 'ninguna casilla segura');
  ok(r.people.every((p) => p.entries.every((e) => e.confidence === 'low')));
  ok(r.issues.some((i) => i.kind === 'interpretation-uncertain'), 'se avisa de la lectura poco fiable');
});

await it('las personas que la IA no lee bien quedan marcadas como dudosas', async () => {
  const t = transcripcion([
    { label: 'JAVIER', entries: [casilla(1, 'M', letraReal(1))] },
    { label: 'WILLIAM', entries: [casilla(2, 'M', letraReal(2))] },
  ], { uncertainPeople: ['WILLIAM'] });

  const r = await leer(interpretacionOctubre(), t);
  ok(r.ok, `motivo: ${r.reason || '—'}`);
  is(r.people.find((p) => p.label === 'JAVIER').entries[0].confidence, 'high');
  const dudosa = r.people.find((p) => p.label === 'WILLIAM').entries[0];
  is(dudosa.confidence, 'low');
  ok(/no lee bien/i.test(dudosa.reason), `el motivo: ${dudosa.reason}`);
});

await it('los recuentos se recalculan y no se copian de la IA', async () => {
  const t = transcripcion([
    {
      label: 'JAVIER',
      entries: [casilla(1, 'M', letraReal(1)), casilla(2, 'M', letraReal(2)), casilla(3, 'M', letraReal(3))],
    },
  ]);
  const r = await leer(interpretacionOctubre(), t);
  ok(r.ok, `motivo: ${r.reason || '—'}`);
  const bruto = vision.buildParseResult({ interpretation: interpretacionOctubre(), transcription: t });
  is(bruto.meta.codeTotals.M, 3, 'tres M de verdad');
  is(bruto.meta.codeTotals.VC, undefined, 'ninguna VC');
  is(
    bruto.meta.interpretation.codes.find((c) => c.code === 'M').count,
    75,
    'lo que dijo la IA se conserva solo como pista, nunca como recuento',
  );
  notOk(r.monthConfidence !== 'high' || r.stats.entries !== 3);
});

/* ==================================================================== *
 * 4. Comportamiento de red (medido en docs/AI-IMPORT.md §4)
 * ==================================================================== */

describe('Red: reintentos y errores');

await it('ante un 503 reintenta y acaba usando el siguiente modelo de reserva', async () => {
  const llamadas = [];
  const esperas = [];
  const fetchImpl = async (url, opts) => {
    llamadas.push({ url, opts });
    // Los dos intentos del primer modelo están saturados; el de reserva responde.
    return llamadas.length <= 2 ? respuestaError(503) : gemini(interpretacionOctubre());
  };

  const r = await vision.interpretSchedule(opciones(fetchImpl, {
    model: 'modelo-saturado',
    sleepImpl: sleepFalso(esperas),
  }));

  ok(r.ok, `debe acabar bien (motivo: ${r.reason || '—'})`);
  is(r.month, 10);
  is(llamadas.length, 3, 'dos intentos del primer modelo y uno del siguiente');
  ok(llamadas[0].url.includes('modelo-saturado'), 'el primero es el preferido');
  ok(llamadas[1].url.includes('modelo-saturado'), 'el segundo intento es del mismo modelo');
  ok(llamadas[2].url.includes('gemini-3.1-flash-lite'), `el de reserva: ${llamadas[2].url}`);
  is(esperas.length, 2, 'se espera entre intentos (con un sleep inyectado que no espera de verdad)');
  ok(esperas[1] > esperas[0], `la espera crece: ${esperas.join(' → ')}`);
});

await it('si se agotan los modelos saturados lo explica y pide reintentar en unos minutos', async () => {
  const llamadas = [];
  const fetchImpl = async (url) => { llamadas.push(url); return respuestaError(503); };
  const r = await vision.interpretSchedule(opciones(fetchImpl, { sleepImpl: async () => {} }));

  is(r.ok, false);
  ok(/saturado/i.test(r.reason), `el motivo: ${r.reason}`);
  ok(/minutos/i.test(r.reason), 'pide reintentar en unos minutos');
  is(llamadas.length, 8, 'cuatro modelos con dos intentos cada uno');
});

await it('un 429 se trata igual que un 503', async () => {
  const llamadas = [];
  const r = await vision.interpretSchedule(opciones(async (url) => {
    llamadas.push(url);
    return llamadas.length <= 2 ? respuestaError(429) : gemini(interpretacionOctubre());
  }, { model: 'modelo-ocupado', sleepImpl: async () => {} }));
  ok(r.ok, `motivo: ${r.reason || '—'}`);
  is(llamadas.length, 3);
});

await it('un 401 no se reintenta y el motivo habla de la clave sin contenerla', async () => {
  const llamadas = [];
  const r = await vision.interpretSchedule(opciones(fetchFijo(respuestaError(401), llamadas), {
    sleepImpl: async () => {},
  }));

  is(r.ok, false);
  is(llamadas.length, 1, 'no se reintenta en un error de clave');
  ok(/clave/i.test(r.reason), `el motivo debe hablar de la clave: ${r.reason}`);
  ok(!r.reason.includes(CLAVE), 'el motivo no puede contener la clave');
  ok(!JSON.stringify(r).includes(CLAVE), 'ni el resultado entero');
});

await it('un 404 dice qué modelo no está disponible y tampoco se reintenta', async () => {
  const llamadas = [];
  const r = await vision.interpretSchedule(opciones(fetchFijo(respuestaError(404), llamadas), {
    model: 'gemini-2.5-flash',
    sleepImpl: async () => {},
  }));

  is(r.ok, false);
  is(llamadas.length, 1, 'no se reintenta si el modelo no existe');
  ok(/no está disponible/i.test(r.reason), `el motivo: ${r.reason}`);
  ok(r.reason.includes('gemini-2.5-flash'), 'nombra el modelo probado');
  ok(!JSON.stringify(r).includes(CLAVE));
});

await it('un fallo de red se devuelve como {ok:false} y no se propaga', async () => {
  let lanzo = false;
  let r = null;
  try {
    r = await vision.interpretSchedule(opciones(async () => {
      throw new Error(`se ha caído la red mandando la clave ${CLAVE}`);
    }));
  } catch {
    lanzo = true;
  }
  is(lanzo, false, 'la función nunca lanza');
  is(r?.ok, false);
  ok(r.reason.length > 10, `explica lo que pasa: ${r.reason}`);
  ok(!r.reason.includes(CLAVE), 'ni un error de red puede filtrar la clave');
});

await it('una respuesta con JSON corrupto se rechaza', async () => {
  const r = await vision.interpretSchedule(opciones(fetchFijo(respuestaTexto('esto no es json {{{'))));
  is(r.ok, false);
  ok(/JSON/i.test(r.reason), `el motivo: ${r.reason}`);
});

await it('cuando la IA contesta con prosa en vez de JSON, se rechaza', async () => {
  const r = await vision.interpretSchedule(opciones(
    fetchFijo(respuestaJson({ candidates: [{ content: { parts: [{ text: 'Lo siento, no puedo leer esta imagen.' }] } }] })),
  ));
  is(r.ok, false);
  ok(/JSON/i.test(r.reason), `el motivo: ${r.reason}`);
});

await it('sin conector de red lo dice sin lanzar', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  delete globalThis.fetch;
  try {
    const r = await vision.interpretSchedule({ provider: 'gemini', apiKey: CLAVE, file: ARCHIVO });
    is(r.ok, false);
    ok(/red|conexión/i.test(r.reason), `el motivo: ${r.reason}`);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor);
  }
});

await it('sin proveedor, sin clave o sin archivo se avisa antes de gastar red', async () => {
  let llamadas = 0;
  const fetchImpl = async () => { llamadas++; return gemini(interpretacionOctubre()); };

  const sinProveedor = await vision.interpretSchedule({ apiKey: CLAVE, file: ARCHIVO, fetchImpl });
  is(sinProveedor.ok, false);
  ok(/proveedor/i.test(sinProveedor.reason));

  const sinClave = await vision.interpretSchedule({ provider: 'gemini', file: ARCHIVO, fetchImpl });
  is(sinClave.ok, false);
  ok(/clave/i.test(sinClave.reason));
  ok(!sinClave.reason.includes(CLAVE));

  const sinArchivo = await vision.interpretSchedule({ provider: 'gemini', apiKey: CLAVE, fetchImpl });
  is(sinArchivo.ok, false);
  ok(/archivo/i.test(sinArchivo.reason));

  const proveedorRaro = await vision.interpretSchedule({ provider: 'inventado', apiKey: CLAVE, file: ARCHIVO, fetchImpl });
  is(proveedorRaro.ok, false);
  ok(/no reconocido/i.test(proveedorRaro.reason));

  is(llamadas, 0, 'ninguno de estos casos toca la red');
});

await it('el adaptador de OpenRouter manda la imagen como data URL y un response_format', async () => {
  const fetchImpl = fetchFijo(openai(interpretacionOctubre()));
  const r = await vision.interpretSchedule({ provider: 'openrouter', apiKey: CLAVE, file: ARCHIVO, fetchImpl });
  ok(r.ok, `motivo: ${r.reason || '—'}`);

  const [llamada] = fetchImpl.llamadas;
  is(llamada.url, 'https://openrouter.ai/api/v1/chat/completions');
  is(llamada.opts.headers.Authorization, `Bearer ${CLAVE}`);
  const imagen = llamada.cuerpo.messages[0].content.find((p) => p.type === 'image_url');
  ok(imagen, 'la imagen va como image_url');
  is(imagen.image_url.url, `data:image/jpeg;base64,${ARCHIVO.data}`);
  is(llamada.cuerpo.response_format.type, 'json_object');
});

await it('el adaptador de Mistral primero hace OCR y luego estructura el texto', async () => {
  const respuestas = [
    respuestaJson({ pages: [{ index: 0, markdown: '| JAVIER | M | M |' }] }),
    openai(interpretacionOctubre()),
  ];
  const fetchImpl = fetchEnCola(respuestas);
  const r = await vision.interpretSchedule({
    provider: 'mistral',
    apiKey: CLAVE,
    file: { ...ARCHIVO, mimeType: 'application/pdf' },
    fetchImpl,
    sleepImpl: async () => {},
  });

  ok(r.ok, `motivo: ${r.reason || '—'}`);
  is(fetchImpl.llamadas.length, 2, 'una llamada de OCR y otra de chat');
  const [ocr, chat] = fetchImpl.llamadas;
  is(ocr.url, 'https://api.mistral.ai/v1/ocr');
  is(ocr.opts.headers.Authorization, `Bearer ${CLAVE}`);
  is(ocr.cuerpo.document.type, 'document_url', 'un PDF va como documento');
  is(chat.url, 'https://api.mistral.ai/v1/chat/completions');
  is(chat.cuerpo.model, 'mistral-small-latest', 'el chat necesita un modelo distinto del de OCR');
  ok(chat.cuerpo.messages[0].content.includes('| JAVIER | M | M |'), 'el texto del OCR entra en el prompt');
});

/* ==================================================================== *
 * 5. Los prompts
 * ==================================================================== */

describe('Los prompts');

await it('el prompt de transcripción lleva el aviso medido sobre la letra de la columna', async () => {
  const fetchImpl = fetchFijo(gemini(transcripcion([
    { label: 'JAVIER', entries: [casilla(1, 'M', letraReal(1))] },
  ])));
  const r = await vision.transcribeSchedule(opciones(fetchImpl, { interpretation: interpretacionOctubre() }));
  ok(r.ok, `motivo: ${r.reason || '—'}`);

  const prompt = promptDe(fetchImpl.llamadas[0]);
  ok(
    prompt.includes('No deduzcas la letra del día de la semana a partir del número: léela de la cabecera. Si no la ves, omite el campo "column".'),
    'falta el aviso medido en docs/AI-IMPORT.md',
  );
  ok(/OCTUBRE 26/.test(prompt), 'lleva la interpretación como contexto');
  ok(prompt.includes('JAVIER'), 'y la lista de personas');
  ok(/no invent|omit/i.test(prompt), 'ordena omitir lo que no se lea con seguridad');
});

await it('el prompt de interpretación pide el mes anterior y el siguiente', async () => {
  const fetchImpl = fetchFijo(gemini(interpretacionOctubre()));
  await vision.interpretSchedule(opciones(fetchImpl));
  const prompt = promptDe(fetchImpl.llamadas[0]);
  ok(/leadingPreviousMonthDays/.test(prompt), 'pide los días del mes anterior');
  ok(/trailingNextMonthDays/.test(prompt), 'y los del mes siguiente');
  ok(/NO transcribas/i.test(prompt), 'no le pide transcribir en el mismo paso');
  ok(/warnings/.test(prompt) && /confidence/.test(prompt), 'pide avisos y confianza');
});

/* ==================================================================== *
 * 6. buildParseResult y verifyParse por separado
 * ==================================================================== */

describe('buildParseResult y verifyParse');

await it('buildParseResult con una transcripción vacía no lanza', () => {
  const r = vision.buildParseResult({ interpretation: interpretacionOctubre(), transcription: { cells: [] } });
  ok(r.ok === false || r.people.length === 0, 'o lo explica o no devuelve personas');
  ok(typeof r.reason === 'string' && r.reason.length > 0, `explica el motivo: ${r.reason}`);
  eq(r.people, [], 'sin personas');
  is(r.stats.entries, 0);

  for (const basura of [undefined, null, {}, { cells: 'no es una lista' }, { cells: [] }]) {
    const x = vision.buildParseResult({ interpretation: interpretacionOctubre(), transcription: basura });
    is(x.ok, false, `con transcripción basura (${JSON.stringify(basura)}) no puede decir que va bien`);
  }
  const sinInterpretacion = vision.buildParseResult({ transcription: transcripcion([]) });
  is(sinInterpretacion.ok, false, 'sin interpretación tampoco');
  ok(/interpretación/i.test(sinInterpretacion.reason));

  const mesRaro = vision.buildParseResult({
    interpretation: interpretacionOctubre({ month: 44 }),
    transcription: transcripcion([{ label: 'JAVIER', entries: [casilla(1, 'M', 'J')] }]),
  });
  is(mesRaro.ok, false, 'un mes imposible se rechaza');
});

await it('si todas las casillas son del mes anterior, no se inventa ninguna persona', () => {
  const r = vision.buildParseResult({
    interpretation: interpretacionOctubre(),
    transcription: transcripcion([{
      label: 'JAVIER',
      entries: [
        casilla(28, 'M', letraReal(28, '2026-09')),
        casilla(29, 'M', letraReal(29, '2026-09')),
        casilla(30, 'M', letraReal(30, '2026-09')),
      ],
    }]),
  });
  is(r.ok, false, 'sin ningún día del mes no hay nada que importar');
  eq(r.people, [], 'y no se inventa una persona vacía');
  ok(/ninguna cae dentro/i.test(r.reason), `el motivo: ${r.reason}`);
});

await it('verifyParse no muta el resultado que recibe y devuelve uno nuevo', () => {
  const bruto = vision.buildParseResult({
    interpretation: interpretacionOctubre(),
    transcription: transcripcion([{
      label: 'JAVIER',
      entries: [casilla(1, 'M', 'X'), casilla(2, 'M')],
    }]),
  });
  ok(bruto.ok, `el montaje va bien (motivo: ${bruto.reason || '—'})`);

  const antes = JSON.stringify(bruto);
  const verificado = vision.verifyParse(bruto, { year: 2026, month: 10 });

  is(JSON.stringify(bruto), antes, 'el original queda exactamente igual');
  ok(verificado !== bruto, 'devuelve un objeto nuevo');
  ok(verificado.people !== bruto.people, 'y no comparte las listas');
  // Verificar dos veces da lo mismo: es determinista e idempotente.
  eq(vision.verifyParse(verificado, { year: 2026, month: 10 }), verificado);
});

await it('verifyParse acepta el mes por parámetro y descarta lo que no sea de ese mes', () => {
  const bruto = {
    ok: true,
    reason: null,
    monthKey: '2026-10',
    monthConfidence: 'high',
    monthCandidates: [],
    page: { width: 0, height: 0 },
    people: [
      {
        label: 'JAVIER',
        matchedMemberId: null,
        memberId: null,
        entries: [
          { date: '2026-10-02', day: 2, code: 'M', confidence: 'high' },
          { date: '2026-09-30', day: 30, code: 'M', confidence: 'high' }, // fuera
          { date: '2026-10-02', day: 2, code: 'VC', confidence: 'high' }, // repetida
          { date: '2026-10-33', day: 33, code: 'M', confidence: 'high' }, // imposible
          { date: '2026-10-04', day: 9, code: 'M', confidence: 'high' }, // día incoherente
        ],
      },
    ],
    unknownCodes: {},
    issues: [],
    stats: { people: 1, entries: 5, high: 5, low: 0, outsideMonth: 0 },
    meta: {},
  };

  const r = vision.verifyParse(bruto, { year: 2026, month: 10 });
  ok(r.ok, `motivo: ${r.reason || '—'}`);
  is(r.people[0].entries.length, 1, 'solo queda la casilla coherente');
  is(r.people[0].entries[0].date, '2026-10-02');
  is(r.stats.outsideMonth, 3, 'las tres casillas descartadas se cuentan (fuera de mes, imposible e incoherente)');
  ok(r.issues.some((i) => i.kind === 'outside-month' && i.count === 3));
  ok(r.issues.some((i) => i.kind === 'duplicate-day' && i.count === 1));
});

await it('verifyParse deja pasar un resultado que no venía de la IA sin tocarlo', () => {
  const ajeno = { ok: false, reason: 'El PDF no tiene texto seleccionable.', people: [], stats: {} };
  const r = vision.verifyParse(ajeno, { year: 2026, month: 10 });
  is(r.ok, false);
  is(r.reason, ajeno.reason);
  ok(r !== ajeno, 'devuelve una copia, no el mismo objeto');
});

/* ==================================================================== *
 * 7. Convergencia con el lector de PDF
 * ==================================================================== */

describe('Convergencia con schedule-import.js');

await it('la salida de buildParseResult la acepta buildEntriesFromParse sin tocar nada', () => {
  const t = transcripcion([{
    label: 'JAVIER',
    entries: [
      casilla(1, 'M', letraReal(1)),
      casilla(2, 'VC', letraReal(2)),
      casilla(3, 'ZZ', letraReal(3)),
    ],
  }]);
  const bruto = vision.buildParseResult({ interpretation: interpretacionOctubre(), transcription: t });
  ok(bruto.ok, `el montaje va bien (motivo: ${bruto.reason || '—'})`);

  const entradas = importer.buildEntriesFromParse(bruto, {});
  ok(entradas.length >= 2, `entradas producidas: ${entradas.length}`);
  ok(entradas.every((e) => e.date && e.typeCode), 'todas traen fecha y tipo de turno');
  ok(entradas.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)), 'con fechas bien formadas');
  is(entradas.find((e) => e.date === '2026-10-02').typeCode, 'V', 'VC es vacaciones para el catálogo');
  notOk(entradas.some((e) => e.typeCode === 'ZZ'), 'un código desconocido no se inventa');

  const verificado = vision.verifyParse(bruto, { year: 2026, month: 10 });
  ok(importer.buildEntriesFromParse(verificado, {}).length >= 2, 'y el resultado verificado también se puede volcar');
});

/* ==================================================================== *
 * Informe
 * ==================================================================== */

console.log(`\n${'─'.repeat(62)}`);
if (failed === 0) {
  console.log(`\x1b[1m\x1b[32m✓ ${passed} pruebas de IA correctas\x1b[0m`);
} else {
  console.log(`\x1b[1m\x1b[31m✗ ${failed} fallidas\x1b[0m de ${passed + failed}`);
  console.log('\nFallos:');
  for (const f of failures) {
    console.log(`  · [${f.suite}] ${f.name}`);
    console.log(`    ${String(f.err.message).split('\n').join('\n    ')}`);
  }
}
console.log(`${'─'.repeat(62)}\n`);

process.exit(failed === 0 ? 0 : 1);
