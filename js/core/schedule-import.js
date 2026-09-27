/**
 * HORUS — js/core/schedule-import.js
 * Importación de un cuadrante mensual exportado a PDF desde el sistema de la
 * empresa (formato descrito en `docs/PDF-FORMAT.md`).
 *
 * QUÉ HACE
 *  1. Lee el texto real del PDF con `pdf-text.js` (nada de OCR).
 *  2. Localiza la rejilla: la fila de cabecera `L M X J V S D` (35 columnas =
 *     5 semanas) y, justo debajo, la tirada de números de día.
 *  3. Reconstruye los días a partir de la tirada de dígitos (no de sus x).
 *  4. Comprueba el mes con el calendario real (día de la semana de cada
 *     columna) y solo entonces da fechas. Nunca adivina el mes en silencio.
 *  5. Lee las filas de personas y coloca cada código en su columna.
 *  6. Devuelve un `ParseResult` que la UI puede enseñar, revisar e importar.
 *
 * REGLAS DE HONESTIDAD (docs/PDF-FORMAT.md §10)
 *  - Nunca se inventa un turno: lo que no se puede situar con seguridad se
 *    marca `low` con un motivo en español.
 *  - Nunca se adivina el mes: se ofrecen candidatos con su número de fallos.
 *  - Nunca se toca el catálogo de turnos.
 *  - Si el PDF es un escaneo (sin texto), se devuelve un error explicable.
 *
 * Sin DOM, sin red y sin módulos de Node: funciona igual en el navegador y en
 * Node. `readPdfText` ya resuelve la descompresión de los streams.
 */

import { readPdfText, groupRows, clusterRow } from './pdf-text.js';
import { dateKey, fromKey, addDays, daysInMonth, MONTHS } from './date.js';
import { defaultShiftTypes } from './model.js';

/* ------------------------------------------------------------------ *
 * Catálogo de códigos del PDF (no es el catálogo de turnos de la app)
 * ------------------------------------------------------------------ */

/**
 * Códigos que el cuadrante de la empresa usa, tal y como los confirma el
 * documento de formato:
 *   M Mañana · T Tarde · I Intermedio · P Partido · V/VC Vacaciones ·
 *   F Festivo · RE/R Reunión.
 *
 * `code` es lo que viene impreso en el PDF y `typeCode` el código del turno del
 * catálogo de HORUS al que corresponde (ver `defaultShiftTypes()` en model.js).
 * Lo que no esté aquí es DESCONOCIDO y va a la lista de dudas de la UI.
 */
export const KNOWN_CODES = Object.freeze({
  M: { code: 'M', typeCode: 'M' },
  T: { code: 'T', typeCode: 'T' },
  I: { code: 'I', typeCode: 'INT' },
  P: { code: 'P', typeCode: 'P' },
  V: { code: 'V', typeCode: 'V' },
  VC: { code: 'VC', typeCode: 'V' },
  F: { code: 'F', typeCode: 'F' },
  RE: { code: 'RE', typeCode: 'RE' },
  R: { code: 'R', typeCode: 'RE' },
});

/** Letra de cabecera → día de la semana real (`Date.getDay()`: 0 = domingo). */
const LETRAS_DIA = { L: 1, M: 2, X: 3, J: 4, V: 5, S: 6, D: 0 };
/** `Date.getDay()` → letra de la cabecera. */
const LETRA_DE_DOW = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

/** Separación (px) a partir de la cual dos fragmentos son filas/celdas distintas. */
const HUECO_NOMBRE = 15;
const HUECO_CELDA = 0.28; // relativo al tamaño de fuente

/* ------------------------------------------------------------------ *
 * Utilidades pequeñas
 * ------------------------------------------------------------------ */

const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const norm = (s) => sinAcentos(s).trim().replace(/\s+/g, ' ').toUpperCase();

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
  };
}

/* ------------------------------------------------------------------ *
 * Geometría: posiciones reales de los glifos
 * ------------------------------------------------------------------ */

/**
 * POSICIONES: las da `pdf-text.js`, y son las de la página.
 *
 * Historia de este apartado, porque costó entenderlo: aquí hubo un «corrector»
 * que rehacía la x de cada glifo dando por hecho que `pdf-text.js` las devolvía
 * mal. Le aplicaba un factor de escala y le sumaba otra vez los anchos de
 * fuente. Aquello tenía dos fallos:
 *
 *  1. Reescalaba cada fila tomando como origen SU primer glifo, que es la letra
 *     del nombre y cambia de persona a persona. Encoger cada fila alrededor de
 *     un origen distinto desplaza a cada una una cantidad distinta: hasta 17 px,
 *     cuando la columna mide 20,6. Casi una casilla entera. Por eso la fila de
 *     ALEJANDRA salía un día corrida y perdía casillas.
 *  2. La escala y la corrección de anchos arreglaban lo mismo dos veces.
 *
 * La raíz estaba en `pdf-text.js`, que suponía 0,5 em por carácter. Ya usa los
 * anchos reales del array `/W` de cada fuente —en este cuadrante la `M` mide
 * 0,854 em, la `I` 0,251 y los dígitos 0,506—, así que las x que llegan aquí son
 * las de verdad y sólo queda rehacer la ANCHURA de cada fragmento, que es lo que
 * hace este código.
 *
 * Se usa la tabla de anchos propia (y no `item.width` de pdf-text.js) porque la
 * tirada de números hay que partirla dígito a dígito para sacar el centro de
 * cada columna, y eso necesita el ancho de cada carácter por separado.
 */

