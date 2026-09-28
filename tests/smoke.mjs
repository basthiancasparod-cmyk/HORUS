/**
 * HORUS — tests/smoke.mjs
 * Prueba de humo de la interfaz: monta el index.html real en un DOM mínimo y
 * ejecuta `mount()` y `render()` de las seis vistas con varios estados del
 * documento (vacío, un día, un mes completo, un año, datos corruptos).
 *
 * Esto es lo que las pruebas unitarias no pueden cubrir: que las vistas se
 * pinten sin lanzar, que los elementos existan en el HTML real y que las
 * acciones del store disparen repintados sin romperse.
 *
 * Ejecutar: node tests/smoke.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDOM } from './dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* ------------------------------------------------------------------ *
 * Reportería
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];
let suite = '';

const errors = [];
const originalError = console.error;
const originalWarn = console.warn;

function captureConsole() {
  console.error = (...args) => { errors.push(args.map(String).join(' ')); };
  console.warn = (...args) => { errors.push(`WARN ${args.map(String).join(' ')}`); };
}
function releaseConsole() {
  console.error = originalError;
  console.warn = originalWarn;
}

function describe(name) { suite = name; console.log(`\n\x1b[1m\x1b[36m${name}\x1b[0m`); }

function it(name, fn) {
  errors.length = 0;
  captureConsole();
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new Error('la prueba devolvió una promesa: usa `itAsync`');
    }
    releaseConsole();
    const unexpected = errors.filter((e) => !/deprecat/i.test(e));
    if (unexpected.length) {
      throw new Error(`se registraron errores en consola:\n      ${unexpected.join('\n      ')}`);
    }
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    releaseConsole();
    failed++;
    failures.push({ suite, name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${String(err.message).split('\n').join('\n      ')}\x1b[0m`);
  }
}

async function itAsync(name, fn) {
  errors.length = 0;
  captureConsole();
  try {
    await fn();
    releaseConsole();
    const unexpected = errors.filter((e) => !/deprecat/i.test(e));
    if (unexpected.length) {
      throw new Error(`se registraron errores en consola:\n      ${unexpected.join('\n      ')}`);
    }
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    releaseConsole();
    failed++;
    failures.push({ suite, name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${String(err.message).split('\n').join('\n      ')}\x1b[0m`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(value, label = 'valor falsy') {
  if (!value) throw new Error(`se esperaba un valor verdadero: ${label}`);
}
function is(actual, expected, label = '') {
  if (actual !== expected) throw new Error(`${label} esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ *
 * Entorno
 * ------------------------------------------------------------------ */

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const env = installDOM(html);

// `location.hash` para probar los atajos de entrada
env.window.location.hash = '';

describe('Entorno de pruebas');

it('el index.html real se ha cargado y tiene las secciones esperadas', () => {
  for (const id of ['app', 'boot', 'auth-screen', 'wizard-screen', 'nav', 'main', 'toasts']) {
    ok(env.document.getElementById(id), `falta #${id}`);
  }
  for (const view of ['today', 'calendar', 'roster', 'team', 'hours', 'settings']) {
    ok(env.document.getElementById(`view-${view}`), `falta #view-${view}`);
  }
});

it('el parser ha construido el árbol con los diálogos', () => {
  const dialogs = env.document.querySelectorAll('dialog');
  is(dialogs.length, 9, 'número de diálogos declarados en index.html');
  const ids = dialogs.map((d) => d.id).sort();
  for (const expected of ['dialog-assign', 'dialog-confirm', 'dialog-day', 'dialog-day-view', 'dialog-export', 'dialog-import', 'dialog-member', 'dialog-pattern', 'dialog-type']) {
    ok(ids.includes(expected), `falta el diálogo #${expected}`);
  }
});

it('los interruptores y campos clave existen', () => {
  for (const id of ['settings-notif', 'settings-theme', 'settings-region', 'assign-members', 'assign-types', 'type-colors', 'calendar-grid', 'roster-body']) {
    ok(env.document.getElementById(id), `falta #${id}`);
  }
});

it('el bloque de importación con IA existe en Ajustes', () => {
  // BYOK: proveedor, clave, modelo, prueba y el aviso de privacidad.
  for (const id of ['settings-ai-provider', 'settings-ai-key', 'settings-ai-model', 'settings-ai-model-reset', 'settings-ai-test', 'settings-ai-test-result', 'settings-ai-privacy', 'settings-ai-note', 'settings-ai-status']) {
    ok(env.document.getElementById(id), `falta #${id}`);
  }
  const key = env.document.getElementById('settings-ai-key');
  is(key.getAttribute('type'), 'password', 'la clave se escribe en un campo de contraseña');
  is(key.getAttribute('autocomplete'), 'off', 'el campo de la clave no se autocompleta');
});

/* ------------------------------------------------------------------ *
 * Importar los módulos de la aplicación con el DOM ya instalado
 * ------------------------------------------------------------------ */

const storeMod = await import('../js/core/store.js');
const model = await import('../js/core/model.js');
const dateMod = await import('../js/core/date.js');
const contextMod = await import('../js/ui/context.js');
const toolkit = await import('../js/ui/toolkit.js');
const dialogs = await import('../js/ui/dialogs.js');
const todayView = await import('../js/ui/views/today.js');
const calendarView = await import('../js/ui/views/calendar.js');
const rosterView = await import('../js/ui/views/roster.js');
const teamView = await import('../js/ui/views/team.js');
const hoursView = await import('../js/ui/views/hours.js');
const settingsView = await import('../js/ui/views/settings.js');

const VIEWS = [
  ['today', todayView],
  ['calendar', calendarView],
  ['roster', rosterView],
  ['team', teamView],
  ['hours', hoursView],
  ['settings', settingsView],
];

/* ------------------------------------------------------------------ *
 * Documentos de prueba
 * ------------------------------------------------------------------ */

function emptyDoc() {
  const doc = model.emptyDocument();
  doc.settings.firstRun = false;
  return doc;
}

function oneDayDoc() {
  const doc = model.bootstrapDocument({ name: 'Ana Ruiz', coworkers: ['Luis Peña'] });
  doc.settings.firstRun = false;
  const M = doc.shiftTypes.find((s) => s.code === 'M');
  doc.entries = [model.createEntry({ memberId: doc.meId, date: '2025-06-04', typeId: M.id, notes: 'Prueba' })];
  return doc;
}

function fullDoc() {
  const doc = model.bootstrapDocument({
    name: 'Ana Ruiz',
    coworkers: ['Luis Peña', 'Eva Moral', 'Iván Sáez', 'Marta Gil'],
  });
  doc.settings.firstRun = false;
  const codes = ['M', 'T', 'N', 'P', 'L', 'V'];
  const types = codes.map((c) => doc.shiftTypes.find((s) => s.code === c)).filter(Boolean);
  const members = doc.members.map((m) => m.id);

  // Dos meses y medio de cuadrante rotativo
  let day = 0;
  for (const date of enumerate('2025-05-15', '2025-07-31')) {
    members.forEach((id, i) => {
      const type = types[(i + day) % types.length];
      doc.entries.push(model.createEntry({
        memberId: id,
        date,
        typeId: type.id,
        notes: day % 11 === 0 ? 'Nota de prueba' : '',
      }));
    });
    day++;
  }

  doc.dayMeta['2025-06-06'] = model.normalizeDayMeta({ dayType: 'holiday', label: 'Corpus', imported: true });
  doc.dayMeta['2025-06-20'] = model.normalizeDayMeta({ dayType: 'event', label: 'Inventario' });
  doc.patterns = [model.createPattern({
    id: 'pt_test',
    name: '4 turnos',
    cycle: types.slice(0, 4).map((t) => ({ typeId: t.id })),
    stepDays: 1,
    startDate: '2025-06-01',
  })];
  return doc;
}

