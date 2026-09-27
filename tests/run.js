/**
 * HORUS — tests/run.js
 * Arnés de pruebas mínimo, sin dependencias. Ejecuta con: node tests/run.js
 *
 * Antes de importar los módulos del núcleo se inyecta un localStorage falso,
 * porque en Node no existe `window`.
 */

/* ------------------------------------------------------------------ *
 * localStorage falso (debe existir ANTES de importar storage.js)
 * ------------------------------------------------------------------ */

const memoryStore = new Map();
globalThis.window = globalThis.window || {};
globalThis.localStorage = {
  getItem: (k) => (memoryStore.has(k) ? memoryStore.get(k) : null),
  setItem: (k, v) => memoryStore.set(k, String(v)),
  removeItem: (k) => memoryStore.delete(k),
  key: (i) => [...memoryStore.keys()][i] ?? null,
  get length() { return memoryStore.size; },
  clear: () => memoryStore.clear(),
};
globalThis.window.localStorage = globalThis.localStorage;

/* ------------------------------------------------------------------ *
 * Mini framework
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  console.log(`\n\x1b[1m\x1b[36m${name}\x1b[0m`);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push({ suite: currentSuite, name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${err.message}\x1b[0m`);
  }
}

function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n      esperado: ${b}\n      recibido: ${a}`);
}

function ok(value, label = 'valor falsy') {
  if (!value) throw new Error(`se esperaba un valor verdadero: ${label}`);
}

function is(value, expected, label = '') {
  if (value !== expected) throw new Error(`${label} esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(value)}`);
}

function close(value, expected, tolerance = 1e-6, label = '') {
  if (Math.abs(value - expected) > tolerance) {
    throw new Error(`${label} esperado ~${expected}, recibido ${value}`);
  }
}

/* ------------------------------------------------------------------ *
 * Importaciones
 * ------------------------------------------------------------------ */

const date = await import('../js/core/date.js');
const model = await import('../js/core/model.js');
const coverage = await import('../js/core/coverage.js');
const storage = await import('../js/core/storage.js');
const storeMod = await import('../js/core/store.js');
const utils = await import('../js/core/utils.js');

/* ================================================================== *
 * date.js
 * ================================================================== */

suite('date.js — horas y duraciones');

test('timeToMin convierte y rechaza basura', () => {
  is(date.timeToMin('00:00'), 0);
  is(date.timeToMin('08:30'), 510);
  is(date.timeToMin('23:59'), 1439);
  ok(Number.isNaN(date.timeToMin('24:00')), '24:00 es inválido');
  ok(Number.isNaN(date.timeToMin('8:5')), '8:5 es inválido');
  ok(Number.isNaN(date.timeToMin(null)), 'null es inválido');
});

test('minToTime da la vuelta a valores fuera de rango', () => {
  is(date.minToTime(0), '00:00');
  is(date.minToTime(510), '08:30');
  is(date.minToTime(1440), '00:00');
  is(date.minToTime(1500), '01:00');
  is(date.minToTime(-60), '23:00');
});

test('blockMinutes con turno diurno, nocturno y de 24 h', () => {
  is(date.blockMinutes({ start: '08:30', end: '17:00' }), 510);
  is(date.blockMinutes({ start: '16:15', end: '00:45' }), 510);
  is(date.blockMinutes({ start: '22:00', end: '06:00' }), 480);
  is(date.blockMinutes({ start: '09:00', end: '09:00' }), 1440);
});

test('crossesMidnight detecta el cambio de día', () => {
  is(date.crossesMidnight({ start: '16:15', end: '00:45' }), true);
  is(date.crossesMidnight({ start: '08:30', end: '17:00' }), false);
  is(date.crossesMidnight({ start: '09:00', end: '09:00' }), true);
});

test('normalizeBlocks fusiona solapamientos y ordena', () => {
  eq(date.normalizeBlocks([
    { start: '17:00', end: '21:00' },
    { start: '08:30', end: '13:00' },
  ]), [{ start: '08:30', end: '13:00' }, { start: '17:00', end: '21:00' }]);

  eq(date.normalizeBlocks([
    { start: '08:00', end: '12:00' },
    { start: '11:00', end: '14:00' },
  ]), [{ start: '08:00', end: '14:00' }], 'intervalos solapados se fusionan');

  eq(date.normalizeBlocks([
    { start: 'basura', end: '14:00' },
    { start: '09:00', end: '10:00' },
  ]), [{ start: '09:00', end: '10:00' }], 'los bloques inválidos se descartan');

  eq(date.normalizeBlocks('no es un array'), []);
});

test('totalMinutes no cuenta dos veces los solapamientos', () => {
  is(date.totalMinutes([{ start: '08:00', end: '12:00' }, { start: '11:00', end: '14:00' }]), 360);
  is(date.totalMinutes([{ start: '22:00', end: '02:00' }]), 240);
});

test('blockSpans proyecta el turno nocturno por encima de 1440', () => {
  const spans = date.blockSpans([{ start: '22:00', end: '06:00' }]);
  is(spans.length, 1);
  is(spans[0].start, 1320);
  is(spans[0].end, 1800);
  is(spans[0].overnight, true);
});

test('freeIntervals encuentra los huecos reales del día', () => {
  eq(date.freeIntervals([{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }]), [
    { start: 0, end: 480 },
    { start: 720, end: 840 },
    { start: 1080, end: 1440 },
  ]);
  eq(date.freeIntervals([{ start: '00:00', end: '00:00' }]), [], 'turno de 24 h no deja huecos');
});

test('isMinuteCovered respeta los límites (fin exclusivo)', () => {
  const blocks = [{ start: '08:00', end: '12:00' }];
  is(date.isMinuteCovered(blocks, 479), false);
  is(date.isMinuteCovered(blocks, 480), true);
  is(date.isMinuteCovered(blocks, 719), true);
  is(date.isMinuteCovered(blocks, 720), false);
});

suite('date.js — calendario');

test('dateKey y fromKey son inversas', () => {
  is(date.dateKey(2025, 5, 4), '2025-06-04');
  is(date.toKey(date.fromKey('2025-06-04')), '2025-06-04');
});

test('fromKey rechaza fechas imposibles y formatos raros', () => {
  is(date.fromKey('2025-02-31'), null);
  is(date.fromKey('2025-13-01'), null);
  is(date.fromKey('25-01-01'), null);
  is(date.fromKey(''), null);
  is(date.fromKey(undefined), null);
  ok(date.fromKey('2024-02-29'), '2024 es bisiesto');
});

test('addDays cruza meses, años y cambios de hora', () => {
  is(date.addDays('2025-01-31', 1), '2025-02-01');
  is(date.addDays('2025-12-31', 1), '2026-01-01');
  is(date.addDays('2025-03-01', -1), '2025-02-28');
  is(date.addDays('2024-03-01', -1), '2024-02-29');
  // Rango que contiene el cambio de horario de verano en Europa (30/03/2025)
  is(date.addDays('2025-03-29', 2), '2025-03-31');
});

test('addMonths y daysInMonth', () => {
  is(date.addMonths('2025-01', 1), '2025-02');
  is(date.addMonths('2025-12', 1), '2026-01');
  is(date.addMonths('2025-01', -1), '2024-12');
  is(date.addMonths('2025-01', 25), '2027-02');
  is(date.daysInMonth('2024-02'), 29);
  is(date.daysInMonth('2025-02'), 28);
  is(date.daysInMonth('2025-06'), 30);
});

test('isoWeek calcula la semana ISO correctamente', () => {
  is(date.isoWeek('2025-01-01').week, 1, '1 de enero de 2025 es semana 1');
  is(date.isoWeek('2024-12-30').week, 1, '30 dic 2024 pertenece a la semana 1 de 2025');
  is(date.isoWeek('2024-12-30').year, 2025);
  is(date.isoWeek('2025-06-04').week, 23);
  is(date.isoWeek('2026-01-01').week, 1);
});