/** Anchos de glifo (em) por fuente: `F2` → Map(carácter → em). */
function buildCharWidths(pdf, fontMaps) {
  const porNombre = new Map();
  try {
    // Igual que buildFontMaps: el diccionario de recursos liga /F1.. a un objeto fuente.
    const objetosDeFuente = new Map();
    for (const [, body] of pdf.objects) {
      for (const m of body.matchAll(/\/(F\d+)\s+(\d+)\s+\d+\s+R/g)) objetosDeFuente.set(m[1], Number(m[2]));
    }
    for (const [nombre, numObj] of objetosDeFuente) {
      const body = pdf.objects.get(numObj);
      const cmap = fontMaps?.get(nombre);
      if (!body || !cmap) continue;
      const w = parseWidthArray(pdf, body);
      if (!w || !w.size) continue;
      const porCaracter = new Map();
      for (const [cid, ch] of cmap) {
        const em = w.get(cid);
        if (em !== undefined) porCaracter.set(ch, em / 1000);
      }
      if (porCaracter.size) porNombre.set(nombre, porCaracter);
    }
  } catch {
    // Sin anchos: se usa 0.5 em para todo y la corrección se anula.
  }
  return porNombre;
}

/** Lee el array /W (directo o indirecto) de un objeto fuente. */
function parseWidthArray(pdf, fontBody) {
  const m = /\/W\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(fontBody);
  if (!m) return null;
  let texto = m[1];
  const ind = /^\s*(\d+)\s+\d+\s+R\s*$/.exec(texto);
  if (ind) texto = pdf.objects.get(Number(ind[1])) || '';
  const nums = [...texto.matchAll(/\d+/g)].map((x) => Number(x[0]));
  const out = new Map();
  for (let i = 0; i + 2 < nums.length; i += 3) {
    const lo = nums[i];
    const hi = nums[i + 1];
    const ancho = nums[i + 2];
    if (!(hi >= lo) || hi - lo > 60000) break;
    for (let c = lo; c <= hi; c++) out.set(c, ancho);
  }
  return out;
}

function anchoDe(tabla, font, ch) {
  const t = tabla.get(font);
  if (!t) return 0.5;
  const v = t.get(ch);
  if (v !== undefined) return v;
  const up = t.get(String(ch).toUpperCase());
  if (up !== undefined) return up;
  return 0.5;
}

/**
 * Devuelve una función que rehace la ANCHURA de cada fragmento de una fila y
 * calcula su centro, dejando la x tal y como la da `pdf-text.js` (que ya son las
 * posiciones de la página).
 */
function makeCorrector(tablaAnchos) {
  return function corregir(items) {
    if (!items || !items.length) return [];
    const out = [];
    for (const it of items) {
      const size = it.size;
      const x = it.x;
      let ancho = 0;
      for (const ch of String(it.text)) ancho += anchoDe(tablaAnchos, it.font, ch) * size;
      out.push({ text: it.text, font: it.font, size, x, ancho, fin: x + ancho, centro: x + ancho / 2 });
    }
    return out;
  };
}

/* ------------------------------------------------------------------ *
 * Rejilla: cabecera, tirada de números y partición en días
 * ------------------------------------------------------------------ */

const esLetraDeDia = (t) => /^[LMXJVSD]$/.test(String(t || '').trim());

/** Fila de cabecera: todos sus fragmentos son letras L M X J V S D. */
function esFilaCabecera(row) {
  const its = row.items || [];
  if (its.length < 7 || its.length % 7 !== 0) return false;
  return its.every((i) => esLetraDeDia(i.text));
}

/** Fila de la tirada de números: todos sus fragmentos son dígitos. */
function esFilaNumeros(row) {
  const its = row.items || [];
  if (its.length < 10) return false;
  return its.every((i) => /^\d+$/.test(String(i.text || '').trim()));
}

/**
 * Parte la tirada de dígitos en la secuencia de días.
 *
 * La tirada es `282930123456789101112…282930` (57 dígitos, 33 días). No se
 * empareja cada número con la columna más cercana (eso falla, ver §3 del
 * documento): se prueba cada final de mes posible (28..31) y cada día de
 * arranque, simulando una secuencia monótona de uno en uno con UN solo
 * reinicio a 1, y se exige que consuma todos los dígitos exactamente.
 */
function partitionDayRun(digits) {
  const candidatos = [];
  for (let largo = 28; largo <= 31; largo++) {
    for (let inicio = 1; inicio <= largo; inicio++) {
      let i = 0;
      let esperado = inicio;
      let reinicios = 0;
      const valores = [];
      let vale = true;
      while (i < digits.length) {
        if (esperado > largo) {
          esperado = 1;
          reinicios++;
          if (reinicios > 1) { vale = false; break; }
        }
        const cifras = esperado >= 10 ? 2 : 1;
        if (i + cifras > digits.length) { vale = false; break; }
        if (Number(digits.slice(i, i + cifras)) !== esperado) { vale = false; break; }
        valores.push(esperado);
        i += cifras;
        esperado++;
      }
      if (vale && i === digits.length && valores.length >= 14) {
        candidatos.push({ largo, inicio, valores, reinicios });
      }
    }
  }
  if (!candidatos.length) return null;
  // Se prefiere la tirada más larga (la que explica más columnas).
  candidatos.sort((a, b) => b.valores.length - a.valores.length || b.inicio - a.inicio);
  return candidatos[0];
}