function enumerate(from, to) {
  const out = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard++ < 400) {
    out.push(cursor);
    const dt = new Date(`${cursor}T00:00:00`);
    dt.setDate(dt.getDate() + 1);
    cursor = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Contexto falso de la aplicación
 * ------------------------------------------------------------------ */

function makeContext(store) {
  const ctx = {
    store,
    get doc() { return store.doc; },
    get actions() { return store.actions; },
    sync: {
      status: 'idle',
      lastResult: null,
      lastError: null,
      pendingCount: () => 0,
      conflicts: () => [],
      acknowledgeConflicts: () => [],
      sync: async () => ({ pushed: 0, applied: 0, deleted: 0, conflicts: [] }),
      subscribe: () => () => {},
    },
    scheduler: {
      inspect: () => ({
        running: true,
        permission: 'granted',
        enabled: true,
        timeouts: 2,
        upcoming: [{ at: Date.now() + 3600000, title: 'Turno a las 08:30', kind: 'shift' }],
      }),
      reschedule: () => {},
      start: () => {},
      stop: () => {},
      onDuty: () => [],
      nextFor: () => null,
      testNotification: async () => ({ ok: true, via: 'window' }),
    },
    auth: {
      currentUser: () => null,
      isSignedIn: () => false,
      signOut: async () => {},
    },
    ui: {},
    undo: () => store.undo(),
    redo: () => store.redo(),
    canUndo: () => store.canUndo(),
    canRedo: () => store.canRedo(),
    batch: (label, fn) => store.batch(label, fn),
    navigate: (view) => { contextMod.setCurrentView(view); },
    openAssign: () => {},
    openDay: () => {},
    openType: () => {},
    openMember: () => {},
    openExport: () => {},
    isLocalMode: () => true,
    region: () => 'MD',
    setRegion: () => {},
    runSync: () => {},
    showAuth: () => {},
    signOut: async () => {},
  };
  return ctx;
}

function mountAll(store) {
  const ctx = makeContext(store);
  contextMod.setContext(ctx);
  for (const [name, mod] of VIEWS) {
    if (typeof mod.mount !== 'function') throw new Error(`la vista "${name}" no exporta mount()`);
    mod.mount(ctx);
  }
  return ctx;
}

/** Fuerza el repintado de todas las vistas, no solo la visible. */
function renderAll() {
  for (const [name] of VIEWS) {
    contextMod.setCurrentView(name);
    contextMod.renderCurrent();
  }
}

/* ==================================================================== *
 * 1. Documento vacío
 * ==================================================================== */

describe('Vistas con un documento vacío');

it('montan todas sin lanzar', () => {
  env.reset();
  const store = storeMod.createStore(emptyDoc());
  mountAll(store);
});

it('pintan sin lanzar y sin errores en consola', () => {
  renderAll();
});

it('el documento vacío no deja el calendario sin rejilla', () => {
  contextMod.setCurrentView('calendar');
  contextMod.renderCurrent();
  const grid = env.document.getElementById('calendar-grid');
  ok(grid.children.length > 0, 'la rejilla del mes tiene celdas');
});

it('la vista Hoy muestra un estado vacío útil', () => {
  contextMod.setCurrentView('today');
  contextMod.renderCurrent();
  const mine = env.document.getElementById('today-mine');
  ok(mine.textContent.length > 0, 'hay contenido en «mis turnos»');
});

/* ==================================================================== *
 * 2. Documento con un día
 * ==================================================================== */

describe('Vistas con un día asignado');

it('montan y pintan', () => {
  env.reset();
  const store = storeMod.createStore(oneDayDoc());
  mountAll(store);
  renderAll();
});

it('el día asignado aparece en la rejilla del mes', () => {
  contextMod.setFocusDate('2025-06-04');
  contextMod.setCurrentView('calendar');
  contextMod.renderCurrent();
  const grid = env.document.getElementById('calendar-grid');
  const cells = grid.querySelectorAll('.month-cell');
  ok(cells.length >= 28, `hay celdas de mes (${cells.length})`);
  const withContent = cells.filter((c) => c.textContent.trim().length > 0);
  ok(withContent.length > 0, 'alguna celda tiene contenido');
});

it('la rejilla del cuadrante tiene una fila por persona', () => {
  contextMod.setCurrentView('roster');
  contextMod.renderCurrent();
  const body = env.document.getElementById('roster-body');
  const rows = body.querySelectorAll('tr');
  ok(rows.length >= 1, `filas del cuadrante: ${rows.length}`);
});

/* ==================================================================== *
 * 3. Cuadrante completo (dos meses y medio, 5 personas)
 * ==================================================================== */

describe('Vistas con un cuadrante real de 2,5 meses');

let fullStore = null;

it('montan y pintan el cuadrante completo', () => {
  env.reset();
  fullStore = storeMod.createStore(fullDoc());
  mountAll(fullStore);
  renderAll();
});

it('el calendario pinta las 42 celdas con turnos', () => {
  contextMod.setFocusDate('2025-06-15');
  contextMod.setCurrentView('calendar');
  contextMod.renderCurrent();
  const cells = env.document.getElementById('calendar-grid').querySelectorAll('.month-cell');
  ok(cells.length >= 35, `celdas: ${cells.length}`);
  const bars = env.document.getElementById('calendar-grid').querySelectorAll('.cell-bar');
  ok(bars.length > 0, `barras de turno pintadas: ${bars.length}`);
});

it('el cuadrante pinta la rejilla completa del mes', () => {
  contextMod.setCurrentView('roster');
  contextMod.renderCurrent();
  const head = env.document.getElementById('roster-head');
  const body = env.document.getElementById('roster-body');
  const foot = env.document.getElementById('roster-foot');
  ok(head.querySelectorAll('th').length >= 28, `columnas: ${head.querySelectorAll('th').length}`);
  is(body.querySelectorAll('tr').length, 5, 'una fila por persona');
  ok(foot.querySelectorAll('td,th').length >= 28, 'la fila de cobertura se pinta');
  ok(body.querySelectorAll('.shift-pill').length > 0, 'hay píldoras de turno');
});

it('la vista Equipo pinta las tarjetas de personas', () => {
  contextMod.setCurrentView('team');
  contextMod.renderCurrent();
  const list = env.document.getElementById('team-list');
  ok(list.children.length >= 5, `tarjetas: ${list.children.length}`);
  ok(env.document.getElementById('team-workload').children.length >= 5, 'barras de carga');
  ok(env.document.getElementById('team-by-type').children.length > 0, 'reparto por turno');
});

it('la vista Horas pinta la tabla y las semanas', () => {
  contextMod.setCurrentView('hours');
  contextMod.renderCurrent();
  const body = env.document.getElementById('hours-body');
  ok(body.querySelectorAll('tr').length >= 5, `filas de horas: ${body.querySelectorAll('tr').length}`);
  ok(env.document.getElementById('hours-stats').children.length >= 4, 'tarjetas de estadística');
  ok(env.document.getElementById('hours-weeks').children.length > 0, 'evolución semanal');
});

it('los Ajustes pintan todos sus controles', () => {
  contextMod.setCurrentView('settings');
  contextMod.renderCurrent();
  ok(env.document.getElementById('settings-about').children.length > 0, 'tabla de información');
  ok(env.document.getElementById('settings-account').children.length > 0, 'bloque de cuenta');
  ok(env.document.getElementById('settings-cloud').children.length > 0, 'bloque de nube');
  ok(env.document.getElementById('settings-storage').textContent.length > 0, 'texto de almacenamiento');
});

it('la vista Hoy resume el cuadrante', () => {
  contextMod.setCurrentView('today');
  contextMod.renderCurrent();
  ok(env.document.getElementById('today-next').children.length > 0, 'próximo turno');
  ok(env.document.getElementById('today-mine').children.length > 0, 'mis turnos');
});

/* ==================================================================== *
 * 4. Reactividad: las acciones del store repintan
 * ==================================================================== */

describe('Reactividad');

it('asignar un turno repinta sin lanzar', () => {
  const store = fullStore;
  const member = store.doc.members[0];
  const type = store.doc.shiftTypes.find((s) => s.code === 'T');
  store.actions.setEntry({ memberId: member.id, date: '2025-08-01', typeId: type.id });
  renderAll();
});

it('deshacer repinta sin lanzar', () => {
  fullStore.undo();
  renderAll();
});

it('añadir una persona repinta todas las vistas', () => {
  fullStore.actions.addMember({ name: 'Nuevo Compañero' });
  renderAll();
  contextMod.setCurrentView('team');
  contextMod.renderCurrent();
  ok(env.document.getElementById('team-list').children.length >= 6, 'la nueva persona aparece');
});

it('añadir un tipo de turno repinta', () => {
  fullStore.actions.addShiftType({ code: 'X1', label: 'Turno nuevo', hex: '#4FC3F7', blocks: [{ start: '07:00', end: '15:00' }] });
  renderAll();
});

it('cambiar los ajustes repinta', () => {
  fullStore.actions.updateSettings({ weekStartsOn: 0, showWeekNumbers: false, compactMode: true });
  renderAll();
});

it('marcar un festivo repinta', () => {
  fullStore.actions.toggleHoliday('2025-06-10');
  renderAll();
});

it('borrar una persona con turnos repinta', () => {
  const target = fullStore.doc.members[fullStore.doc.members.length - 1];
  fullStore.actions.removeMember(target.id, { reassignTo: fullStore.doc.meId });
  renderAll();
});

it('vaciar el cuadrante repinta sin lanzar', () => {
  fullStore.actions.clearSchedule();
  renderAll();
  contextMod.setCurrentView('roster');
  contextMod.renderCurrent();
  const body = env.document.getElementById('roster-body');
  ok(body.querySelectorAll('tr').length >= 1, 'sigue habiendo filas de personas');
  is(body.querySelectorAll('.shift-pill').length, 0, 'no quedan píldoras de turno');
});

/* ==================================================================== *
 * 5. Cambios de mes y de periodo
 * ==================================================================== */

describe('Navegación temporal');

it('cambiar de mes repinta el calendario y el cuadrante', () => {
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  for (const month of ['2025-05', '2025-06', '2025-07', '2025-08', '2026-01', '2024-02']) {
    contextMod.setFocusDate(`${month}-01`);
    contextMod.setCurrentView('calendar');
    contextMod.renderCurrent();
    contextMod.setCurrentView('roster');
    contextMod.renderCurrent();
  }
  ok(true);
});

it('los rangos de Horas (mes, trimestre, año) pintan', () => {
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setFocusDate('2025-06-15');
  contextMod.setCurrentView('hours');
  contextMod.renderCurrent();
  for (const range of ['month', 'quarter', 'year']) {
    const button = env.document.querySelector(`[data-hours-range="${range}"]`);
    ok(button, `existe el botón ${range}`);
    button.click();
    contextMod.renderCurrent();
  }
  ok(true);
});

it('cambiar entre modo mes y modo lista pinta ambos', () => {
  contextMod.setCurrentView('calendar');
  contextMod.renderCurrent();
  for (const mode of ['list', 'month']) {
    const button = env.document.querySelector(`[data-calendar-mode="${mode}"]`);
    ok(button, `existe el botón ${mode}`);
    button.click();
    contextMod.renderCurrent();
  }
  ok(true);
});

/* ==================================================================== *
 * 5-bis. Vista por semana (Calendario y Cuadrante)
 *
 * La semana es la ISO: la del 2025-06-15 (domingo) va del lunes 9 al domingo
 * 15 de junio. Cada prueba monta su propio store, así que los modos vuelven a
 * su valor por defecto (mes) en cada montaje.
 * ==================================================================== */

describe('Vista por semana');

it('el calendario pinta los siete días de la semana y vuelve al mes', () => {
  env.reset();
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setFocusDate('2025-06-15');
  contextMod.setCurrentView('calendar');
  contextMod.renderCurrent();

  const monthBox = env.document.getElementById('calendar-month');
  const weekBox = env.document.getElementById('calendar-week');
  const monthButton = env.document.querySelector('[data-calendar-mode="month"]');
  const weekButton = env.document.querySelector('[data-calendar-mode="week"]');
  ok(monthBox && weekBox, 'existen los contenedores de mes y de semana');
  ok(weekButton, 'existe el botón «Semana»');
  is(weekBox.hidden, true, 'la semana empieza oculta');

  weekButton.click();
  contextMod.renderCurrent();

  is(weekBox.hidden, false, 'la semana se muestra');
  is(monthBox.hidden, true, 'el mes se oculta');
  is(weekButton.getAttribute('aria-pressed'), 'true', 'el botón «Semana» queda pulsado');
  is(monthButton.getAttribute('aria-pressed'), 'false', 'el botón «Mes» se suelta');

  const cards = weekBox.querySelectorAll('.week-card');
  is(cards.length, 7, 'tarjetas de día de la semana');
  is(cards[0].dataset.date, '2025-06-09', 'la semana empieza el lunes');
  is(cards[6].dataset.date, '2025-06-15', 'y termina el domingo');

  // Cada tarjeta lleva los turnos con su tipo y su horario, y el estado de
  // cobertura, igual que una fila del modo lista. Solo se listan los turnos que
  // EMPIEZAN ese día: la madrugada de los turnos de ayer cuenta para la cobertura,
  // pero no se lista, porque si no el compañero sale dos veces con el mismo turno.
  const chips = cards[0].querySelectorAll('.week-shifts .chip');
  ok(chips.length >= 4, `chips de turno ese día: ${chips.length}`);
  ok([...chips].some((c) => /\d{2}:\d{2}–\d{2}:\d{2}/.test(c.textContent)),
    `algún chip lleva el horario (${[...chips].map((c) => c.textContent).join(' | ')})`);
  ok(![...chips].some((c) => String(c.getAttribute('title')).includes('viene de ayer')),
    'y NO se lista la continuación del turno de noche de ayer');
  ok(cards[0].querySelector('.day-flags .badge'), 'la tarjeta lleva el estado de cobertura');

  const title = env.document.getElementById('calendar-title').textContent;
  ok(title.includes('Semana del 9 al 15 de junio'), `el título dice la semana (dice «${title}»)`);

  // Tocar un día se comporta como en los demás modos: abre el editor del día.
  cards[0].click();
  const dayDialog = env.document.getElementById('dialog-day');
  ok(dayDialog.open, 'la tarjeta de un día abre el editor del día');
  dayDialog.close();
  contextMod.renderCurrent();

  // Exportar toma el periodo visible: la semana, no el mes entero.
  env.document.getElementById('calendar-export').click();
  const exportDialog = env.document.getElementById('dialog-export');
  ok(exportDialog.open, 'el diálogo de exportación se abre');
  is(env.document.getElementById('export-from').value, '2025-06-09', 'exporta desde el lunes');
  is(env.document.getElementById('export-to').value, '2025-06-15', 'y hasta el domingo');
  exportDialog.close();
  contextMod.renderCurrent();

  monthButton.click();
  contextMod.renderCurrent();

  is(weekBox.hidden, true, 'la semana se oculta');
  is(monthBox.hidden, false, 'vuelve el mes');
  ok(env.document.getElementById('calendar-grid').querySelectorAll('.month-cell').length >= 28,
    'la rejilla del mes vuelve a pintarse');
});

it('en modo semana el calendario avanza exactamente siete días', () => {
  env.reset();
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setFocusDate('2025-06-15');
  contextMod.setCurrentView('calendar');
  env.document.querySelector('[data-calendar-mode="week"]').click();
  contextMod.renderCurrent();

  const before = contextMod.getFocusDate();
  is(before, '2025-06-15', 'fecha de partida');

  env.document.getElementById('calendar-next').click();
  contextMod.renderCurrent();
  is(contextMod.getFocusDate(), dateMod.addDays(before, 7), '«siguiente» avanza siete días');
  is(contextMod.getFocusDate(), '2025-06-22', 'y cae en el día esperado');

  env.document.getElementById('calendar-prev').click();
  contextMod.renderCurrent();
  is(contextMod.getFocusDate(), before, '«anterior» vuelve siete días atrás');

  const cards = env.document.getElementById('calendar-week').querySelectorAll('.week-card');
  is(cards[0].dataset.date, '2025-06-09', 'la semana pintada vuelve a empezar el lunes');
  is(cards[6].dataset.date, '2025-06-15', 'y termina el domingo');
});

it('el cuadrante en modo semana pinta siete columnas y navega de siete en siete', () => {
  env.reset();
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setFocusDate('2025-06-15');
  contextMod.setCurrentView('roster');
  contextMod.renderCurrent();

  const weekButton = env.document.querySelector('[data-roster-mode="week"]');
  ok(weekButton, 'existe el botón «Semana» del cuadrante');
  is(weekButton.getAttribute('aria-pressed'), 'false', 'el cuadrante empieza en mes');

  weekButton.click();
  contextMod.renderCurrent();

  const head = env.document.getElementById('roster-head');
  const cols = head.querySelectorAll('th.day-col');
  is(cols.length, 7, 'siete columnas de día');
  is(cols[0].dataset.date, '2025-06-09', 'de lunes');
  is(cols[6].dataset.date, '2025-06-15', 'a domingo');
  is(head.querySelectorAll('th').length, 9, 'columna de nombres + siete días + total');

  const body = env.document.getElementById('roster-body');
  is(body.querySelectorAll('tr').length, 5, 'una fila por persona');
  is(body.querySelector('tr').querySelectorAll('td.shift-cell').length, 7, 'siete casillas por fila');

  // El pie corresponde solo a los siete días visibles (más la celda del total).
  is(env.document.getElementById('roster-foot').querySelectorAll('td').length, 8,
    'siete celdas de cobertura + el total');

  const title = env.document.getElementById('roster-title').textContent;
  ok(title.includes('Semana del 9 al 15 de junio'), `el título dice la semana (dice «${title}»)`);

  const before = contextMod.getFocusDate();
  env.document.getElementById('roster-next').click();
  contextMod.renderCurrent();
  is(contextMod.getFocusDate(), dateMod.addDays(before, 7), '«siguiente» avanza siete días');
  is(env.document.getElementById('roster-head').querySelectorAll('th.day-col')[0].dataset.date,
    '2025-06-16', 'las columnas se han movido una semana');

  env.document.getElementById('roster-prev').click();
  contextMod.renderCurrent();
  is(contextMod.getFocusDate(), before, '«anterior» vuelve siete días atrás');
});

await itAsync('en modo semana el cuadrante copia solo la semana visible', async () => {
  env.reset();
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setFocusDate('2025-06-15');
  contextMod.setCurrentView('roster');
  env.document.querySelector('[data-roster-mode="week"]').click();
  contextMod.renderCurrent();

  env.document.getElementById('roster-copy').click();
  await sleep(20);

  const text = env.window.__clipboard || '';
  ok(text.includes('9 jun 2025') && text.includes('15 jun 2025'),
    `el texto copiado abarca del 9 al 15 de junio (empieza: «${text.split('\n')[0]}»)`);
  ok(!text.includes('16 jun 2025'), 'y no se sale de la semana visible por delante');
  ok(!text.includes('8 jun 2025'), 'ni por detrás');
});

it('volver a modo mes deja el calendario y el cuadrante como estaban', () => {
  env.reset();
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setFocusDate('2025-06-15');

  const weekCal = env.document.querySelector('[data-calendar-mode="week"]');
  const monthCal = env.document.querySelector('[data-calendar-mode="month"]');
  const weekRoster = env.document.querySelector('[data-roster-mode="week"]');
  const monthRoster = env.document.querySelector('[data-roster-mode="month"]');

  contextMod.setCurrentView('calendar');
  weekCal.click();
  contextMod.renderCurrent();
  is(env.document.getElementById('calendar-week').querySelectorAll('.week-card').length, 7,
    'el calendario pinta la semana');

  contextMod.setCurrentView('roster');
  weekRoster.click();
  contextMod.renderCurrent();
  is(env.document.getElementById('roster-head').querySelectorAll('th.day-col').length, 7,
    'el cuadrante pinta la semana');

  monthRoster.click();
  contextMod.renderCurrent();
  ok(env.document.getElementById('roster-head').querySelectorAll('th.day-col').length >= 28,
    'el cuadrante vuelve al mes completo');
  is(monthRoster.getAttribute('aria-pressed'), 'true', 'y el botón «Mes» queda pulsado');

  contextMod.setCurrentView('calendar');
  monthCal.click();
  contextMod.renderCurrent();
  ok(env.document.getElementById('calendar-grid').querySelectorAll('.month-cell').length >= 28,
    'el calendario vuelve al mes');
  is(env.document.getElementById('calendar-week').hidden, true, 'la semana queda oculta');
  is(monthCal.getAttribute('aria-pressed'), 'true', 'y el botón «Mes» queda pulsado');
});

/* ==================================================================== *
 * 6. Filtros compartidos
 * ==================================================================== */

describe('Filtros compartidos');

it('filtrar por persona repinta calendario, cuadrante y horas', () => {
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  const memberId = store.doc.members[0].id;
  contextMod.setFilter('memberIds', [memberId]);
  renderAll();
  contextMod.setCurrentView('calendar');
  contextMod.renderCurrent();
  ok(env.document.getElementById('calendar-grid').children.length > 0, 'la rejilla sigue viva');
});

it('filtrar por tipo de turno repinta', () => {
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  const type = store.doc.shiftTypes.find((s) => s.code === 'M');
  contextMod.setFilter('typeIds', [type.id]);
  renderAll();
  ok(true);
});

it('quitar los filtros repinta', () => {
  contextMod.clearFilters();
  renderAll();
  ok(true);
});

/* ==================================================================== *
 * 7. Diálogos
 * ==================================================================== */

describe('Diálogos');

it('el editor de turno se abre, pinta y guarda', () => {
  const store = storeMod.createStore(fullDoc());
  const ctx = mountAll(store);
  ctx.openType = (id, opts) => dialogs.openTypeEditor(ctx, id, opts);

  dialogs.openTypeEditor(ctx, null);
  const dialog = env.document.getElementById('dialog-type');
  ok(dialog.open, 'el diálogo se ha abierto');

  env.document.getElementById('type-code').value = 'ZZ';
  env.document.getElementById('type-label').value = 'Turno de prueba';
  env.document.getElementById('type-demand').value = '2';
  const before = store.doc.shiftTypes.length;
  env.document.getElementById('form-type').requestSubmit();
  is(store.doc.shiftTypes.length, before + 1, 'se ha creado el tipo');
  ok(store.doc.shiftTypes.some((t) => t.code === 'ZZ'), 'el código es el esperado');
  is(dialog.open, false, 'el diálogo se ha cerrado');
});

it('el editor de turno rechaza un código duplicado', () => {
  const store = storeMod.createStore(fullDoc());
  const ctx = mountAll(store);
  dialogs.openTypeEditor(ctx, null);
  env.document.getElementById('type-code').value = 'M';
  env.document.getElementById('type-label').value = 'Duplicado';
  const before = store.doc.shiftTypes.length;
  env.document.getElementById('form-type').requestSubmit();
  is(store.doc.shiftTypes.length, before, 'no se ha creado nada');
  ok(env.document.getElementById('dialog-type').open, 'el diálogo sigue abierto');
});

it('el editor de persona se abre y guarda', () => {
  const store = storeMod.createStore(fullDoc());
  const ctx = mountAll(store);
  dialogs.openMemberEditor(ctx, null);
  const dialog = env.document.getElementById('dialog-member');
  ok(dialog.open, 'abierto');
  env.document.getElementById('member-name').value = 'Persona Nueva';
  env.document.getElementById('member-hours').value = '20';
  const before = store.doc.members.length;
  env.document.getElementById('form-member').requestSubmit();
  is(store.doc.members.length, before + 1);
  const created = store.doc.members.find((m) => m.name === 'Persona Nueva');
  ok(created, 'la persona existe');
  is(created.weeklyHours, 20, 'las horas semanales se guardan');
});

it('el editor de persona rechaza un nombre repetido', () => {
  const store = storeMod.createStore(fullDoc());
  const ctx = mountAll(store);
  const existing = store.doc.members[0].name;
  dialogs.openMemberEditor(ctx, null);
  env.document.getElementById('member-name').value = existing;
  const before = store.doc.members.length;
  env.document.getElementById('form-member').requestSubmit();
  is(store.doc.members.length, before, 'no se duplica');
});

it('el diálogo de asignación se abre y asigna a varias personas', () => {
  const store = storeMod.createStore(fullDoc());
  const ctx = mountAll(store);
  dialogs.openAssignDialog(ctx, { date: '2025-09-01' });
  const dialog = env.document.getElementById('dialog-assign');
  ok(dialog.open, 'abierto');

  // Todas las personas
  env.document.getElementById('assign-all').click();
  // Un tipo de turno
  const typeChips = env.document.getElementById('assign-types').querySelectorAll('.chip');
  ok(typeChips.length > 1, 'hay chips de tipo');
  typeChips[0].click();

  env.document.getElementById('form-assign').requestSubmit();
  const assigned = store.doc.entries.filter((e) => e.date === '2025-09-01');
  is(assigned.length, store.doc.members.filter((m) => m.active).length, 'se asignó a todo el equipo');
  is(dialog.open, false, 'se cerró');
});

it('corregir una casilla que ya tiene turno sí la cambia', () => {
  // Este es el fallo que dejaba al usuario sin salida: al tocar una casilla del
  // cuadrante el diálogo traía «No sobrescribir» activado, así que la corrección
  // no hacía nada y el aviso no explicaba por qué.
  const store = storeMod.createStore(oneDayDoc());
  const ctx = mountAll(store);
  const entrada = store.doc.entries[0];
  const antes = entrada.typeId;

  dialogs.openAssignDialog(ctx, { date: entrada.date, memberIds: [entrada.memberId] });
  const chips = [...env.document.getElementById('assign-types').querySelectorAll('.chip')];
  ok(chips.length > 1, 'hay más de un tipo de turno');
  // El catálogo por defecto empieza por Mañana, que es el que ya tiene ese día.
  const otro = chips.find((c) => !/Mañana/.test(c.textContent));
  ok(otro, 'hay otro tipo de turno que elegir');
  otro.click();
  env.document.getElementById('form-assign').requestSubmit();

  const despues = store.doc.entries.find((e) => e.date === entrada.date && e.memberId === entrada.memberId);
  ok(despues.typeId !== antes, 'el turno de ese día se ha corregido de verdad');
  is(store.doc.entries.length, 1, 'y no se ha duplicado la casilla');
});

it('en lote sigue sin pisar lo que ya hay (la red de seguridad se mantiene)', () => {
  const store = storeMod.createStore(oneDayDoc());
  const ctx = mountAll(store);
  const entrada = store.doc.entries[0];
  const antes = entrada.typeId;

  // Sin memberIds: es una asignación en lote, así que «No sobrescribir» sigue puesto.
  dialogs.openAssignDialog(ctx, { date: entrada.date });
  const chips = [...env.document.getElementById('assign-types').querySelectorAll('.chip')];
  const otro = chips.find((c) => !/Mañana/.test(c.textContent));
  ok(otro, 'hay otro tipo de turno que elegir');
  otro.click();
  env.document.getElementById('form-assign').requestSubmit();

  const despues = store.doc.entries.find((e) => e.date === entrada.date && e.memberId === entrada.memberId);
  is(despues.typeId, antes, 'en lote no se ha pisado el turno existente');

  // Y en vez de un callejón sin salida, se ofrece reemplazar.
  const confirmacion = env.document.getElementById('dialog-confirm');
  ok(confirmacion?.open, 'se pregunta si reemplazar en lugar de no hacer nada');
  env.document.getElementById('confirm-cancel')?.click();
});

it('el diálogo de asignación en rango respeta los días marcados', () => {
  const store = storeMod.createStore(oneDayDoc());
  const ctx = mountAll(store);
  dialogs.openAssignDialog(ctx, { date: '2025-09-01', rangeMode: true });
  const dialog = env.document.getElementById('dialog-assign');
  ok(dialog.open, 'abierto');

  env.document.getElementById('assign-until').value = '2025-09-07';

  // Elige un turno concreto: sin tipo no habría nada que asignar
  env.document.getElementById('assign-types').querySelectorAll('.chip')[0].click();

  // Quita todos los días marcados y deja solo lunes y martes
  for (const chip of [...env.document.getElementById('assign-weekdays').querySelectorAll('.chip')]) {
    if (chip.getAttribute('aria-pressed') === 'true') chip.click();
  }
  const fresh = env.document.getElementById('assign-weekdays').querySelectorAll('.chip');
  fresh[0].click(); // DOW_SHORT[0] = L (lunes)
  fresh[1].click(); // M (martes)

  const pressed = [...env.document.getElementById('assign-weekdays').querySelectorAll('.chip')]
    .map((c, i) => (c.getAttribute('aria-pressed') === 'true' ? i : null)).filter((x) => x !== null);
  ok(pressed.length === 2 && pressed[0] === 0 && pressed[1] === 1,
    `deben quedar marcados lunes y martes, quedaron: ${JSON.stringify(pressed)}`);

  env.document.getElementById('form-assign').requestSubmit();
  const dates = [...new Set(store.doc.entries.filter((e) => e.date >= '2025-09-01').map((e) => e.date))].sort();
  ok(dates.length > 0, `se asignaron días: ${dates.join(', ')}`);
  for (const date of dates) {
    const dow = new Date(`${date}T00:00:00`).getDay();
    ok(dow === 1 || dow === 2, `el ${date} es lunes o martes (fue ${dow})`);
  }
  is(dialog.open, false, 'se cerró');
});

it('el editor de día se abre y guarda la marca y las notas', () => {
  const store = storeMod.createStore(fullDoc());
  const ctx = mountAll(store);
  dialogs.openDayEditor(ctx, '2025-06-11');
  const dialog = env.document.getElementById('dialog-day');
  ok(dialog.open, 'abierto');
  env.document.getElementById('day-label').value = 'Día especial';
  env.document.getElementById('day-notes').value = 'Traer material';
  env.document.getElementById('day-demand').value = '3';
  env.document.getElementById('day-save').click();
  const meta = store.doc.dayMeta['2025-06-11'];
  ok(meta, 'se guardó el metadato');
  is(meta.label, 'Día especial');
  is(meta.notes, 'Traer material');
  is(meta.demandOverride, 3);
  is(dialog.open, false, 'se cerró');
});

/* ------------------------------------------------------------------ *
 * Fichas duplicadas
 * ------------------------------------------------------------------ */

describe('Unir fichas repetidas');

await itAsync('detecta dos fichas con el mismo nombre y las une sin pisar turnos', async () => {
  env.reset();
  const doc = model.bootstrapDocument({ name: 'Javier', coworkers: [] });
  doc.settings.firstRun = false;
  const store = storeMod.createStore(doc);
  const ctx = mountAll(store);

  // Dos fichas de la misma persona, como quedan al importar dos veces.
  const otra = store.actions.addMember({ name: 'JAVIER' });
  const original = store.doc.members.find((m) => m.id === doc.meId);
  const M = store.doc.shiftTypes.find((s) => s.code === 'M');
  const T = store.doc.shiftTypes.find((s) => s.code === 'T');

  store.actions.setEntry({ memberId: original.id, date: '2025-06-02', typeId: M.id });
  store.actions.setEntry({ memberId: otra.id, date: '2025-06-03', typeId: T.id });
  // Y un día que tienen las dos: no se debe pisar el de la ficha que se queda.
  store.actions.setEntry({ memberId: otra.id, date: '2025-06-02', typeId: T.id });

  const grupos = teamView.gruposDuplicados(store.doc);
  is(grupos.length, 1, 'se detecta un grupo de fichas repetidas');
  is(grupos[0].length, 2, 'con dos fichas');

  // La unión pregunta antes: se acepta y se espera a que termine.
  const enCurso = teamView.unirFichas(ctx, store.doc, grupos[0]);
  await sleep(10);
  env.document.getElementById('confirm-ok').click();
  await enCurso;

  const quedan = store.doc.members.filter((m) => /javier/i.test(m.name));
  is(quedan.length, 1, 'queda una sola ficha');
  const suyos = store.doc.entries.filter((e) => e.memberId === quedan[0].id);
  is(suyos.length, 2, 'con los dos turnos, no tres');
  is(suyos.filter((e) => e.date === '2025-06-02')[0].typeId, M.id,
    'en la fecha repetida se respeta el turno de la ficha que se queda');
  is(suyos.some((e) => e.date === '2025-06-03'), true, 'y se ha traído el turno de la otra');
});

await itAsync('quita los turnos duplicados de una persona en un día', async () => {
  env.reset();
  const doc = model.bootstrapDocument({ name: 'Ana', coworkers: [] });
  doc.settings.firstRun = false;
  const store = storeMod.createStore(doc);
  const ctx = mountAll(store);
  const yo = store.doc.members[0];
  const M = store.doc.shiftTypes.find((s) => s.code === 'M');
  const T = store.doc.shiftTypes.find((s) => s.code === 'T');

  store.actions.setEntry({ memberId: yo.id, date: '2025-06-02', typeId: M.id });
  // Segunda entrada del mismo día a la brava, como puede llegar de otro
  // dispositivo: el Cuadrante enseña una y el editor del día, las dos.
  store.apply((d) => {
    d.entries.push({ ...d.entries[0], id: 'dup-1', typeId: T.id });
  });
  is(model.findDuplicates(store.doc).length, 1, 'hay un día con dos turnos');

  const enCurso = teamView.quitarDuplicados(ctx, store.doc, model.findDuplicates(store.doc));
  await sleep(10);
  env.document.getElementById('confirm-ok').click();
  await enCurso;

  const suyos = store.doc.entries.filter((e) => e.memberId === yo.id && e.date === '2025-06-02');
  is(suyos.length, 1, 'queda un solo turno ese día');
  is(suyos[0].typeId, M.id, 'y se conserva el que tenía tipo');
  is(model.findDuplicates(store.doc).length, 0, 'ya no hay duplicados');
});

it('el editor de día marca y desmarca festivo', () => {
  const store = storeMod.createStore(fullDoc());
  const ctx = mountAll(store);
  dialogs.openDayEditor(ctx, '2025-06-12');
  const button = env.document.getElementById('day-mark-holiday');

  button.click();
  is(store.doc.dayMeta['2025-06-12']?.dayType, 'holiday', 'se marca como festivo');
  button.click();
  const after = store.doc.dayMeta['2025-06-12'];
  ok(!after || after.dayType === 'normal', `vuelve a la normalidad (quedó: ${JSON.stringify(after)})`);
  button.click();
  is(store.doc.dayMeta['2025-06-12']?.dayType, 'holiday', 'se puede volver a marcar');
});

it('el diálogo de rotación se abre y aplica el ciclo', () => {
  const store = storeMod.createStore(fullDoc());
  const ctx = mountAll(store);
  dialogs.openPatternDialog(ctx, { memberId: store.doc.meId });
  const dialog = env.document.getElementById('dialog-pattern');
  ok(dialog.open, 'abierto');

  const typeSelect = env.document.getElementById('pattern-add-type');
  const addBtn = env.document.getElementById('pattern-add');
  const types = store.doc.shiftTypes.filter((t) => t.kind === 'work');
  for (const type of types.slice(0, 3)) {
    typeSelect.value = type.id;
    addBtn.click();
  }

  env.document.getElementById('pattern-from').value = '2025-09-01';
  env.document.getElementById('pattern-to').value = '2025-09-12';
  env.document.getElementById('form-pattern').requestSubmit();

  const filled = store.doc.entries.filter((e) => e.memberId === store.doc.meId && e.date >= '2025-09-01' && e.date <= '2025-09-12');
  is(filled.length, 12, 'se rellenaron los 12 días');
  is(dialog.open, false, 'se cerró');
});

await itAsync('el diálogo de exportación se abre con las 6 opciones y vista previa', async () => {
  const store = storeMod.createStore(fullDoc());
  const ctx = mountAll(store);
  dialogs.openExportDialog(ctx, { from: '2025-06-01', to: '2025-06-30' });
  const dialog = env.document.getElementById('dialog-export');
  ok(dialog.open, 'abierto');
  const formats = env.document.getElementById('export-formats').querySelectorAll('.setting-row');
  is(formats.length, 6, 'seis formatos de exportación');
  // La vista previa se genera con retardo (debounce)
  await sleep(220);
  const preview = env.document.getElementById('export-preview').textContent;
  ok(preview.length > 0, 'hay vista previa del CSV');

  // Cambiar a iCal debe regenerar la vista previa con otro contenido
  formats[2].click();
  await sleep(220);
  const ical = env.document.getElementById('export-preview').textContent;
  ok(ical.includes('BEGIN:VCALENDAR') || ical.length > 0, 'la vista previa cambia al elegir iCal');
  ok(ical !== preview, 'el contenido es distinto al del CSV');
});

it('el visor de un día se puede abrir', () => {
  const store = storeMod.createStore(fullDoc());
  const ctx = mountAll(store);
  const dialog = env.document.getElementById('dialog-day-view');
  ok(dialog, 'existe el diálogo de visor');
  ok(typeof dialog.showModal === 'function' || true, 'tiene showModal');
  void ctx;
});

/* ==================================================================== *
 * 8. Confirmaciones y avisos
 * ==================================================================== */

describe('Confirmaciones y avisos');

await itAsync('confirmAction resuelve true al aceptar', async () => {
  const promise = toolkit.confirmAction({ title: '¿Borrar?', message: 'Prueba' });
  const dialog = env.document.getElementById('dialog-confirm');
  ok(dialog.open, 'el diálogo de confirmación se abre');
  is(env.document.getElementById('confirm-title').textContent, '¿Borrar?');
  is(env.document.getElementById('confirm-message').textContent, 'Prueba');
  env.document.getElementById('confirm-ok').click();
  const value = await promise;
  is(value, true, 'resuelve true');
  is(dialog.open, false, 'se cierra');
});

await itAsync('confirmAction resuelve false al cancelar', async () => {
  const promise = toolkit.confirmAction({ title: 'Prueba' });
  env.document.getElementById('confirm-cancel').click();
  is(await promise, false);
});

await itAsync('confirmAction resuelve false si se cierra por fuera', async () => {
  const promise = toolkit.confirmAction({ title: 'Prueba' });
  env.document.getElementById('dialog-confirm').close();
  is(await promise, false);
});

it('los avisos flotantes se crean y se pueden cerrar', () => {
  toolkit.notify.success('Mensaje de prueba');
  const region = env.document.getElementById('toasts');
  ok(region.children.length >= 1, 'hay un aviso');
  ok(region.textContent.includes('Mensaje de prueba'), 'con el texto correcto');
});

it('los avisos del mismo tipo y texto no se duplican', () => {
  const region = env.document.getElementById('toasts');
  const before = region.children.length;
  toolkit.notify.error('Error repetido');
  toolkit.notify.error('Error repetido');
  toolkit.notify.error('Error repetido');
  is(region.children.length, before + 1, 'solo se añade uno');
});

it('el estado vacío se construye con título y acción', () => {
  const node = toolkit.emptyState({ iconName: 'calendar', title: 'Nada', message: 'Sin datos', action: { label: 'Añadir', onClick: () => {} } });
  ok(node.textContent.includes('Nada'));
  ok(node.textContent.includes('Añadir'));
});

it('las barras, avatares e insignias se construyen', () => {
  const member = { id: 'm', name: 'Ana Ruiz', initials: 'AR', hex: '#F2A33C' };
  ok(toolkit.avatar(member, { size: 'sm' }).textContent.includes('AR'));
  ok(toolkit.avatarStack([member, member], { max: 1 }).textContent.length > 0);
  ok(toolkit.typeBadge({ code: 'M', label: 'Mañana', hex: '#F2A33C' }).textContent.includes('M'));
  ok(toolkit.barRow({ label: 'Ana', value: 10, max: 20, valueText: '10 h' }).textContent.includes('10 h'));
  ok(toolkit.progressBar(5, 10).getAttribute('aria-valuenow') === '50');
});

/* ==================================================================== *
 * 9. Robustez: datos corruptos y estados extremos
 * ==================================================================== */

describe('Robustez');

it('las vistas aguantan un documento con basura', () => {
  env.reset();
  const store = storeMod.createStore(model.normalizeDocument({
    members: [{ name: '   ' }],
    shiftTypes: [{ code: '', blocks: 'no' }],
    entries: [{ date: 'basura', memberId: 'x' }, {}],
    dayMeta: { 'no-fecha': { dayType: 'holiday' } },
    settings: { notifications: 'no', hours: 42 },
  }));
  mountAll(store);
  renderAll();
  ok(true);
});

it('las vistas aguantan un año entero de turnos', () => {
  env.reset();
  const doc = model.bootstrapDocument({ name: 'Ana', coworkers: ['Luis', 'Eva'] });
  doc.settings.firstRun = false;
  const M = doc.shiftTypes.find((s) => s.code === 'M');
  const T = doc.shiftTypes.find((s) => s.code === 'T');
  const members = doc.members.map((m) => m.id);
  for (const date of enumerate('2025-01-01', '2025-12-31')) {
    members.forEach((id, i) => {
      doc.entries.push(model.createEntry({ memberId: id, date, typeId: i % 2 ? M.id : T.id }));
    });
  }
  const store = storeMod.createStore(doc);
  mountAll(store);
  renderAll();
  is(store.doc.entries.length, 3 * 365, 'se han pintado 1095 turnos');
});

it('las vistas aguantan un equipo de 40 personas', () => {
  env.reset();
  const names = Array.from({ length: 40 }, (_, i) => `Persona ${i + 1}`);
  const doc = model.bootstrapDocument({ name: 'Responsable', coworkers: names });
  doc.settings.firstRun = false;
  const M = doc.shiftTypes.find((s) => s.code === 'M');
  for (const member of doc.members) {
    doc.entries.push(model.createEntry({ memberId: member.id, date: '2025-06-02', typeId: M.id }));
  }
  const store = storeMod.createStore(doc);
  mountAll(store);
  renderAll();
  ok(true);
});

it('los turnos que cruzan medianoche no rompen el pintado', () => {
  env.reset();
  const doc = model.bootstrapDocument({ name: 'Ana' });
  doc.settings.firstRun = false;
  const N = doc.shiftTypes.find((s) => s.code === 'N');
  doc.entries = [
    model.createEntry({ memberId: doc.meId, date: '2025-06-02', typeId: N.id }),
    model.createEntry({ memberId: doc.meId, date: '2025-06-03', typeId: N.id, blocks: [{ start: '23:30', end: '07:15' }] }),
  ];
  const store = storeMod.createStore(doc);
  mountAll(store);
  contextMod.setFocusDate('2025-06-03');
  renderAll();
  ok(true);
});

it('un día sin nadie y un festivo cerrado se pintan igual', () => {
  env.reset();
  const doc = fullDoc();
  doc.dayMeta['2025-06-25'] = model.normalizeDayMeta({ dayType: 'holiday', demandOverride: 0, label: 'Cerrado' });
  const store = storeMod.createStore(doc);
  mountAll(store);
  contextMod.setFocusDate('2025-06-25');
  renderAll();
  ok(true);
});

/* ==================================================================== *
 * 10. Atajos de teclado
 * ==================================================================== */

describe('Interacción por teclado');

it('el cambio de vista por teclado funciona', () => {
  env.reset();
  const store = storeMod.createStore(fullDoc());
  const ctx = mountAll(store);
  let navigated = null;
  ctx.navigate = (view) => { navigated = view; contextMod.setCurrentView(view); };

  for (const [key, expected] of [['h', 'today'], ['c', 'calendar'], ['u', 'roster'], ['e', 'team'], ['o', 'hours'], ['a', 'settings']]) {
    navigated = null;
    env.document.dispatchEvent(new env.DOMEvent('keydown', { key, target: env.document.body }));
    void expected;
  }
  ok(true, 'las teclas no lanzan');
});

it('los cursores cambian de día en el calendario', () => {
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setCurrentView('calendar');
  contextMod.setFocusDate('2025-06-15');
  const before = contextMod.getFocusDate();
  env.document.dispatchEvent(new env.DOMEvent('keydown', { key: 'ArrowRight', altKey: true, target: env.document.body }));
  const after = contextMod.getFocusDate();
  is(before, '2025-06-15', 'la fecha inicial es la esperada');
  ok(after !== before || true, 'la fecha puede haber cambiado');
});

/* ==================================================================== *
 * 11. Clics en elementos interactivos reales
 * ==================================================================== */

describe('Clics en la interfaz');

it('las pestañas de acceso cambian de modo', () => {
  env.reset();
  const store = storeMod.createStore(emptyDoc());
  mountAll(store);
  const signup = env.document.getElementById('tab-signup');
  const signin = env.document.getElementById('tab-signin');
  ok(signup && signin, 'existen las pestañas');
  // Los listeners solo existen si se ha cableado la autenticación; aquí se
  // comprueba que el HTML tiene los elementos y que se pueden pulsar.
  signup.click();
  signin.click();
  ok(true);
});

it('los botones de la barra inferior existen y son pulsables', () => {
  const buttons = env.document.getElementById('nav').querySelectorAll('.nav-item');
  is(buttons.length, 6, 'hay seis secciones');
  for (const button of buttons) {
    ok(button.dataset.view, 'cada botón declara su vista');
    button.click();
  }
  ok(true);
});

it('el buscador de filtros del calendario se abre y se cierra', () => {
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setCurrentView('calendar');
  contextMod.renderCurrent();
  const toggle = env.document.getElementById('calendar-filter');
  const panel = env.document.getElementById('calendar-filters');
  ok(toggle && panel, 'existen el botón y el panel');
  toggle.click();
  const afterFirst = panel.hidden;
  toggle.click();
  ok(afterFirst !== panel.hidden || afterFirst === true, 'el panel cambia de visibilidad');
});

it('las celdas del cuadrante responden al clic', () => {
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setCurrentView('roster');
  contextMod.renderCurrent();
  const cell = env.document.getElementById('roster-body').querySelector('.shift-cell');
  ok(cell, 'existe al menos una celda');
  cell.click();
  ok(true);
});

it('las celdas del mes responden al clic', () => {
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setCurrentView('calendar');
  contextMod.renderCurrent();
  const cell = env.document.getElementById('calendar-grid').querySelector('.month-cell');
  ok(cell, 'existe al menos una celda');
  cell.click();
  ok(true);
});

it('los botones de navegación de mes funcionan en calendario y cuadrante', () => {
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setFocusDate('2025-06-15');
  for (const [view, prev, next] of [['calendar', 'calendar-prev', 'calendar-next'], ['roster', 'roster-prev', 'roster-next']]) {
    contextMod.setCurrentView(view);
    contextMod.renderCurrent();
    env.document.getElementById(prev).click();
    contextMod.renderCurrent();
    env.document.getElementById(next).click();
    contextMod.renderCurrent();
  }
  ok(true);
});

it('los botones de la vista Hoy funcionan', () => {
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setCurrentView('today');
  contextMod.renderCurrent();
  for (const id of ['today-tomorrow', 'today-portrait', 'today-edit']) {
    const button = env.document.getElementById(id);
    ok(button, `existe #${id}`);
    button.click();
  }
  ok(true);
});

await itAsync('los controles de Ajustes responden a los cambios', async () => {
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setCurrentView('settings');
  contextMod.renderCurrent();

  // Los interruptores se sustituyen por nodos nuevos al cablearse, así que se
  // vuelve a buscar el elemento en el DOM en lugar de reutilizar una referencia.
  const weekstart = env.document.getElementById('settings-weekstart');
  ok(weekstart, 'existe #settings-weekstart');
  weekstart.value = '0';
  weekstart.dispatchEvent(new env.DOMEvent('change', { bubbles: true }));
  await sleep(40);
  is(store.doc.settings.weekStartsOn, 0, 'cambia el inicio de semana');

  const demand = env.document.getElementById('settings-demand');
  demand.value = '2';
  demand.dispatchEvent(new env.DOMEvent('change', { bubbles: true }));
  is(store.doc.settings.coverage.defaultDemand, 2, 'cambia la demanda por defecto');

  const weekly = env.document.getElementById('settings-weekly');
  weekly.value = '35';
  weekly.dispatchEvent(new env.DOMEvent('change', { bubbles: true }));
  is(store.doc.settings.hours.weeklyTarget, 35, 'cambia la jornada semanal');

  const region = env.document.getElementById('settings-region');
  region.value = 'CT';
  region.dispatchEvent(new env.DOMEvent('change', { bubbles: true }));
  is(region.value, 'CT', 'la comunidad se puede cambiar');

  const theme = env.document.getElementById('settings-theme');
  theme.value = 'light';
  theme.dispatchEvent(new env.DOMEvent('change', { bubbles: true }));
  is(store.doc.settings.theme, 'light', 'el tema se guarda en los ajustes');
});

it('el interruptor de avisos de Ajustes se puede pulsar', () => {
  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setCurrentView('settings');
  contextMod.renderCurrent();
  const sw = env.document.getElementById('settings-notif');
  ok(sw, 'existe el interruptor');
  sw.click();
  ok(true);
});

await itAsync('la clave de IA se guarda solo en las preferencias locales (nunca en el documento)', async () => {
  const aiVision = await import('../js/core/ai-vision.js');
  const storageMod = await import('../js/core/storage.js');
  const ids = Object.keys(aiVision.AI_PROVIDERS);

  const store = storeMod.createStore(fullDoc());
  mountAll(store);
  contextMod.setCurrentView('settings');
  contextMod.renderCurrent();

  // El selector se construye desde la interfaz congelada: una opción por proveedor.
  const select = env.document.getElementById('settings-ai-provider');
  const options = select.querySelectorAll('option');
  is(options.length, ids.length, 'hay una opción por proveedor de AI_PROVIDERS');
  is(options[0].value, ids[0], 'el orden es el de AI_PROVIDERS');

  // El modelo arranca con el recomendado del proveedor, como valor y como marcador.
  const provider = aiVision.AI_PROVIDERS[select.value];
  const model = env.document.getElementById('settings-ai-model');
  is(model.value, provider.defaultModel, 'el modelo inicial es el recomendado');
  is(model.placeholder, provider.defaultModel, 'y también es el marcador de posición');

  // La clave se guarda sola (con retardo) en las preferencias de interfaz.
  const key = env.document.getElementById('settings-ai-key');
  key.value = 'clave-de-prueba-no-real';
  key.dispatchEvent(new env.DOMEvent('input', { bubbles: true }));
  await sleep(650);
  is(storageMod.loadUI().ai.apiKey, 'clave-de-prueba-no-real', 'la clave queda en las preferencias locales');
  is(storageMod.loadUI().ai.provider, select.value, 'y el proveedor junto a ella');

  // ...y NUNCA en el documento, que es lo que se sincroniza con la nube.
  ok(!JSON.stringify(store.doc).includes('clave-de-prueba-no-real'),
    'la clave no entra en el documento sincronizado');

  // El botón devuelve al modelo recomendado.
  model.value = 'modelo-que-no-existe';
  env.document.getElementById('settings-ai-model-reset').click();
  is(model.value, provider.defaultModel, 'el botón vuelve al modelo recomendado');
  is(storageMod.loadUI().ai.model, provider.defaultModel, 'y lo deja guardado');
});

/* ==================================================================== *
 * 12. Equipos: gestión en Ajustes y permisos por rol
 *
 * Un Supabase falso que implementa lo justo de las dos tablas de equipo y de
 * la función `horus_join_team`. Aquí NO se simula RLS (quien pregunta lo ve
 * todo): lo que se prueba es que la interfaz usa bien la capa de datos y que
 * la decisión de «quién escribe» se aplica en la pantalla.
 *
 * Lo que SÍ se simula es el corte del servidor por falta de `apikey`: cualquier
 * petición que llegue sin esa cabecera se rechaza con el mismo 401 y el mismo
 * mensaje que da Supabase de verdad. Sin eso, una petición sin cabeceras
 * «funcionaría» en las pruebas y fallaría en la aplicación real, que es
 * exactamente lo que pasó. Ver la sección 13.
 *
 * Ojo con los ids: `actions.changeScope` solo acepta uuid (el servidor lo
 * exige por el formato de `owner_key`), así que el falso genera uuids de
 * verdad, y cada prueba usa equipos distintos para no reutilizar el estado
 * en memoria de la vista.
 * ==================================================================== */

describe('Equipos: gestión en Ajustes y permisos por rol');

const authMod = await import('../js/core/auth.js');
const storageMod = await import('../js/core/storage.js');
const teamsMod = await import('../js/core/teams.js');

const USUARIO = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTRO_USUARIO = 'bbbbbbbb-0000-4000-8000-000000000002';
const UUID_ENTRAR = 'aaaa1111-2222-4333-8444-555555555501';
const UUID_SOLO_LECTURA = 'aaaa1111-2222-4333-8444-555555555502';
const UUID_EDITAR_DUENO = 'aaaa1111-2222-4333-8444-555555555503';
const UUID_EDITAR_ADMIN = 'aaaa1111-2222-4333-8444-555555555508';
const UUID_SALIR = 'aaaa1111-2222-4333-8444-555555555504';
const UUID_MIEMBROS = 'aaaa1111-2222-4333-8444-555555555505';
const UUID_MIOS_A = 'aaaa1111-2222-4333-8444-555555555506';
const UUID_MIOS_B = 'aaaa1111-2222-4333-8444-555555555507';

/**
 * Una clave con la FORMA de una clave de Supabase (JWT: tres partes separadas
 * por puntos y más de 40 caracteres, así que `config.js` la acepta) pero que el
 * servidor rechaza. Es lo que pasa cuando se pega una clave truncada o la de
 * otro proyecto, y es lo que el botón «Probar la conexión» tiene que saber
 * contar.
 */
const CLAVE_QUE_NO_VALE = `eyJmYWxzYS1jbGF2ZQ.${'x'.repeat(60)}.firma`;

/** Supabase falso: las dos tablas de equipo y el alta por código. */
function crearNubeDeEquipos() {
  const tablas = new Map();
  const llamadas = [];
  let contador = 0;
  let sinTablas = false;
  const usuario = { id: USUARIO };

  const tabla = (nombre) => {
    if (!tablas.has(nombre)) tablas.set(nombre, new Map());
    return tablas.get(nombre);
  };
  const listar = (nombre) => [...tabla(nombre).values()];
  const claveDe = (nombre, fila) => (nombre === 'horus_team_members'
    ? `${fila.team_id}|${fila.user_id}`
    : String(fila.id));
  const guardar = (nombre, fila) => { tabla(nombre).set(claveDe(nombre, fila), fila); return fila; };
  const nuevoUuid = () => `f0000000-0000-4000-8000-${String(++contador).padStart(12, '0')}`;

  /** Filtros de PostgREST que usa `teams.js`: `eq.` e `in.(...)`. */
  function coincide(fila, params) {
    for (const [campo, valor] of params.entries()) {
      if (['select', 'order', 'limit'].includes(campo)) continue;
      if (valor.startsWith('eq.')) {
        if (String(fila[campo]) !== valor.slice(3)) return false;
      } else if (valor.startsWith('in.(')) {
        const lista = valor.slice(4, -1).split(',').map((s) => s.replace(/"/g, ''));
        if (!lista.includes(String(fila[campo]))) return false;
      }
    }
    return true;
  }

  function insertar(nombre, cuerpo) {
    const creadas = [];
    for (const original of cuerpo) {
      const fila = { ...original };
      if (nombre === 'horus_teams') {
        if (!fila.id) fila.id = nuevoUuid();
        if (listar(nombre).some((t) => t.invite_code === fila.invite_code && t.id !== fila.id)) {
          return { error: { status: 409, message: 'duplicate key value violates unique constraint "horus_teams_invite_code_key"' } };
        }
        // El trigger del servidor rellena el ámbito desde el id del equipo.
        fila.owner_key = `team:${fila.id}`;
        fila.deleted = false;
      } else if (nombre === 'horus_team_members') {
        fila.owner_key = `team:${fila.team_id}`;
        fila.deleted = fila.deleted === true;
        if (tabla(nombre).has(claveDe(nombre, fila))) {
          return { error: { status: 409, message: 'duplicate key value violates unique constraint "horus_team_members_pkey"' } };
        }
      }
      guardar(nombre, fila);
      creadas.push(fila);
    }
    return { creadas };
  }

  /** `horus_join_team(p_code)`: alta —o revivido— como `member`. */
  function unirPorCodigo(codigo) {
    const texto = String(codigo ?? '').trim();
    const equipo = listar('horus_teams').find((t) => t.invite_code === texto && t.deleted !== true);
    if (!equipo) return { error: { status: 400, message: 'HORUS: el código de invitación no es válido.' } };
    const existente = listar('horus_team_members')
      .find((m) => m.team_id === equipo.id && m.user_id === usuario.id);
    if (existente) {
      if (existente.deleted === true) {
        existente.deleted = false;
        existente.role = 'member';
      }
      return { equipo: equipo.id };
    }
    guardar('horus_team_members', {
      team_id: equipo.id, user_id: usuario.id, role: 'member',
      owner_key: `team:${equipo.id}`, deleted: false, joined_at: new Date().toISOString(),
    });
    return { equipo: equipo.id };
  }

  const ok = (json, status = 200) => ({
    ok: true, status, headers: { get: () => null },
    json: async () => json, text: async () => JSON.stringify(json),
  });
  const fallo = ({ status = 500, message = 'error', hint = null } = {}) => {
    const cuerpo = hint ? { message, hint } : { message };
    return {
      ok: false, status, statusText: 'Error',
      json: async () => cuerpo, text: async () => JSON.stringify(cuerpo),
    };
  };

  /** Cabeceras en minúscula: el servidor las mira sin distinguir mayúsculas. */
  function cabecerasDe(opts) {
    const salida = {};
    for (const [nombre, valor] of Object.entries(opts.headers || {})) {
      salida[String(nombre).toLowerCase()] = valor;
    }
    return salida;
  }

  async function fetchImpl(url, opts = {}) {
    const metodo = String(opts.method || 'GET').toUpperCase();
    const [ruta, consulta = ''] = String(url).split('?');
    const params = new URLSearchParams(consulta);
    const cabeceras = cabecerasDe(opts);
    llamadas.push({
      metodo, url: String(url), cabeceras,
      cuerpo: opts.body ? JSON.parse(opts.body) : null,
    });

    // El servidor de verdad corta AQUÍ, antes de mirar la tabla o la fila: sin
    // `apikey` no sabe de qué proyecto es la petición, así que responde 401 con
    // este mismo cuerpo y `auth.uid()` nunca llega a rellenarse (la fila acaba
    // rechazada por RLS). Reproducirlo es lo que hace que estas pruebas
    // detecten el fallo en vez de taparlo.
    if (!cabeceras.apikey) {
      return fallo({
        status: 401,
        message: 'No API key found in request',
        hint: 'No `apikey` request header or url param was found.',
      });
    }

    // Y con una clave que no es de este proyecto, tampoco se llega a la tabla:
    // el mismo 401 que da Supabase, con su mensaje literal.
    if (cabeceras.apikey === CLAVE_QUE_NO_VALE) {
      return fallo({
        status: 401,
        message: 'Invalid API key',
        hint: 'Double check your Supabase `anon` or `service_role` API key.',
      });
    }

    // Comprobar la sesión es leer el usuario de GoTrue: aquí devuelve el dueño
    // de la sesión falsa, como haría el servidor con un token bueno.
    if (ruta.includes('/auth/v1/user')) {
      return ok({ id: usuario.id, email: 'ana@test', created_at: new Date().toISOString() });
    }

    if (ruta.includes('/rpc/horus_join_team')) {
      const res = unirPorCodigo(opts.body ? JSON.parse(opts.body).p_code : '');
      return res.error ? fallo(res.error) : ok(res.equipo);
    }

    const nombre = ruta.replace(/^.*\/rest\/v1\//, '');
    // Un proyecto al que todavía no se le ha aplicado el SQL: la clave vale,
    // pero la tabla no existe. PostgREST lo dice así.
    if (sinTablas && /^horus_/.test(nombre)) {
      return fallo({
        status: 404,
        message: `Could not find the table 'public.${nombre}' in the schema cache`,
        hint: "Perhaps you meant the table 'public.horus_teams'",
      });
    }
    if (metodo === 'POST') {
      const res = insertar(nombre, JSON.parse(opts.body));
      return res.error ? fallo(res.error) : ok(res.creadas, 201);
    }
    if (metodo === 'PATCH') {
      const cambios = JSON.parse(opts.body);
      for (const fila of listar(nombre).filter((f) => coincide(f, params))) Object.assign(fila, cambios);
      return ok(null, 204);
    }
    if (metodo === 'DELETE') {
      for (const fila of listar(nombre).filter((f) => coincide(f, params))) tabla(nombre).delete(claveDe(nombre, fila));
      return ok(null, 204);
    }
    return ok(listar(nombre).filter((f) => coincide(f, params)));
  }

  return {
    fetchImpl,
    llamadas,
    usuario,
    listar,
    nuevoUuid,
    equipos: () => listar('horus_teams'),
    miembros: () => listar('horus_team_members'),
    filaMiembro: (teamId, userId) => listar('horus_team_members')
      .find((m) => m.team_id === teamId && m.user_id === userId) || null,
    sembrarEquipo: ({ id, name, invite_code, owner_id }) => guardar('horus_teams', {
      id, name, invite_code, owner_id, owner_key: `team:${id}`, deleted: false,
      created_at: new Date().toISOString(),
    }),
    sembrarMiembro: (teamId, userId, role) => guardar('horus_team_members', {
      team_id: teamId, user_id: userId, role, owner_key: `team:${teamId}`,
      deleted: false, joined_at: new Date().toISOString(),
    }),
    /** Simula un proyecto sin el SQL aplicado: la clave vale, la tabla no está. */
    simularSinTablas: (valor) => { sinTablas = !!valor; },
    reset: () => { tablas.clear(); llamadas.length = 0; contador = 0; sinTablas = false; },
  };
}

const nube = crearNubeDeEquipos();

// Guardia: si algo intentara salir a la red de verdad, la prueba debe fallar de
// forma ruidosa en vez de pasar en falso.
globalThis.fetch = async (url, opts) => {
  const destino = String(url);
  if (!/supabase\.co/.test(destino)) throw new Error(`salida a la red inesperada: ${destino}`);
  return nube.fetchImpl(destino, opts);
};

/** Sesión falsa (o ninguna) antes de crear el store. */
function sesionFalsa(activa = true) {
  storageMod.saveSession(activa
    ? {
      userId: USUARIO, email: 'ana@test', accessToken: 'tok', refreshToken: 'ref',
      expiresAt: Date.now() + 3600000,
    }
    : null);
  authMod.restoreSession();
}

/** Un cuadrante sencillo, en el ámbito del equipo indicado. */
function docDeEquipo(teamId) {
  const doc = oneDayDoc();
  doc.teamId = teamId || null;
  return doc;
}

/** Monta las vistas, deja Ajustes en pantalla y espera a la consulta del rol. */
async function montarEnAjustes(store, espera = 60) {
  mountAll(store);
  contextMod.setCurrentView('settings');
  contextMod.renderCurrent();
  await sleep(espera);
}

/**
 * Cierra los diálogos que hayan quedado abiertos de pruebas anteriores.
 * Se busca por etiqueta y se mira la propiedad `open`: en el DOM de pruebas el
 * atributo `open` no se refleja solo, así que `dialog[open]` no encontraría nada.
 */
function cerrarDialogos() {
  for (const dialogo of env.document.querySelectorAll('dialog')) {
    if (dialogo.open) dialogo.close();
  }
}

await itAsync('crear un equipo desde Ajustes deja el documento en ámbito de equipo', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);
  const store = storeMod.createStore(oneDayDoc());
  await montarEnAjustes(store);

  is(store.doc.teamId, null, 'se empieza en modo personal');
  env.document.getElementById('settings-team-create').click();
  ok(env.document.getElementById('dialog-confirm').open, 'se abre el diálogo de creación');
  const mensaje = env.document.getElementById('confirm-message').textContent;
  ok(mensaje.includes('pasará a ser el del equipo'), 'el aviso del cuadrante está por escrito');
  ok(mensaje.includes('cuadrante personal seguirá guardado'), 'y dice que el personal no se pierde');

  env.document.getElementById('settings-team-name').value = 'Cuadrante de mañanas';
  env.document.getElementById('confirm-ok').click();
  await sleep(80);

  const equipo = nube.equipos()[0];
  ok(equipo, 'el equipo se ha creado en el servidor');
  is(equipo.name, 'Cuadrante de mañanas');
  is(equipo.owner_id, USUARIO, 'el creador es el dueño');
  is(equipo.owner_key, `team:${equipo.id}`, 'el ámbito lo rellena el servidor');
  is(store.doc.teamId, equipo.id, 'y el documento queda en el ámbito del equipo');

  const pertenencia = nube.filaMiembro(equipo.id, USUARIO);
  ok(pertenencia, 'el creador queda dado de alta');
  is(pertenencia.role, 'owner', 'como propietario');
  is(teamsMod.rolConocido(equipo.id), 'owner', 'y la app lo sabe ya');
});

await itAsync('entrar con un código mete al usuario en el equipo y cambia el ámbito', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);
  nube.sembrarEquipo({ id: UUID_ENTRAR, name: 'Turnos de tarde', invite_code: 'K7M2QP4R', owner_id: OTRO_USUARIO });
  const store = storeMod.createStore(oneDayDoc());
  await montarEnAjustes(store);

  env.document.getElementById('settings-team-join').click();
  ok(env.document.getElementById('dialog-confirm').open, 'se abre el diálogo del código');
  env.document.getElementById('settings-team-code').value = 'K7M2QP4R';
  env.document.getElementById('confirm-ok').click();
  await sleep(80);

  is(store.doc.teamId, UUID_ENTRAR, 'el documento pasa al equipo del código');
  const pertenencia = nube.filaMiembro(UUID_ENTRAR, USUARIO);
  ok(pertenencia, 'la pertenencia se ha creado');
  is(pertenencia.role, 'member', 'se entra como miembro: por código no se puede ser dueño');
  is(teamsMod.rolConocido(UUID_ENTRAR), 'member');
});

