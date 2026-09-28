/**
 * HORUS — tests/io.js
 * Pruebas de exportación/importación (JSON, CSV, iCal, texto), del motor de
 * sincronización (con un Supabase falso, sin red) y de las alarmas.
 *
 * Ejecutar: node tests/io.js
 */

/* --- localStorage falso, antes de cualquier import ------------------- */

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
globalThis.window.location = { href: 'https://example.test/horus/', pathname: '/horus/', search: '', hash: '' };
globalThis.window.history = { replaceState() {} };
// Node ya define `navigator` como accesorio de solo lectura: se redefine la
// propiedad `onLine` en lugar de sustituir el objeto entero.
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true, writable: true });
globalThis.document = globalThis.document || {
  addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
};

let passed = 0;
let failed = 0;
const failures = [];
let suiteName = '';

function suite(name) { suiteName = name; console.log(`\n\x1b[1m\x1b[36m${name}\x1b[0m`); }
function test(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') throw new Error('la prueba devolvió una promesa; usa testAsync');
    passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++; failures.push({ suite: suiteName, name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${err.message.split('\n').join('\n      ')}\x1b[0m`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++; failures.push({ suite: suiteName, name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${err.message.split('\n').join('\n      ')}\x1b[0m`);
  }
}
function eq(a, b, label = '') {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${label}\n      esperado: ${y}\n      recibido: ${x}`);
}
function is(a, b, label = '') {
  if (a !== b) throw new Error(`${label} esperado ${JSON.stringify(b)}, recibido ${JSON.stringify(a)}`);
}
function ok(v, label = 'valor falsy') { if (!v) throw new Error(`se esperaba verdadero: ${label}`); }
function notOk(v, label = 'valor truthy') { if (v) throw new Error(`se esperaba falso: ${label}`); }
function close(a, b, tol = 1e-6, label = '') {
  if (Math.abs(a - b) > tol) throw new Error(`${label} esperado ~${b}, recibido ${a}`);
}
function includes(haystack, needle, label = '') {
  if (!String(haystack).includes(needle)) throw new Error(`${label}\n      no contiene: ${needle}`);
}

/* --- imports --------------------------------------------------------- */

const date = await import('../js/core/date.js');
const model = await import('../js/core/model.js');
const coverage = await import('../js/core/coverage.js');
const exporter = await import('../js/core/exporter.js');
const syncMod = await import('../js/core/sync.js');
const reminders = await import('../js/core/reminders.js');
const storage = await import('../js/core/storage.js');
const { createStore } = await import('../js/core/store.js');

/* --- fixtures -------------------------------------------------------- */

/** uuid de equipo para las pruebas de ámbito (el servidor exige uuid). */
const TEAM_ID = '11111111-2222-3333-4444-555555555555';

function teamDoc() {
  const doc = model.bootstrapDocument({ name: 'Ana Ruiz', coworkers: ['Luis Peña', 'Eva Moral'] });
  const [ana, luis, eva] = doc.members;
  const M = doc.shiftTypes.find((s) => s.code === 'M');
  const T = doc.shiftTypes.find((s) => s.code === 'T');
  const N = doc.shiftTypes.find((s) => s.code === 'N');
  const V = doc.shiftTypes.find((s) => s.code === 'V');
  doc.entries = [
    model.createEntry({ id: 'e1', memberId: ana.id, date: '2025-06-02', typeId: M.id, notes: 'Llevar llaves' }),
    model.createEntry({ id: 'e2', memberId: luis.id, date: '2025-06-02', typeId: T.id }),
    model.createEntry({ id: 'e3', memberId: ana.id, date: '2025-06-03', typeId: N.id }),
    model.createEntry({ id: 'e4', memberId: eva.id, date: '2025-06-04', typeId: V.id }),
    model.createEntry({ id: 'e5', memberId: luis.id, date: '2025-06-05', typeId: M.id, blocks: [{ start: '10:00', end: '14:00' }, { start: '16:00', end: '20:00' }] }),
  ];
  doc.dayMeta['2025-06-06'] = model.normalizeDayMeta({ dayType: 'holiday', label: 'Corpus' });
  return doc;
}

/** El mismo cuadrante, pero en el ámbito de un equipo. */
function teamScopedDoc(teamId = TEAM_ID) {
  const doc = teamDoc();
  doc.teamId = teamId;
  return doc;
}

/**
 * Envejece todas las marcas de un documento. Sirve para simular un cuadrante
 * que se subió al equipo hace un rato: así sus `updated_at` del servidor son
 * MÁS ANTIGUOS que la marca de agua de un dispositivo que sincroniza ahora.
 */
function envejecer(doc, ms = 3600000) {
  const t = Date.now() - ms;
  for (const m of doc.members) { m.createdAt = t; m.updatedAt = t; }
  for (const s of doc.shiftTypes) { s.createdAt = t; s.updatedAt = t; }
  for (const e of doc.entries) { e.createdAt = t; e.updatedAt = t; }
  for (const p of doc.patterns) { p.createdAt = t; p.updatedAt = t; }
  for (const meta of Object.values(doc.dayMeta || {})) meta.updatedAt = t;
  doc.updatedAt = t;
  return doc;
}

/* ================================================================== *
 * JSON
 * ================================================================== */

suite('exporter.js — copia de seguridad JSON');

test('la copia incluye metadatos y el documento', () => {
  const doc = teamDoc();
  const wrapper = exporter.documentToBackup(doc);
  is(wrapper.format, 'horus.backup');
  is(wrapper.schema, 4);
  ok(wrapper.exportedAt);
  is(wrapper.counts.entries, 5);
  is(wrapper.counts.members, 3);
  is(wrapper.counts.shiftTypes, doc.shiftTypes.length);
  is(wrapper.counts.dayMeta, 1);
});

test('ida y vuelta exacta', () => {
  const doc = teamDoc();
  const { doc: restored, kind } = exporter.parseBackup(exporter.backupToJson(doc));
  is(kind, 'backup');
  is(restored.entries.length, 5);
  is(restored.members.length, 3);
  is(restored.members[0].name, 'Ana Ruiz');
  is(restored.entries.find((e) => e.id === 'e1').notes, 'Llevar llaves');
  is(restored.entries.find((e) => e.id === 'e5').blocks.length, 2);
  is(restored.dayMeta['2025-06-06'].label, 'Corpus');
  eq(restored.entries.map((e) => e.id).sort(), ['e1', 'e2', 'e3', 'e4', 'e5']);
});

test('acepta un documento suelto sin envoltorio', () => {
  const doc = teamDoc();
  const { doc: restored, kind } = exporter.parseBackup(JSON.stringify(doc));
  is(kind, 'document');
  is(restored.entries.length, 5);
});

test('acepta y convierte un archivo de la versión antigua', () => {
  const legacy = {
    activeProfile: 'Javier',
    profiles: ['Javier', 'Alejandra'],
    shiftTypes: { M: { code: 'M', label: 'Mañana', hex: '#F2A33C', blocks: [{ start: '08:30', end: '17:00' }] } },
    days: { '2025-06-02': { sc: 'M', dt: 'normal', notes: '' } },
    settings: { notificationsEnabled: true, alarmMinutesBefore: 15 },
    onboardingDone: true,
  };
  const { doc, kind, warnings } = exporter.parseBackup(JSON.stringify(legacy));
  is(kind, 'legacy');
  is(doc.entries.length, 1);
  is(doc.members.length, 2);
  is(doc.settings.notifications.minutesBefore, 15);
  ok(warnings.some((w) => /versión antigua/i.test(w)), 'avisa de la conversión');
});

test('rechaza basura con un mensaje claro', () => {
  is(exporter.parseBackup('{no json').kind, 'invalid');
  ok(exporter.parseBackup('{no json').error);
  is(exporter.parseBackup('').kind, 'invalid');
  is(exporter.parseBackup('[]').kind, 'invalid');
  is(exporter.parseBackup('{"foo":1}').kind, 'invalid');
  is(exporter.parseBackup('null').kind, 'invalid');
});

test('avisa si la copia es de una versión más nueva', () => {
  const doc = teamDoc();
  const wrapper = exporter.documentToBackup(doc);
  wrapper.schema = 99;
  const { warnings } = exporter.parseBackup(JSON.stringify(wrapper));
  ok(warnings.some((w) => /versión más nueva/i.test(w)));
});

/* ================================================================== *
 * CSV
 * ================================================================== */

suite('exporter.js — CSV');

test('el CSV de un mes tiene cabecera y una fila por turno', () => {
  const doc = teamDoc();
  const csv = exporter.monthToCSV(doc, '2025-06');
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  includes(lines[0], 'Fecha;Día;Persona;Turno', 'cabecera');
  is(lines.length, 6, 'cabecera + 5 turnos');
  includes(csv, 'Ana Ruiz');
  includes(csv, 'Llevar llaves');
});

test('el CSV usa punto y coma y BOM para Excel en español', () => {
  const csv = exporter.monthToCSV(teamDoc(), '2025-06');
  is(csv.charCodeAt(0), 0xFEFF, 'empieza con BOM');
  includes(csv.split('\r\n')[0], ';');
});

test('el CSV calcula las horas por turno', () => {
  const doc = teamDoc();
  const csv = exporter.monthToCSV(doc, '2025-06');
  includes(csv, '8,50', 'la mañana son 8,5 h');
  // Eva está de vacaciones: 0 horas pero sí aparece
  const evaLine = csv.split('\r\n').find((l) => l.includes('Eva Moral'));
  ok(evaLine, 'Eva aparece en el CSV');
  includes(evaLine, 'Vacaciones');
});

test('se puede filtrar el CSV por personas', () => {
  const doc = teamDoc();
  const csv = exporter.monthToCSV(doc, '2025-06', { memberIds: [doc.members[0].id] });
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  is(lines.length, 3, 'cabecera + 2 turnos de Ana');
  notOk(csv.includes('Luis Peña'));
});

test('el resumen de horas cuadra con el motor de cobertura', () => {
  const doc = teamDoc();
  const csv = exporter.summaryToCSV(doc, '2025-06-01', '2025-06-30');
  const summary = coverage.summarize(doc, { from: '2025-06-01', to: '2025-06-30' });
  includes(csv, 'Horas totales');
  includes(csv, 'Horas nocturnas');
  includes(csv, 'TOTAL EQUIPO');
  includes(csv, (summary.totalMinutes / 60).toFixed(2).replace('.', ','), 'el total del equipo');
  // La noche de Ana (22:00-06:00) son 8 h nocturnas
  const anaLine = csv.split('\r\n').find((l) => l.startsWith('Ana Ruiz'));
  includes(anaLine, '8,00', 'horas nocturnas de Ana');
});

suite('exporter.js — importar CSV');

test('acepta fechas en varios formatos', () => {
  is(exporter.normalizeDateInput('2025-06-04'), '2025-06-04');
  is(exporter.normalizeDateInput('04/06/2025'), '2025-06-04');
  is(exporter.normalizeDateInput('4-6-2025'), '2025-06-04');
  is(exporter.normalizeDateInput('04.06.25'), '2025-06-04');
  is(exporter.normalizeDateInput('2025-02-31'), null, 'fecha imposible');
  is(exporter.normalizeDateInput('32/01/2025'), null);
  is(exporter.normalizeDateInput('hola'), null);
});

test('lee un CSV de turnos con cabeceras flexibles', () => {
  const csv = 'Persona;Fecha;Turno;Notas\nAna Ruiz;04/06/2025;M;Entra antes\nLuis Peña;2025-06-05;T;';
  const { rows, errors } = exporter.parseScheduleCSV(csv);
  is(rows.length, 2);
  is(errors.length, 0);
  is(rows[0].date, '2025-06-04');
  is(rows[0].person, 'Ana Ruiz');
  is(rows[0].code, 'M');
  is(rows[0].notes, 'Entra antes');
  is(rows[1].date, '2025-06-05');
});

test('acepta otros nombres de columna y detecta la coma', () => {
  const csv = 'nombre,fecha,codigo\nAna,2025-06-04,M\nLuis,2025-06-05,T';
  const { rows } = exporter.parseScheduleCSV(csv);
  is(rows.length, 2);
  is(rows[0].person, 'Ana');
});

test('informa de las filas malas sin abortar el resto', () => {
  const csv = 'Persona;Fecha;Turno\nAna;04/06/2025;M\n;2025-06-05;T\nLuis;32/01/2025;N\nEva;2025-06-07;M';
  const { rows, errors } = exporter.parseScheduleCSV(csv);
  is(rows.length, 2, 'solo se importan las filas válidas');
  is(errors.length, 2);
  ok(errors[0].includes('falta el nombre'), errors[0]);
  ok(errors[1].includes('no se entiende'), errors[1]);
});

test('un CSV vacío no rompe', () => {
  const { rows, errors } = exporter.parseScheduleCSV('');
  is(rows.length, 0);
  ok(errors.length >= 1);
});

/* ================================================================== *
 * iCal
 * ================================================================== */

suite('exporter.js — iCal');

test('el calendario tiene la estructura mínima válida', () => {
  const doc = teamDoc();
  const ics = exporter.monthToICal(doc, '2025-06');
  const lines = ics.split('\r\n');
  is(lines[0], 'BEGIN:VCALENDAR');
  is(lines[1], 'VERSION:2.0');
  ok(lines.some((l) => l.startsWith('PRODID:')));
  ok(lines.includes('END:VCALENDAR'));
  is(lines.filter((l) => l === 'BEGIN:VEVENT').length, lines.filter((l) => l === 'END:VEVENT').length, 'VEVENT equilibrados');
  ok(ics.endsWith('\r\n'), 'termina con CRLF');
});

test('un turno nocturno termina al día siguiente', () => {
  const doc = teamDoc();
  const ics = exporter.monthToICal(doc, '2025-06', { alarms: false });
  // La noche del 3 de junio: 22:00 → 06:00 del día 4
  includes(ics, 'DTSTART:20250603T220000');
  includes(ics, 'DTEND:20250604T060000');
});

test('un turno partido genera dos eventos', () => {
  const doc = teamDoc();
  const ics = exporter.monthToICal(doc, '2025-06', { alarms: false });
  includes(ics, 'DTSTART:20250605T100000');
  includes(ics, 'DTEND:20250605T140000');
  includes(ics, 'DTSTART:20250605T160000');
  includes(ics, 'DTEND:20250605T200000');
  includes(ics, 'UID:horus-e5-0@horus');
  includes(ics, 'UID:horus-e5-1@horus');
});

test('incluye alarmas cuando se piden', () => {
  const doc = teamDoc();
  const withAlarms = exporter.monthToICal(doc, '2025-06', { alarms: true, alarmMinutes: 45 });
  includes(withAlarms, 'BEGIN:VALARM');
  includes(withAlarms, 'TRIGGER:-PT45M');
  const without = exporter.monthToICal(doc, '2025-06', { alarms: false });
  notOk(without.includes('BEGIN:VALARM'));
});

test('el festivo sale como evento de día completo', () => {
  const doc = teamDoc();
  const ics = exporter.monthToICal(doc, '2025-06', { alarms: false });
  includes(ics, 'DTSTART;VALUE=DATE:20250606');
  includes(ics, 'DTEND;VALUE=DATE:20250607');
  includes(ics, 'SUMMARY:Corpus');
});

test('escapa los caracteres especiales de iCal', () => {
  const doc = teamDoc();
  doc.entries[0].notes = 'Comprar pan; leche, y café\nsegunda línea';
  const ics = exporter.monthToICal(doc, '2025-06', { alarms: false });
  includes(ics, 'Comprar pan\\; leche\\, y café\\nsegunda línea');
});

test('no pliega mal las líneas largas', () => {
  const doc = teamDoc();
  const ics = exporter.monthToICal(doc, '2025-06', { alarms: false });
  for (const line of ics.split('\r\n')) {
    if (line.length > 75) throw new Error(`línea demasiado larga (${line.length}): ${line.slice(0, 90)}…`);
  }
});

test('filtra por persona en el iCal', () => {
  const doc = teamDoc();
  const ics = exporter.monthToICal(doc, '2025-06', { memberIds: [doc.members[0].id], alarms: false });
  includes(ics, 'X-HORUS-MEMBER:Ana Ruiz');
  notOk(ics.includes('X-HORUS-MEMBER:Luis Peña'));
});

/* ================================================================== *
 * Texto
 * ================================================================== */

suite('exporter.js — texto para compartir');

test('el cuadrante de texto es legible', () => {
  const doc = teamDoc();
  const text = exporter.monthToText(doc, '2025-06');
  includes(text, 'Junio 2025');
  includes(text, 'Ana Ruiz');
  includes(text, '8:30-17:00');
  includes(text, 'Total del mes');
  includes(text, 'Equipo:');
});

test('marca los festivos y las notas', () => {
  const doc = teamDoc();
  const text = exporter.monthToText(doc, '2025-06');
  includes(text, 'Festivo');
  includes(text, 'Llevar llaves');
});

test('el detalle de un día es correcto', () => {
  const doc = teamDoc();
  const text = exporter.dayToText(doc, '2025-06-02');
  includes(text, 'Ana Ruiz');
  includes(text, 'Luis Peña');
  const vacio = exporter.dayToText(doc, '2025-06-20');
  includes(vacio, 'Sin turnos');
});

test('el informe de cobertura resume los huecos', () => {
  const doc = teamDoc();
  const text = exporter.monthCoverageToText(doc, '2025-06');
  includes(text, 'Cobertura de Junio 2025');
  includes(text, 'Días con huecos:');
  includes(text, 'Tiempo sin cubrir:');
  includes(text, 'Cobertura total:');
  includes(text, '%');
});

test('detecta solapamientos en el informe', () => {
  const doc = teamDoc();
  const ana = doc.members[0].id;
  const M = doc.shiftTypes.find((s) => s.code === 'M');
  doc.entries.push(model.createEntry({
    id: 'dup', memberId: ana, date: '2025-06-02', typeId: M.id,
    blocks: [{ start: '12:00', end: '20:00' }],
  }));
  const text = exporter.monthCoverageToText(doc, '2025-06');
  includes(text, 'solapamiento');
});

/* ================================================================== *
 * Huellas y sincronización
 * ================================================================== */

suite('sync.js — huellas y diferencias');

test('fingerprint es estable e insensible al orden de claves', () => {
  const a = syncMod.fingerprint({ x: 1, y: 'dos', z: [1, 2] });
  const b = syncMod.fingerprint({ z: [1, 2], y: 'dos', x: 1 });
  is(a, b, 'el orden de claves no importa');
  is(a, syncMod.fingerprint({ x: 1, y: 'dos', z: [1, 2] }), 'es determinista');
});

test('fingerprint detecta cambios reales', () => {
  const base = { name: 'Ana', role: 'member' };
  notOk(syncMod.fingerprint(base) === syncMod.fingerprint({ ...base, name: 'Ana ' }));
  notOk(syncMod.fingerprint(base) === syncMod.fingerprint({ ...base, role: 'admin' }));
  notOk(syncMod.fingerprint([1, 2]) === syncMod.fingerprint([2, 1]), 'el orden en arrays sí importa');
  is(syncMod.fingerprint({ a: undefined, b: 1 }), syncMod.fingerprint({ b: 1 }), 'undefined se ignora');
});

test('fingerprint aguanta estructuras raras', () => {
  is(typeof syncMod.fingerprint(null), 'string');
  is(typeof syncMod.fingerprint(undefined), 'string');
  is(typeof syncMod.fingerprint(NaN), 'string');
  const circular = { a: 1 };
  circular.self = circular;
  is(typeof syncMod.fingerprint(circular), 'string', 'no entra en bucle con referencias circulares');
});

/* ================================================================== *
 * Ámbito del documento (personal o equipo)
 * ================================================================== */

suite('model.js y sync.js — el ámbito del documento');

test('un documento sin teamId es personal (los documentos viejos no se rompen)', () => {
  is(model.normalizeDocument(model.emptyDocument()).teamId, null, 'un documento nuevo es personal');
  const antiguo = model.emptyDocument();
  delete antiguo.teamId;
  is(model.normalizeDocument(antiguo).teamId, null, 'sin el campo, personal');
  is(model.emptyDocument().teamId, null);
});

test('el id de equipo se normaliza y la basura no se cuela como ámbito', () => {
  is(model.normalizeDocument({ teamId: TEAM_ID }).teamId, TEAM_ID);
  is(model.normalizeDocument({ teamId: TEAM_ID.toUpperCase() }).teamId, TEAM_ID, 'en minúsculas, como el servidor');
  is(model.normalizeDocument({ teamId: 'no-es-un-uuid' }).teamId, null);
  is(model.normalizeTeamId(''), null);
  is(model.normalizeTeamId(null), null);
});

test('ownerKeyFor decide el ámbito a partir del documento y de la sesión', () => {
  is(syncMod.ownerKeyFor({ teamId: null }, 'u-1'), 'user:u-1', 'personal: el ámbito sale de la sesión');
  is(syncMod.ownerKeyFor({}, 'u-1'), 'user:u-1', 'sin campo, personal');
  is(syncMod.ownerKeyFor({ teamId: TEAM_ID }, 'u-1'), `team:${TEAM_ID}`, 'con equipo manda el equipo');
  is(syncMod.ownerKeyFor({ teamId: TEAM_ID }, null), `team:${TEAM_ID}`, 'el equipo no necesita sesión');
  is(syncMod.ownerKeyFor({ teamId: null }, null), null, 'sin sesión ni equipo no hay ámbito');
});

/* ------------------------------------------------------------------ *
 * Supabase falso: implementa lo justo del API REST que usa el motor
 *
 * Desde el esquema por ámbito (migración 0002) la clave de una fila es
 * (owner_key, id), así que aquí se guardan igual: con el MISMO id puede haber
 * una fila por ámbito, que es justo lo que hay que poder distinguir. El filtro
 * `owner_key` (y `user_id`, `updated_at`, `deleted`…) se aplica solo si la
 * consulta lo trae, como en PostgREST: si el motor se olvidara de filtrar por
 * ámbito, el falso tocaría las filas de los dos ámbitos y la prueba fallaría.
 * Lo que el falso NO simula es RLS: quien pregunta puede verlo todo.
 * ------------------------------------------------------------------ */

function createFakeSupabase() {
  const tables = new Map(); // tabla -> Map(clave (ámbito|id) -> fila)
  const calls = [];
  let failNext = null;

  const tableOf = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };

  const parseQuery = (url) => {
    const [path, query = ''] = String(url).split('?');
    const table = path.replace(/^.*\/rest\/v1\//, '');
    const params = new URLSearchParams(query);
    return { table, params };
  };

  const pkOf = (table) => (table === 'horus_day_meta' ? 'day_date' : 'id');

  /**
   * Ámbito de una fila, igual que el trigger del servidor: si la fila no trae
   * `owner_key`, sale de user_id (tablas del cuadrante), del id (horus_teams) o
   * del team_id (horus_team_members).
   */
  function scopeOfRow(table, row) {
    if (row.owner_key) return String(row.owner_key);
    if (table === 'horus_teams') return `team:${row.id}`;
    if (table === 'horus_team_members') return `team:${row.team_id}`;
    return `user:${row.user_id}`;
  }

  const rowKey = (table, row) => `${scopeOfRow(table, row)}|${row[pkOf(table)]}`;

  function parseInFilter(value) {
    if (!value || !value.startsWith('in.(')) return [];
    return value.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''));
  }

  /** Filtra como PostgREST: solo por los parámetros que vienen en la consulta. */
  function matchRows(table, params) {
    const pk = pkOf(table);
    let list = [...tableOf(table).values()];

    const inIds = parseInFilter(params.get(pk));
    if (inIds.length) list = list.filter((r) => inIds.includes(String(r[pk])));

    const owner = params.get('owner_key');
    if (owner?.startsWith('eq.')) {
      const want = owner.slice(3);
      list = list.filter((r) => scopeOfRow(table, r) === want);
    }

    const userId = params.get('user_id');
    if (userId?.startsWith('eq.')) {
      const want = userId.slice(3);
      list = list.filter((r) => String(r.user_id) === want);
    }

    const deletedFilter = params.get('deleted');
    if (deletedFilter?.startsWith('eq.')) {
      const want = deletedFilter.slice(3) === 'true';
      list = list.filter((r) => (r.deleted === true) === want);
    }

    // Marca de agua del servidor (`updated_at`), que es la que usa el motor.
    // Se admite `gte.` porque la consulta real pide el corte incluido.
    const porServidor = params.get('updated_at');
    if (porServidor?.startsWith('gte.')) {
      const corte = porServidor.slice(4);
      list = list.filter((r) => String(r.updated_at) >= corte);
    }

    const since = params.get('client_updated_at');
    if (since?.startsWith('gt.')) {
      const threshold = Number(since.slice(3)) || 0;
      list = list.filter((r) => (Number(r.client_updated_at) || 0) > threshold);
    }

    return list;
  }

  const fetchImpl = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const { table, params } = parseQuery(url);
    calls.push({ method, table, url: String(url), body: opts.body ? JSON.parse(opts.body) : null });

    if (failNext) {
      const err = failNext;
      failNext = null;
      return { ok: false, status: err.status || 500, statusText: 'Error', text: async () => JSON.stringify({ message: err.message }) };
    }

    if (method === 'POST') {
      const body = JSON.parse(opts.body);
      for (const row of body) {
        const scope = scopeOfRow(table, row);
        tableOf(table).set(`${scope}|${row[pkOf(table)]}`, {
          ...row,
          owner_key: scope,
          // `updated_at` del servidor se deriva de la marca del cliente para que
          // las marcas de agua del pull sean coherentes en las pruebas.
          updated_at: new Date(Number(row.client_updated_at) || Date.now()).toISOString(),
        });
      }
      return { ok: true, status: 201, headers: { get: () => null }, json: async () => body, text: async () => '' };
    }

    if (method === 'PATCH') {
      const body = JSON.parse(opts.body);
      for (const existing of matchRows(table, params)) {
        // El trigger del servidor prohíbe mover una fila de ámbito con un UPDATE.
        if (body.owner_key && body.owner_key !== scopeOfRow(table, existing)) {
          return {
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            text: async () => JSON.stringify({ message: 'HORUS: el ámbito de una fila (owner_key) no se puede cambiar por un UPDATE.' }),
          };
        }
        tableOf(table).set(rowKey(table, existing), {
          ...existing,
          ...body,
          updated_at: new Date(Number(body.client_updated_at) || Date.parse(body.updated_at) || Date.now()).toISOString(),
        });
      }
      return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
    }

    if (method === 'DELETE') {
      for (const row of matchRows(table, params)) tableOf(table).delete(rowKey(table, row));
      return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
    }

    // GET
    const list = matchRows(table, params)
      .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
    const contentRange = `0-${Math.max(0, list.length - 1)}/${list.length}`;
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-range' ? contentRange : null) },
      json: async () => list,
      text: async () => JSON.stringify(list),
    };
  };

  return {
    fetchImpl,
    tables,
    calls,
    failNextWith: (err) => { failNext = err; },
    count: (table) => tableOf(table).size,
    all: (table) => [...tableOf(table).values()],
    seed: (table, rows) => {
      for (const r of rows) {
        const scope = scopeOfRow(table, r);
        tableOf(table).set(`${scope}|${r[pkOf(table)]}`, { ...r, owner_key: scope });
      }
    },
    /**
     * Simula una edición hecha en otro dispositivo por `stamp`.
     * Las claves sueltas (`notes`, `blocks`, …) se aplican TANTO a las columnas
     * como al `payload`, que es lo que hace el servidor real al recibir una fila.
     * `ownerKey` hace falta cuando el mismo id existe en dos ámbitos.
     */
    remoteEdit(table, id, changes, stamp, ownerKey = null) {
      const pk = pkOf(table);
      const row = [...tableOf(table).values()].find((r) => String(r[pk]) === String(id)
        && (ownerKey == null || scopeOfRow(table, r) === ownerKey));
      if (!row) throw new Error(`no existe la fila ${table}/${id}${ownerKey ? ` en ${ownerKey}` : ''} en el servidor falso`);
      const payloadChanges = {};
      for (const [k, v] of Object.entries(changes)) {
        if (k === 'payload') continue;
        payloadChanges[k] = v;
      }
      Object.assign(payloadChanges, changes.payload || {});
      if (!('updatedAt' in payloadChanges)) payloadChanges.updatedAt = stamp;

      const next = {
        ...row,
        ...changes,
        payload: { ...row.payload, ...payloadChanges },
        // Se guarda la marca del cliente TAL CUAL, sin quedarse con la mayor: el
        // servidor real almacena lo que le mandan, y un dispositivo con el reloj
        // atrasado manda una marca más antigua.
        client_updated_at: Number(stamp) || 0,
        // `updated_at` lo pone el trigger del servidor, o sea SIEMPRE la hora de
        // ahora. Es lo que permite que una escritura con el reloj atrasado siga
        // siendo visible para la marca de agua del servidor.
        updated_at: new Date().toISOString(),
      };
      delete next.payload.deleted;
      tableOf(table).set(rowKey(table, next), next);
      return next;
    },
    /** Vacía el servidor falso para aislar una prueba. */
    reset() { tables.clear(); calls.length = 0; failNext = null; },
  };
}

/* ------------------------------------------------------------------ *
 * El motor usa authFetch; se sustituye globalThis.fetch y se activa una
 * sesión falsa antes de crearlo.
 * ------------------------------------------------------------------ */

const fake = createFakeSupabase();
// Guardia: si algo intentara salir a la red de verdad, la prueba debe fallar
// de forma ruidosa en vez de quedarse colgada o pasar en falso.
globalThis.fetch = async (url, opts) => {
  const target = String(url);
  if (!/supabase\.co|127\.0\.0\.1|localhost/.test(target)) {
    throw new Error(`¡Intento de salida a la red en una prueba!: ${target}`);
  }
  return fake.fetchImpl(target, opts);
};

const auth = await import('../js/core/auth.js');
storage.saveSession({ userId: 'u-1', email: 'ana@test', accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3600000 });
auth.restoreSession();

suite('sync.js — motor de sincronización (Supabase falso)');

/**
 * Crea un motor de sincronización sobre un store real, que es como lo usa la
 * aplicación: el documento que ve el motor siempre viene normalizado por el
 * store, y así el push y el pull calculan huellas sobre la misma forma.
 */
function engineFor(initialDoc) {
  const store = createStore(initialDoc);
  const history = [];
  const engine = syncMod.createSyncEngine({
    getDoc: () => store.doc,
    replaceDoc: (next, meta) => {
      history.push(meta?.label);
      store.replaceDocument(next, { label: meta?.label || 'sync', silent: true });
    },
    getAuthUserId: () => 'u-1',
  });
  return { engine, store, get: () => store.doc, history };
}

/** Escenario limpio: almacenamiento y servidor vacíos. */
function resetWorld() {
  mem.clear();
  fake.reset();
}

/**
 * Simula OTRO dispositivo: tira el estado de sincronización guardado, que es
 * lo único que dos navegadores distintos no comparten. Sin esto, el segundo
 * motor arrancaría con las marcas de agua y los ids del primero (sería el mismo
 * dispositivo con dos documentos, no dos dispositivos).
 */
function otroDispositivo() {
  syncMod.resetSyncState();
}

await testAsync('un documento nuevo se sube entero', async () => {
  resetWorld();
  const doc = teamDoc();
  const { engine } = engineFor(doc);
  const result = await engine.sync();
  is(result.pushed, 5 + 3 + doc.shiftTypes.length + 1, 'turnos + miembros + tipos + dayMeta');
  is(fake.count('horus_entries'), 5);
  is(fake.count('horus_members'), 3);
  is(fake.count('horus_shift_types'), doc.shiftTypes.length);
  is(fake.count('horus_day_meta'), 1);
  is(engine.status, 'idle');
});

await testAsync('no se reenvía nada si no hay cambios', async () => {
  resetWorld();
  const doc = teamDoc();
  const { engine } = engineFor(doc);
  await engine.sync();
  const before = fake.calls.filter((c) => c.method === 'POST').length;
  const result = await engine.sync();
  is(result.pushed, 0, 'el segundo sync no sube filas');
  is(fake.calls.filter((c) => c.method === 'POST').length, before, 'no hay POST nuevos');
});

await testAsync('solo se sube la fila que cambió', async () => {
  resetWorld();
  const doc = teamDoc();
  const { engine, store } = engineFor(doc);
  await engine.sync();
  const entry = store.doc.entries.find((e) => e.id === 'e1');
  store.actions.updateEntry(entry.id, { notes: 'Cambiado' });
  const result = await engine.sync();
  is(result.pushed, 1, 'exactamente una fila');
});

await testAsync('borrar un turno lo propaga como borrado lógico', async () => {
  resetWorld();
  const doc = teamDoc();
  const { engine, store } = engineFor(doc);
  await engine.sync();
  const entry = store.doc.entries.find((e) => e.id === 'e1');
  store.actions.removeEntries({ memberId: entry.memberId, date: entry.date });
  const result = await engine.sync();
  is(result.deleted, 1);
  is(fake.count('horus_entries'), 5, 'la fila sigue existiendo');
  const row = fake.all('horus_entries').find((r) => r.id === 'e1');
  is(row.deleted, true, 'marcada como borrada');
});

await testAsync('un turno borrado en otro dispositivo desaparece aquí', async () => {
  resetWorld();
  const doc = teamDoc();
  const { engine, store } = engineFor(doc);
  await engine.sync();
  fake.remoteEdit('horus_entries', 'e2', { deleted: true }, Date.now() + 60000);
  // Se baja sin subir antes: es lo que ocurre al abrir la app y recibir el
  // cambio de otro dispositivo sin haber tocado nada aquí.
  const result = await engine.pull();
  ok(result.applied >= 1, 'se aplica el borrado remoto');
  notOk(store.doc.entries.some((e) => e.id === 'e2'), 'el turno borrado se quita del cuadrante local');
  is(store.doc.entries.length, 4);
});

await testAsync('un cambio remoto se descarga al documento local', async () => {
  resetWorld();
  const doc = teamDoc();
  const { engine, store } = engineFor(doc);
  await engine.sync();
  const remoteStamp = Date.now() + 60000;
  fake.remoteEdit('horus_entries', 'e1', { notes: 'Nota puesta por el jefe' }, remoteStamp);
  const result = await engine.pull();
  ok(result.applied >= 1, 'algo se aplicó');
  is(result.conflicts.length, 0, 'sin edición local no hay conflicto');
  is(store.doc.entries.find((e) => e.id === 'e1').notes, 'Nota puesta por el jefe');
});

/**
 * EL FALLO QUE DEJABA A UN DISPOSITIVO SORDO.
 *
 * La marca de agua del pull era `client_updated_at`, o sea el reloj del otro
 * dispositivo, y encima se saltaba a `Date.now()` cuando la respuesta venía
 * vacía. Si el móvil va unos minutos por detrás de la PC, sus cambios nacen con
 * una marca ANTERIOR a la que la PC ya se había traído, así que la consulta los
 * ignoraba para siempre. El síntoma era «todo estaba al día» y los cambios del
 * móvil sin llegar nunca.
 */
/**
 * PENDIENTE (documentado, no resuelto): un cambio hecho en un dispositivo cuyo
 * reloj va ATRASADO puede seguir perdiéndose, porque la resolución de conflictos
 * compara `updatedAt`, que es la hora del cliente. La marca de agua ya usa la del
 * servidor (que era el fallo gordo: los cambios no llegaban NUNCA), pero mientras
 * el desempate dependa del reloj del dispositivo, un desfase grande sigue siendo
 * peligroso. El arreglo de verdad es desempatar con `updated_at` del servidor.
 */

await testAsync('un miembro borrado en otro dispositivo no resucita', async () => {
  resetWorld();
  const doc = teamDoc();
  const { engine, store } = engineFor(doc);
  await engine.sync();
  const luis = store.doc.members.find((m) => m.name === 'Luis Peña');
  store.actions.removeMember(luis.id);
  await engine.sync();
  is(fake.all('horus_members').find((r) => r.id === luis.id).deleted, true, 'queda marcado como borrado');
  // Un segundo ciclo no debe traerlo de vuelta desde el servidor
  await engine.pull();
  notOk(store.doc.members.some((m) => m.id === luis.id), 'no resucita al bajar cambios');
  is(store.doc.members.length, 2);
});

await testAsync('lo local no se pierde si el servidor va por detrás', async () => {
  resetWorld();
  const doc = teamDoc();
  const { engine, store } = engineFor(doc);
  await engine.sync();
  store.actions.updateEntry('e1', { notes: 'Mío más nuevo' });
  await engine.sync();
  is(store.doc.entries.find((e) => e.id === 'e1').notes, 'Mío más nuevo');
  const row = fake.all('horus_entries').find((r) => r.id === 'e1');
  is(row.notes, 'Mío más nuevo', 'y llegó al servidor');
});

await testAsync('un conflicto real se registra y se avisa, sin perder la nota local', async () => {
  resetWorld();
  const base = teamDoc();
  const { engine, store } = engineFor(base);
  const syncedAt = Date.now();
  await engine.sync();

  // El servidor cambia la fila…
  fake.remoteEdit('horus_entries', 'e1', { notes: 'Versión del servidor' }, syncedAt + 300000);
  // …y aquí también se cambia, pero con una marca MÁS ANTIGUA: pierde
  store.apply((d) => {
    const e = d.entries.find((x) => x.id === 'e1');
    e.notes = 'Versión local';
    e.updatedAt = syncedAt + 1000;
  }, { label: 'edición local' });

  const result = await engine.pull();
  ok(result.conflicts.length >= 1, 'se detecta el conflicto');
  is(result.conflicts[0].table, 'horus_entries');
  is(result.conflicts[0].id, 'e1');
  is(result.conflicts[0].resolution, 'remote', 'gana la marca más reciente');
  // La entidad adopta la versión del servidor COMPLETA (marca y contenido), sin
  // mezclas: un híbrido corrompería la siguiente subida.
  const merged = store.doc.entries.find((e) => e.id === 'e1');
  is(merged.updatedAt, syncedAt + 300000, 'adopta la marca del servidor');
  is(merged.notes, 'Versión del servidor', 'y su contenido');

  // …pero lo que había aquí NO se tira a la basura: queda en el registro de
  // conflictos para poder enseñárselo al usuario.
  const pending = engine.conflicts();
  is(pending.length, 1);
  is(pending[0].id, 'e1');
  is(pending[0].remote, syncedAt + 300000);
  is(pending[0].lost.notes, 'Versión local', 'se conserva la edición perdedora');

  engine.acknowledgeConflicts();
  is(engine.conflicts().length, 0, 'se pueden dar por revisados');
  // Y tras revisarlos, el ciclo siguiente queda limpio
  const after = await engine.sync();
  is(after.conflicts.length, 0, 'ya no se vuelve a avisar del mismo conflicto');
});

await testAsync('un conflicto no deja el documento en un estado híbrido', async () => {
  resetWorld();
  const { engine, store } = engineFor(teamDoc());
  const syncedAt = Date.now();
  await engine.sync();
  fake.remoteEdit('horus_entries', 'e1', { notes: 'Servidor' }, syncedAt + 300000);
  store.apply((d) => {
    const e = d.entries.find((x) => x.id === 'e1');
    e.notes = 'Local';
    e.updatedAt = syncedAt + 1000;
  }, { label: 'edición local' });
  await engine.pull();

  // Tras el pull, el estado local y el servidor deben coincidir: nada pendiente
  // y ningún reenvío fantasma en el siguiente ciclo.
  is(engine.pendingCount(), 0, 'no queda nada pendiente tras resolver el conflicto');
  const after = await engine.sync();
  is(after.pushed, 0, 'no se reenvía nada en el siguiente ciclo');
});

await testAsync('una edición local más reciente gana al servidor', async () => {
  resetWorld();
  const doc = teamDoc();
  const { engine, store } = engineFor(doc);
  const syncedAt = Date.now();
  await engine.sync();
  // El servidor cambia, pero aquí cambiamos DESPUÉS: debe ganar lo local
  fake.remoteEdit('horus_entries', 'e1', { notes: 'Del servidor' }, syncedAt + 1000);
  store.apply((d) => {
    const e = d.entries.find((x) => x.id === 'e1');
    e.notes = 'Mía y más nueva';
    e.updatedAt = syncedAt + 300000;
  }, { label: 'edición local' });

  await engine.pull();
  is(store.doc.entries.find((e) => e.id === 'e1').notes, 'Mía y más nueva', 'la local no se pisa');
  await engine.sync();
  const row = fake.all('horus_entries').find((r) => r.id === 'e1');
  is(row.notes, 'Mía y más nueva', 'y acaba llegando al servidor');
});

await testAsync('sin sesión no se intenta sincronizar', async () => {
  resetWorld();
  const saved = auth.currentSession();
  storage.saveSession(null);
  auth.restoreSession();
  const { engine } = engineFor(teamDoc());
  const result = await engine.sync();
  is(result.skipped, true);
  is(result.reason, 'no-session');
  storage.saveSession(saved);
  auth.restoreSession();
});

await testAsync('sin conexión se marca como offline y no se pierde nada', async () => {
  resetWorld();
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
  Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true, writable: true });
  const { engine } = engineFor(teamDoc());
  const result = await engine.sync();
  is(result.skipped, true);
  is(result.reason, 'offline');
  is(engine.status, 'offline');
  Object.defineProperty(globalThis.navigator, 'onLine', original);
});

await testAsync('un error del servidor no corrompe el estado local', async () => {
  resetWorld();
  const doc = teamDoc();
  const { engine, get } = engineFor(doc);
  fake.failNextWith({ status: 500, message: 'boom' });
  let threw = false;
  try { await engine.sync(); } catch { threw = true; }
  ok(threw, 'el error se propaga');
  is(engine.status, 'error');
  is(get().entries.length, 5, 'el documento local sigue intacto');
  const result = await engine.sync();
  ok(result.pushed > 0, 'se recupera en el siguiente intento');
  is(engine.status, 'idle');
});

await testAsync('pendingCount refleja lo que falta por subir', async () => {
  resetWorld();
  const doc = teamDoc();
  const { engine, store } = engineFor(doc);
  ok(engine.pendingCount() > 0, 'un documento nuevo tiene todo pendiente');
  await engine.sync();
  is(engine.pendingCount(), 0, 'tras sincronizar no queda nada');
  store.actions.updateEntry('e1', { notes: 'nuevo' });
  is(engine.pendingCount(), 1, 'un cambio deja una fila pendiente');
});

await testAsync('el estado de sincronización sobrevive a un motor nuevo', async () => {
  resetWorld();
  const doc = teamDoc();
  const { engine } = engineFor(doc);
  await engine.sync();
  is(engine.pendingCount(), 0, 'tras sincronizar no queda nada');

  // Un motor nuevo sobre el MISMO documento y el mismo almacenamiento simula
  // recargar la página: no debe reenviar todo otra vez.
  const { engine: engine2 } = engineFor(doc);
  is(engine2.pendingCount(), 0, 'reconoce lo ya sincronizado al recargar');
  const result = await engine2.sync();
  is(result.pushed, 0);
  is(result.deleted, 0);
});

await testAsync('los tipos de turno y las personas se suben antes que los turnos', async () => {
  resetWorld();
  const { engine } = engineFor(teamDoc());
  await engine.sync();
  const order = fake.calls.filter((c) => c.method === 'POST').map((c) => c.table);
  const firstEntries = order.indexOf('horus_entries');
  ok(order.indexOf('horus_shift_types') < firstEntries, 'los tipos van antes');
  ok(order.indexOf('horus_members') < firstEntries, 'las personas van antes');
});

/* ================================================================== *
 * Ámbitos: cuadrante personal y cuadrante de equipo
 * ================================================================== */

suite('sync.js — ámbitos (cuadrante de equipo)');

const TABLAS_CUADRANTE = ['horus_entries', 'horus_members', 'horus_shift_types', 'horus_day_meta'];

await testAsync('sin equipo, las filas se suben en el ámbito personal y con user_id', async () => {
  resetWorld();
  const { engine } = engineFor(teamDoc());
  await engine.sync();

  const filas = TABLAS_CUADRANTE.flatMap((t) => fake.all(t));
  ok(filas.length > 0, 'se subió algo');
  for (const fila of filas) {
    is(fila.owner_key, 'user:u-1', 'el ámbito personal sale de la sesión, no del documento');
    is(fila.user_id, 'u-1', 'user_id se sigue mandando: el trigger del servidor lo espera');
  }
  is(engine.state.ownerKey, 'user:u-1');
});

await testAsync('con equipo, las filas se suben en el ámbito del equipo', async () => {
  resetWorld();
  const { engine } = engineFor(teamScopedDoc());
  await engine.sync();

  for (const tabla of TABLAS_CUADRANTE) {
    const filas = fake.all(tabla);
    ok(filas.length > 0, `se subió ${tabla}`);
    for (const fila of filas) {
      is(fila.owner_key, `team:${TEAM_ID}`, `${tabla}: ámbito del equipo`);
      is(fila.user_id, 'u-1', 'el autor sigue siendo quien escribe');
    }
  }
  is(engine.state.ownerKey, `team:${TEAM_ID}`);
  is(fake.all('horus_entries').filter((r) => r.owner_key === 'user:u-1').length, 0, 'nada se fue al ámbito personal');
});

await testAsync('dos dispositivos del mismo equipo comparten el cuadrante', async () => {
  resetWorld();
  const a = engineFor(teamScopedDoc());
  await a.engine.sync();
  const turnosDeA = a.get().entries.map((e) => [e.id, e.memberId]);

  // El segundo dispositivo acaba de entrar en el equipo: apenas tiene su ficha.
  const bDoc = model.bootstrapDocument({ name: 'Luis Peña' });
  bDoc.teamId = TEAM_ID;
  otroDispositivo();
  const b = engineFor(bDoc);
  await b.engine.sync();

  ok(b.get().entries.some((e) => e.id === 'e1'), 'B recibe los turnos que ya había en el equipo');
  for (const [id, memberId] of turnosDeA) {
    is(b.get().entries.find((e) => e.id === id).memberId, memberId, 'el turno bajado es el de A, no una copia de B');
  }
  ok(b.get().members.some((m) => m.name === 'Ana Ruiz'), 'y también sus personas');

  // Un cambio de A llega a B
  a.store.actions.updateEntry('e1', { notes: 'Cambiado por A' });
  await a.engine.sync();
  await b.engine.sync();
  is(b.get().entries.find((e) => e.id === 'e1').notes, 'Cambiado por A', 'el cambio de A llega a B');
});

await testAsync('un dispositivo personal no ve el cuadrante del equipo, ni al revés', async () => {
  resetWorld();
  const equipo = engineFor(teamScopedDoc());
  await equipo.engine.sync();
  const genteDelEquipo = new Set(equipo.get().members.map((m) => m.id));

  otroDispositivo();
  const personal = engineFor(teamDoc());
  await personal.engine.sync();
  const gentePersonal = new Set(personal.get().members.map((m) => m.id));

  // Pull COMPLETO: sin marca de agua que estorbe, lo único que puede separar
  // los dos cuadrantes es el filtro por ámbito de la consulta.
  await personal.engine.pull({ full: true });
  notOk(personal.get().members.some((m) => genteDelEquipo.has(m.id)), 'el personal no ve a la gente del equipo');

  await equipo.engine.pull({ full: true });
  notOk(equipo.get().members.some((m) => gentePersonal.has(m.id)), 'el equipo no ve el cuadrante personal');

  // Y en el servidor cada fila está en su ámbito, sin mezclarse
  is(fake.all('horus_members').filter((r) => r.owner_key === `team:${TEAM_ID}`).length, 3);
  is(fake.all('horus_members').filter((r) => r.owner_key === 'user:u-1').length, 3);

  // Todas las consultas de lectura van filtradas por ámbito
  const lecturas = fake.calls.filter((c) => c.method === 'GET');
  ok(lecturas.length > 0, 'hubo lecturas');
  for (const llamada of lecturas) {
    includes(llamada.url, 'owner_key=eq.', `la lectura de ${llamada.table} filtra por ámbito`);
  }
});

/**
 * LA PRUEBA DEL FALLO SILENCIOSO.
 *
 * El equipo ya tenía cuadrante, subido hace una hora. Este dispositivo acaba de
 * sincronizar en modo personal, así que su marca de agua es de AHORA: si al
 * pasar al equipo no se reiniciara el estado, el primer pull preguntaría «lo
 * cambiado desde ahora» y TODO lo que ya había en el equipo (más antiguo) se
 * quedaría fuera de la consulta. El cuadrante se vería vacío y sin ningún error.
 */
await testAsync('al pasar a equipo, el estado de sincronización se reinicia y el primer pull trae lo del equipo', async () => {
  resetWorld();

  const equipoViejo = teamScopedDoc();
  // Ids de otro dispositivo: si coincidieran con los de este, el pull tendría
  // que decidir entre dos versiones de la misma fila y no se probaría nada.
  for (const e of equipoViejo.entries) e.id = `eq_${e.id}`;
  envejecer(equipoViejo, 3600000);
  const equipo = engineFor(equipoViejo);
  await equipo.engine.sync();

  otroDispositivo();
  const mio = engineFor(teamDoc());
  await mio.engine.sync();
  ok(Object.keys(mio.engine.state.lastPullAt).length > 0, 'hay marcas de agua del ámbito personal');
  ok(Object.keys(mio.engine.state.hashes).length > 0, 'y huellas');
  ok(mio.engine.state.ids.entries?.length > 0, 'y ids conocidos del servidor');
  // La marca que, si sobreviviera, dejaría sordo al dispositivo en el otro ámbito.
  const marcaPersonal = mio.engine.state.lastPullAt.horus_entries;

  ok(mio.store.actions.changeScope(TEAM_ID), 'el ámbito cambia al equipo');
  is(syncMod.loadSyncState().ownerKey, null, 'el estado guardado se tira: un motor nuevo arranca sin ámbito');

  // Cualquier cálculo del motor (pendingCount, push, pull) revisa el ámbito y
  // se da cuenta del cambio: aquí se fuerza ese paso.
  ok(mio.engine.pendingCount() > 0, 'todo el documento queda pendiente de subir al ámbito nuevo');
  is(mio.engine.ownerKey, `team:${TEAM_ID}`, 'el motor trabaja ya en el ámbito del equipo');
  is(Object.keys(mio.engine.state.lastPullAt).length, 0, 'sin marcas de agua: con ellas, el pull se saltaría todo lo anterior');
  is(Object.keys(mio.engine.state.hashes).length, 0, 'sin huellas: el push sube el documento entero');
  is(Object.keys(mio.engine.state.ids).length, 0, 'sin ids: no se dan por borradas filas del equipo que aún no se conocen');
  is(mio.engine.state.tombstones.length, 0, 'sin lápidas: las del ámbito viejo borrarían filas del nuevo');

  const bajado = await mio.engine.pull();
  ok(bajado.applied > 0, 'el primer pull trae algo');
  ok(mio.get().entries.some((e) => e.id === 'eq_e1'), 'los turnos que ya estaban en el equipo llegan');
  ok(mio.get().members.some((m) => m.name === 'Ana Ruiz'), 'y sus personas');
  ok(mio.get().dayMeta['2025-06-06'], 'y los metadatos de día');
  is(typeof mio.engine.state.lastPullAt.horus_entries, 'string', 'la marca de agua se rehace con la hora del servidor');
  // Esto es lo que hace falta demostrar: lo que ha llegado es MÁS ANTIGUO que
  // la marca de agua del ámbito personal. Sin el reinicio, la consulta («lo
  // cambiado desde marcaPersonal») no lo habría traído nunca.
  const filaDelEquipo = fake.all('horus_entries').find((r) => r.owner_key === `team:${TEAM_ID}`);
  ok(filaDelEquipo.updated_at < marcaPersonal, 'la fila del equipo es anterior a la marca de agua personal');
});

await testAsync('al volver a personal, lo que se subió al equipo sigue en el equipo', async () => {
  resetWorld();
  const { store, engine } = engineFor(teamScopedDoc());
  await engine.sync();
  const enElEquipo = fake.all('horus_entries').filter((r) => r.owner_key === `team:${TEAM_ID}`).length;
  is(enElEquipo, 5, 'el equipo tiene el cuadrante');

  ok(store.actions.changeScope(null), 'se vuelve al ámbito personal');
  is(store.doc.teamId, null);
  await engine.sync();

  is(fake.all('horus_entries').filter((r) => r.owner_key === `team:${TEAM_ID}` && !r.deleted).length, 5, 'nada del equipo se borra');
  is(fake.all('horus_entries').filter((r) => r.owner_key === 'user:u-1').length, 5, 'y el cuadrante se sube al ámbito personal');
  is(engine.state.ownerKey, 'user:u-1');
});

await testAsync('cambiar de ámbito se puede deshacer en un solo paso', async () => {
  resetWorld();
  const { store, engine } = engineFor(teamDoc());
  is(store.doc.teamId, null, 'se empieza en personal');
  is(store.historySize(), 0, 'sin historial todavía');

  ok(store.actions.changeScope(TEAM_ID), 'se pasa al equipo');
  is(store.doc.teamId, TEAM_ID);
  is(store.historySize(), 1, 'es un solo paso de deshacer');
  is(store.undoLabel(), 'pasar el cuadrante al equipo');
  is(syncMod.loadSyncState().ownerKey, null, 'y deja el estado de sincronización tirado');

  ok(store.undo(), 'se puede deshacer');
  is(store.doc.teamId, null, 'vuelve al ámbito personal');
  ok(store.redo(), 'y rehacer');
  is(store.doc.teamId, TEAM_ID);

  notOk(store.actions.changeScope('no-es-un-uuid'), 'un id de equipo que no es uuid se rechaza');
  is(store.doc.teamId, TEAM_ID, 'y no toca el ámbito');
  notOk(store.actions.changeScope(TEAM_ID), 'cambiar al mismo ámbito no hace nada');
  is(syncMod.loadSyncState().ownerKey, null, 'el estado sigue sin restaurarse: cada vuelta baja del ámbito que toque');
});

await testAsync('un borrado con el mismo id no toca la fila del otro ámbito', async () => {
  resetWorld();
  // Dos cuadrantes que comparten los ids de los turnos ('e1'…): con la clave
  // primaria (owner_key, id), un id suelto ya no identifica una fila.
  const personal = engineFor(teamDoc());
  await personal.engine.sync();
  otroDispositivo();
  const equipo = engineFor(teamScopedDoc());
  await equipo.engine.sync();
  is(fake.all('horus_entries').filter((r) => r.id === 'e1').length, 2, 'hay dos filas con el id e1, una por ámbito');

  const e1 = personal.get().entries.find((e) => e.id === 'e1');
  personal.store.actions.removeEntries({ memberId: e1.memberId, date: e1.date });
  await personal.engine.sync();

  const mio = fake.all('horus_entries').find((r) => r.id === 'e1' && r.owner_key === 'user:u-1');
  const ajeno = fake.all('horus_entries').find((r) => r.id === 'e1' && r.owner_key === `team:${TEAM_ID}`);
  is(mio.deleted, true, 'la fila de mi ámbito se marca como borrada');
  notOk(ajeno.deleted, 'y la del equipo se queda como estaba');

  const patch = fake.calls.find((c) => c.method === 'PATCH' && c.table === 'horus_entries');
  includes(patch.url, `owner_key=eq.${encodeURIComponent('user:u-1')}`, 'el borrado filtra por ámbito');
  includes(patch.url, 'id=in.(', 'y por id');

  // El otro ámbito no se entera del borrado ni al bajar cambios
  await equipo.engine.sync();
  ok(equipo.get().entries.some((e) => e.id === 'e1'), 'el equipo conserva su turno');
});

/* ================================================================== *
 * Alarmas
 * ================================================================== */

suite('reminders.js — alarmas');

/**
 * En el navegador `notificationsSupported()` mira `window.Notification`, así
 * que las pruebas deben colocarlo ahí (no basta con `globalThis.Notification`).
 */
function fakeNotification(permission = 'granted') {
  const delivered = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = async () => permission;
    constructor(title, options) { delivered.push({ title, options }); }
  }
  globalThis.window.Notification = FakeNotification;
  Object.defineProperty(globalThis.navigator, 'serviceWorker', { value: undefined, configurable: true, writable: true });
  return delivered;
}

function restoreNotification() {
  delete globalThis.window.Notification;
  Object.defineProperty(globalThis.navigator, 'serviceWorker', { value: undefined, configurable: true, writable: true });
}

function alarmDoc() {
  const doc = model.emptyDocument();
  const ana = model.createMember('Ana', { id: 'm_ana' });
  doc.members = [ana];
  doc.meId = ana.id;
  doc.settings.notifications = { enabled: true, minutesBefore: 30, dailyBriefing: false, briefingHour: '20:00', coverageAlerts: false };
  const M = doc.shiftTypes.find((s) => s.code === 'M');
  const N = doc.shiftTypes.find((s) => s.code === 'N');
  doc.entries = [
    model.createEntry({ id: 'a1', memberId: 'm_ana', date: '2025-06-04', typeId: M.id }),
    model.createEntry({ id: 'a2', memberId: 'm_ana', date: '2025-06-05', typeId: N.id }),
  ];
  return doc;
}

test('la alarma de turno se programa con la antelación configurada', () => {
  const doc = alarmDoc();
  const now = new Date(2025, 5, 4, 7, 0);
  const alarms = reminders.pendingAlarms(doc, { now, hoursAhead: 48 });
  const shift = alarms.filter((a) => a.kind === 'shift');
  is(shift.length, 2, 'una por turno de las próximas 48 h');
  const first = shift[0];
  is(date.formatClock(first.at), '08:00', '30 min antes de las 08:30');
  includes(first.title, 'Turno');
  ok(first.body.includes('8:30–17:00'), first.body);
  // La segunda es la noche del día 5, que empieza a las 22:00
  is(date.formatClock(shift[1].at), '21:30');
  ok(shift[1].body.includes('22:00–06:00'), shift[1].body);
});

test('las alarmas se ordenan por hora', () => {
  const doc = alarmDoc();
  const alarms = reminders.pendingAlarms(doc, { now: new Date(2025, 5, 4, 0, 0), hoursAhead: 72 });
  ok(alarms.length >= 2);
  for (let i = 1; i < alarms.length; i++) {
    ok(alarms[i - 1].at <= alarms[i].at, 'orden ascendente');
  }
});

test('un turno ya pasado no genera alarma', () => {
  const doc = alarmDoc();
  const alarms = reminders.pendingAlarms(doc, { now: new Date(2025, 5, 4, 12, 0), hoursAhead: 48 });
  notOk(alarms.some((a) => a.entryId === 'a1'), 'el turno de la mañana ya pasó');
  ok(alarms.some((a) => a.entryId === 'a2'), 'el de la noche sigue pendiente');
});

test('las ausencias no generan alarma de turno', () => {
  const doc = alarmDoc();
  const V = doc.shiftTypes.find((s) => s.code === 'V');
  doc.entries.push(model.createEntry({ id: 'a3', memberId: 'm_ana', date: '2025-06-06', typeId: V.id }));
  const alarms = reminders.pendingAlarms(doc, { now: new Date(2025, 5, 4, 0, 0), hoursAhead: 96 });
  notOk(alarms.some((a) => a.entryId === 'a3'), 'las vacaciones no avisan');
});

test('se puede limitar a una persona', () => {
  const doc = alarmDoc();
  const luis = model.createMember('Luis', { id: 'm_luis' });
  doc.members.push(luis);
  const M = doc.shiftTypes.find((s) => s.code === 'M');
  doc.entries.push(model.createEntry({ id: 'a4', memberId: 'm_luis', date: '2025-06-04', typeId: M.id }));
  const soloLuis = reminders.pendingAlarms(doc, { now: new Date(2025, 5, 4, 7, 0), hoursAhead: 24, memberId: 'm_luis' });
  eq(soloLuis.filter((a) => a.kind === 'shift').map((a) => a.entryId), ['a4']);
});

test('el resumen diario se genera a la hora indicada', () => {
  const doc = alarmDoc();
  doc.settings.notifications.dailyBriefing = true;
  doc.settings.notifications.briefingHour = '20:00';
  const alarms = reminders.pendingAlarms(doc, { now: new Date(2025, 5, 4, 19, 0), hoursAhead: 6 });
  const briefing = alarms.find((a) => a.kind === 'briefing');
  ok(briefing, 'hay resumen');
  is(date.formatClock(briefing.at), '20:00');
  includes(briefing.title, 'Mañana');
  includes(briefing.body, 'Ana');
});

test('el aviso de cobertura solo aparece si hay huecos y está activado', () => {
  const doc = alarmDoc();
  const now = new Date(2025, 5, 4, 7, 0);
  notOk(reminders.pendingAlarms(doc, { now, hoursAhead: 24 }).some((a) => a.kind === 'coverage'), 'desactivado por defecto');

  doc.settings.notifications.coverageAlerts = true;
  const alarms = reminders.pendingAlarms(doc, { now, hoursAhead: 24 });
  const cov = alarms.find((a) => a.kind === 'coverage');
  ok(cov, 'ahora sí avisa');
  includes(cov.title, 'hueco');
  includes(cov.body, 'sin cubrir');
});

test('las claves de alarma son únicas y estables', () => {
  const doc = alarmDoc();
  const a = reminders.pendingAlarms(doc, { now: new Date(2025, 5, 4, 0, 0), hoursAhead: 72 });
  const b = reminders.pendingAlarms(doc, { now: new Date(2025, 5, 4, 0, 0), hoursAhead: 72 });
  eq(a.map((x) => x.key), b.map((x) => x.key), 'mismas entradas → mismas claves');
  is(new Set(a.map((x) => x.key)).size, a.length, 'no hay claves repetidas');
});

test('describeOnDuty produce frases naturales', () => {
  is(reminders.describeOnDuty([]), 'Nadie de guardia ahora mismo');
  const uno = [{ member: { name: 'Ana' }, end: 1020 }];
  is(reminders.describeOnDuty(uno), 'Ana, hasta las 17:00');
  const dos = [{ member: { name: 'Ana' }, end: 1020 }, { member: { name: 'Luis' }, end: 1500 }];
  is(reminders.describeOnDuty(dos), 'Ana y Luis, hasta las mañana');
});

await testAsync('el planificador entrega una alarma y no la repite', async () => {
  const doc = alarmDoc();
  const fired = [];
  const scheduler = reminders.createScheduler({ getDoc: () => doc, onFire: (alarm) => fired.push(alarm.key) });
  const alarm = reminders.pendingAlarms(doc, { now: new Date(2025, 5, 4, 7, 0), hoursAhead: 48 })[0];

  const delivered = fakeNotification('granted');
  scheduler.clearFired();

  const first = await scheduler.fire(alarm);
  ok(first.ok, 'se entrega la primera vez');
  is(delivered.length, 1, 'llegó exactamente una notificación');
  is(delivered[0].title, alarm.title);
  is(fired.length, 1, 'se avisó del evento');
  is(first.via, 'window', 'sin service worker usa la notificación de la página');

  const second = await scheduler.fire(alarm);
  is(second.reason, 'already-fired', 'la segunda vez se ignora');
  is(delivered.length, 1, 'no se duplica el aviso');

  restoreNotification();
});

await testAsync('el registro de avisos sobrevive a un planificador nuevo', async () => {
  const doc = alarmDoc();
  const alarm = reminders.pendingAlarms(doc, { now: new Date(2025, 5, 4, 7, 0), hoursAhead: 48 })[0];
  fakeNotification('granted');

  const a = reminders.createScheduler({ getDoc: () => doc });
  a.clearFired();
  const first = await a.fire(alarm);
  ok(first.ok, 'la primera entrega funciona');

  // Un planificador nuevo (como tras recargar la página) lee el registro guardado
  const b = reminders.createScheduler({ getDoc: () => doc });
  const again = await b.fire(alarm);
  is(again.ok, false, 'no vuelve a entregar tras recargar');
  is(again.reason, 'already-fired', 'porque ya consta como avisado');

  restoreNotification();
});

await testAsync('tick recupera un aviso perdido dentro de la ventana de gracia', async () => {
  const doc = alarmDoc();
  // Son las 08:25 y la alarma debía haber sonado a las 08:00 (25 min de retraso)
  const late = new Date(2025, 5, 4, 8, 5);
  const delivered = fakeNotification('granted');
  const OriginalDate = globalThis.Date;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [late.getTime()])); }
    static now() { return late.getTime(); }
  };

  const scheduler = reminders.createScheduler({ getDoc: () => doc });
  scheduler.clearFired();
  const result = await scheduler.tick();
  is(result.fired, 1, 'se recupera el aviso que se perdió por unos minutos');
  is(delivered.length, 1);

  globalThis.Date = OriginalDate;
  restoreNotification();
});

await testAsync('tick no dispara avisos demasiado antiguos', async () => {
  const doc = alarmDoc();
  // Son las 09:30: la alarma de las 08:00 llegaría 90 min tarde
  const tooLate = new Date(2025, 5, 4, 9, 30);
  const delivered = fakeNotification('granted');
  const OriginalDate = globalThis.Date;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [tooLate.getTime()])); }
    static now() { return tooLate.getTime(); }
  };

  const scheduler = reminders.createScheduler({ getDoc: () => doc });
  scheduler.clearFired();
  const result = await scheduler.tick();
  is(result.fired, 0, 'no se avisa con hora y media de retraso');
  is(delivered.length, 0);

  globalThis.Date = OriginalDate;
  restoreNotification();
});

await testAsync('con las notificaciones apagadas no se entrega', async () => {
  const doc = alarmDoc();
  doc.settings.notifications.enabled = false;
  const scheduler = reminders.createScheduler({ getDoc: () => doc });
  const alarm = { key: 'k', at: new Date(), title: 't', body: 'b', tag: 'x', kind: 'shift', data: {} };
  fakeNotification('granted');
  const result = await scheduler.fire(alarm);
  is(result.reason, 'disabled');
  restoreNotification();
});

await testAsync('sin permiso del navegador no se entrega nada', async () => {
  const doc = alarmDoc();
  const scheduler = reminders.createScheduler({ getDoc: () => doc });
  const alarm = reminders.pendingAlarms(doc, { now: new Date(2025, 5, 4, 7, 0), hoursAhead: 48 })[0];
  const delivered = fakeNotification('denied');
  scheduler.clearFired();
  const result = await scheduler.fire(alarm);
  is(result.reason, 'no-permission');
  is(delivered.length, 0);
  restoreNotification();
});

test('inspect resume el estado del planificador', () => {
  const doc = alarmDoc();
  const scheduler = reminders.createScheduler({ getDoc: () => doc });
  const info = scheduler.inspect();
  is(info.running, false);
  is(info.enabled, true);
  is(info.permission, 'unsupported', 'en Node no hay Notification');
  notOk(info.timeouts);
});

test('onDuty y nextFor delegan en el motor de cobertura', () => {
  const doc = alarmDoc();
  const scheduler = reminders.createScheduler({ getDoc: () => doc });
  const midMorning = new Date(2025, 5, 4, 10, 0);
  const duty = scheduler.onDuty(midMorning);
  is(duty.length, 1);
  is(duty[0].member.name, 'Ana');
  const next = scheduler.nextFor('m_ana', new Date(2025, 5, 4, 6, 0));
  is(next.entry.id, 'a1');
  is(next.minutesUntil, 150);
});

/* ------------------------------------------------------------------ *
 * Resumen
 * ------------------------------------------------------------------ */

console.log(`\n${'─'.repeat(58)}`);
if (failed === 0) {
  console.log(`\x1b[1m\x1b[32m✓ ${passed} pruebas correctas\x1b[0m`);
} else {
  console.log(`\x1b[1m\x1b[31m✗ ${failed} fallidas\x1b[0m de ${passed + failed}`);
  console.log('\nFallos:');
  for (const f of failures) {
    console.log(`  · [${f.suite}] ${f.name}`);
    console.log(`    ${f.err.message.split('\n').join('\n    ')}`);
  }
}
console.log(`${'─'.repeat(58)}\n`);
process.exit(failed === 0 ? 0 : 1);