/** Texto de mes y año de la cabecera («OCTUBRE 26»). */
function detectMonthHeader(rows, filaCabecera) {
  const meses = MONTHS.map((m) => norm(m));
  for (const row of rows) {
    if (row.y <= filaCabecera.y + 1) continue; // solo por encima de la rejilla
    // Los fragmentos son carácter a carácter: se unen SIN separador para no
    // romper las palabras («O C T U B R E» no contiene «OCTUBRE»).
    const texto = norm(row.items.map((i) => i.text).join(''));
    const idx = meses.findIndex((m) => texto.includes(m));
    if (idx < 0) continue;
    const cuatro = /(19|20)\d{2}/.exec(texto);
    let year = cuatro ? Number(cuatro[0]) : null;
    if (year === null) {
      const dos = /(\d{2})(?!\d)/.exec(texto);
      if (dos) {
        const n = Number(dos[1]);
        year = n >= 70 ? 1900 + n : 2000 + n;
      }
    }
    return { month: idx + 1, year };
  }
  return null;
}

/**
 * Construye las fechas de las columnas para un mes candidato.
 *
 * `month` es el mes de la columna que lleva el número 1 (el reinicio de la
 * tirada); las columnas anteriores son del mes anterior y las posteriores
 * siguen corriendo con el calendario real. Así, las columnas finales que no
 * llevan número impreso (en el archivo real la extracción pierde los dos
 * últimos dígitos, fuera de página) también reciben su fecha.
 *
 * Se comprueba cada columna con DOS señales: el número impreso debe coincidir
 * con el día real y la letra de la cabecera con el día de la semana real.
 */
function evaluarCandidato(valores, letras, year, month) {
  const nColumnas = letras.length;
  const idxUno = valores.indexOf(1);
  const colAncla = idxUno >= 0 ? idxUno : 0;
  const diaAncla = idxUno >= 0 ? 1 : (valores[0] ?? 1);
  const inicio = dateKey(year, month - 1, diaAncla);

  const fechas = [];
  const verificada = [];
  let fallos = 0;
  let fallosDia = 0;
  let fallosSemana = 0;
  let comprobadas = 0;
  let sinNumero = 0;

  for (let i = 0; i < nColumnas; i++) {
    const clave = addDays(inicio, i - colAncla);
    const dt = fromKey(clave);
    fechas.push(clave);

    // La señal AUTORITATIVA es el número de día impreso: si el 28, el 29 y el 30
    // van seguidos del 1, del 2…, la columna sólo puede ser ese día del mes. Eso
    // fija la fecha sin ambigüedad, y con 33 columnas comprobadas no hay duda.
    //
    // Ojo con no confundir dos cosas distintas: que el número NO CUADRE (fallo
    // real) y que la columna NO TRAIGA NÚMERO (no se puede comprobar). Lo segundo
    // pasa en las últimas columnas del mes, que la hoja imprime sin número. Si se
    // contaran igual, ningún mes podría llegar a confianza alta.
    let diaOk = false;
    if (i < valores.length) {
      comprobadas++;
      diaOk = !!dt && dt.getDate() === valores[i];
      if (!diaOk) { fallosDia++; fallos++; }
    } else {
      sinNumero++;
    }

    // Las letras de la cabecera L M X J V S D son una señal SECUNDARIA: en este
    // cuadrante la fila trae un par de fragmentos descolocados (dos letras a 2 px
    // cuando las columnas están a ~21), así que no pueden mandar sobre el número.
    // Se cuentan y se avisa, pero no hunden la confianza si el número cuadra.
    if (i < letras.length && dt && letras[i]) {
      if (LETRA_DE_DOW[dt.getDay()] !== letras[i]) fallosSemana++;
    }

    // Una columna sólo se da por verificada si el número impreso lo confirma.
    // Las que no traen número quedan sin verificar a propósito.
    verificada.push(diaOk);
  }

  const cuenta = new Map();
  for (const f of fechas) {
    const k = f.slice(0, 7);
    cuenta.set(k, (cuenta.get(k) || 0) + 1);
  }
  const [monthKey] = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0];

  return { year, month, fechas, verificada, fallos, fallosDia, fallosSemana, comprobadas, sinNumero, monthKey, colAncla };
}

/* ------------------------------------------------------------------ *
 * Lectura de las filas de personas
 * ------------------------------------------------------------------ */

/** Corta la fila por su primer hueco grande: a la izquierda está el nombre. */
function cortarNombre(glifos) {
  for (let i = 1; i < glifos.length; i++) {
    if (glifos[i].x - glifos[i - 1].fin > HUECO_NOMBRE) return i;
  }
  return glifos.length;
}

