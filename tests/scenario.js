/**
 * HORUS — tests/scenario.js
 * Prueba de escenario realista: un equipo de 5 personas, varias semanas de
 * turnos rotativos, turnos nocturnos, festivos, vacaciones y solapamientos.
 * Comprueba la coherencia de los cálculos, no tanto las unidades.
 *
 * Ejecutar: node tests/scenario.js
 */

globalThis.window = globalThis.window || {};
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
  clear: () => mem.clear(),
};
globalThis.window.localStorage = globalThis.localStorage;

const model = await import('../js/core/model.js');
const coverage = await import('../js/core/coverage.js');
const date = await import('../js/core/date.js');
const { createStore } = await import('../js/core/store.js');

let problems = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    problems++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const is = (a, b, label) => check(label, a === b, `esperado ${JSON.stringify(b)}, recibido ${JSON.stringify(a)}`);

console.log('\n\x1b[1m\x1b[36m1. Montar un equipo de 5 con turnos rotativos\x1b[0m');

const store = createStore();
store.actions.updateSettings({ coverage: { defaultDemand: 2 } });

// El documento arranca con un miembro ("Yo"); lo renombramos y añadimos el resto.
const meId = store.doc.meId;
store.actions.updateMember(meId, { name: 'Ana Ruiz' });
store.actions.addMembers(['Luis Peña', 'Eva Moral', 'Iván Sáez', 'Marta Gil']);
const members = store.doc.members.map((m) => m.id);
is(store.doc.members.length, 5, 'el equipo tiene 5 personas');
is(store.doc.members[0].initials, 'AR', 'las iniciales se recalculan al renombrar');

const code = (c) => store.doc.shiftTypes.find((s) => s.code === c);
const M = code('M'); const T = code('T'); const N = code('N'); const L = code('L'); const V = code('V');

// Dos semanas de rotación sobre 5 personas: M → T → N → L → V
const MONDAY = '2025-06-02';
store.batch('pintar dos semanas de rotación', () => {
  const pattern = [M.id, T.id, N.id, L.id, V.id];
  for (let day = 0; day < 14; day++) {
    const d = date.addDays(MONDAY, day);
    members.forEach((id, i) => {
      store.actions.setEntry({ memberId: id, date: d, typeId: pattern[(i + day) % pattern.length] });
    });
  }
});

is(store.doc.entries.length, 70, '14 días × 5 personas');
// El lunes cada persona tiene un turno distinto: M, T, N, L y V.
// Trabajan 3 (mañana, tarde y noche): L es libre y V son vacaciones.
const painted = coverage.analyzeDate(store.doc, MONDAY);
is(painted.headsOnShift, 3, 'el lunes trabajan 3: uno libre y otro de vacaciones no cuentan');
is(painted.working.length, 3, 'solo los turnos con horas cuentan como cobertura');
is(painted.off.length, 2, 'libre y vacaciones quedan fuera del cómputo');

console.log('\n\x1b[1m\x1b[36m2. Coherencia de horas\x1b[0m');

const month = coverage.summarizeMonth(store.doc, '2025-06');
const manualTotal = store.doc.entries
  .filter((e) => e.date >= '2025-06-01' && e.date <= '2025-06-30')
  .reduce((a, e) => a + model.entryMinutes(store.doc, e), 0);
is(month.totalMinutes, manualTotal, 'el total del resumen coincide con la suma entrada a entrada');
is(month.shifts, 70, 'cuenta los 70 turnos (incluidos los libres)');
check('las horas trabajadas son menores que los turnos × 8h porque hay libres',
  month.totalMinutes < 70 * 8 * 60, `${month.totalMinutes} min`);

const sumMembers = month.perMember.reduce((a, m) => a + m.minutes, 0);
is(sumMembers, month.totalMinutes, 'la suma por persona cuadra con el total');

const sumTypes = month.perType.reduce((a, t) => a + t.minutes, 0);
is(sumTypes, month.totalMinutes, 'la suma por tipo cuadra con el total');

console.log('\n\x1b[1m\x1b[36m3. Turnos nocturnos a caballo entre dos días\x1b[0m');

// Ana y Luis: noche del lunes 2 (22:00 → 06:00 del martes 3)
store.actions.clearSchedule();
store.actions.setEntry({ memberId: members[0], date: '2025-06-02', typeId: N.id });
store.actions.setEntry({ memberId: members[1], date: '2025-06-02', typeId: N.id });
is(store.doc.entries.length, 2, 'solo hay dos turnos en el cuadrante');

const noche2 = coverage.analyzeDate(store.doc, '2025-06-02');
is(noche2.working.length, 2, 'el lunes empiezan dos turnos de noche');
check('el turno de noche del lunes ocupa 22:00→24:00 del lunes',
  noche2.working.every((p) => p.start === 1320 && p.end === 1440 && !p.continuedFromPrevDay));