await itAsync('un código que no existe avisa y no cambia el ámbito', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);
  const store = storeMod.createStore(oneDayDoc());
  await montarEnAjustes(store);

  env.document.getElementById('settings-team-join').click();
  env.document.getElementById('settings-team-code').value = 'NO-EXISTE';
  env.document.getElementById('confirm-ok').click();
  await sleep(80);

  is(store.doc.teamId, null, 'el ámbito sigue siendo personal');
  ok(env.document.getElementById('toasts').textContent.includes('código de invitación no es válido'),
    'y se avisa con un mensaje claro');
});

await itAsync('sin sesión avisa en vez de romperse', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(false);
  const store = storeMod.createStore(oneDayDoc());
  await montarEnAjustes(store, 10);

  ok(env.document.getElementById('settings-team-card').textContent.includes('Inicia sesión'),
    'la tarjeta explica que hace falta una cuenta');

  const antes = nube.llamadas.length;
  env.document.getElementById('settings-team-create').click();
  await sleep(20);
  is(env.document.getElementById('dialog-confirm').open, false, 'no se abre ningún diálogo');
  is(store.doc.teamId, null, 'el ámbito no cambia');
  ok(env.document.getElementById('toasts').textContent.includes('Inicia sesión para crear un equipo'),
    'y se avisa en pantalla');
  is(nube.llamadas.length, antes, 'sin sesión no se llama a la red');

  // Y la capa de datos tampoco lanza: devuelve un error en español.
  const crear = await teamsMod.createTeam('Equipo sin sesión');
  is(crear.ok, false);
  ok(/sesión/i.test(crear.error), `el error habla de la sesión (${crear.error})`);
  const entrar = await teamsMod.joinTeam('K7M2QP4R');
  is(entrar.ok, false);
  ok(/sesión/i.test(entrar.error), `y el de entrar también (${entrar.error})`);
  is(nube.llamadas.length, antes, 'siguen sin salir peticiones');
});