/**
 * Agrupa los glifos de un bloque en «celdas»: cada celda es lo que el cuadrante
 * imprime en UNA casilla (un día). Los glifos de una misma casilla van pegados
 * (hueco ≈ 0); entre casillas queda el relleno de la columna (≥ 4 px medidos).
 */
function celdasDeGlifos(glifos) {
  const celdas = [];
  for (const g of glifos) {
    const t = String(g.text || '');
    if (!t.trim()) continue; // espacios y puntos no son códigos
    const ult = celdas[celdas.length - 1];
    if (ult && (g.x - ult.fin) < HUECO_CELDA * g.size) {
      ult.text += t;
      ult.fin = g.x + g.ancho;
      ult.centro = (ult.x + ult.fin) / 2;
    } else {
      celdas.push({ text: t, x: g.x, fin: g.x + g.ancho, centro: g.x + g.ancho / 2, size: g.size, font: g.font });
    }
  }
  return celdas;
}

/* ------------------------------------------------------------------ *
 * API pública
 * ------------------------------------------------------------------ */

/**
 * Interpreta el PDF de cuadrante y devuelve el mes estructurado.
 *
 * @param {Uint8Array} bytes contenido del PDF
 * @returns {Promise<object>} ParseResult (ver el contrato del módulo)
 */