const noche3 = coverage.analyzeDate(store.doc, '2025-06-03');
is(noche3.working.length, 2, 'el martes hereda los dos turnos de noche');
check('cada uno cubre 00:00→06:00 del martes',
  noche3.working.every((p) => p.start === 0 && p.end === 360 && p.continuedFromPrevDay));

// Quién está de guardia a las 03:00 del martes
const deMadrugada = coverage.whoIsNow(store.doc, new Date(2025, 5, 3, 3, 0));
is(deMadrugada.length, 2, 'a las 03:00 hay dos personas trabajando');
is(Math.round(deMadrugada[0].minutesLeft), 180, 'les quedan 3 horas');
is(deMadrugada[0].continued, true, 'y se sabe que vienen del día anterior');

// A las 12:00 del martes no hay nadie de noche
const aMediodia = coverage.whoIsNow(store.doc, new Date(2025, 5, 3, 12, 0));
is(aMediodia.length, 0, 'a mediodía nadie del turno de noche sigue trabajando');

console.log('\n\x1b[1m\x1b[36m4. Detección de huecos de cobertura\x1b[0m');

// Un día con una sola persona de 09:00 a 13:00 y demanda de 2
store.actions.clearSchedule();
const solo = code('M');
const custom = store.actions.addShiftType({ code: 'S1', label: 'Solo mañana', hex: '#4FC3F7', blocks: [{ start: '09:00', end: '13:00' }], demand: 2 });
store.actions.setEntry({ memberId: members[0], date: '2025-06-10', typeId: custom.id });

const flaco = coverage.analyzeDate(store.doc, '2025-06-10');
is(flaco.gaps.length, 2, 'hay dos huecos: antes y después del turno');
is(flaco.gaps[0].start, 0);
is(flaco.gaps[0].end, 540);
is(flaco.gaps[1].start, 780);
is(flaco.gaps[1].end, 1440);
is(flaco.gapMin, 540 + 660, 'los huecos suman 20 h');
const bajoMinimo = flaco.intervals.filter((i) => i.status === 'under');
is(bajoMinimo.length, 1, 'el tramo trabajado está bajo mínimos (1 persona, hacen falta 2)');
is(bajoMinimo[0].required, 2);

// Con dos personas ya no falta nadie
store.actions.setEntry({ memberId: members[1], date: '2025-06-10', typeId: custom.id });
const cubierto = coverage.analyzeDate(store.doc, '2025-06-10');
is(cubierto.intervals.filter((i) => i.status === 'under').length, 0, 'con dos personas se cubre la demanda');
is(cubierto.intervals.filter((i) => i.status === 'over').length, 0, 'y no sobra nadie');

console.log('\n\x1b[1m\x1b[36m5. El día pedido no se contamina de otros días\x1b[0m');

store.actions.clearSchedule();
store.actions.setEntry({ memberId: members[0], date: '2025-06-15', typeId: M.id });
const antes = coverage.analyzeDate(store.doc, '2025-06-14');
const despues = coverage.analyzeDate(store.doc, '2025-06-16');
is(antes.coverageMin, 0, 'el día anterior no tiene cobertura');
is(despues.coverageMin, 0, 'el día siguiente tampoco (la mañana no cruza medianoche)');
is(coverage.analyzeDate(store.doc, '2025-06-15').coverageMin, 510, 'el día del turno sí');

console.log('\n\x1b[1m\x1b[36m6. Festivos\x1b[0m');

store.actions.clearSchedule();
store.actions.setEntry({ memberId: members[0], date: '2025-06-15', typeId: M.id });

// Un festivo normal: hay servicio, así que la cobertura se evalúa igual
store.actions.toggleHoliday('2025-06-15');
const festivo = coverage.analyzeDate(store.doc, '2025-06-15');
is(festivo.isHoliday, true, 'el día queda marcado como festivo');
check('un festivo sigue mostrando sus huecos, porque puede hacer falta servicio',
  festivo.gapMin > 0 && festivo.status === 'gaps', `gapMin=${festivo.gapMin}`);

// Pero si se fija la demanda a 0, ese día NO necesita a nadie: ni huecos ni avisos
store.actions.setDayMeta('2025-06-15', { dayType: 'holiday', label: 'Festivo cerrado', demandOverride: 0 });
const cerrado = coverage.analyzeDate(store.doc, '2025-06-15');
is(cerrado.gapMin, 0, 'con demanda 0 no hay huecos que reportar');
is(cerrado.gaps.length, 0);
is(cerrado.status, 'covered', 'y la cobertura se considera resuelta');