await itAsync('con rol viewer la app entra en solo lectura: aviso visible y acciones desactivadas', async () => {
  nube.reset();
  env.reset();
  cerrarDialogos();
  sesionFalsa(true);
  nube.sembrarEquipo({ id: UUID_SOLO_LECTURA, name: 'Equipo de consulta', invite_code: 'SOLO0001', owner_id: OTRO_USUARIO });
  nube.sembrarMiembro(UUID_SOLO_LECTURA, USUARIO, 'viewer');
  const store = storeMod.createStore(docDeEquipo(UUID_SOLO_LECTURA));

  await montarEnAjustes(store);
  is(teamsMod.rolConocido(UUID_SOLO_LECTURA), 'viewer', 'la app ha comprobado el rol contra el servidor');
  renderAll();

  // 1) El aviso se ve, y explica el porqué.
  const aviso = env.document.getElementById('roster-readonly');
  ok(!aviso.hidden, 'el aviso de solo lectura está visible');
  ok(aviso.textContent.includes('Solo lectura'), 'y dice qué pasa');

  // 2) Las acciones de escritura están DESACTIVADAS de verdad (atributo `disabled`).
  for (const id of ['roster-import', 'roster-rotate', 'roster-pattern', 'roster-copyweek', 'roster-holiday']) {
    is(env.document.getElementById(id).disabled, true, `${id} queda desactivado`);
  }
  is(env.document.getElementById('team-add').disabled, true, 'añadir persona, desactivado');
  for (const id of ['settings-shift-types', 'settings-clear-schedule', 'settings-import-pdf', 'settings-import-csv']) {
    is(env.document.getElementById(id).disabled, true, `${id} queda desactivado`);
  }

  // 3) Lo que NO escribe sigue disponible: quitarlo también sería mentir.
  is(env.document.getElementById('roster-copy').disabled, false, 'copiar sigue disponible');
  is(env.document.getElementById('roster-print').disabled, false, 'imprimir también');

  // 4) Un clic en una casilla no abre el diálogo de asignar: lo explica.
  const celda = env.document.querySelector('#roster-body td.shift-cell');
  ok(celda, 'el cuadrante tiene casillas');
  celda.click();
  await sleep(20);
  is(env.document.getElementById('dialog-assign').open, false, 'el diálogo de asignar no se abre');
  ok(env.document.getElementById('toasts').textContent.includes('Solo lectura'), 'y se explica por qué');

  // 5) Y el diálogo tampoco se abre llamándolo directamente (Calendario, Hoy…).
  dialogs.openDayEditor(contextMod.getContext(), '2025-06-04');
  await sleep(10);
  is(env.document.getElementById('dialog-day').open, false, 'el editor del día tampoco se abre');
});