test('startOfWeek y weekDays empiezan en lunes', () => {
  is(date.startOfWeek('2025-06-04'), '2025-06-02');
  is(date.startOfWeek('2025-06-02'), '2025-06-02');
  is(date.startOfWeek('2025-06-08'), '2025-06-02', 'domingo pertenece a la semana que empezó el lunes');
  eq(date.weekDays('2025-06-04'), [
    '2025-06-02', '2025-06-03', '2025-06-04', '2025-06-05', '2025-06-06', '2025-06-07', '2025-06-08',
  ]);
});

test('monthGrid cubre el mes completo y marca lo que está fuera', () => {
  const grid = date.monthGrid('2025-06');
  is(grid.length % 7, 0, 'la rejilla es múltiplo de 7');
  ok(grid.length >= 35, 'al menos 5 semanas');
  is(grid[0].dow, 1, 'la rejilla empieza en lunes');
  const inMonth = grid.filter((c) => c.inMonth);
  is(inMonth.length, 30, 'junio tiene 30 días dentro');
  is(inMonth[0].key, '2025-06-01');
  is(inMonth[inMonth.length - 1].key, '2025-06-30');
  is(grid.filter((c) => c.isWeekend).length > 0, true);
});

test('monthGrid de un mes que empieza en lunes no añade relleno por delante', () => {
  const grid = date.monthGrid('2025-09');
  is(grid[0].key, '2025-09-01', 'septiembre de 2025 empieza en lunes');
  is(grid[0].inMonth, true);
});

suite('date.js — formatos');

test('formatDuration en español', () => {
  is(date.formatDuration(0), '0 min');
  is(date.formatDuration(45), '45 min');
  is(date.formatDuration(60), '1 h');
  is(date.formatDuration(510), '8 h 30 min');
  is(date.formatDuration(-90), '1 h 30 min');
});

test('formatBlocks usa guiones y omite el cero inicial', () => {
  is(date.formatBlocks([{ start: '08:30', end: '13:00' }, { start: '17:00', end: '21:00' }]), '8:30–13:00 · 17:00–21:00');
  is(date.formatBlocks([]), '');
});

test('formatLongDate devuelve un texto en español capitalizado', () => {
  const s = date.formatLongDate('2025-06-04');
  ok(/^Miércoles/.test(s), `recibido: ${s}`);
  ok(s.includes('junio'), `recibido: ${s}`);
});

test('shiftRuntime detecta un turno en curso y el progreso', () => {
  const startKey = '2025-06-04';
  const blocks = [{ start: '16:00', end: '20:00' }];
  const rt = date.shiftRuntime(startKey, blocks, new Date(2025, 5, 4, 18, 0));
  is(rt.isNow, true);
  close(rt.progress, 0.5, 0.01);
  is(rt.minutesToEnd, 120);

  const notYet = date.shiftRuntime(startKey, blocks, new Date(2025, 5, 4, 10, 0));
  is(notYet.isNow, false);
  is(notYet.minutesToStart, 360);
});

test('shiftRuntime funciona con turno nocturno ya empezado ayer', () => {
  const rt = date.shiftRuntime('2025-06-04', [{ start: '22:00', end: '02:00' }], new Date(2025, 5, 5, 1, 0));
  is(rt.isNow, true);
  is(rt.minutesToEnd, 60);
});

/* ================================================================== *
 * model.js
 * ================================================================== */

suite('model.js — documento y normalización');