// Un festivo cerrado y sin nadie asignado tampoco es una alarma
store.actions.clearSchedule();
store.actions.setDayMeta('2025-06-16', { dayType: 'holiday', demandOverride: 0 });
const vacioCerrado = coverage.analyzeDate(store.doc, '2025-06-16');
is(vacioCerrado.status, 'covered', 'un festivo cerrado sin turnos no es un problema');
is(vacioCerrado.working.length, 0);

// Un día laborable sin nadie SÍ es un problema
const vacioLaborable = coverage.analyzeDate(store.doc, '2025-06-17');
is(vacioLaborable.status, 'empty', 'un día laborable sin nadie se marca como vacío');
is(vacioLaborable.gapMin, 1440, 'y cuenta como 24 h descubiertas');

console.log('\n\x1b[1m\x1b[36m7. Conflictos y solapamientos\x1b[0m');

store.actions.clearSchedule();
store.actions.setEntry({ memberId: members[0], date: '2025-06-20', typeId: M.id });
store.actions.setEntry({ memberId: members[0], date: '2025-06-20', typeId: T.id });
is(store.doc.entries.filter((e) => e.date === '2025-06-20').length, 1, 'asignar dos turnos el mismo día reemplaza, no duplica');

// Para forzar un solapamiento real hay que crear dos entradas distintas
store.actions.updateEntry(store.doc.entries[0].id, { blocks: [{ start: '08:30', end: '17:00' }, { start: '16:00', end: '23:00' }] });
is(store.doc.entries[0].blocks.length, 1, 'los bloques solapados se fusionan al normalizar');
is(model.entryMinutes(store.doc, store.doc.entries[0]), date.blockMinutes({ start: '08:30', end: '23:00' }), 'y las horas no se cuentan dos veces');

console.log('\n\x1b[1m\x1b[36m8. Patrones de rotación\x1b[0m');

store.actions.clearSchedule();
// Cada paso del ciclo dura 2 días: M M T T N N L L → 8 días por vuelta completa
const pattern = store.actions.addPattern({
  name: '2 días por turno',
  cycle: [M.id, T.id, N.id, L.id].map((typeId) => ({ typeId })),
  stepDays: 2,
  startDate: '2025-07-01',
});
const applied = store.actions.applyPattern({ patternId: pattern.id, memberId: members[0], from: '2025-07-01', to: '2025-07-16' });
is(applied, 16, 'se aplica a los 16 días del rango');
const byDate = Object.fromEntries(store.doc.entries.map((e) => [e.date, e.typeId]));
is(byDate['2025-07-01'], M.id, 'día 1: mañana');
is(byDate['2025-07-02'], M.id, 'día 2: sigue mañana (2 días por turno)');
is(byDate['2025-07-03'], T.id, 'día 3: cambia a tarde');
is(byDate['2025-07-04'], T.id, 'día 4: sigue tarde');
is(byDate['2025-07-05'], N.id, 'día 5: noche');
is(byDate['2025-07-06'], N.id, 'día 6: sigue noche');
is(byDate['2025-07-07'], L.id, 'día 7: libre');
is(byDate['2025-07-08'], L.id, 'día 8: sigue libre');
is(byDate['2025-07-09'], M.id, 'día 9: la vuelta de 8 días empieza otra vez');
is(byDate['2025-07-17'], undefined, 'fuera del rango no se toca nada');

// El mismo patrón consultado directamente debe coincidir con lo aplicado
for (const d of ['2025-07-01', '2025-07-05', '2025-07-09', '2025-07-13']) {
  is(model.patternTypeForDate(store.doc.patterns[0], d), byDate[d], `patternTypeForDate coincide el ${d}`);
}

console.log('\n\x1b[1m\x1b[36m9. Rotación del equipo\x1b[0m');

store.actions.clearSchedule();
store.actions.setEntry({ memberId: members[0], date: '2025-08-01', typeId: M.id });
store.actions.setEntry({ memberId: members[1], date: '2025-08-01', typeId: T.id });
store.actions.setEntry({ memberId: members[2], date: '2025-08-01', typeId: N.id });
const before = Object.fromEntries(store.doc.entries.map((e) => [e.memberId, e.typeId]));
store.actions.rotateTeam({ memberIds: [members[0], members[1], members[2]], from: '2025-08-01', to: '2025-08-01', direction: 1 });
const after = Object.fromEntries(store.doc.entries.map((e) => [e.memberId, e.typeId]));
is(store.doc.entries.length, 3, 'no se crean ni se pierden turnos al rotar');
is(after[members[1]], before[members[0]], 'cada uno recibe el turno del anterior');
is(after[members[2]], before[members[1]]);
is(after[members[0]], before[members[2]], 'y el primero recibe el del último (la rotación da la vuelta)');

console.log('\n\x1b[1m\x1b[36m10. Copiar semanas\x1b[0m');