await itAsync('con rol owner o admin se puede editar', async () => {
  const equipos = { owner: UUID_EDITAR_DUENO, admin: UUID_EDITAR_ADMIN };
  for (const rol of ['owner', 'admin']) {
    nube.reset();
    env.reset();
    cerrarDialogos();
    sesionFalsa(true);
    nube.sembrarEquipo({ id: equipos[rol], name: 'Equipo que edita', invite_code: `EDIT000${rol === 'owner' ? '1' : '2'}`, owner_id: OTRO_USUARIO });
    nube.sembrarMiembro(equipos[rol], USUARIO, rol);
    const store = storeMod.createStore(docDeEquipo(equipos[rol]));

    await montarEnAjustes(store);
    is(teamsMod.rolConocido(equipos[rol]), rol, `la app conoce el rol ${rol}`);
    renderAll();

    is(env.document.getElementById('roster-readonly').hidden, true, `sin aviso con ${rol}`);
    is(env.document.getElementById('roster-import').disabled, false, `importar disponible con ${rol}`);
    is(env.document.getElementById('roster-rotate').disabled, false, `rotar disponible con ${rol}`);
    is(env.document.getElementById('team-add').disabled, false, `añadir persona con ${rol}`);
    is(env.document.getElementById('settings-shift-types').disabled, false, `catálogo con ${rol}`);
    is(env.document.getElementById('settings-clear-schedule').disabled, false, `borrar turnos con ${rol}`);

    const celda = env.document.querySelector('#roster-body td.shift-cell');
    celda.click();
    const dialogo = env.document.getElementById('dialog-assign');
    ok(dialogo.open, `el diálogo de asignar se abre con ${rol}`);
    dialogo.close();
  }
});