test('emptyDocument es válido y trae catálogo por defecto', () => {
  const doc = model.emptyDocument();
  is(doc.schema, 4);
  is(doc.entries.length, 0);
  ok(doc.shiftTypes.length >= 5, 'hay tipos de turno por defecto');
  ok(doc.shiftTypes.some((s) => s.code === 'M'));
  ok(doc.shiftTypes.every((s) => /^#[0-9A-F]{6}$/i.test(s.hex)), 'todos los colores son hex válidos');
});

test('normalizeDocument aguanta basura sin lanzar', () => {
  for (const junk of [null, undefined, 42, 'texto', [], { members: 'no' }, { entries: {} }]) {
    const doc = model.normalizeDocument(junk);
    is(doc.schema, 4);
    ok(Array.isArray(doc.members));
    ok(Array.isArray(doc.entries));
    ok(doc.settings && typeof doc.settings === 'object');
  }
});

test('normalizeDocument conserva las entradas aunque su tipo ya no exista', () => {
  const doc = model.normalizeDocument({
    members: [{ id: 'm1', name: 'Ana' }],
    shiftTypes: [{ id: 'st1', code: 'M', label: 'Mañana', hex: '#F2A33C', blocks: [{ start: '08:00', end: '16:00' }] }],
    entries: [
      { id: 'e1', memberId: 'm1', date: '2025-06-04', typeId: 'st1' },
      { id: 'e2', memberId: 'fantasma', date: '2025-06-04', typeId: 'st1' },
      { id: 'e3', memberId: 'm1', date: '2025-06-05', typeId: 'no-existe' },
      { id: 'e4', memberId: 'm1', date: 'fecha-mala', typeId: 'st1' },
    ],
  });
  eq(doc.entries.map((e) => e.id).sort(), ['e1', 'e3', 'e4'], 'solo se descartan las de miembros inexistentes');
  is(doc.entries.find((e) => e.id === 'e4').date.length, 10, 'la fecha inválida se sustituye por hoy');
  is(doc.entries.find((e) => e.id === 'e3').typeId, null, 'el tipo inexistente se anula');
  // ...pero una entrada sin tipo resoluble no aporta horario al cuadrante
  eq(model.entryBlocks(doc, doc.entries.find((e) => e.id === 'e3')), []);
  is(model.entryMinutes(doc, doc.entries.find((e) => e.id === 'e3')), 0);
});

test('normalizeDocument corrige el color hex malformado', () => {
  const doc = model.normalizeDocument({
    shiftTypes: [{ id: 'st1', code: 'M', label: 'M', hex: 'rojo', blocks: [] }],
  });
  ok(/^#[0-9A-F]{6}$/i.test(doc.shiftTypes[0].hex), doc.shiftTypes[0].hex);
});

test('initialsOf genera iniciales razonables', () => {
  is(model.initialsOf('Ana'), 'AN');
  is(model.initialsOf('Ana María Ruiz'), 'AM');
  is(model.initialsOf('José de la Cruz'), 'JC');
  is(model.initialsOf(''), '?');
  is(model.initialsOf('   '), '?');
});

test('uid genera ids únicos', () => {
  const set = new Set();
  for (let i = 0; i < 5000; i++) set.add(model.uid('e'));
  is(set.size, 5000);
});

test('createEntry normaliza bloques y aplica valores por defecto', () => {
  const e = model.createEntry({ memberId: 'm1', date: '2025-06-04', blocks: [{ start: '17:00', end: '21:00' }, { start: '08:30', end: '13:00' }] });
  eq(e.blocks, [{ start: '08:30', end: '13:00' }, { start: '17:00', end: '21:00' }]);
  is(e.dayType, 'normal');
  is(e.approved, true);
});

test('normalizeSettings repara valores fuera de rango', () => {
  const s = model.normalizeSettings({
    theme: 'arcoiris',
    weekStartsOn: 99,
    notifications: { minutesBefore: 99999, briefingHour: 'basura' },
    hours: { weeklyTarget: -5 },
  });
  is(s.theme, 'dark');
  is(s.weekStartsOn, 1);
  is(s.notifications.minutesBefore, 720);
  is(s.notifications.briefingHour, '20:00');
  is(s.hours.weeklyTarget, 0);
});

suite('model.js — migración del formato antiguo');

const LEGACY = {
  activeProfile: 'Javier',
  profiles: ['Javier', 'Alejandra', 'Sergio'],
  shiftTypes: {
    M: { code: 'M', label: 'Mañana', hex: '#F2A33C', blocks: [{ start: '08:30', end: '17:00' }] },
    T: { code: 'T', label: 'Tarde', hex: '#5B8DEF', blocks: [{ start: '16:15', end: '00:45' }] },
    P: { code: 'P', label: 'Partido', hex: '#C77DFF', blocks: [] },
    V: { code: 'V', label: 'Vacaciones', hex: '#7C9885', blocks: [] },
  },
  days: {
    '2025-06-02': { date: '2025-06-02', sc: 'M', dt: 'normal', notes: 'Llevar llaves' },
    '2025-06-03': { date: '2025-06-03', sc: 'T', dt: 'normal', notes: '' },
    '2025-06-04': { date: '2025-06-04', sc: 'P', dt: 'normal', notes: '', bo: [{ start: '08:30', end: '13:00' }, { start: '17:00', end: '21:00' }] },
    '2025-06-05': { date: '2025-06-05', sc: null, dt: 'feriado', notes: '' },
    '2025-06-06': { date: '2025-06-06', sc: 'M', dt: 'normal', notes: '', dtb: [{ start: '17:30', end: '' }] },
    '2025-06-07': { date: '2025-06-07', sc: 'V', dt: 'normal', notes: '' },
    'basura': { sc: 'M' },
  },
  settings: { notificationsEnabled: true, alarmMinutesBefore: 45 },
  onboardingDone: true,
  _savedAt: 1749000000000,
};

test('migrateFromLegacy convierte perfiles en miembros', () => {
  const doc = model.migrateFromLegacy(LEGACY);
  eq(doc.members.map((m) => m.name), ['Javier', 'Alejandra', 'Sergio']);
  is(doc.members[0].role, 'owner', 'el perfil activo pasa a dueño');
  is(doc.members.find((m) => m.id === doc.meId).name, 'Javier');
  is(doc.members[0].initials, 'JA');
});

test('migrateFromLegacy convierte el catálogo a array con ids', () => {
  const doc = model.migrateFromLegacy(LEGACY);
  const m = doc.shiftTypes.find((s) => s.code === 'M');
  ok(m, 'existe el turno M');
  is(m.id, 'st_m');
  eq(m.blocks, [{ start: '08:30', end: '17:00' }]);
  is(doc.shiftTypes.find((s) => s.code === 'V').kind, 'leave', 'V se interpreta como vacaciones');
  ok(doc.shiftTypes.every((s) => typeof s.id === 'string' && s.id.length), 'todos tienen id');
  is(new Set(doc.shiftTypes.map((s) => s.id)).size, doc.shiftTypes.length, 'los ids no se repiten');
});

test('migrateFromLegacy convierte los días en entradas del miembro activo', () => {
  const doc = model.migrateFromLegacy(LEGACY);
  is(doc.entries.length, 6, 'las seis fechas válidas se migran; la basura no');
  ok(doc.entries.every((e) => e.memberId === doc.meId), 'todas las entradas son del miembro activo');
  const lunes = doc.entries.find((e) => e.date === '2025-06-02');
  is(lunes.typeId, 'st_m');
  is(lunes.notes, 'Llevar llaves');
  is(lunes.blocks, null, 'los bloques que coinciden con el catálogo no se duplican');
});

test('migrateFromLegacy conserva los horarios propios y las excepciones', () => {
  const doc = model.migrateFromLegacy(LEGACY);
  const miercoles = doc.entries.find((e) => e.date === '2025-06-04');
  eq(miercoles.blocks, [{ start: '08:30', end: '13:00' }, { start: '17:00', end: '21:00' }]);
  is(model.entryBlocks(doc, miercoles).length, 2, 'el horario propio tiene prioridad sobre el catálogo');
  is(miercoles.typeId, 'st_p', 'y sigue sabiendo de qué turno se trata');
});

test('migrateFromLegacy marca los festivos en dayMeta', () => {
  const doc = model.migrateFromLegacy(LEGACY);
  is(doc.dayMeta['2025-06-05']?.dayType, 'holiday');
});

test('migrateFromLegacy traslada los ajustes de notificaciones', () => {
  const doc = model.migrateFromLegacy(LEGACY);
  is(doc.settings.notifications.enabled, true);
  is(doc.settings.notifications.minutesBefore, 45);
  is(doc.settings.firstRun, false);
  is(doc.migration.entries, 6);
});

test('migrateFromLegacy avisa de los horarios ilegibles sin romper', () => {
  const doc = model.migrateFromLegacy(LEGACY);
  is(doc.migration.invalidBlocks, 1, 'el bloque {17:30, ""} se detecta como inválido');
  is(doc.migration.skippedDays, 1, 'la fecha "basura" se cuenta como descartada');
  ok(Array.isArray(doc.migration.warnings) && doc.migration.warnings.length === 2);
  // Al descartar su horario propio, la entrada conserva el del catálogo
  const viernes = doc.entries.find((e) => e.date === '2025-06-06');
  eq(model.entryBlocks(doc, viernes), [{ start: '08:30', end: '17:00' }]);
  is(viernes.typeId, 'st_m', 'y el turno del catálogo se mantiene');
});

test('migrateFromLegacy aguanta un blob vacío o corrupto', () => {
  for (const junk of [null, {}, { days: null }, { profiles: [1, 2, 3] }, 'texto']) {
    const doc = model.migrateFromLegacy(junk);
    is(doc.schema, 4);
    ok(doc.members.length >= 1, 'siempre hay al menos un miembro');
  }
});

suite('model.js — consultas');

function sampleDoc() {
  const doc = model.emptyDocument();
  const ana = model.createMember('Ana', { id: 'm_ana', role: 'owner' });
  const luis = model.createMember('Luis', { id: 'm_luis' });
  doc.members = [ana, luis];
  doc.meId = ana.id;
  const manana = doc.shiftTypes.find((s) => s.code === 'M');
  const noche = doc.shiftTypes.find((s) => s.code === 'N');
  doc.entries = [
    model.createEntry({ id: 'e1', memberId: 'm_ana', date: '2025-06-02', typeId: manana.id }),
    model.createEntry({ id: 'e2', memberId: 'm_luis', date: '2025-06-02', typeId: noche.id }),
    model.createEntry({ id: 'e3', memberId: 'm_ana', date: '2025-06-03', typeId: manana.id }),
  ];
  return doc;
}

test('entryBlocks hereda del catálogo cuando la entrada no trae bloques', () => {
  const doc = sampleDoc();
  eq(model.entryBlocks(doc, doc.entries[0]), [{ start: '08:30', end: '17:00' }]);
});

test('entryMinutes respeta countsHours', () => {
  const doc = sampleDoc();
  const vacaciones = doc.shiftTypes.find((s) => s.code === 'V');
  const e = model.createEntry({ memberId: 'm_ana', date: '2025-06-10', typeId: vacaciones.id });
  is(model.entryMinutes(doc, e), 0);
  is(model.entryMinutes(doc, doc.entries[0]), 510);
});

test('entriesForDate ordena por hora de inicio', () => {
  const doc = sampleDoc();
  const list = model.entriesForDate(doc, '2025-06-02');
  is(list.length, 2);
  is(list[0].memberId, 'm_ana', 'la mañana (08:30) va antes que la noche (22:00)');
  is(list[1].memberId, 'm_luis');
});

test('entriesForDate filtra por miembro', () => {
  const doc = sampleDoc();
  is(model.entriesForDate(doc, '2025-06-02', { memberId: 'm_ana' }).length, 1);
  is(model.entriesForDate(doc, '2025-06-09').length, 0);
});

test('entryIsOvernight detecta turnos que cruzan medianoche', () => {
  const doc = sampleDoc();
  ok(model.entryIsOvernight(doc, doc.entries[1]), 'la noche cruza medianoche');
  is(model.entryIsOvernight(doc, doc.entries[0]), false);
});

test('patternTypeForDate recorre el ciclo y da la vuelta', () => {
  const cycle = [{ typeId: 'a' }, { typeId: 'b' }, { typeId: 'c' }];
  const p = model.createPattern({ cycle, stepDays: 1, startDate: '2025-06-02' });
  is(model.patternTypeForDate(p, '2025-06-02'), 'a');
  is(model.patternTypeForDate(p, '2025-06-03'), 'b');
  is(model.patternTypeForDate(p, '2025-06-04'), 'c');
  is(model.patternTypeForDate(p, '2025-06-05'), 'a', 'vuelve a empezar');
  is(model.patternTypeForDate(p, '2025-06-01'), 'c', 'el día anterior también rota');
});

test('patternTypeForDate con stepDays de 2 mantiene el turno dos días', () => {
  const p = model.createPattern({ cycle: [{ typeId: 'a' }, { typeId: 'b' }], stepDays: 2, startDate: '2025-06-02' });
  is(model.patternTypeForDate(p, '2025-06-02'), 'a');
  is(model.patternTypeForDate(p, '2025-06-03'), 'a');
  is(model.patternTypeForDate(p, '2025-06-04'), 'b');
  is(model.patternTypeForDate(p, '2025-06-05'), 'b');
});

test('findDuplicates detecta dos turnos el mismo día para la misma persona', () => {
  const doc = sampleDoc();
  doc.entries.push(model.createEntry({ id: 'e4', memberId: 'm_ana', date: '2025-06-02', typeId: doc.shiftTypes[0].id }));
  is(model.findDuplicates(doc).length, 1);
});

/* ================================================================== *
 * coverage.js
 * ================================================================== */

suite('coverage.js — cobertura y huecos');

function coverageDoc() {
  const doc = model.emptyDocument();
  const ana = model.createMember('Ana', { id: 'm_ana' });
  const luis = model.createMember('Luis', { id: 'm_luis' });
  doc.members = [ana, luis];
  doc.meId = ana.id;
  const manana = doc.shiftTypes.find((s) => s.code === 'M');   // 08:30–17:00
  const tarde = doc.shiftTypes.find((s) => s.code === 'T');    // 16:15–00:45
  const noche = doc.shiftTypes.find((s) => s.code === 'N');    // 22:00–06:00
  doc.entries = [
    model.createEntry({ id: 'e1', memberId: 'm_ana', date: '2025-06-02', typeId: manana.id }),
    model.createEntry({ id: 'e2', memberId: 'm_luis', date: '2025-06-02', typeId: tarde.id }),
    model.createEntry({ id: 'e3', memberId: 'm_ana', date: '2025-06-03', typeId: noche.id }),
  ];
  return doc;
}

test('analyzeDate calcula minutos cubiertos y huecos', () => {
  const doc = coverageDoc();
  const day = coverage.analyzeDate(doc, '2025-06-02');
  is(day.date, '2025-06-02');
  // Mañana 08:30–17:00 y tarde 16:15–00:45 → cubierto de 08:30 a 24:00
  is(day.coverageMin, 1440 - 510);
  is(day.gaps.length, 1);
  is(day.gaps[0].start, 0);
  is(day.gaps[0].end, 510);
  is(day.gapMin, 510);
  is(day.status, 'gaps');
  is(day.headsOnShift, 2);
});

test('analyzeDate proyecta el turno nocturno de ayer sobre hoy', () => {
  const doc = coverageDoc();
  // Día 3: Ana empieza la noche a las 22:00 (120 min de este día) y Luis sigue
  // de tarde hasta las 00:45 (45 min de este día). Total: 165 min cubiertos.
  const dia3 = coverage.analyzeDate(doc, '2025-06-03');
  is(dia3.coverageMin, 120 + 45);
  eq(dia3.intervals.map((i) => `${i.start}-${i.end}:${i.count}`), ['0-45:1', '45-1320:0', '1320-1440:1']);

  // ...y el día 4 recoge la madrugada del turno de noche de Ana: 00:00→06:00
  const dia4 = coverage.analyzeDate(doc, '2025-06-04');
  is(dia4.coverageMin, 360, 'la madrugada del turno de noche cuenta en el día siguiente');
  is(dia4.gaps.length, 1);
  is(dia4.gaps[0].start, 360);
  is(dia4.gaps[0].end, 1440);
  is(dia4.working[0].continuedFromPrevDay, true);
  is(dia4.working[0].member.name, 'Ana');

  // El día 2 tiene dos turnos en curso: la mañana de Ana (08:30–17:00) y la
  // tarde de Luis (16:15–00:45), de la que solo pertenecen a este día hasta
  // las 24:00. Cubierto: 08:30→24:00 = 930 min. El hueco: 00:00→08:30.
  const dia2 = coverage.analyzeDate(doc, '2025-06-02');
  is(dia2.working.length, 2, 'el día 2 tiene sus dos turnos');
  is(dia2.coverageMin, 1440 - 510);
  is(dia2.gaps.length, 1);
  is(dia2.gaps[0].end, 510);
  is(dia2.working.find((p) => p.member.name === 'Luis').continuesNextDay, true);
});

test('analyzeDate de un día sin nadie devuelve el día entero como hueco', () => {
  const doc = coverageDoc();
  const vacio = coverage.analyzeDate(doc, '2025-06-20');
  is(vacio.status, 'empty');
  is(vacio.coverageMin, 0);
  is(vacio.gapMin, 1440);
  is(vacio.headsOnShift, 0);
});

test('coverageIntervals distingue falta y exceso de personal', () => {
  const doc = coverageDoc();
  const manana = doc.shiftTypes.find((s) => s.code === 'M');
  // Tres personas a la mañana, pero cada turno pide 2
  manana.demand = 2;
  doc.members.push(model.createMember('Eva', { id: 'm_eva' }), model.createMember('Iván', { id: 'm_ivan' }));
  doc.entries.push(
    model.createEntry({ id: 'e4', memberId: 'm_ana', date: '2025-06-09', typeId: manana.id }),
    model.createEntry({ id: 'e5', memberId: 'm_luis', date: '2025-06-09', typeId: manana.id }),
    model.createEntry({ id: 'e6', memberId: 'm_eva', date: '2025-06-09', typeId: manana.id }),
  );
  const day = coverage.analyzeDate(doc, '2025-06-09');
  const over = day.intervals.filter((i) => i.status === 'over');
  ok(over.length, 'hay tramos con exceso de personal');
  is(over[0].count, 3);
  is(over[0].required, 2);

  // Ahora solo una persona cuando hacen falta 2 → falta personal
  doc.entries = doc.entries.filter((e) => e.id !== 'e5' && e.id !== 'e6');
  const day2 = coverage.analyzeDate(doc, '2025-06-09');
  const under = day2.intervals.filter((i) => i.status === 'under');
  ok(under.length, 'hay tramos con falta de personal');
  is(under[0].count, 1);
  is(under[0].required, 2);
});

test('effectiveDemand respeta la prioridad entrada > tipo > día > ajustes', () => {
  const doc = coverageDoc();
  const manana = doc.shiftTypes.find((s) => s.code === 'M');
  manana.demand = 3;
  const e = doc.entries[0];
  is(coverage.effectiveDemand(doc, e, e.date), 3, 'usa la demanda del tipo');
  is(coverage.effectiveDemand(doc, { ...e, demandOverride: 7 }, e.date), 7, 'el override de la entrada manda');
  is(coverage.effectiveDemand(doc, { ...e, typeId: null, demandOverride: null }, '2025-06-02'), doc.settings.coverage.defaultDemand);
});

test('un festivo con demanda 0 no genera huecos', () => {
  const doc = coverageDoc();
  doc.dayMeta['2025-06-20'] = model.normalizeDayMeta({ dayType: 'holiday', demandOverride: 0 });
  const day = coverage.analyzeDate(doc, '2025-06-20');
  is(day.gapMin, 0);
  is(day.status, 'covered');
  is(day.gaps.length, 0);
});

test('whoIsNow devuelve quién está trabajando y cuánto le queda', () => {
  const doc = coverageDoc();
  const manana = doc.shiftTypes.find((s) => s.code === 'M');
  manana.blocks = [{ start: '09:00', end: '17:00' }];
  const now = new Date(2025, 5, 2, 10, 30);
  const list = coverage.whoIsNow(doc, now);
  is(list.length, 1);
  is(list[0].member.name, 'Ana');
  is(list[0].minutesLeft, 390);
  close(list[0].progress, 90 / 480, 0.01);
});

test('whoIsNow detecta el turno de noche que empezó ayer', () => {
  const doc = coverageDoc();
  const ahora = new Date(2025, 5, 3, 2, 0); // madrugada del día 3
  const list = coverage.whoIsNow(doc, ahora);
  // El turno de noche empieza el 3 a las 22:00, así que de madrugada no hay nadie
  is(list.length, 0);

  const docs2 = coverageDoc();
  docs2.entries = [model.createEntry({
    id: 'e9', memberId: 'm_ana', date: '2025-06-02',
    typeId: docs2.shiftTypes.find((s) => s.code === 'N').id,
  })];
  const list2 = coverage.whoIsNow(docs2, new Date(2025, 5, 3, 2, 0));
  is(list2.length, 1, 'a las 2 de la madrugada sigue trabajando el turno de noche de ayer');
  is(list2[0].minutesLeft, 240);
  is(list2[0].startDate ?? list2[0].entry.date, '2025-06-02');
});

test('nextShift encuentra el próximo turno de una persona', () => {
  const doc = coverageDoc();
  const n = coverage.nextShift(doc, 'm_ana', new Date(2025, 5, 2, 6, 0));
  is(n.startDate, '2025-06-02');
  is(n.minutesUntil, 150);
  is(n.type.code, 'M');

  const n2 = coverage.nextShift(doc, 'm_ana', new Date(2025, 5, 2, 12, 0));
  is(n2.startDate, '2025-06-03', 'si ya está trabajando, el próximo es el de mañana');
  is(n2.type.code, 'N');
});

test('nextShift ignora los turnos que no cuentan horas (vacaciones)', () => {
  const doc = coverageDoc();
  doc.entries = [model.createEntry({
    memberId: 'm_ana', date: '2025-06-20',
    typeId: doc.shiftTypes.find((s) => s.code === 'V').id,
  })];
  is(coverage.nextShift(doc, 'm_ana', new Date(2025, 5, 2)), null);
});

test('summarize agrega horas por miembro y por tipo', () => {
  const doc = coverageDoc();
  const s = coverage.summarize(doc, { from: '2025-06-01', to: '2025-06-30' });
  is(s.shifts, 3, 'tres turnos en total (dos de Ana, uno de Luis)');
  is(s.totalMinutes, 510 + 510 + 480, 'mañana 8,5 h + tarde 8,5 h + noche 8 h');
  is(s.workDays, 2, 'Ana trabaja dos días distintos; Luis uno');
  is(s.overnight, 2, 'la tarde y la noche cruzan medianoche');
  is(s.perMember.length, 2);
  is(s.perMember[0].member.name, 'Ana', 'Ana acumula más horas');
  is(s.perMember[0].minutes, 510 + 480);
  is(s.perMember[0].shifts, 2);
  is(s.perMember[1].minutes, 510);
  is(s.distinctMembers, 2);
  is(s.perType.length, 3, 'un tipo distinto por turno');

  const soloAna = coverage.summarize(doc, { from: '2025-06-01', to: '2025-06-30', memberId: 'm_ana' });
  is(soloAna.totalMinutes, 990);
  is(soloAna.perMember.length, 1);
  is(soloAna.averageMinutesPerMember, 990, 'con un solo miembro la media es su total');
});

test('summarize cuenta las ausencias como turnos pero no como horas', () => {
  const doc = coverageDoc();
  doc.entries.push(model.createEntry({
    memberId: 'm_ana', date: '2025-06-15',
    typeId: doc.shiftTypes.find((s) => s.code === 'V').id,
  }));
  const s = coverage.summarize(doc, { from: '2025-06-01', to: '2025-06-30', memberId: 'm_ana' });
  is(s.shifts, 3, 'las vacaciones cuentan como turno del cuadrante');
  is(s.totalMinutes, 990, 'pero no suman horas trabajadas');
  is(s.workDays, 2, 'ni cuentan como día trabajado');

  // Y también aparecen en el análisis diario
  const dia = coverage.analyzeDate(doc, '2025-06-15');
  is(dia.off.length, 1, 'la ausencia se ve en el día');
  is(dia.working.length, 0);
  is(dia.off[0].zeroLength, true);
});

test('summarizeMonth cubre el mes completo', () => {
  const doc = coverageDoc();
  const s = coverage.summarizeMonth(doc, '2025-06');
  is(s.from, '2025-06-01');
  is(s.to, '2025-06-30');
  is(s.totalMinutes, 1500);
});

test('weeklyBreakdown agrupa por semanas ISO', () => {
  const doc = coverageDoc();
  const weeks = coverage.weeklyBreakdown(doc, { from: '2025-06-01', to: '2025-06-30' });
  is(weeks.length, 1, 'las tres entradas caen en la semana del 2 de junio');
  is(weeks[0].weekStart, '2025-06-02');
  is(weeks[0].week, 23, 'semana ISO 23 de 2025');
  is(weeks[0].minutes, 1500);
  is(weeks[0].shifts, 3);
  is(weeks[0].days, 2, 'dos días distintos con turno');
});

test('findConflicts detecta solapamientos de la misma persona', () => {
  const doc = coverageDoc();
  const manana = doc.shiftTypes.find((s) => s.code === 'M');
  doc.entries.push(model.createEntry({ id: 'dup', memberId: 'm_ana', date: '2025-06-02', typeId: manana.id }));
  const conflicts = coverage.findConflicts(doc, { from: '2025-06-01', to: '2025-06-30' });
  is(conflicts.length, 1);
  is(conflicts[0].member.name, 'Ana');
});

test('findConflicts no se inventa conflictos con turnos contiguos', () => {
  const doc = model.emptyDocument();
  doc.members = [model.createMember('Ana', { id: 'm_ana' })];
  doc.meId = 'm_ana';
  const partido = doc.shiftTypes.find((s) => s.code === 'P'); // 08:30–13:00 y 17:00–21:00
  doc.entries = [
    model.createEntry({ id: 'x1', memberId: 'm_ana', date: '2025-06-02', typeId: partido.id }),
  ];
  is(coverage.findConflicts(doc, { from: '2025-06-01', to: '2025-06-30' }).length, 0);
});

test('coverageRate devuelve la fracción cubierta', () => {
  const doc = coverageDoc();
  const rate = coverage.coverageRate(doc, '2025-06-02', '2025-06-02');
  close(rate, (1440 - 510) / 1440, 0.001);
});

test('mergeIntervals fusiona y ordena', () => {
  eq(coverage.mergeIntervals([
    { start: 100, end: 200 },
    { start: 150, end: 300 },
    { start: 400, end: 500 },
  ]), [{ start: 100, end: 300 }, { start: 400, end: 500 }]);
  eq(coverage.mergeIntervals([]), []);
});

/* ================================================================== *
 * store.js
 * ================================================================== */

suite('store.js — estado reactivo');

function freshStore() {
  const doc = model.emptyDocument();
  const ana = model.createMember('Ana', { id: 'm_ana', role: 'owner' });
  doc.members = [ana];
  doc.meId = 'm_ana';
  return storeMod.createStore(doc);
}

test('subscribe notifica y permite darse de baja', () => {
  const store = freshStore();
  let calls = 0;
  const off = store.subscribe(() => { calls++; });
  store.actions.addMember({ name: 'Luis' });
  is(calls, 1);
  off();
  store.actions.addMember({ name: 'Eva' });
  is(calls, 1, 'tras la baja ya no se notifica');
});

test('subscribe con immediate entrega el estado actual', () => {
  const store = freshStore();
  let seen = null;
  store.subscribe((doc) => { seen = doc; }, { immediate: true });
  is(seen.members.length, 1);
});

test('addMember crea el miembro y sube la revisión', () => {
  const store = freshStore();
  const before = store.doc.rev;
  const m = store.actions.addMember({ name: 'Luis' });
  is(store.doc.members.length, 2);
  is(store.doc.members[1].name, 'Luis');
  is(store.doc.members[1].initials, 'LU');
  ok(store.doc.rev > before);
  is(store.doc.members[1].id, m.id);
});

test('addMembers ignora duplicados y vacíos', () => {
  const store = freshStore();
  const created = store.actions.addMembers(['Luis', 'luis', '  ', 'Eva', 'Ana']);
  is(created.length, 2, 'Luis y Eva; "luis" y "Ana" se descartan');
  is(store.doc.members.length, 3);
});

test('setEntry asigna, actualiza y borra al quedar vacío', () => {
  const store = freshStore();
  const manana = store.doc.shiftTypes.find((s) => s.code === 'M');
  ok(store.actions.setEntry({ memberId: 'm_ana', date: '2025-06-02', typeId: manana.id }));
  is(store.doc.entries.length, 1);

  // Asignar otro tipo el mismo día reemplaza, no duplica
  const tarde = store.doc.shiftTypes.find((s) => s.code === 'T');
  store.actions.setEntry({ memberId: 'm_ana', date: '2025-06-02', typeId: tarde.id });
  is(store.doc.entries.length, 1);
  is(store.doc.entries[0].typeId, tarde.id);

  // Sin tipo ni bloques ni notas → se elimina
  store.actions.setEntry({ memberId: 'm_ana', date: '2025-06-02', typeId: null });
  is(store.doc.entries.length, 0);
});

test('setEntry rechaza miembros y tipos inexistentes', () => {
  const store = freshStore();
  is(store.actions.setEntry({ memberId: 'fantasma', date: '2025-06-02', typeId: null }), false);
  is(store.doc.entries.length, 0);
  store.actions.setEntry({ memberId: 'm_ana', date: '2025-06-02', typeId: 'no-existe' });
  is(store.doc.entries.length, 0, 'sin tipo ni bloques no se crea nada');
});

test('setEntryRange aplica solo los días de la semana pedidos', () => {
  const store = freshStore();
  const manana = store.doc.shiftTypes.find((s) => s.code === 'M');
  store.actions.setEntryRange({
    memberId: 'm_ana',
    from: '2025-06-02',
    to: '2025-06-15',
    typeId: manana.id,
    weekdays: [1, 2, 3, 4, 5], // lunes a viernes
  });
  is(store.doc.entries.length, 10, 'dos semanas laborables completas');
  ok(store.doc.entries.every((e) => ![0, 6].includes(new Date(`${e.date}T00:00:00`).getDay())));
});

test('setEntryMany asigna a varios en un solo paso de historial', () => {
  const store = freshStore();
  store.actions.addMembers(['Luis', 'Eva']);
  const ids = store.doc.members.map((m) => m.id);
  const manana = store.doc.shiftTypes.find((s) => s.code === 'M');
  const n = store.actions.setEntryMany({ memberIds: ids, date: '2025-06-02', typeId: manana.id });
  is(n, 3);
  is(store.doc.entries.length, 3);
  is(store.historySize(), 2, 'una entrada por añadir miembros y una por la asignación múltiple');
});

test('copyRange traslada el cuadrante una semana después', () => {
  const store = freshStore();
  const manana = store.doc.shiftTypes.find((s) => s.code === 'M');
  store.actions.setEntryRange({ memberId: 'm_ana', from: '2025-06-02', to: '2025-06-06', typeId: manana.id });
  const copied = store.actions.copyRange({ from: '2025-06-02', to: '2025-06-06', targetFrom: '2025-06-09' });
  is(copied, 5);
  is(store.doc.entries.length, 10);
  is(store.doc.entries.filter((e) => e.date >= '2025-06-09').length, 5);
});

test('removeMember reasigna los turnos si se pide', () => {
  const store = freshStore();
  const luis = store.actions.addMember({ name: 'Luis' });
  const manana = store.doc.shiftTypes.find((s) => s.code === 'M');
  store.actions.setEntry({ memberId: luis.id, date: '2025-06-02', typeId: manana.id });
  store.actions.removeMember(luis.id, { reassignTo: 'm_ana' });
  is(store.doc.members.length, 1);
  is(store.doc.entries.length, 1);
  is(store.doc.entries[0].memberId, 'm_ana', 'el turno no se pierde');
});

test('removeMember no deja el calendario sin nadie', () => {
  const store = freshStore();
  is(store.actions.removeMember('m_ana'), false);
  is(store.doc.members.length, 1);
});

test('removeShiftType conserva las horas como turno suelto', () => {
  const store = freshStore();
  const manana = store.doc.shiftTypes.find((s) => s.code === 'M');
  store.actions.setEntry({ memberId: 'm_ana', date: '2025-06-02', typeId: manana.id });
  store.actions.removeShiftType(manana.id);
  is(store.doc.shiftTypes.find((s) => s.id === manana.id), undefined);
  is(store.doc.entries.length, 1);
  is(store.doc.entries[0].typeId, null);
  eq(store.doc.entries[0].blocks, [{ start: '08:30', end: '17:00' }], 'los bloques quedan congelados');
  is(model.entryMinutes(store.doc, store.doc.entries[0]), 510);
});

test('undo y redo restauran el estado', () => {
  const store = freshStore();
  store.actions.addMember({ name: 'Luis' });
  is(store.doc.members.length, 2);
  is(store.canUndo(), true);
  store.undo();
  is(store.doc.members.length, 1);
  is(store.canRedo(), true);
  store.redo();
  is(store.doc.members.length, 2);
});

test('undo del setEntry devuelve el turno anterior', () => {
  const store = freshStore();
  const manana = store.doc.shiftTypes.find((s) => s.code === 'M');
  const tarde = store.doc.shiftTypes.find((s) => s.code === 'T');

  // Dos cambios seguidos sobre el MISMO hueco se agrupan en un solo paso de
  // deshacer (el usuario percibe una única acción sobre ese hueco).
  store.actions.setEntry({ memberId: 'm_ana', date: '2025-06-02', typeId: manana.id });
  store.actions.setEntry({ memberId: 'm_ana', date: '2025-06-02', typeId: tarde.id });
  is(store.doc.entries.length, 1);
  is(store.doc.entries[0].typeId, tarde.id);
  is(store.historySize(), 1, 'los dos cambios del mismo hueco son un solo paso');
  store.undo();
  is(store.doc.entries.length, 0, 'deshacer revierte la secuencia completa de ese hueco');

  // Cambios sobre huecos distintos SÍ son pasos independientes
  store.redo();
  is(store.doc.entries[0].typeId, tarde.id, 'rehacer la recupera tal cual quedó');
  store.actions.setEntry({ memberId: 'm_ana', date: '2025-06-04', typeId: manana.id });
  is(store.historySize(), 2);
  store.undo();
  is(store.doc.entries.length, 1, 'deshacer quita solo el último hueco tocado');
  is(store.doc.entries[0].date, '2025-06-02');
  store.undo();
  is(store.doc.entries.length, 0);
});

test('deshacer respeta los cambios de personas distintas', () => {
  const store = freshStore();
  const luis = store.actions.addMember({ name: 'Luis' }).id;
  const manana = store.doc.shiftTypes.find((s) => s.code === 'M');
  store.actions.setEntry({ memberId: 'm_ana', date: '2025-06-03', typeId: manana.id });
  store.actions.setEntry({ memberId: luis, date: '2025-06-03', typeId: manana.id });
  is(store.doc.entries.length, 2);
  store.undo();
  is(store.doc.entries.length, 1, 'solo se quita el turno de Luis');
  is(store.doc.entries[0].memberId, 'm_ana');
});

test('undo en un store vacío no rompe', () => {
  const store = freshStore();
  is(store.undo(), false);
  is(store.redo(), false);
  is(store.undoLabel(), null);
});

test('las acciones que no cambian nada no ensucian el historial', () => {
  const store = freshStore();
  store.actions.setEntry({ memberId: 'fantasma', date: '2025-06-02', typeId: null });
  is(store.historySize(), 0);
  is(store.canUndo(), false);
});

test('batch agrupa y notifica una sola vez', () => {
  const store = freshStore();
  let calls = 0;
  store.subscribe(() => { calls++; });
  store.batch('varias cosas', () => {
    store.actions.addMember({ name: 'Luis' });
    store.actions.addMember({ name: 'Eva' });
  });
  is(calls, 1, 'una sola notificación');
  is(store.doc.members.length, 3);
});

test('applyPattern rellena el rango con el ciclo', () => {
  const store = freshStore();
  const codes = ['M', 'T', 'L'];
  const cycle = codes.map((c) => ({ typeId: store.doc.shiftTypes.find((s) => s.code === c).id }));
  const p = store.actions.addPattern({ name: '3 turnos', cycle, stepDays: 1, startDate: '2025-06-02' });
  const n = store.actions.applyPattern({ patternId: p.id, memberId: 'm_ana', from: '2025-06-02', to: '2025-06-07' });
  is(n, 6);
  const byDate = Object.fromEntries(store.doc.entries.map((e) => [e.date, e.typeId]));
  is(byDate['2025-06-02'], cycle[0].typeId);
  is(byDate['2025-06-03'], cycle[1].typeId);
  is(byDate['2025-06-04'], cycle[2].typeId);
  is(byDate['2025-06-05'], cycle[0].typeId, 'el ciclo vuelve a empezar');
});

test('rotateTeam desplaza el cuadrante entre compañeros', () => {
  const store = freshStore();
  store.actions.addMembers(['Luis', 'Eva']);
  const [ana, luis, eva] = store.doc.members.map((m) => m.id);
  const manana = store.doc.shiftTypes.find((s) => s.code === 'M');
  const noche = store.doc.shiftTypes.find((s) => s.code === 'N');
  store.actions.setEntry({ memberId: ana, date: '2025-06-02', typeId: manana.id });
  store.actions.setEntry({ memberId: luis, date: '2025-06-02', typeId: noche.id });

  store.actions.rotateTeam({ memberIds: [ana, luis, eva], from: '2025-06-02', to: '2025-06-02', direction: 1 });
  const anaEntry = store.doc.entries.find((e) => e.memberId === ana);
  const luisEntry = store.doc.entries.find((e) => e.memberId === luis);
  is(luisEntry.typeId, manana.id, 'Luis recibe el turno de Ana');
  is(luisEntry.memberId, luis);
  ok(!anaEntry || anaEntry.typeId !== manana.id, 'Ana ya no tiene su turno de mañana');
  is(store.doc.entries.filter((e) => e.date === '2025-06-02').length, 2, 'no se duplican turnos');
});

test('setDayMeta guarda y limpia cuando vuelve a la normalidad', () => {
  const store = freshStore();
  store.actions.setDayMeta('2025-06-05', { dayType: 'holiday', label: 'Corpus' });
  is(store.doc.dayMeta['2025-06-05'].label, 'Corpus');
  store.actions.setDayMeta('2025-06-05', { dayType: 'normal', label: '' });
  is(store.doc.dayMeta['2025-06-05'], undefined, 'sin contenido se borra la entrada');
});

test('toggleHoliday alterna el festivo', () => {
  const store = freshStore();
  store.actions.toggleHoliday('2025-06-05');
  is(store.doc.dayMeta['2025-06-05'].dayType, 'holiday');
  store.actions.toggleHoliday('2025-06-05');
  is(store.doc.dayMeta['2025-06-05'], undefined);
});

test('updateSettings fusiona en profundidad', () => {
  const store = freshStore();
  store.actions.updateSettings({ notifications: { minutesBefore: 15 } });
  is(store.doc.settings.notifications.minutesBefore, 15);
  is(store.doc.settings.notifications.briefingHour, '20:00', 'el resto se conserva');
});

test('replaceDocument normaliza lo que entra', () => {
  const store = freshStore();
  store.replaceDocument({ members: 'basura', entries: [{}] });
  is(store.doc.schema, 4);
  ok(Array.isArray(store.doc.members));
});

test('importDocument con merge no pisa lo existente', () => {
  const store = freshStore();
  const manana = store.doc.shiftTypes.find((s) => s.code === 'M');
  store.actions.setEntry({ memberId: 'm_ana', date: '2025-06-02', typeId: manana.id });

  const other = model.bootstrapDocument({ name: 'Ana', coworkers: ['Luis'] });
  const otherManana = other.shiftTypes.find((s) => s.code === 'M');
  other.entries = [model.createEntry({ memberId: other.meId, date: '2025-06-02', typeId: otherManana.id })];
  other.entries.push(model.createEntry({ memberId: other.members[1].id, date: '2025-06-03', typeId: otherManana.id }));

  store.actions.importDocument(other, { merge: true });
  is(store.doc.members.length, 2, 'no duplica a Ana, añade a Luis');
  is(store.doc.entries.length, 2, 'la entrada del 2 ya existía; se añade la del 3');
  is(store.doc.entries.filter((e) => e.date === '2025-06-02').length, 1);
  is(store.doc.entries.filter((e) => e.date === '2025-06-03').length, 1);
});

test('clearSchedule vacía los turnos pero conserva el equipo', () => {
  const store = freshStore();
  const manana = store.doc.shiftTypes.find((s) => s.code === 'M');
  store.actions.setEntry({ memberId: 'm_ana', date: '2025-06-02', typeId: manana.id });
  store.actions.clearSchedule();
  is(store.doc.entries.length, 0);
  is(store.doc.members.length, 1);
  ok(store.doc.shiftTypes.length > 0);
});

test('memoSelector cachea por revisión', () => {
  let computed = 0;
  const sel = storeMod.memoSelector((doc) => { computed++; return doc.members.length; });
  const store = freshStore();
  sel(store.doc);
  sel(store.doc);
  is(computed, 1, 'la segunda llamada usa la caché');
  store.actions.addMember({ name: 'Luis' });
  sel(store.doc);
  is(computed, 2, 'al cambiar la revisión se recalcula');
});

/* ================================================================== *
 * storage.js
 * ================================================================== */

suite('storage.js — persistencia');

test('writeDocument y loadDocument hacen ida y vuelta', () => {
  memoryStore.clear();
  const doc = model.bootstrapDocument({ name: 'Ana', coworkers: ['Luis'] });
  const manana = doc.shiftTypes.find((s) => s.code === 'M');
  doc.entries = [model.createEntry({ memberId: doc.meId, date: '2025-06-02', typeId: manana.id })];
  writeOk(storage.writeDocument(doc, { backup: false }));

  const loaded = storage.loadDocument();
  is(loaded.source, 'v4');
  is(loaded.migrated, false);
  is(loaded.doc.members.length, 2);
  is(loaded.doc.entries.length, 1);
  is(loaded.doc.entries[0].date, '2025-06-02');
});

test('loadDocument migra automáticamente el formato antiguo', () => {
  memoryStore.clear();
  localStorage.setItem(model.OLD_DB_KEY, JSON.stringify(LEGACY));
  const loaded = storage.loadDocument();
  is(loaded.source, 'legacy');
  is(loaded.migrated, true);
  is(loaded.doc.members.length, 3);
  is(loaded.doc.entries.length, 6);
  ok(loaded.legacySummary, 'informa del resumen de la migración');
  ok(storage.readLegacyBackup(), 'guarda una copia del blob antiguo');
  ok(localStorage.getItem(storage.KEY_DOC), 'deja el documento nuevo escrito');
});

test('loadDocument con localStorage vacío devuelve un documento nuevo', () => {
  memoryStore.clear();
  const loaded = storage.loadDocument();
  is(loaded.source, 'fresh');
  is(loaded.doc.entries.length, 0);
  ok(loaded.doc.shiftTypes.length > 0);
});

test('loadDocument sobrevive a un JSON corrupto', () => {
  memoryStore.clear();
  localStorage.setItem(storage.KEY_DOC, '{esto no es json');
  const loaded = storage.loadDocument();
  is(loaded.source, 'fresh');
  is(loaded.doc.schema, 4);
});

test('las copias de seguridad rotan', () => {
  memoryStore.clear();
  for (let i = 0; i < 5; i++) {
    const doc = model.bootstrapDocument({ name: `V${i}` });
    storage.writeDocument(doc);
  }
  const backups = storage.listBackups();
  is(backups.length, 3, 'se conservan tres copias');
  const restored = storage.readBackup(0);
  ok(restored, 'la copia más reciente es legible');
  ok(restored.members[0].name, 'contiene un documento real');
});

test('purgeLegacy borra el blob antiguo y conserva la copia', () => {
  memoryStore.clear();
  localStorage.setItem(model.OLD_DB_KEY, JSON.stringify(LEGACY));
  storage.purgeLegacy({ keepBackup: true });
  is(localStorage.getItem(model.OLD_DB_KEY), null);
  ok(storage.readLegacyBackup(), 'la copia de seguridad sigue ahí');
});

test('la sesión se guarda, se lee y caduca', () => {
  memoryStore.clear();
  is(storage.loadSession(), null);
  storage.saveSession({ userId: 'u1', email: 'a@b.c', accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3600000 });
  const s = storage.loadSession();
  is(s.email, 'a@b.c');
  is(storage.sessionExpired(s), false);
  is(storage.sessionExpired({ ...s, expiresAt: Date.now() - 1000 }), true);
  storage.saveSession(null);
  is(storage.loadSession(), null);
});

test('loadUI y saveUI fusionan preferencias', () => {
  memoryStore.clear();
  const ui = storage.loadUI();
  is(ui.lastView, 'today');
  storage.saveUI({ lastView: 'calendar', calendarMode: 'team' });
  const ui2 = storage.loadUI();
  is(ui2.lastView, 'calendar');
  is(ui2.calendarMode, 'team');
  is(ui2.showOnlyMine, false, 'el resto conserva los valores por defecto');
});

test('storageStats informa del espacio ocupado', () => {
  memoryStore.clear();
  storage.writeDocument(model.bootstrapDocument({ name: 'Ana' }), { backup: false });
  const stats = storage.storageStats();
  ok(stats.bytes > 0);
  ok(stats.detail.some((d) => d.key === storage.KEY_DOC));
  is(stats.backend, 'localStorage');
});

test('clearAll respeta las preferencias de interfaz', () => {
  memoryStore.clear();
  storage.writeDocument(model.bootstrapDocument({ name: 'Ana' }));
  storage.saveUI({ lastView: 'calendar' });
  storage.clearAll();
  is(localStorage.getItem(storage.KEY_DOC), null);
  is(storage.loadUI().lastView, 'calendar', 'la preferencia visual se conserva');
});

function writeOk(result) {
  if (result === false) throw new Error('no se pudo escribir en el almacenamiento');
}

/* ================================================================== *
 * utils.js
 * ================================================================== */

suite('utils.js');

test('esc neutraliza HTML peligroso', () => {
  is(utils.esc('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  is(utils.esc("O'Neill & hijos"), 'O&#39;Neill &amp; hijos');
  is(utils.esc(null), '');
});

test('fold quita acentos y mayúsculas', () => {
  is(utils.fold('  José MARÍA  '), 'jose maria');
  is(utils.fold('Ñoño'), 'nono');
});

test('toCSV escapa comillas, separadores y saltos de línea', () => {
  const csv = utils.toCSV(['Nombre', 'Nota'], [['Ana; la jefa', 'Dijo "hola"'], ['Luis', 'a\nb']], { bom: false });
  is(csv, 'Nombre;Nota\r\n"Ana; la jefa";"Dijo ""hola"""\r\nLuis;"a\nb"');
});

test('parseCSV detecta el separador y respeta las comillas', () => {
  eq(utils.parseCSV('a;b;c\r\n1;2;3'), [['a', 'b', 'c'], ['1', '2', '3']]);
  eq(utils.parseCSV('a,b\n"x,y",z'), [['a', 'b'], ['x,y', 'z']]);
  eq(utils.parseCSV('a,b\n"con ""comillas""",z'), [['a', 'b'], ['con "comillas"', 'z']]);
  eq(utils.parseCSV(''), []);
});

test('csvToObjects normaliza las cabeceras', () => {
  const { objects } = utils.csvToObjects('Nombre;Fecha de inicio\nAna;2025-06-02');
  is(objects.length, 1);
  is(objects[0].nombre, 'Ana');
  is(objects[0].fechadeinicio, '2025-06-02');
});

test('readableOn elige texto claro u oscuro según el fondo', () => {
  is(utils.readableOn('#FFFFFF'), '#101319');
  is(utils.readableOn('#000000'), '#FFFFFF');
  is(utils.readableOn('#F2A33C'), '#101319');
  is(utils.readableOn('#5B8DEF'), '#FFFFFF');
});

test('withAlpha y shade producen colores válidos', () => {
  is(utils.withAlpha('#F2A33C', 0.15), 'rgba(242,163,60,0.15)');
  is(utils.shade('#000000', 1), '#ffffff');
  is(utils.shade('#ffffff', -1), '#000000');
  is(utils.shade('#808080', 0), '#808080');
});

test('clamp, sum y groupBy', () => {
  is(utils.clamp(5, 0, 3), 3);
  is(utils.clamp(-5, 0, 3), 0);
  is(utils.sum([{ n: 1 }, { n: 2 }], (x) => x.n), 3);
  const g = utils.groupBy([1, 2, 3, 4], (n) => (n % 2 ? 'impar' : 'par'));
  eq(g.get('impar'), [1, 3]);
  eq(g.get('par'), [2, 4]);
});

test('initials, plural y formatBytes', () => {
  is(utils.initials('Ana María'), 'AM');
  is(utils.initials('Beyoncé'), 'BE');
  is(utils.initials(''), '?');
  is(utils.plural(1, 'turno', 'turnos'), '1 turno');
  is(utils.plural(3, 'turno', 'turnos'), '3 turnos');
  is(utils.formatBytes(512), '512 B');
  is(utils.formatBytes(2048), '2.0 KB');
});

test('debounce agrupa llamadas', async () => {
  let calls = 0;
  const fn = utils.debounce(() => { calls++; }, 10);
  fn(); fn(); fn();
  is(calls, 0, 'todavía no se ha llamado');
  await utils.sleep(30);
  is(calls, 1);
});

/* ================================================================== *
 * Resumen
 * ================================================================== */

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