export async function parseSchedulePdf(bytes) {
  if (!bytes || !bytes.length) {
    return resultadoVacio('El archivo está vacío: no hay nada que leer.');
  }

  let lectura = null;
  try {
    lectura = await readPdfText(bytes);
  } catch (err) {
    return resultadoVacio(`No se ha podido leer el PDF: ${err?.message || 'formato no reconocido'}.`);
  }

  const items = lectura?.items || [];
  const page = lectura?.page || { width: 0, height: 0 };

  if (!items.length) {
    return resultadoVacio('El PDF no tiene texto seleccionable: parece un escaneo o una imagen. '
      + 'Hace falta el PDF original exportado por el sistema de cuadrantes.');
  }

  const rows = groupRows(items);

  /* --- 1. Rejilla ------------------------------------------------- */
  const filaCabecera = rows.find(esFilaCabecera);
  if (!filaCabecera) {
    return resultadoVacio('No se reconoce la rejilla del cuadrante: no aparece la cabecera de días '
      + '(L M X J V S D repetido).');
  }
  const filaNumeros = rows.find((r) => r.y < filaCabecera.y - 0.5 && esFilaNumeros(r));
  if (!filaNumeros) {
    return resultadoVacio('No se encuentra la fila con los números de los días, justo debajo de la cabecera.');
  }

  const letras = filaCabecera.items.map((i) => String(i.text).trim());
  const digits = filaNumeros.items.map((i) => String(i.text).trim()).join('');
  const particion = partitionDayRun(digits);
  if (!particion) {
    return resultadoVacio('No se ha podido reconstruir la secuencia de días: la tirada de números del '
      + 'cuadrante no tiene el formato esperado (28 29 30 1 2 … 31).');
  }
  const valores = particion.valores;
  const nColumnas = letras.length;

  /* --- 2. Geometría: anchura real de cada fragmento ---------------- */
  const tablaAnchos = buildCharWidths(lectura.pdf, lectura.fontMaps);
  // Las x que llegan ya son las de la página (pdf-text.js usa los anchos /W de
  // las fuentes), así que no se reescala nada: sólo se rehace la anchura.
  const corregir = makeCorrector(tablaAnchos);

  // Centro de cada columna según los números impresos (los dígitos de un número
  // van pegados, así que el centro del número es el centro de la casilla).
  const glifosNumero = [];
  for (const it of corregir(filaNumeros.items)) {
    const size = it.size;
    const chars = [...String(it.text)];
    chars.forEach((ch, k) => {
      const em = anchoDe(tablaAnchos, it.font, ch);
      const x = it.x + k * em * size;
      glifosNumero.push({ ch, x, ancho: em * size, centro: x + (em * size) / 2 });
    });
  }
  const centros = [];
  let cursor = 0;
  for (const v of valores) {
    const n = String(v).length;
    const trozo = glifosNumero.slice(cursor, cursor + n);
    cursor += n;
    if (!trozo.length) break;
    const x0 = trozo[0].x;
    const x1 = trozo[trozo.length - 1].x + trozo[trozo.length - 1].ancho;
    centros.push((x0 + x1) / 2);
  }

  /* --- 3. Mes: cabecera + comprobación por día de la semana -------- */
  const cabeceraMes = detectMonthHeader(rows, filaCabecera);
  const yearBase = cabeceraMes?.year ?? new Date().getFullYear();
  const anios = [...new Set([yearBase, yearBase - 1, yearBase + 1])];

  const candidatos = [];
  for (const y of anios) {
    for (let m = 1; m <= 12; m++) candidatos.push(evaluarCandidato(valores, letras, y, m));
  }
  candidatos.sort((a, b) => {
    if (a.fallos !== b.fallos) return a.fallos - b.fallos;
    // A igualdad de fallos, se prefiere el mes y año que dice la cabecera.
    const da = cabeceraMes ? Math.abs(a.month - cabeceraMes.month) + Math.abs(a.year - cabeceraMes.year) : 0;
    const db = cabeceraMes ? Math.abs(b.month - cabeceraMes.month) + Math.abs(b.year - cabeceraMes.year) : 0;
    if (da !== db) return da - db;
    return a.year - b.year || a.month - b.month;
  });

  // Se deduplica por mes resultante, conservando el candidato con menos fallos.
  const vistos = new Set();
  const listaCandidatos = [];
  for (const c of candidatos) {
    if (vistos.has(c.monthKey)) continue;
    vistos.add(c.monthKey);
    listaCandidatos.push(c);
  }
  const mejor = listaCandidatos[0];

  let mesConfianza = 'low';
  if (mejor.fallos === 0) mesConfianza = 'high';
  else if (cabeceraMes && mejor.fallos <= Math.max(1, Math.round(mejor.comprobadas * 0.2))) mesConfianza = 'medium';

  const monthKey = mejor.monthKey;
  const fechas = mejor.fechas;
  const verificada = mejor.verificada;

  /* --- 4. Personas -------------------------------------------------- */
  const issues = [];
  const unknownCodes = {};
  const people = [];
  let fueraDeMes = 0;
  let celdasDudosas = 0;
  let celdasAmbiguas = 0;

  const esFilaDeRejilla = (row) => esFilaCabecera(row) || esFilaNumeros(row);

  for (const row of rows) {
    if (row.y >= filaNumeros.y - 0.5) continue; // solo por debajo de los números
    if (esFilaDeRejilla(row)) break;            // segunda copia de la rejilla: se para

    const glifos = corregir(row.items);
    const corte = cortarNombre(glifos);
    if (corte >= glifos.length) continue; // sin códigos: no es una fila de persona
    const etiqueta = glifos.slice(0, corte).map((g) => g.text).join('').trim().replace(/\s+/g, ' ');
    if (!etiqueta || !/[A-Za-zÁÉÍÓÚÜÑ]/.test(etiqueta) || /\d/.test(etiqueta)) continue;

    const resto = glifos.slice(corte);
    // Agrupación gruesa por proximidad (regla del documento) y luego, dentro de
    // cada grupo, separación fina en celdas usando la geometría corregida.
    const grupos = clusterRow({ items: resto }, 8);
    const celdas = [];
    for (const grupo of grupos) {
      const dentro = resto.filter((g) => g.x >= grupo.x - 1 && g.x <= grupo.x2 + 1);
      for (const celda of celdasDeGlifos(dentro)) celdas.push(celda);
    }
    if (!celdas.length) continue;

    const entradas = [];
    let ultimaCol = -1;
    for (const celda of celdas) {
      const codigo = String(celda.text).toUpperCase().replace(/[^A-Z]/g, '');
      if (!codigo) continue;

      // Columna: centro de la celda contra el centro de cada columna, con la
      // restricción de que las celdas van en orden (una casilla por día).
      let col = -1;
      let mejorDist = Infinity;
      for (let i = Math.max(0, ultimaCol + 1); i < nColumnas; i++) {
        if (centros[i] === undefined) break;
        const d = Math.abs(centros[i] - celda.centro);
        if (d < mejorDist) { mejorDist = d; col = i; }
      }
      if (col < 0) continue;
      let forzada = false;
      if (col <= ultimaCol) { col = ultimaCol + 1; forzada = true; }
      ultimaCol = col;

      const fecha = fechas[col];
      const conocido = KNOWN_CODES[codigo];
      const motivos = [];
      let confianza = 'high';

      if (!conocido) {
        confianza = 'low';
        motivos.push(`el código «${codigo}» no es conocido: se enseña para que lo asignes, no se ha inventado nada`);
        unknownCodes[codigo] = (unknownCodes[codigo] || 0) + 1;
      }
      if (codigo.length > 1 && !conocido) {
        celdasAmbiguas++;
        motivos.push(`la casilla lleva «${codigo}» (varias letras juntas): puede ser un código de dos letras o dos códigos distintos`);
      }
      if (!verificada[col]) {
        confianza = 'low';
        motivos.push('la columna no se ha podido verificar con el día de la semana');
      }
      if (forzada) {
        confianza = 'low';
        motivos.push('la casilla se ha tenido que desplazar a la columna siguiente (encaje dudoso)');
      }
      if (mesConfianza !== 'high') {
        confianza = 'low';
        motivos.push('el mes no se ha podido verificar con seguridad');
      }
      if (confianza === 'low') celdasDudosas++;

      // Fuera del mes del cuadrante: se CUENTA, pero NO se descarta.
      // Un cuadrante de octubre empieza a menudo con los últimos días de
      // septiembre y acaba con los primeros de noviembre, y esas casillas son
      // días de trabajo reales: van a su fecha de verdad, no se tiran ni se
      // mudan de mes.
      if (!fecha) continue;
      const fuera = fecha.slice(0, 7) !== monthKey;
      if (fuera) fueraDeMes++;

      const dt = fromKey(fecha);
      entradas.push({
        date: fecha,
        day: dt ? dt.getDate() : Number(fecha.slice(8, 10)),
        code: codigo,
        confidence: confianza,
        ...(fuera ? { outsideMonth: true } : {}),
        ...(motivos.length ? { reason: motivos.join('; ') } : {}),
      });
    }

    if (!entradas.length) continue;
    entradas.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    people.push({
      label: etiqueta,
      matchedMemberId: null, // lo rellena la UI al emparejar con el equipo
      memberId: null,        // (alias del anterior, por comodidad de las vistas)
      entries: entradas,
    });
  }

  if (!people.length) {
    return resultadoVacio('La rejilla se ha reconocido, pero no se ha encontrado ninguna fila de personas '
      + 'con turnos debajo de la cabecera.');
  }

  /* --- 5. Recuentos y avisos --------------------------------------- */
  let entradasTotales = 0;
  let altas = 0;
  let bajas = 0;
  for (const p of people) {
    for (const e of p.entries) {
      entradasTotales++;
      if (e.confidence === 'high') altas++;
      else bajas++;
    }
  }

  for (const [codigo, n] of Object.entries(unknownCodes)) {
    issues.push({
      kind: 'unknown-code',
      code: codigo,
      count: n,
      message: `El código «${codigo}» aparece ${n} ${n === 1 ? 'vez' : 'veces'} y no está en el catálogo. `
        + 'Asígnalo (o déjalo sin turno) antes de importar.',
    });
  }
  if (celdasAmbiguas) {
    issues.push({
      kind: 'ambiguous-cell',
      count: celdasAmbiguas,
      message: `Hay ${celdasAmbiguas} casillas con varias letras juntas que no forman un código conocido. `
        + 'Se han leído como una sola casilla (su fecha es la correcta); revísalas por si son códigos sueltos.',
    });
  }
  if (fueraDeMes) {
    issues.push({
      kind: 'outside-month',
      count: fueraDeMes,
      message: `${fueraDeMes} casillas son de los meses vecinos (finales del anterior o principios del siguiente). `
        + 'Se importan a su fecha de verdad, y en la revisión salen marcadas como de otro mes.',
    });
  }
  if (mejor.fallosDia) {
    issues.push({
      kind: 'day-mismatch',
      count: mejor.fallosDia,
      message: `En ${mejor.fallosDia} columnas el número impreso no coincide con el día calculado: revísalas.`,
    });
  }
  if (mejor.sinNumero) {
    issues.push({
      kind: 'unverified-columns',
      count: mejor.sinNumero,
      message: `${mejor.sinNumero} columnas del final no traen el número del día impreso, así que no se han podido`
        + ' comprobar contra el calendario. Sus casillas van marcadas para que las revises.',
    });
  }
  if (mejor.fallosSemana) {
    issues.push({
      kind: 'weekday-mismatch',
      count: mejor.fallosSemana,
      message: `En ${mejor.fallosSemana} columnas la letra de la cabecera no coincide con el día de la semana real. `
        + 'No cambia las fechas —manda el número de día impreso, que sí cuadra— pero conviene mirar esas casillas.',
    });
  }
  if (mesConfianza !== 'high') {
    issues.push({
      kind: 'month-uncertain',
      count: mejor.fallos,
      message: 'El mes no se ha podido confirmar del todo con el calendario. Elige el mes correcto antes de importar.',
    });
  }

  // La leyenda del cuadrante puede discrepar del catálogo: se avisa, no se toca.
  const leyenda = detectarLeyenda(rows);
  if (leyenda) issues.push(leyenda);

  return {
    ok: true,
    reason: null,
    monthKey,
    monthConfidence: mesConfianza,
    // `month` va en 1..12 (enero = 1) para que la UI lo enseñe tal cual.
    monthCandidates: listaCandidatos.slice(0, 6).map((c) => ({
      year: Number(c.monthKey.slice(0, 4)),
      month: Number(c.monthKey.slice(5, 7)),
      mismatches: c.fallos,
    })),
    page: { width: page.width, height: page.height },
    people,
    unknownCodes,
    issues,
    stats: {
      people: people.length,
      entries: entradasTotales,
      high: altas,
      low: bajas,
      outsideMonth: fueraDeMes,
    },
    meta: {
      columns: nColumnas,
      days: valores.length,
      firstDay: valores[0],
      lastDay: valores[valores.length - 1],
      fontMetrics: tablaAnchos.size > 0,
      header: cabeceraMes ? `${MONTHS[cabeceraMes.month - 1]} ${cabeceraMes.year}` : null,
      /**
       * Evidencia del ENCUADRE: la secuencia de números que el lector ha
       * encontrado impresa en la hoja, en orden, y las letras de la cabecera. La
       * pantalla de revisión la enseña para que se pueda comparar de un vistazo
       * con el papel: si esta tira no es la de la hoja, el encuadre está mal.
       */
      printedDays: [...valores],
      headerLetters: [...letras],
    },
  };
}