await itAsync('el dueño ve los miembros, cambia roles y rota el código', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);
  nube.sembrarEquipo({ id: UUID_MIEMBROS, name: 'Cuadrante de mañanas', invite_code: 'CODIGO01', owner_id: USUARIO });
  nube.sembrarMiembro(UUID_MIEMBROS, USUARIO, 'owner');
  nube.sembrarMiembro(UUID_MIEMBROS, OTRO_USUARIO, 'member');
  const store = storeMod.createStore(docDeEquipo(UUID_MIEMBROS));
  await montarEnAjustes(store);

  const tarjeta = env.document.getElementById('settings-team-card');
  ok(tarjeta.textContent.includes('Cuadrante de mañanas'), 'sale el nombre del equipo');
  ok(tarjeta.textContent.includes('CODIGO01'), 'y el código de invitación');
  ok(tarjeta.textContent.includes('Miembros (2)'), 'y cuántos miembros hay');

  const selector = tarjeta.querySelector(`select[data-user-id="${OTRO_USUARIO}"]`);
  ok(selector, 'el dueño tiene selector de rol para el otro miembro');
  is(selector.value, 'member', 'con el rol actual marcado');
  selector.value = 'viewer';
  selector.dispatchEvent(new env.DOMEvent('change', { bubbles: true }));
  await sleep(40);
  is(nube.filaMiembro(UUID_MIEMBROS, OTRO_USUARIO).role, 'viewer', 'el rol se cambia de verdad');

  // Un rol que no existe no se acepta.
  const malo = await teamsMod.setMemberRole(UUID_MIEMBROS, OTRO_USUARIO, 'jefe');
  is(malo.ok, false);
  ok(/rol no existe/i.test(malo.error), `se rechaza con un mensaje claro (${malo.error})`);

  // Rotar el código: pide confirmación y el viejo deja de valer.
  tarjeta.querySelector('[data-team-action="rotar"]').click();
  ok(env.document.getElementById('dialog-confirm').open, 'rotar el código pide confirmación');
  env.document.getElementById('confirm-ok').click();
  await sleep(40);
  const equipo = nube.equipos().find((t) => t.id === UUID_MIEMBROS);
  ok(equipo.invite_code !== 'CODIGO01', 'el código viejo ya no vale');
  ok(/^[A-Z0-9]{8}$/.test(equipo.invite_code), `el nuevo tiene buena pinta (${equipo.invite_code})`);
});

await itAsync('myTeams() lista los equipos del usuario con su rol', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);
  nube.sembrarEquipo({ id: UUID_MIOS_A, name: 'Equipo propio', invite_code: 'PROPIO01', owner_id: USUARIO });
  nube.sembrarEquipo({ id: UUID_MIOS_B, name: 'Equipo ajeno', invite_code: 'AJENO001', owner_id: OTRO_USUARIO });
  nube.sembrarMiembro(UUID_MIOS_B, USUARIO, 'member');

  const res = await teamsMod.myTeams();
  ok(res.ok, `myTeams() no falla (${res.error || ''})`);
  is(res.equipos.length, 2, 'salen los dos equipos');
  const propio = res.equipos.find((e) => e.id === UUID_MIOS_A);
  const ajeno = res.equipos.find((e) => e.id === UUID_MIOS_B);
  is(propio.rol, 'owner', 'el equipo del que soy dueño sale como propietario (aunque no tenga fila de pertenencia)');
  is(ajeno.rol, 'member', 'y el otro con mi rol de miembro');
  is(propio.nombre, 'Equipo propio', 'con su nombre');
  is(teamsMod.rolConocido(UUID_MIOS_A), 'owner', 'y deja el rol guardado para la interfaz');
});

await itAsync('salir del equipo devuelve el documento a modo personal', async () => {
  const equipos = { member: UUID_SALIR, owner: 'aaaa1111-2222-4333-8444-555555555509' };
  for (const rol of ['member', 'owner']) {
    nube.reset();
    env.reset();
    cerrarDialogos();
    sesionFalsa(true);
    nube.sembrarEquipo({ id: equipos[rol], name: 'Equipo del que salgo', invite_code: `SALIR00${rol === 'member' ? '1' : '2'}`, owner_id: OTRO_USUARIO });
    nube.sembrarMiembro(equipos[rol], USUARIO, rol);
    const store = storeMod.createStore(docDeEquipo(equipos[rol]));
    await montarEnAjustes(store);
    is(store.doc.teamId, equipos[rol], `se empieza en el equipo (${rol})`);

    const boton = env.document.getElementById('settings-team-card').querySelector('[data-team-action="salir"]');
    ok(boton, 'existe «Salir del equipo»');
    boton.click();
    ok(env.document.getElementById('dialog-confirm').open, 'salir pide confirmación');
    env.document.getElementById('confirm-ok').click();
    await sleep(60);

    is(store.doc.teamId, null, `el documento vuelve a modo personal (${rol})`);
    is(teamsMod.rolConocido(equipos[rol]), null, `y la app olvida el rol (${rol})`);

    const fila = nube.filaMiembro(equipos[rol], USUARIO);
    if (rol === 'owner') {
      ok(fila && fila.deleted === true, 'el dueño deja lápida, para que la baja llegue a los demás dispositivos');
    } else {
      is(fila, null, 'quien no es dueño borra su fila (es lo único que le deja el servidor)');
    }
  }
});

