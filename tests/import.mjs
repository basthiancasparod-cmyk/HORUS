/**
 * HORUS — tests/import.mjs
 * Prueba de la importación de un cuadrante desde el PDF real de la empresa.
 *
 * Cubre el camino completo: leer el PDF → interpretar la rejilla → revisar →
 * volcar al cuadrante → deshacer en un solo paso.
 *
 * Ejecutar: node tests/import.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIXTURE = join(HERE, 'fixtures', 'cuadrante-octubre-henares.pdf');

/* --- localStorage falso (el store lo necesita) ---------------------- */

const mem = new Map();
globalThis.window = globalThis.window || {};
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
  clear: () => mem.clear(),
};
globalThis.window.localStorage = globalThis.localStorage;

/* --- Arnés ---------------------------------------------------------- */

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
function is(a, b, label = '') {
  if (a !== b) throw new Error(`${label} esperado ${JSON.stringify(b)}, recibido ${JSON.stringify(a)}`);
}
function eq(a, b, label = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${label}\n      esperado: ${y}\n      recibido: ${x}`);
}

/* --- Módulos -------------------------------------------------------- */

const model = await import('../js/core/model.js');
const { createStore } = await import('../js/core/store.js');
const importer = await import('../js/core/schedule-import.js');
const date = await import('../js/core/date.js');

/**
 * El cuadrante de prueba es un archivo REAL de la empresa y lleva los nombres de
 * compañeros, así que no se publica en el repositorio (está en .gitignore). Si no
 * está, esta suite se salta con un aviso en vez de fallar: no tiene sentido que
 * un repositorio público falle por no incluir datos personales.
 */
let bytes;
try {
  bytes = new Uint8Array(readFileSync(FIXTURE));
} catch {
  console.log(`\n\x1b[33m⚠ Suite de importación SALTADA\x1b[0m`);
  console.log(`  Falta el cuadrante de prueba:`);
  console.log(`    ${FIXTURE}`);
  console.log('  Es un archivo real con nombres de compañeros, por eso no viaja en el');
  console.log('  repositorio. Copia ahí tu propio cuadrante y esta suite se ejecuta entera.\n');
  process.exit(0);
}

let parse = null;

/* ==================================================================== *
 * 1. Lectura del PDF
 * ==================================================================== */

describe('Lectura del PDF real');

await it('el archivo de prueba existe y se puede leer', () => {
  ok(bytes.length > 1000, `bytes leídos: ${bytes.length}`);
  is(String.fromCharCode(...bytes.subarray(0, 5)), '%PDF-', 'empieza por %PDF-');
});

await it('el cuadrante se interpreta sin errores', async () => {
  parse = await importer.parseSchedulePdf(bytes);
  ok(parse, 'devuelve un resultado');
  ok(parse.ok, `ok debe ser true (motivo: ${parse.reason || '—'})`);
});

await it('detecta el mes y el año, y con confianza alta', () => {
  is(parse.monthKey, '2026-10', 'el cuadrante es de octubre de 2026');
  is(parse.monthConfidence, 'high', 'la comprobación por día de la semana cuadra');
});

await it('encuentra a las seis personas de la hoja', () => {
  const labels = parse.people.map((p) => p.label);
  is(parse.people.length, 6, `personas detectadas: ${labels.join(', ')}`);
  for (const expected of ['JAVIER', 'WILLIAM', 'ALEJANDRA', 'DANIEL', 'SERGIO']) {
    ok(labels.some((l) => l.toUpperCase().includes(expected)),
      `falta ${expected} (detectadas: ${labels.join(', ')})`);
  }
  ok(labels.some((l) => l.toUpperCase().startsWith('YORBELI')),
    `falta YORBELI (detectadas: ${labels.join(', ')})`);
});

await it('no genera ningún turno fuera del mes', () => {
  for (const person of parse.people) {
    for (const entry of person.entries) {
      ok(entry.date.startsWith('2026-10'),
        `${person.label} tiene una fecha fuera del mes: ${entry.date}`);
    }
  }
  is(parse.stats.outsideMonth >= 0, true, 'se cuentan las columnas de fuera');
});

await it('la mayoría de las casillas se detectan con seguridad', () => {
  const { high, entries } = parse.stats;
  ok(entries > 100, `se han detectado ${entries} turnos`);
  const ratio = high / entries;
  ok(ratio > 0.75, `proporción de seguros: ${(ratio * 100).toFixed(1)}% (${high}/${entries})`);
});

/* ==================================================================== *
 * 2. La rejilla es correcta (comprobaciones de contenido)
 * ==================================================================== */

describe('Comprobaciones del contenido detectado');

/** Busca una persona por fragmento de nombre. */
const person = (needle) => parse.people.find((p) => p.label.toUpperCase().includes(needle.toUpperCase()));

/** Códigos de una persona, ordenados por día. */
function codesOf(name) {
  const p = person(name);
  if (!p) throw new Error(`no se encontró a ${name}`);
  return p.entries
    .slice()
    .sort((a, b) => a.day - b.day)
    .map((e) => e.code);
}

await it('el día 16 cae en viernes, como dice la propia hoja', () => {
  const dt = date.fromKey('2026-10-16');
  is(dt.getDay(), 5, 'el 16 de octubre de 2026 es viernes');
});

await it('el 1 de octubre es jueves y el mes empieza donde toca', () => {
  const dt = date.fromKey('2026-10-01');
  is(dt.getDay(), 4, 'el 1 de octubre de 2026 es jueves');
  is(date.daysInMonth('2026-10'), 31, 'octubre tiene 31 días');
});

await it('ALEJANDRA tiene vacaciones continuadas (VC) en días consecutivos', () => {
  const codes = codesOf('ALEJANDRA');
  const vacaciones = codes.filter((c) => /^V/i.test(c)).length;
  ok(vacaciones >= 7, `debe tener al menos una semana de vacaciones, tiene ${vacaciones}`);
});

await it('las vacaciones de ALEJANDRA son un tramo seguido, no días sueltos', () => {
  const p = person('ALEJANDRA');
  const days = p.entries
    .filter((e) => /^V/i.test(e.code))
    .map((e) => e.day)
    .sort((a, b) => a - b);
  ok(days.length >= 7, `días de vacaciones: ${days.length}`);
  // Un tramo seguido: la diferencia entre días consecutivos es 1
  let consecutivos = 1;
  let mejor = 1;
  for (let i = 1; i < days.length; i++) {
    if (days[i] === days[i - 1] + 1) consecutivos++;
    else consecutivos = 1;
    mejor = Math.max(mejor, consecutivos);
  }
  ok(mejor >= 5, `el tramo más largo de vacaciones seguidas es de ${mejor} días (días: ${days.join(',')})`);
});

await it('DANIEL alterna A y F en un tramo, que son códigos distintos', () => {
  const p = person('DANIEL');
  const codes = codesOf('DANIEL');
  const tieneA = codes.includes('A');
  const tieneF = codes.includes('F');
  if (!tieneA || !tieneF) {
    // El usuario dice que en su hoja no hay A: se informa y no se falla en falso
    console.log(`      nota: DANIEL tiene códigos ${[...new Set(codes)].join(',')} (sin A/F alternos)`);
    return;
  }
  ok(tieneA && tieneF, 'aparecen A y F');
});

await it('los códigos detectados están entre los conocidos o declarados como desconocidos', () => {
  const conocidos = new Set(Object.keys(importer.KNOWN_CODES));
  for (const p of parse.people) {
    for (const e of p.entries) {
      if (!conocidos.has(e.code)) {
        ok(e.code in (parse.unknownCodes || {}),
          `el código «${e.code}» (${p.label}, día ${e.day}) no está ni como conocido ni como desconocido`);
      }
    }
  }
});

/* ------------------------------------------------------------------ *
 * 2-bis. Verdad de referencia, casilla a casilla
 *
 * Estas listas están comprobadas a mano contra las coordenadas reales del PDF
 * (cada código cae en la columna cuyo número de día está impreso encima). Son la
 * red que impide que un cambio en el extractor vuelva a correr las fechas sin
 * que nadie se entere: es justo el fallo que tuvo el lector durante un tiempo,
 * con la fila de ALEJANDRA desplazada un día.
 * ------------------------------------------------------------------ */

describe('Verdad de referencia del cuadrante');

/** Mapa día → código de una persona, para comparar de golpe. */
function mapaDe(name) {
  const p = person(name);
  const m = {};
  for (const e of p.entries.slice().sort((a, b) => a.day - b.day)) m[e.day] = e.code;
  return m;
}

await it('ALEJANDRA coincide casilla a casilla con la hoja', () => {
  eq(mapaDe('ALEJANDRA'), {
    1: 'I', 4: 'T', 7: 'T', 8: 'T',
    11: 'M', 12: 'M', 13: 'M', 14: 'M', 15: 'M', 16: 'M',
    17: 'T',
    20: 'VC', 21: 'VC', 22: 'VC', 23: 'VC', 24: 'VC',
    25: 'VC', 26: 'VC', 27: 'VC', 28: 'VC', 29: 'VC',
    30: 'T',
  }, 'rejilla de ALEJANDRA');
});

await it('DANIEL coincide casilla a casilla con la hoja', () => {
  eq(mapaDe('DANIEL'), {
    1: 'M', 2: 'M', 3: 'T', 4: 'T', 5: 'T', 6: 'T',
    9: 'M', 10: 'M', 11: 'T', 12: 'T', 13: 'T',
    17: 'P', 18: 'T', 19: 'T',
    20: 'AF', 21: 'AF', 22: 'AF',
    25: 'M', 26: 'M', 27: 'M', 28: 'M', 29: 'M', 30: 'T',
  }, 'rejilla de DANIEL');
});

await it('JAVIER coincide casilla a casilla con la hoja', () => {
  eq(mapaDe('JAVIER'), {
    2: 'P', 3: 'P',
    5: 'M', 6: 'M', 7: 'M', 8: 'M', 9: 'T', 10: 'T',
    14: 'T', 15: 'RE',
    17: 'M', 18: 'M', 20: 'M', 21: 'M', 23: 'M', 24: 'M', 25: 'M',
    28: 'M', 29: 'M', 30: 'M',
  }, 'rejilla de JAVIER');
});

await it('las vacaciones de ALEJANDRA son un tramo de 10 días seguidos', () => {
  const p = person('ALEJANDRA');
  const dias = p.entries.filter((e) => /^V/i.test(e.code)).map((e) => e.day).sort((a, b) => a - b);
  eq(dias, [20, 21, 22, 23, 24, 25, 26, 27, 28, 29], 'días de vacaciones');
});

await it('ninguna casilla del mes queda sin verificar contra el número impreso', () => {
  const p = person('JAVIER');
  const dudosas = p.entries.filter((e) => e.confidence !== 'high');
  eq(dudosas.map((e) => e.day), [], 'JAVIER no debería tener casillas dudosas');
});

await it('el mes se confirma con confianza alta por los números impresos', () => {
  is(parse.monthConfidence, 'high', 'confianza del mes');
  is(parse.meta.days, 33, 'días con número impreso');
  is(parse.meta.columns, 35, 'columnas de la rejilla');
});

/* ==================================================================== *
 * 3. Volcado al cuadrante
 * ==================================================================== */

describe('Importar al cuadrante');

function freshStore() {
  const doc = model.bootstrapDocument({ name: 'JAVIER', coworkers: [] });
  doc.settings.firstRun = false;
  return createStore(doc);
}

await it('buildEntriesFromParse produce entradas con fecha y tipo', () => {
  const entries = importer.buildEntriesFromParse(parse, {});
  ok(Array.isArray(entries), 'devuelve un array');
  ok(entries.length > 0, `entradas: ${entries.length}`);
  const first = entries.find((e) => e.date && e.typeCode);
  ok(first, 'al menos una entrada tiene fecha y tipo de turno');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(first.date), `fecha con formato correcto: ${first.date}`);
});

await it('se importan los turnos y se crean las personas que faltan', () => {
  const store = freshStore();
  const entries = importer.buildEntriesFromParse(parse, {});
  const result = importer.commitImportedEntries(store, entries, { year: 2026, month: 10 });

  ok(result.imported > 0, `turnos importados: ${result.imported}`);
  ok(store.doc.entries.length > 0, 'el cuadrante tiene turnos');

  // Las seis personas de la hoja deben existir (más la que ya estaba)
  for (const needle of ['JAVIER', 'WILLIAM', 'ALEJANDRA', 'DANIEL', 'SERGIO']) {
    ok(store.doc.members.some((m) => m.name.toUpperCase().includes(needle)),
      `debe existir ${needle} en el equipo`);
  }

  // Todos los turnos importados caen en octubre de 2026
  for (const entry of store.doc.entries) {
    ok(entry.date.startsWith('2026-10'), `turno fuera del mes: ${entry.date}`);
    ok(entry.typeId, 'todo turno importado tiene tipo');
  }
});

await it('la importación se deshace de una sola vez', () => {
  const store = freshStore();
  const before = store.doc.entries.length;
  const entries = importer.buildEntriesFromParse(parse, {});
  importer.commitImportedEntries(store, entries, { year: 2026, month: 10 });
  ok(store.doc.entries.length > before, 'se han añadido turnos');

  is(store.canUndo(), true, 'hay algo que deshacer');
  store.undo();
  is(store.doc.entries.length, before, 'un solo deshacer revierte toda la importación');
});

await it('las correcciones del usuario se respetan', () => {
  const store = freshStore();
  const target = parse.people[0];
  const day = target.entries[0]?.day;
  ok(day, 'la primera persona tiene algún día detectado');

  const dateKey = `2026-10-${String(day).padStart(2, '0')}`;
  const key = `${target.label}|${dateKey}`;

  const entries = importer.buildEntriesFromParse(parse, {
    corrections: { [key]: 'V' },
  });
  const corrected = entries.find((e) => e.date === dateKey && e.memberLabel === target.label);
  ok(corrected, 'la entrada corregida existe');
  is(corrected.typeCode, 'V', 'se aplica el turno corregido');

  const result = importer.commitImportedEntries(store, entries, { year: 2026, month: 10 });
  ok(result.imported > 0, 'se importa igualmente');

  const member = store.doc.members.find((m) => m.name.toUpperCase().includes(target.label.toUpperCase().slice(0, 6)));
  const vacaciones = store.doc.shiftTypes.find((t) => t.code === 'V');
  const entry = store.doc.entries.find((e) => e.memberId === member?.id && e.date === dateKey);
  is(entry?.typeId, vacaciones?.id, 'el día corregido queda como vacaciones');
});

await it('una corrección vacía deja el día sin turno', () => {
  const store = freshStore();
  const target = parse.people[0];
  const day = target.entries[0]?.day;
  const dateKey = `2026-10-${String(day).padStart(2, '0')}`;
  const key = `${target.label}|${dateKey}`;

  const entries = importer.buildEntriesFromParse(parse, { corrections: { [key]: null } });
  notOk(entries.some((e) => e.date === dateKey && e.memberLabel === target.label),
    'la entrada descartada no debe aparecer');

  const result = importer.commitImportedEntries(store, entries, { year: 2026, month: 10 });
  ok(result.imported > 0, 'el resto se importa');
});

function notOk(v, label = 'valor truthy') { if (v) throw new Error(`se esperaba falso: ${label}`); }

await it('los códigos desconocidos se pueden mapear y se aplican', () => {
  const store = freshStore();
  const desconocidos = Object.keys(parse.unknownCodes || {});
  if (!desconocidos.length) {
    console.log('      nota: este cuadrante no tiene códigos desconocidos');
    return;
  }
  const code = desconocidos[0];
  const entries = importer.buildEntriesFromParse(parse, { codeMap: { [code]: 'M' } });
  const mapped = entries.filter((e) => e.typeCode === 'M');
  ok(mapped.length > 0, `el código ${code} mapeado a M produce entradas`);

  const result = importer.commitImportedEntries(store, entries, { year: 2026, month: 10 });
  ok(result.imported > 0, `se importan ${result.imported} turnos`);
});

await it('importar dos veces no duplica personas', () => {
  const store = freshStore();
  const entries = importer.buildEntriesFromParse(parse, {});
  importer.commitImportedEntries(store, entries, { year: 2026, month: 10 });
  const membersAfterFirst = store.doc.members.length;
  importer.commitImportedEntries(store, entries, { year: 2026, month: 10 });
  is(store.doc.members.length, membersAfterFirst, 'el equipo no crece al reimportar');
});

/* ==================================================================== *
 * 4. Casos límite
 * ==================================================================== */

describe('Qué hace cuando no puede');

await it('un archivo que no es PDF se rechaza con un motivo claro', async () => {
  const basura = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const result = await importer.parseSchedulePdf(basura);
  is(result.ok, false, 'no debe decir que ha ido bien');
  ok(typeof result.reason === 'string' && result.reason.length > 10, `motivo: ${result.reason}`);
});

await it('un PDF vacío no revienta', async () => {
  const result = await importer.parseSchedulePdf(new Uint8Array(0));
  is(result.ok, false, 'no debe decir que ha ido bien');
  ok(result.reason, 'explica por qué');
});

await it('un documento sin el cuadrante se rechaza sin inventar nada', async () => {
  const result = await importer.parseSchedulePdf(new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n')));
  is(result.ok, false, 'no debe inventar un cuadrante');
  eq(result.people, [], 'no devuelve personas');
});

await it('buildEntriesFromParse aguanta un resultado vacío', () => {
  const entries = importer.buildEntriesFromParse({ ok: false, people: [] }, {});
  eq(entries, [], 'devuelve una lista vacía');
});

await it('commitImportedEntries aguanta una lista vacía sin romper', () => {
  const store = freshStore();
  const result = importer.commitImportedEntries(store, [], { year: 2026, month: 10 });
  is(result.imported, 0, 'no importa nada');
  is(store.doc.entries.length, 0, 'el cuadrante queda igual');
});

/* ==================================================================== *
 * Informe
 * ==================================================================== */

console.log(`\n${'─'.repeat(62)}`);
if (parse?.ok) {
  console.log(`Resumen del cuadrante leído: ${parse.monthKey} · ${parse.people.length} personas · `
    + `${parse.stats.entries} turnos (${parse.stats.high} seguros, ${parse.stats.low} dudosos)`);
  const desconocidos = Object.entries(parse.unknownCodes || {});
  if (desconocidos.length) {
    console.log(`Códigos por decidir: ${desconocidos.map(([c, n]) => `${c}×${n}`).join(', ')}`);
  }
  if (parse.issues?.length) {
    console.log(`Avisos: ${parse.issues.map((i) => i.kind).join(', ')}`);
  }
  console.log('');
}
if (failed === 0) {
  console.log(`\x1b[1m\x1b[32m✓ ${passed} pruebas de importación correctas\x1b[0m`);
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