/** Compara la leyenda de horarios del PDF con el catálogo (solo avisa). */
function detectarLeyenda(rows) {
  const tipos = defaultShiftTypes();
  const turno = (code) => tipos.find((t) => t.code === code);
  const texto = rows.map((r) => norm(r.items.map((i) => i.text).join(''))).join(' | ');
  const m = /TARDE\s*(\d{1,2})[:.](\d{2})\s*A\s*(\d{1,2})[:.](\d{2})/.exec(texto);
  if (!m) return null;
  const hhmm = (h, mi) => `${String(Number(h)).padStart(2, '0')}:${mi}`;
  const inicio = hhmm(m[1], m[2]);
  const fin = hhmm(m[3], m[4]);
  const tarde = turno('T');
  const suyo = tarde?.blocks?.[0];
  if (!suyo || (suyo.start === inicio && suyo.end === fin)) return null;
  return {
    kind: 'legend-mismatch',
    message: `La leyenda del PDF dice que la tarde es ${inicio}–${fin}, pero el catálogo tiene `
      + `${suyo.start}–${suyo.end}. Manda el catálogo; revísalo si el horario ha cambiado.`,
  };
}

/* ------------------------------------------------------------------ *
 * Del resultado del parser a entradas del documento
 * ------------------------------------------------------------------ */