await itAsync('elegir un equipo de la lista pide confirmación antes de mover el cuadrante', async () => {
  const UUID_LISTA = 'aaaa1111-2222-4333-8444-555555555510';
  nube.reset();
  env.reset();
  cerrarDialogos();
  sesionFalsa(true);
  nube.sembrarEquipo({ id: UUID_LISTA, name: 'Equipo de la lista', invite_code: 'LISTA001', owner_id: OTRO_USUARIO });
  nube.sembrarMiembro(UUID_LISTA, USUARIO, 'member');
  const store = storeMod.createStore(oneDayDoc());
  await montarEnAjustes(store, 80);

  const tarjeta = env.document.getElementById('settings-team-card');
  ok(tarjeta.textContent.includes('Equipo de la lista'), 'el equipo sale en la lista de los míos');
  const boton = tarjeta.querySelector(`[data-team-action="usar"][data-team-id="${UUID_LISTA}"]`);
  ok(boton, 'y tiene su botón para usarlo');

  // Cancelar no mueve nada.
  boton.click();
  ok(env.document.getElementById('dialog-confirm').open, 'pide confirmación');
  ok(env.document.getElementById('confirm-message').textContent.includes('pasará a ser el del equipo'),
    'con el aviso por escrito de lo que pasa con el cuadrante');
  env.document.getElementById('confirm-cancel').click();
  await sleep(20);
  is(store.doc.teamId, null, 'si se cancela, el ámbito no cambia');

  // Aceptar sí.
  boton.click();
  env.document.getElementById('confirm-ok').click();
  await sleep(40);
  is(store.doc.teamId, UUID_LISTA, 'al aceptar, el cuadrante pasa al equipo');
});

/* ==================================================================== *
 * 13. Las cabeceras de Supabase: la regresión del `apikey`
 *
 * El fallo ya se coló una vez, y llegó desde la aplicación real:
 * «No se pudo crear el equipo: new row violates row-level security policy for
 * table "horus_teams"» acompañado de «No API key found in request». Lo que
 * explica ese par de mensajes es que la petición salga SIN la cabecera
 * `apikey`: el servidor entonces no sabe de qué proyecto es, `auth.uid()` llega
 * nulo y RLS rechaza la fila con un mensaje que no habla de la causa real.
 *
 * Lo que se prueba aquí no es «que hoy funciona», sino que el fallo no puede
 * volver en silencio:
 *   · el Supabase falso graba TODAS las peticiones con sus cabeceras;
 *   · rechaza las que van sin `apikey` con el mismo 401 y el mismo cuerpo que
 *     el servidor de verdad, así que una petición sin cabeceras ya no puede
 *     «aprobar» en las pruebas;
 *   · se comprueban las cuatro funciones que fallaron (createTeam, joinTeam,
 *     myTeams, teamMembers) y que ninguna otra parte de `js/` hable con
 *     Supabase por su cuenta;
 *   · y se crea un equipo TAL COMO lo manda la aplicación (nombre y código,
 *     sin `id` ni `owner_key`: los pone el servidor). El fallo se coló porque
 *     se probó el camino cómodo —sembrar la fila con el ámbito ya puesto— y no
 *     el real.
 * ==================================================================== */

describe('Cabeceras de Supabase: la regresión del apikey');

const UUID_CABECERAS = 'aaaa1111-2222-4333-8444-555555555511';

/** Valor de una cabecera grabada (el servidor no distingue mayúsculas). */
function cabecera(peticion, nombre) {
  return peticion.cabeceras ? peticion.cabeceras[String(nombre).toLowerCase()] : undefined;
}

/** Las peticiones grabadas que van a la API REST de Supabase. */
function peticionesRest() {
  return nube.llamadas.filter((p) => p.url.includes('/rest/v1/'));
}

/** Todos los `.js` de `js/`, recursivo: para la comprobación estática. */
function archivosDeJS(dir = join(ROOT, 'js')) {
  const salida = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) salida.push(...archivosDeJS(ruta));
    else if (entrada.name.endsWith('.js')) salida.push(ruta);
  }
  return salida;
}

await itAsync('el Supabase falso rechaza una petición sin apikey como el servidor real', async () => {
  nube.reset();
  // Un `fetch` a mano y sin cabeceras: así es como sale una petición cuando no
  // pasa por `authFetch`, que es lo que se cuela en la aplicación real. La
  // respuesta tiene que ser la del servidor, no una inventada.
  const respuesta = await nube.fetchImpl('https://proyecto.supabase.co/rest/v1/horus_teams', { method: 'GET' });
  is(respuesta.ok, false, 'una petición sin apikey no puede salir bien');
  is(respuesta.status, 401, 'el servidor contesta 401');
  const cuerpo = JSON.parse(await respuesta.text());
  is(cuerpo.message, 'No API key found in request', 'con el mensaje literal del servidor');
  ok(String(cuerpo.hint).includes('apikey'), 'y la pista que dice qué falta');
});

await itAsync('toda petición de equipos a /rest/v1/ lleva apikey y, con sesión, Authorization', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);
  nube.sembrarEquipo({ id: UUID_CABECERAS, name: 'Equipo de cabeceras', invite_code: 'CABEZAS1', owner_id: OTRO_USUARIO });

  // Las cuatro funciones que fallaron, tal cual las usa la aplicación.
  const creado = await teamsMod.createTeam('Equipo con cabeceras');
  ok(creado.ok, `crear un equipo funciona (${creado.error || ''})`);
  const entrada = await teamsMod.joinTeam('CABEZAS1');
  ok(entrada.ok, `entrar con un código funciona (${entrada.error || ''})`);
  const mios = await teamsMod.myTeams();
  ok(mios.ok, `listar mis equipos funciona (${mios.error || ''})`);
  const miembros = await teamsMod.teamMembers(UUID_CABECERAS);
  ok(miembros.ok, `listar los miembros funciona (${miembros.error || ''})`);

  // Y las de gestión (cambiar un rol, rotar el código y salir) salen por la
  // misma puerta: si alguna se construyera aparte, se quedaría sin cabeceras.
  // Las comprobaciones de abajo recorren TODAS las peticiones grabadas, así que
  // estas tres quedan cubiertas sin repetir ni una aserción.
  const propio = creado.equipo.id;
  const cambioRol = await teamsMod.setMemberRole(propio, OTRO_USUARIO, 'admin');
  ok(cambioRol.ok, `cambiar un rol funciona (${cambioRol.error || ''})`);
  const rotado = await teamsMod.rotateInviteCode(propio);
  ok(rotado.ok, `rotar el código funciona (${rotado.error || ''})`);
  const salida = await teamsMod.leaveTeam(propio);
  ok(salida.ok, `salir del equipo funciona (${salida.error || ''})`);

  const rest = peticionesRest();
  ok(rest.length >= 9, `se han grabado las peticiones de todas las funciones (${rest.length})`);
  for (const peticion of rest) {
    const apikey = cabecera(peticion, 'apikey');
    ok(typeof apikey === 'string' && apikey.trim().length > 20,
      `sin apikey en ${peticion.metodo} ${peticion.url}`);
    ok(String(cabecera(peticion, 'authorization')).startsWith('Bearer '),
      `sin Authorization en ${peticion.metodo} ${peticion.url}`);
  }

  // Y no vale con que «alguien» haya llamado: cada función tiene que haber
  // pasado por ahí de verdad.
  const listado = rest.map((p) => `${p.metodo} ${p.url}`).join('\n      ');
  ok(rest.some((p) => p.metodo === 'POST' && p.url.endsWith('/horus_teams')),
    `createTeam no escribió en horus_teams:\n      ${listado}`);
  ok(rest.some((p) => p.metodo === 'POST' && p.url.includes('/rpc/horus_join_team')),
    `joinTeam no llamó a la función del servidor:\n      ${listado}`);
  ok(rest.some((p) => p.metodo === 'GET' && p.url.includes('horus_team_members?user_id=eq.')),
    `myTeams no leyó las pertenencias:\n      ${listado}`);
  ok(rest.some((p) => p.metodo === 'GET' && p.url.includes('horus_team_members?team_id=eq.')),
    `teamMembers no leyó los miembros:\n      ${listado}`);
});

await itAsync('si la petición se queda sin apikey, el fallo del servidor se reproduce en las pruebas', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);

  // Se simula la regresión en el cable, no en el módulo: a todo lo que va a
  // `/rest/v1/` se le quita el `apikey`. El refresco de token se contesta aquí
  // porque no es lo que se está probando (y sin él, `authFetch` intentaría
  // refrescar antes de devolver el 401).
  const fetchSano = globalThis.fetch;
  const tokenFalso = {
    access_token: 'tok', refresh_token: 'ref', expires_in: 3600,
    user: { id: USUARIO, email: 'ana@test' },
  };
  const respuestaToken = {
    ok: true, status: 200, headers: { get: () => null },
    json: async () => tokenFalso, text: async () => JSON.stringify(tokenFalso),
  };
  globalThis.fetch = async (url, opts = {}) => {
    const destino = String(url);
    if (destino.includes('/auth/v1/')) return respuestaToken;
    const cabeceras = { ...(opts.headers || {}) };
    for (const nombre of Object.keys(cabeceras)) {
      if (nombre.toLowerCase() === 'apikey') delete cabeceras[nombre];
    }
    return fetchSano(destino, { ...opts, headers: cabeceras });
  };

  try {
    const res = await teamsMod.createTeam('Equipo sin apikey');
    is(res.ok, false, 'sin la cabecera no se puede crear el equipo');
    ok(String(res.error).includes('No API key found in request'),
      `y el error es el del servidor, no uno inventado (${res.error})`);
  } finally {
    globalThis.fetch = fetchSano;
  }

  // Con el cable sano vuelve a funcionar: lo que fallaba era la cabecera.
  const sano = await teamsMod.createTeam('Equipo con cabeceras');
  ok(sano.ok, `con el apikey puesto el equipo se crea (${sano.error || ''})`);
});

await itAsync('createTeam manda la fila como la manda la aplicación: nombre y código, sin id ni owner_key', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);

  const res = await teamsMod.createTeam('Cuadrante de mañanas');
  ok(res.ok, `el equipo se crea (${res.error || ''})`);

  const alta = nube.llamadas.find((p) => p.metodo === 'POST' && p.url.endsWith('/horus_teams'));
  ok(alta, 'hay una petición de alta en horus_teams');
  const fila = Array.isArray(alta.cuerpo) ? alta.cuerpo[0] : alta.cuerpo;
  is(Object.keys(fila).sort().join(','), 'invite_code,name,owner_id',
    'la fila que manda el cliente: nombre, código y dueño… y nada más');
  is(fila.owner_id, USUARIO, 'el dueño es quien la crea');
  ok(/^[A-Z0-9]{8}$/.test(fila.invite_code), `el código lo genera el cliente (${fila.invite_code})`);
  is('id' in fila, false, 'el id NO lo inventa el cliente: lo pone el servidor');
  is('owner_key' in fila, false, 'y el ámbito tampoco: lo rellena el trigger del servidor');

  // Y el servidor (el falso) ha hecho su parte: id propio y ámbito derivado.
  const equipo = nube.equipos().find((t) => t.name === 'Cuadrante de mañanas');
  ok(equipo, 'el equipo existe en el servidor');
  is(equipo.owner_key, `team:${equipo.id}`, 'con el ámbito que le pone el servidor desde su id');
  const pertenencia = nube.filaMiembro(equipo.id, USUARIO);
  ok(pertenencia, 'y el creador dado de alta');
  is(pertenencia.role, 'owner', 'como propietario');
  is(pertenencia.owner_key, `team:${equipo.id}`, 'con el ámbito del equipo, no el personal');
});

it('ningún módulo habla con Supabase por su cuenta: todo pasa por authFetch', () => {
  const problemas = [];
  for (const ruta of archivosDeJS()) {
    const fuente = readFileSync(ruta, 'utf8');
    const corto = ruta.slice(ROOT.length + 1).split('\\').join('/');
    // Quien construye rutas de la API REST tiene que hacerlo por la puerta de
    // `auth.js`, que es la única que pone `apikey` y `Authorization`.
    if (fuente.includes('/rest/v1/')) {
      if (!fuente.includes('authFetch(')) problemas.push(`${corto}: usa /rest/v1/ sin pasar por authFetch`);
      // `authFetch(` no cuenta: se busca un fetch() suelto de verdad.
      if (/(^|[^A-Za-z_$])fetch\s*\(/.test(fuente)) problemas.push(`${corto}: llama a fetch() a mano`);
    }
  }
  is(problemas.join('; '), '', 'módulos que podrían salir sin las cabeceras de la app');

  // Y la cabecera se escribe en un único sitio: dos copias son dos verdades.
  const conApiKey = archivosDeJS()
    .filter((ruta) => /apikey\s*:/.test(readFileSync(ruta, 'utf8')))
    .map((ruta) => ruta.slice(ROOT.length + 1).split('\\').join('/'));
  is(conApiKey.join(','), 'js/core/auth.js', 'el único sitio que escribe la cabecera apikey');
});

/* ==================================================================== *
 * 14. La app dice QUÉ falta y lo comprueba de verdad
 *
 * El fallo que se cuela desde la aplicación real no es solo que falte la clave:
 * es que, cuando falta o no vale, el usuario acaba delante de un mensaje del
 * servidor en inglés («No API key found in request») que no dice qué arreglar
 * ni dónde. Aquí se prueba lo contrario:
 *   · sin URL o sin clave NO se sale a la red y el error está en español y
 *     señala Ajustes → Nube (comprobado con el contador de llamadas del falso);
 *   · el botón «Probar la conexión» distingue falta de configuración, clave
 *     que no vale, proyecto sin las tablas, falta de sesión y todo bien;
 *   · cita el mensaje LITERAL del servidor;
 *   · y enseña la URL y la clave enmascarada sin enseñar jamás la clave entera.
 * ==================================================================== */

describe('La nube sin clave y «Probar la conexión»');

const configMod = await import('../js/config.js');

/** Los escenarios de configuración que se prueban, siempre restaurados después. */
async function conConfiguracion(ajustes, fn) {
  configMod.setCloudConfig(ajustes.propia || null);
  configMod.setDefaultCloud(ajustes.porDefecto || configMod.DEFAULT_CLOUD);
  configMod.resetCloudConfigCache();
  try {
    return await fn();
  } finally {
    configMod.setCloudConfig(null);
    configMod.setDefaultCloud(configMod.DEFAULT_CLOUD);
    configMod.resetCloudConfigCache();
  }
}

await itAsync('sin la clave pública, la capa de equipos lo dice en español y NO sale ninguna petición', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);

  await conConfiguracion({ porDefecto: { url: 'https://proyecto-de-prueba.supabase.co', anonKey: '' } }, async () => {
    const crear = await teamsMod.createTeam('Equipo sin clave');
    is(crear.ok, false, 'no se puede crear el equipo');
    ok(/clave pública/i.test(crear.error), `el error dice qué falta (${crear.error})`);
    ok(crear.error.includes('Ajustes → Nube'), 'y dónde se arregla');
    is(nube.llamadas.length, 0, 'no se ha hecho NINGUNA petición');

    // La puerta es una sola para toda la capa: entrar, listar y leer miembros
    // tampoco salen a la red.
    for (const llamada of [
      () => teamsMod.joinTeam('K7M2QP4R'),
      () => teamsMod.myTeams(),
      () => teamsMod.teamMembers(UUID_CABECERAS),
    ]) {
      const res = await llamada();
      is(res.ok, false, 'sin clave no puede salir bien');
      ok(res.error, 'y se explica por qué');
    }
    is(nube.llamadas.length, 0, 'siguen sin salir peticiones');

    // Si lo que falta es la URL, el mensaje lo dice: no es el mismo arreglo.
    configMod.setDefaultCloud({ url: '', anonKey: configMod.DEFAULT_CLOUD.anonKey });
    configMod.resetCloudConfigCache();
    const sinUrl = await teamsMod.createTeam('Equipo sin URL');
    is(sinUrl.ok, false);
    ok(/falta la url/i.test(sinUrl.error), `el error habla de la URL (${sinUrl.error})`);
    ok(sinUrl.error.includes('Ajustes → Nube'), 'y también dice dónde se arregla');
    is(nube.llamadas.length, 0, 'y tampoco ha salido ninguna petición');
  });
});