store.actions.clearSchedule();
store.actions.setEntryRange({ memberId: members[0], from: '2025-09-01', to: '2025-09-07', typeId: T.id, weekdays: [1, 2, 3, 4, 5] });
is(store.doc.entries.length, 5, 'se pintan los 5 días laborables');
store.actions.copyRange({ from: '2025-09-01', to: '2025-09-07', targetFrom: '2025-09-08' });
is(store.doc.entries.length, 10, 'la semana siguiente se copia');
is(store.doc.entries.filter((e) => e.date >= '2025-09-08' && e.date <= '2025-09-12').length, 5, 'con los mismos días de la semana');
check('y no se cuela el fin de semana',
  store.doc.entries.every((e) => e.date < '2025-09-13' || e.date > '2025-09-14'));

console.log('\n\x1b[1m\x1b[36m11. Deshacer / rehacer en grande\x1b[0m');

const revBefore = store.doc.rev;
const countBefore = store.doc.entries.length;
is(countBefore, 10, 'antes de borrar hay 10 turnos');
store.batch('borrar todo el mes', () => { store.actions.clearSchedule(); });
is(store.doc.entries.length, 0, 'el lote deja el cuadrante vacío');
check('la revisión avanza con el lote', store.doc.rev > revBefore, `${revBefore} → ${store.doc.rev}`);
store.undo();
is(store.doc.entries.length, countBefore, 'un solo deshacer recupera TODO el lote');
store.redo();
is(store.doc.entries.length, 0, 'rehacer vuelve a vaciarlo');
store.undo();
is(store.doc.entries.length, countBefore, 'y se puede deshacer otra vez');

console.log('\n\x1b[1m\x1b[36m12. Rendimiento\x1b[0m');

// 5 personas × 365 días = 1825 entradas
store.actions.clearSchedule();
const t0 = Date.now();
store.batch('un año entero', () => {
  const types = [M.id, T.id, N.id, L.id, V.id];
  for (let day = 0; day < 365; day++) {
    const d = date.addDays('2025-01-01', day);
    members.forEach((id, i) => {
      store.actions.setEntry({ memberId: id, date: d, typeId: types[(i + day) % types.length] });
    });
  }
});
const tPaint = Date.now() - t0;
is(store.doc.entries.length, 1825, 'se han creado 1825 entradas');

const t1 = Date.now();
const yearSum = coverage.summarize(store.doc, { from: '2025-01-01', to: '2025-12-31' });
const tSummarize = Date.now() - t1;

const t2 = Date.now();
const grid = date.monthGrid('2025-06');
const analyses = grid.map((c) => coverage.analyzeDate(store.doc, c.key));
const tMonth = Date.now() - t2;

console.log(`  · pintar 1825 entradas: ${tPaint} ms`);
console.log(`  · resumir un año: ${tSummarize} ms`);
console.log(`  · analizar 42 celdas de un mes: ${tMonth} ms`);
check('pintar un año por lotes tarda menos de 4000 ms', tPaint < 4000, `${tPaint} ms`);
check('analizar un mes tarda menos de 1500 ms', tMonth < 1500, `${tMonth} ms`);
check('el resumen anual es coherente', yearSum.totalMinutes > 0 && yearSum.perMember.length === 5);
is(analyses.length, grid.length, 'se analiza cada celda de la rejilla');

console.log('\n\x1b[1m\x1b[36m13. Resistencia a datos corruptos\x1b[0m');

const basura = [
  null, undefined, 0, '', 'texto', [], {},
  { members: [{ name: '   ' }], shiftTypes: [{ code: '', blocks: 'no' }] },
  { entries: new Array(10).fill({ date: 'x', memberId: 'y' }) },
  { dayMeta: { 'no-es-fecha': { dayType: 'holiday' } } },
  { settings: { notifications: 'no', hours: 42, coverage: [] } },
  { shiftTypes: [{ hex: 'javascript:alert(1)', code: '<script>' }] },
];
let survived = 0;
for (const junk of basura) {
  try {
    const doc = model.normalizeDocument(junk);
    if (doc.schema === 4 && Array.isArray(doc.entries)) survived++;
  } catch (err) {
    console.log(`    fallo con ${JSON.stringify(junk)?.slice(0, 40)}: ${err.message}`);
  }
}
is(survived, basura.length, 'todos los documentos corruptos se normalizan sin lanzar');

const docFinal = store.doc;
check('ningún color quedó sin sanear',
  docFinal.shiftTypes.every((s) => /^#[0-9A-F]{6}$/i.test(s.hex)));

console.log(`\n${'─'.repeat(58)}`);
if (problems === 0) {
  console.log('\x1b[1m\x1b[32m✓ Escenario completo sin problemas\x1b[0m');
} else {
  console.log(`\x1b[1m\x1b[31m✗ ${problems} problema(s) en el escenario\x1b[0m`);
}
console.log(`${'─'.repeat(58)}\n`);
process.exit(problems === 0 ? 0 : 1);