/** Mes de un `monthOverrides`: admite 'YYYY-MM', { monthKey }, { year, month } o mapa por persona. */
function mesDeOverride(ov, etiqueta) {
  if (!ov) return null;
  if (typeof ov === 'string') return /^\d{4}-\d{2}$/.test(ov) ? ov : null;
  if (typeof ov !== 'object') return null;
  if (typeof ov.monthKey === 'string' && /^\d{4}-\d{2}$/.test(ov.monthKey)) return ov.monthKey;
  if (Number.isFinite(Number(ov.year)) && Number.isFinite(Number(ov.month))) {
    const y = Number(ov.year);
    const m = Number(ov.month);
    if (m >= 1 && m <= 12) return `${y}-${String(m).padStart(2, '0')}`;
  }
  if (etiqueta && typeof ov[etiqueta] === 'string' && /^\d{4}-\d{2}$/.test(ov[etiqueta])) return ov[etiqueta];
  return null;
}

/** Mueve una fecha al mes indicado conservando el día (si existe en ese mes). */
function recolocarMes(fecha, monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const dia = Number(fecha.slice(8, 10));
  if (!(dia >= 1) || dia > daysInMonth(monthKey)) return null;
  return dateKey(y, m - 1, dia);
}

/**
 * Convierte un ParseResult + las decisiones del usuario en entradas listas para
 * el documento: `{ memberLabel, date, typeCode, blocks }`.
 *
 * @param {object} parseResult
 * @param {object} [options]
 * @param {object} [options.codeMap]     código del PDF desconocido → typeCode del catálogo
 * @param {object} [options.monthOverrides] mes forzado ('YYYY-MM', {year,month}, {monthKey} o por persona)
 * @param {boolean} [options.onlyHighConfidence] descarta las casillas dudosas
 * @param {object} [options.corrections]  "ETIQUETA|YYYY-MM-DD" → typeCode o null (dejar el día vacío)
 * @returns {{memberLabel:string,date:string,typeCode:string,blocks:object[]}[]}
 */