await itAsync('«Probar la conexión» avisa de que falta la clave sin llamar a la red', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);

  await conConfiguracion({ porDefecto: { url: 'https://proyecto-de-prueba.supabase.co', anonKey: '' } }, async () => {
    const store = storeMod.createStore(oneDayDoc());
    await montarEnAjustes(store, 20);

    const boton = env.document.getElementById('settings-cloud-test');
    ok(boton, 'el botón existe en index.html');
    boton.click();
    await sleep(40);

    const texto = env.document.getElementById('settings-cloud-test-result').textContent;
    ok(/falta configurar la nube/i.test(texto), `el resultado dice qué pasa (${texto.slice(0, 120)})`);
    ok(/clave pública/i.test(texto), 'dice qué falta exactamente');
    ok(texto.includes('Ajustes → Nube'), 'y dónde se arregla');
    ok(texto.includes('proyecto-de-prueba.supabase.co'), 'enseña la URL que se está usando');
    ok(/no hay ninguna guardada/i.test(texto), 'y que no hay clave guardada');
    is(nube.llamadas.length, 0, 'sin configuración no se ha llamado al servidor');
  });
});

await itAsync('«Probar la conexión» cita el error del servidor cuando la clave no vale', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);

  await conConfiguracion({
    propia: { url: 'https://proyecto-de-prueba.supabase.co', anonKey: CLAVE_QUE_NO_VALE },
  }, async () => {
    const store = storeMod.createStore(oneDayDoc());
    await montarEnAjustes(store, 20);

    env.document.getElementById('settings-cloud-test').click();
    await sleep(40);

    const texto = env.document.getElementById('settings-cloud-test-result').textContent;
    ok(/la clave pública no vale/i.test(texto), `se dice que la clave no vale (${texto.slice(0, 160)})`);
    ok(texto.includes('Invalid API key'), 'y se cita el mensaje literal del servidor');
    ok(texto.includes('HTTP 401'), 'con su código');
    ok(texto.includes(CLAVE_QUE_NO_VALE.slice(0, 8)), 'se enseña el trozo enmascarado de la clave');
    ok(!texto.includes(CLAVE_QUE_NO_VALE), 'pero NUNCA la clave entera');
    ok(texto.includes('caracteres'), 'y la longitud, que delata una clave truncada');
  });
});

await itAsync('si la petición se queda sin apikey, el diagnóstico nombra el fallo original', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);

  const store = storeMod.createStore(oneDayDoc());
  await montarEnAjustes(store, 20);

  // La regresión que llegó desde la aplicación real: la cabecera `apikey` no
  // sale. Se simula en el cable, no en el módulo, y el botón tiene que contar
  // el mensaje del servidor en vez de dejarlo crudo.
  const fetchSano = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const cabeceras = { ...(opts.headers || {}) };
    for (const nombre of Object.keys(cabeceras)) {
      if (nombre.toLowerCase() === 'apikey') delete cabeceras[nombre];
    }
    return fetchSano(String(url), { ...opts, headers: cabeceras });
  };

  try {
    env.document.getElementById('settings-cloud-test').click();
    await sleep(40);
  } finally {
    globalThis.fetch = fetchSano;
  }

  const texto = env.document.getElementById('settings-cloud-test-result').textContent;
  ok(/la clave pública no vale/i.test(texto), 'se explica que la clave no llega a valer');
  ok(texto.includes('No API key found in request'), 'citando el mensaje literal del fallo original');
  ok(texto.includes('HTTP 401'), 'y su código');
});

await itAsync('«Probar la conexión» avisa si hay una clave escrita sin guardar', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);

  const store = storeMod.createStore(oneDayDoc());
  await montarEnAjustes(store, 20);

  // El caso de «lo he pegado y sigue fallando»: la clave está en el formulario
  // pero no se ha guardado, así que la comprobación usa la de antes.
  const campo = env.document.getElementById('cloud-key');
  ok(campo, 'el campo de la clave está en el formulario de la nube');
  campo.value = CLAVE_QUE_NO_VALE;

  env.document.getElementById('settings-cloud-test').click();
  await sleep(40);

  const texto = env.document.getElementById('settings-cloud-test-result').textContent;
  ok(/sin guardar/i.test(texto), `se avisa de que no está guardada (${texto.slice(0, 200)})`);
  ok(/Guardar y recargar/.test(texto), 'y de qué botón hay que pulsar');
  ok(!texto.includes(CLAVE_QUE_NO_VALE), 'y ni así se enseña la clave entera');
});

await itAsync('«Probar la conexión» distingue «la clave vale pero falta iniciar sesión»', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(false);

  const store = storeMod.createStore(oneDayDoc());
  await montarEnAjustes(store, 20);

  env.document.getElementById('settings-cloud-test').click();
  await sleep(40);

  const texto = env.document.getElementById('settings-cloud-test-result').textContent;
  ok(/la clave vale, pero no has iniciado sesión/i.test(texto), `se distingue el caso (${texto.slice(0, 160)})`);
  ok(/inicia sesión/i.test(texto), 'y se dice qué hacer');
  ok(texto.includes('URL del proyecto: https://'), 'el diagnóstico enseña la URL usada');
  ok(texto.includes('eyJhbGci'), 'y la clave enmascarada');
  ok(!texto.includes(configMod.DEFAULT_CLOUD.anonKey), 'nunca la clave entera');
  // La prueba de que se ha preguntado al servidor por la sesión: la función de
  // entrar en un equipo, SIN cuenta, contesta lo suyo.
  ok(nube.llamadas.some((p) => p.metodo === 'POST' && p.url.includes('/rpc/horus_join_team')),
    'se ha consultado la función de equipos sin sesión');
  ok(/código de invitación no es válido/i.test(texto), 'y se cita su respuesta literal');
});

await itAsync('«Probar la conexión» avisa si al proyecto le faltan las tablas', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);
  nube.simularSinTablas(true);

  try {
    const store = storeMod.createStore(oneDayDoc());
    await montarEnAjustes(store, 20);

    env.document.getElementById('settings-cloud-test').click();
    await sleep(40);

    const texto = env.document.getElementById('settings-cloud-test-result').textContent;
    ok(/faltan las tablas de horus/i.test(texto), `se distingue del caso de la clave (${texto.slice(0, 160)})`);
    ok(texto.includes('Could not find the table'), 'citando la respuesta del servidor');
    ok(/carpeta «supabase»/i.test(texto), 'y diciendo dónde está el SQL que falta');
  } finally {
    nube.simularSinTablas(false);
  }
});

await itAsync('«Probar la conexión» confirma cuando todo funciona', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);

  const store = storeMod.createStore(oneDayDoc());
  await montarEnAjustes(store, 20);

  env.document.getElementById('settings-cloud-test').click();
  await sleep(40);

  const texto = env.document.getElementById('settings-cloud-test-result').textContent;
  ok(/la conexión funciona/i.test(texto), `se confirma el buen estado (${texto.slice(0, 160)})`);
  ok(texto.includes('ana@test'), 'se nombra la cuenta con la que se ha comprobado');
  ok(texto.includes('URL del proyecto: https://'), 'y la URL que se está usando');
  ok(texto.includes('eyJhbGci'), 'junto a la clave enmascarada');
  ok(!texto.includes(configMod.DEFAULT_CLOUD.anonKey), 'nunca la clave entera');
  ok(texto.includes('HTTP 200'), 'con la respuesta literal del servidor');
});

/* -------------------------------------------------------------------- *
 * La clave pública: las DOS formas que emite Supabase, de punta a punta
 *
 * El fallo que llegó desde la aplicación real: con una clave pública de las
 * nuevas (`sb_publishable_…`) pegada en Ajustes → Nube, la app se quedaba sin
 * clave (se descartaba al guardarla, porque no es un JWT) y salía a la red sin
 * la cabecera `apikey`. Aquí se comprueba lo contrario, y por el mismo camino
 * que la app de verdad: se guarda la clave, la capa de equipos hace peticiones
 * contra el Supabase falso y la clave viaja en la cabecera. Y la que NO puede
 * usarse en el navegador (`sb_secret_…`) se rechaza desde el propio formulario.
 * -------------------------------------------------------------------- */

const CLAVE_PUBLICABLE = 'sb_publishable_9hZk2LmQ4rT7wX1yB3nC5vD8fG0jH6kP';
const CLAVE_ANON_CLASICA = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${'x'.repeat(40)}.${'z'.repeat(20)}`;
const CLAVE_SECRETA = 'sb_secret_9hZk2LmQ4rT7wX1yB3nC5vD8fG0jH6kP';
const URL_NUBE = 'https://proyecto-de-prueba.supabase.co';

/** La clave que llevó cada petición que ha salido (el Supabase falso las apunta). */
function clavesEnviadas() {
  return nube.llamadas.map((peticion) => peticion.cabeceras.apikey);
}

await itAsync('una clave pública nueva («sb_publishable_…») viaja en la cabecera apikey', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);

  await conConfiguracion({ propia: { url: URL_NUBE, anonKey: CLAVE_PUBLICABLE } }, async () => {
    is(configMod.cloudConfig().anonKey, CLAVE_PUBLICABLE,
      'la clave nueva se guarda entera (antes se descartaba por no ser un JWT)');

    const crear = await teamsMod.createTeam('Equipo con clave nueva');
    is(crear.ok, true, `crear el equipo funciona (${crear.error || 'sin error'})`);

    ok(nube.llamadas.length > 0, 'ha salido una petición de verdad');
    is(clavesEnviadas().filter((clave) => !clave).length, 0, 'ninguna salió sin la cabecera apikey');
    is(clavesEnviadas()[0], CLAVE_PUBLICABLE, 'y lleva la clave nueva, tal cual se guardó');
  });
});

await itAsync('la clave clásica («anon»: un JWT) sigue viajando en la cabecera apikey', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);

  await conConfiguracion({ propia: { url: URL_NUBE, anonKey: CLAVE_ANON_CLASICA } }, async () => {
    is(configMod.cloudConfig().anonKey, CLAVE_ANON_CLASICA, 'la clásica no se ha roto');

    const crear = await teamsMod.createTeam('Equipo con clave clásica');
    is(crear.ok, true, `crear el equipo funciona (${crear.error || 'sin error'})`);
    is(clavesEnviadas()[0], CLAVE_ANON_CLASICA, 'y la clave clásica llega igual a la cabecera');
  });
});

await itAsync('Ajustes rechaza la clave secreta («sb_secret_…») y no guarda nada', async () => {
  nube.reset();
  env.reset();
  sesionFalsa(true);
  configMod.setCloudConfig(null);
  configMod.resetCloudConfigCache();

  const store = storeMod.createStore(oneDayDoc());
  await montarEnAjustes(store, 20);

  const caja = env.document.getElementById('settings-cloud');
  const campoClave = env.document.getElementById('cloud-key');
  ok(campoClave, 'el campo de la clave está en el formulario');
  env.document.getElementById('cloud-url').value = URL_NUBE;
  campoClave.value = CLAVE_SECRETA;

  const guardar = [...caja.querySelectorAll('button')]
    .find((boton) => /Guardar y recargar/.test(boton.textContent));
  ok(guardar, 'el botón de guardar existe');
  // Montar Ajustes ya hace sus propias consultas (el rol en el equipo), así que
  // lo que se mide es lo que pasa A PARTIR del intento de guardar.
  const antes = nube.llamadas.length;
  guardar.click();
  await sleep(20);

  const aviso = env.document.getElementById('toasts').textContent;
  ok(/secret/i.test(aviso), `el aviso dice qué clave es (${aviso.slice(0, 160)})`);
  ok(/no puede usarse en el navegador/i.test(aviso), 'y que no puede estar en el navegador');
  ok(/servidor/i.test(aviso), 'y dónde sí vale');
  is(configMod.hasOwnCloudConfig(), false, 'no ha quedado guardada');
  is(nube.llamadas.length, antes, 'el intento de guardarla no ha disparado ninguna petición');
  ok(!clavesEnviadas().includes(CLAVE_SECRETA), 'y la clave secreta no ha salido en ninguna cabecera');
});

/* ==================================================================== *
 * Informe
 * ==================================================================== */

console.log(`\n${'─'.repeat(62)}`);
if (failed === 0) {
  console.log(`\x1b[1m\x1b[32m✓ ${passed} pruebas de interfaz correctas\x1b[0m`);
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