export function buildEntriesFromParse(parseResult, options = {}) {
  const out = [];
  if (!parseResult || !parseResult.ok || !Array.isArray(parseResult.people)) return out;

  const {
    codeMap = {},
    monthOverrides = {},
    onlyHighConfidence = false,
    corrections = {},
  } = options || {};

  const catalogo = new Map(defaultShiftTypes().map((t) => [String(t.code).toUpperCase(), t]));
  // OJO: el mes detectado NO se usa para recolocar fechas. Las del lector ya son
  // las de verdad, incluidos los últimos días del mes anterior y los primeros del
  // siguiente, que el cuadrante también cubre. Solo se recoloca si el usuario ha
  // forzado un mes a mano (`monthOverrides`), que es un caso distinto: rehacer
  // una hoja entera como si fuera de otro mes.
  const mesBase = mesDeOverride(monthOverrides, null) || null;

  for (const persona of parseResult.people) {
    if (!persona || !Array.isArray(persona.entries)) continue;
    const etiqueta = String(persona.label ?? '').trim();
    if (!etiqueta) continue;
    const mes = mesDeOverride(monthOverrides, etiqueta) || mesBase;

    for (const entrada of persona.entries) {
      if (!entrada || !entrada.date || !entrada.code) continue;

      // Fecha final (con el mes forzado, si lo hay) y fecha original del PDF.
      let fecha = entrada.date;
      if (mes && fecha.slice(0, 7) !== mes) {
        const movida = recolocarMes(fecha, mes);
        if (!movida) continue; // día inexistente en el mes destino
        fecha = movida;
      }

      // Correcciones explícitas del usuario. Se aceptan las dos claves (la fecha
      // final y la que traía el PDF) para que la UI no tenga que adivinar.
      const claves = [`${etiqueta}|${fecha}`, `${etiqueta}|${entrada.date}`];
      const tieneCorreccion = claves.some((k) => Object.prototype.hasOwnProperty.call(corrections, k));
      if (tieneCorreccion) {
        const elegido = claves.map((k) => corrections[k]).find((v) => v !== undefined);
        if (elegido == null || elegido === '') continue; // «dejar vacío»
        const typeCode = String(elegido).toUpperCase();
        out.push({ memberLabel: etiqueta, date: fecha, typeCode, blocks: catalogo.get(typeCode)?.blocks ?? [] });
        continue;
      }

      if (onlyHighConfidence && entrada.confidence !== 'high') continue;

      const conocido = KNOWN_CODES[String(entrada.code).toUpperCase()];
      const elegido = conocido ? conocido.typeCode : codeMap[entrada.code] ?? codeMap[String(entrada.code).toUpperCase()];
      if (!elegido) continue; // desconocido y sin decisión: no se inventa nada
      const typeCode = String(elegido).toUpperCase();
      out.push({ memberLabel: etiqueta, date: fecha, typeCode, blocks: catalogo.get(typeCode)?.blocks ?? [] });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Volcado al store
 * ------------------------------------------------------------------ */

/**
 * Aplica las entradas al store en UNA sola acción de deshacer.
 *
 * - Crea los miembros que falten (emparejando por nombre, sin acentos ni
 *   mayúsculas) y no duplica los que ya estén.
 * - Resuelve cada `typeCode` al `typeId` del documento; lo que no exista en el
 *   catálogo se descarta (nunca se inventa un turno).
 * - Nunca lanza: devuelve un resumen con lo importado y lo descartado.
 *
 * @param {object} store
 * @param {object[]} entries
 * @param {{year:number, month:number}} [rango] mes que se está importando (1..12)
 * @param {object} [opciones.identities] etiqueta del cuadrante → id de miembro ya
 *   existente. Es la respuesta del usuario a «¿es la misma persona?»: si viene,
 *   se usa ese miembro en vez de crear una ficha nueva. Un `null` explícito
 *   significa «es otra persona» y obliga a crear una ficha nueva aunque el nombre
 *   coincida.
 * @returns {{imported:number, members:number, skipped:number, reasons:string[]}}
 */
export function commitImportedEntries(store, entries, { year, month, identities = {} } = {}) {
  const resumen = { imported: 0, members: 0, skipped: 0, reasons: [] };
  if (!store || typeof store.batch !== 'function' || !Array.isArray(entries) || !entries.length) return resumen;
  if (typeof store.actions?.setEntry !== 'function') {
    resumen.reasons.push('El store no tiene la acción setEntry.');
    return resumen;
  }

  const clave = (s) => norm(s);
  const mesObjetivo = (Number.isFinite(Number(year)) && Number.isFinite(Number(month)))
    ? `${Number(year)}-${String(Number(month)).padStart(2, '0')}`
    : null;

  const porCodigo = new Map();
  for (const t of store.doc.shiftTypes || []) {
    if (t?.code) porCodigo.set(String(t.code).toUpperCase(), t);
    if (t?.id) porCodigo.set(String(t.id), t);
  }

  const miembros = new Map();
  for (const m of store.doc.members || []) miembros.set(clave(m.name), m.id);
  /**
   * Etiqueta del cuadrante → id ya resuelto en ESTA importación. Hace falta para
   * la respuesta «es otra persona»: si no se recuerda, cada turno de esa fila
   * crearía una ficha nueva (una por día).
   */
  const resueltos = new Map();

  try {
    store.batch('importar cuadrante del PDF', () => {
      for (const e of entries) {
        if (!e || !e.memberLabel || !e.date || !e.typeCode) { resumen.skipped++; continue; }
        /* NO se filtra por el mes del cuadrante: las casillas de los últimos días
           del mes anterior y de los primeros del siguiente también se importan, a
           su fecha real. Filtrarlas aquí era lo que hacía que se perdieran los
           días de septiembre y el primero de noviembre. */
        if (!fromKey(e.date)) { resumen.skipped++; continue; }
        const tipo = porCodigo.get(String(e.typeCode).toUpperCase());
        if (!tipo) {
          resumen.skipped++;
          const aviso = `El turno «${e.typeCode}» no está en el catálogo del documento: no se importa.`;
          if (!resumen.reasons.includes(aviso)) resumen.reasons.push(aviso);
          continue;
        }

        const k = clave(e.memberLabel);
        // Decisión del usuario sobre a quién corresponde esa fila del cuadrante:
        // un id manda sobre todo; `null` obliga a crear ficha nueva aunque el
        // nombre ya exista; sin decisión, se busca por nombre como siempre.
        const decidido = Object.prototype.hasOwnProperty.call(identities, e.memberLabel)
          ? identities[e.memberLabel]
          : undefined;
        let memberId = resueltos.has(e.memberLabel)
          ? resueltos.get(e.memberLabel)
          : (decidido === undefined ? miembros.get(k) : decidido);

        if (!memberId) {
          const creado = store.actions.addMember({ name: String(e.memberLabel).trim().slice(0, 40) });
          memberId = creado?.id;
          if (!memberId) { resumen.skipped++; continue; }
          miembros.set(k, memberId);
          resumen.members++;
        }
        // Se recuerda la resolución de esta etiqueta para el resto de sus días.
        resueltos.set(e.memberLabel, memberId);

        // `blocks: null` = la entrada hereda el horario del catálogo (así un
        // cambio de horario del turno se refleja en todo el cuadrante).
        const aplicado = store.actions.setEntry({ memberId, date: e.date, typeId: tipo.id, blocks: null });
        if (aplicado) resumen.imported++;
        else resumen.skipped++;
      }
    });
  } catch (err) {
    resumen.reasons.push(`La importación falló a medias y se ha deshecho: ${err?.message || err}`);
    return resumen;
  }

  return resumen;
}
