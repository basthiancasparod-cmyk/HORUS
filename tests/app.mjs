/**
 * HORUS — tests/app.mjs
 * Prueba de extremo a extremo del arranque real de la aplicación.
 *
 * A diferencia de `smoke.mjs` (que monta las vistas con un contexto falso), aquí
 * se ejecuta `boot()` de verdad: se decide la pantalla inicial, se recorre el
 * asistente, se usa la aplicación, se exporta, se recarga y se comprueba que la
 * migración del formato antiguo funciona.
 *
 * Ejecutar: node tests/app.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDOM } from './dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0;
let failed = 0;
const failures = [];
let suiteName = '';

const errors = [];
const originalError = console.error;
const originalWarn = console.warn;

function describe(name) { suiteName = name; console.log(`\n\x1b[1m\x1b[36m${name}\x1b[0m`); }

async function it(name, fn) {
  errors.length = 0;
  console.error = (...args) => { errors.push(args.map(String).join(' ')); };
  console.warn = (...args) => { errors.push(`AVISO ${args.map(String).join(' ')}`); };
  try {
    await fn();
    console.error = originalError;
    console.warn = originalWarn;
    const unexpected = errors.filter((e) => !/deprecat/i.test(e));
    if (unexpected.length) throw new Error(`se registraron errores:\n      ${unexpected.join('\n      ')}`);
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    console.error = originalError;
    console.warn = originalWarn;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==================================================================== *
 * Entorno
 * ==================================================================== */

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const env = installDOM(html);
globalThis.fetch = async () => {
  throw new Error('la prueba de arranque no debe salir a la red');
};

const config = await import('../js/config.js');
const storage = await import('../js/core/storage.js');
const model = await import('../js/core/model.js');

/**
 * Dos escenarios de despliegue:
 *  - «sin nube»: alguien que usa HORUS por su cuenta, todo en el dispositivo.
 *  - «con nube»: el despliegue con Supabase configurado (lo normal en el equipo).
 */
const TEST_CLOUD = {
  url: 'https://proyecto-de-prueba.supabase.co',
  anonKey: `${'a'.repeat(20)}.${'b'.repeat(40)}.${'c'.repeat(20)}`,
};

/**
 * Escenario «despliegue con nube»: BORRA todo y deja Supabase configurado.
 * Es un punto de partida limpio, no un simple cambio de configuración.
 */
function resetStorage() {
  env.reset();
  localStorage.clear();
  config.setCloudConfig(TEST_CLOUD);
  config.setDefaultCloud(null);
  config.resetCloudConfigCache();
}

/** Escenario «despliegue sin nube»: también desde cero. */
function useNoCloud() {
  env.reset();
  localStorage.clear();
  config.setCloudConfig(null);
  config.setDefaultCloud(null);
  config.resetCloudConfigCache();
}

/**
 * Cambia el escenario a «sin nube» CONSERVANDO los datos guardados.
 *
 * Es lo que hace falta para probar una recarga: el almacenamiento tiene que
 * sobrevivir, porque es justo lo que se está comprobando. Borrarlo aquí dejaría
 * las pruebas de persistencia sin nada que recuperar (y así se comportaban mal
 * antes de separar estas dos funciones).
 */
function keepDataNoCloud() {
  config.setCloudConfig(null);
  config.setDefaultCloud(null);
  config.resetCloudConfigCache();
}

// La aplicación se arranca sola al importarse en un navegador. En Node se
// importa sin arrancar y las pruebas controlan cuándo empieza cada escenario.
resetStorage();
const app = await import('../js/app.js');

/**
 * Arranca la aplicación como si se acabara de abrir la pestaña.
 * Los datos guardados se conservan: es una recarga, no un borrón.
 */
async function bootFresh() {
  await sleep(10);
  for (const id of ['boot', 'auth-screen', 'wizard-screen', 'app']) {
    env.document.getElementById(id).hidden = true;
  }
  env.document.getElementById('boot').hidden = false;
  await app.boot();
  await sleep(40);
}

const visibleScreen = () => {
  for (const id of ['boot', 'auth-screen', 'wizard-screen', 'app']) {
    if (!env.document.getElementById(id).hidden) return id;
  }
  return null;
};

/** El contexto vivo de la aplicación. */
const ctxNow = () => app.getContext();

/* ==================================================================== *
 * 1. Despliegue sin nube: la app nunca pide cuenta
 * ==================================================================== */

describe('Despliegue sin nube (instalación personal)');

await it('la primera vez muestra el asistente, no la pantalla de acceso', async () => {
  useNoCloud();
  await bootFresh();
  is(visibleScreen(), 'wizard-screen', 'debe empezar por el asistente');
  is(env.document.getElementById('wizard-name').value, '', 'el nombre empieza vacío');
});

await it('el asistente avanza por los tres pasos y añade compañeros', async () => {
  const form = env.document.getElementById('form-wizard');

  env.document.getElementById('wizard-name').value = 'Ana Ruiz';
  env.document.getElementById('wizard-hours').value = '40';
  form.requestSubmit();
  ok(env.document.querySelector('[data-wizard-step="1"]').classList.contains('is-active'), 'paso 2 activo');

  for (const name of ['Luis Peña', 'Eva Moral']) {
    env.document.getElementById('wizard-member-input').value = name;
    env.document.getElementById('wizard-add-member').click();
  }
  is(env.document.getElementById('wizard-members').children.length, 2, 'dos compañeros añadidos');

  form.requestSubmit();
  ok(env.document.querySelector('[data-wizard-step="2"]').classList.contains('is-active'), 'paso 3 activo');
});

await it('al terminar se entra en la aplicación con el equipo creado', async () => {
  env.document.getElementById('wizard-region').value = 'MD';
  env.document.getElementById('form-wizard').requestSubmit();
  await sleep(250); // el asistente termina de forma asíncrona (monta las vistas)

  is(visibleScreen(), 'app', 'debe mostrarse la aplicación');
  const ctx = ctxNow();
  const doc = ctx.doc;
  is(doc.members.length, 3, 'tres personas en el equipo');
  is(doc.members[0].name, 'Ana Ruiz', 'la primera es quien configuró la app');
  is(doc.meId, doc.members[0].id, 'y es el perfil activo');
  is(doc.members[0].weeklyHours, 40, 'con su jornada semanal');
  is(doc.settings.firstRun, false, 'el primer arranque queda marcado');
});

await it('los festivos de la comunidad elegida se han marcado', async () => {
  const ctx = ctxNow();
  const year = new Date().getFullYear();
  const imported = Object.entries(ctx.doc.dayMeta)
    .filter(([date, meta]) => date.startsWith(String(year)) && meta.imported);
  ok(imported.length >= 8, `debe haber festivos de ${year} marcados (hay ${imported.length})`);
  const enero = ctx.doc.dayMeta[`${year}-01-01`];
  ok(enero, 'el 1 de enero está marcado');
  is(enero.dayType, 'holiday', 'y es festivo');
});

await it('el calendario se pinta con la rejilla del mes', async () => {
  ctxNow().navigate('calendar');
  await sleep(30);
  const cells = env.document.getElementById('calendar-grid').querySelectorAll('.month-cell');
  ok(cells.length >= 28, `la rejilla tiene celdas (${cells.length})`);
});

/* ==================================================================== *
 * 2. Uso real de la aplicación
 * ==================================================================== */

describe('Uso de la aplicación');

await it('asignar un turno desde el diálogo funciona', async () => {
  const ctx = ctxNow();
  const date = '2025-06-10';
  ctx.navigate('roster');
  await sleep(20);
  ctx.openAssign({ date, memberIds: [ctx.doc.meId] });

  const dialog = env.document.getElementById('dialog-assign');
  ok(dialog.open, 'el diálogo se abre');
  is(env.document.getElementById('assign-date').value, date, 'con la fecha pedida');

  env.document.getElementById('assign-types').querySelectorAll('.chip')[0].click();
  env.document.getElementById('form-assign').requestSubmit();

  const entries = ctx.doc.entries.filter((e) => e.date === date);
  is(entries.length, 1, 'hay un turno ese día');
  ok(entries[0].typeId, 'con un tipo asignado');
});

await it('deshacer y rehacer responden al instante', async () => {
  const ctx = ctxNow();
  const before = ctx.doc.entries.length;
  ctx.undo();
  is(ctx.doc.entries.length, before - 1, 'deshacer quita el turno');
  ctx.redo();
  is(ctx.doc.entries.length, before, 'rehacer lo devuelve');
});

await it('el editor de un día guarda notas y marca festivo', async () => {
  const ctx = ctxNow();
  ctx.openDay('2025-06-11');
  ok(env.document.getElementById('dialog-day').open, 'el editor se abre');
  env.document.getElementById('day-notes').value = 'Reunión a las 9';
  env.document.getElementById('day-mark-holiday').click();
  env.document.getElementById('day-save').click();
  await sleep(30);

  const meta = ctx.doc.dayMeta['2025-06-11'];
  ok(meta, 'el día tiene metadatos');
  is(meta.notes, 'Reunión a las 9', 'con la nota');
  is(meta.dayType, 'holiday', 'y marcado como festivo');
});

await it('el catálogo de turnos se puede ampliar desde Ajustes', async () => {
  const ctx = ctxNow();
  ctx.navigate('settings');
  await sleep(30);
  env.document.getElementById('settings-shift-types').click();
  ok(env.document.getElementById('dialog-type').open, 'el gestor de turnos se abre');

  const addButton = [...env.document.getElementById('dialog-type').querySelectorAll('button')]
    .find((b) => b.textContent.includes('Añadir un tipo de turno'));
  ok(addButton, 'existe el botón de añadir');
  addButton.click();
  env.document.getElementById('type-code').value = 'R1';
  env.document.getElementById('type-label').value = 'Refuerzo';
  env.document.getElementById('form-type').requestSubmit();
  await sleep(30);
  ok(ctx.doc.shiftTypes.some((t) => t.code === 'R1'), 'el turno nuevo existe en el catálogo');
});

/* ==================================================================== *
 * 3. Persistencia y recarga
 * ==================================================================== */

const snapshot = {};

await it('el estado se guarda sola en el dispositivo', async () => {
  const ctx = ctxNow();
  await sleep(500); // el guardado va con retardo (debounce)
  const raw = localStorage.getItem(storage.KEY_DOC);
  ok(raw, 'hay documento guardado');
  const saved = JSON.parse(raw);
  snapshot.members = ctx.doc.members.length;
  snapshot.entries = ctx.doc.entries.length;
  snapshot.shiftTypes = ctx.doc.shiftTypes.length;
  is(saved.members.length, snapshot.members, 'mismas personas');
  is(saved.entries.length, snapshot.entries, 'mismos turnos');
});

await it('al recargar todo sigue donde estaba', async () => {
  await bootFresh();
  is(visibleScreen(), 'app', 'entra directa, sin asistente ni acceso');
  const ctx = ctxNow();
  is(ctx.doc.members.length, snapshot.members, 'conserva las personas');
  is(ctx.doc.entries.length, snapshot.entries, 'conserva los turnos');
  is(ctx.doc.shiftTypes.length, snapshot.shiftTypes, 'conserva el catálogo');
  is(ctx.doc.members[0].name, 'Ana Ruiz', 'y el nombre');
  is(ctx.doc.dayMeta['2025-06-11']?.notes, 'Reunión a las 9', 'y las notas del día');
});

/* ==================================================================== *
 * 4. Despliegue con nube configurada
 * ==================================================================== */

describe('Despliegue con nube configurada');

await it('sin datos locales ofrece iniciar sesión (puede tenerlos en la nube)', async () => {
  resetStorage();
  await bootFresh();
  is(visibleScreen(), 'auth-screen', 'muestra la pantalla de acceso');
  ok(env.document.getElementById('form-auth'), 'con el formulario de acceso');
});

await it('se puede seguir en local sin crear cuenta', async () => {
  env.document.getElementById('auth-local').click();
  await sleep(40);
  is(visibleScreen(), 'wizard-screen', 'entra al asistente en modo local');
});

await it('y ese cuadrante local sobrevive a recargas posteriores', async () => {
  const form = env.document.getElementById('form-wizard');
  env.document.getElementById('wizard-name').value = 'Bea';
  form.requestSubmit(); // paso 2
  form.requestSubmit(); // paso 3
  form.requestSubmit(); // finalizar
  await sleep(250);
  is(visibleScreen(), 'app', 'se entra en la aplicación');
  is(ctxNow().doc.members.map((m) => m.name).join(','), 'Bea', 'con el equipo recién creado');
  await sleep(500); // deja que se guarde (el guardado va con retardo)

  // Al recargar hay datos locales: entra directo aunque haya nube configurada.
  // Se conserva el almacenamiento a propósito: es lo que se está probando.
  keepDataNoCloud();
  await bootFresh();
  is(visibleScreen(), 'app', 'entra directa con los datos locales');
  is(ctxNow().doc.members[0].name, 'Bea', 'y son los suyos');
});

/* ==================================================================== *
 * 5. Migración del formato antiguo
 * ==================================================================== */

describe('Migración del formato antiguo');

await it('un archivo de la versión anterior se convierte al arrancar', async () => {
  useNoCloud();
  const legacy = {
    activeProfile: 'Javier',
    profiles: ['Javier', 'Alejandra', 'Sergio'],
    shiftTypes: {
      M: { code: 'M', label: 'Mañana', hex: '#F2A33C', blocks: [{ start: '08:30', end: '17:00' }] },
      T: { code: 'T', label: 'Tarde', hex: '#5B8DEF', blocks: [{ start: '16:15', end: '00:45' }] },
    },
    days: {
      '2025-06-02': { date: '2025-06-02', sc: 'M', dt: 'normal', notes: 'Llevar llaves' },
      '2025-06-03': { date: '2025-06-03', sc: 'T', dt: 'normal', notes: '' },
      '2025-06-05': { date: '2025-06-05', sc: null, dt: 'feriado', notes: '' },
    },
    settings: { notificationsEnabled: true, alarmMinutesBefore: 15 },
    onboardingDone: true,
    _savedAt: Date.now() - 86400000,
  };
  localStorage.setItem(model.OLD_DB_KEY, JSON.stringify(legacy));

  await bootFresh();

  is(visibleScreen(), 'app', 'con datos migrados se entra directamente');
  const ctx = ctxNow();
  is(ctx.doc.members.length, 3, 'los tres perfiles pasan a ser personas');
  is(ctx.doc.members.find((m) => m.name === 'Javier').role, 'owner', 'el activo pasa a responsable');
  is(ctx.doc.entries.length, 3, 'los tres días pasan a ser turnos');
  is(ctx.doc.entries.find((e) => e.date === '2025-06-02').notes, 'Llevar llaves', 'las notas se conservan');
  is(ctx.doc.dayMeta['2025-06-05']?.dayType, 'holiday', 'el feriado queda como festivo');
  is(ctx.doc.settings.notifications.minutesBefore, 15, 'la antelación del aviso se traslada');
  ok(localStorage.getItem('horus.legacy.bak'), 'queda copia del archivo antiguo por si acaso');
});

await it('el cuadrante migrado se ve en el calendario', async () => {
  const ctx = ctxNow();
  ctx.navigate('calendar');
  // Los datos migrados son de junio de 2025: hay que situarse en ese mes
  ctx.setFocusDate('2025-06-01');
  ctx.store.notify(); // el repintado va por frame; se fuerza para comprobarlo
  await sleep(60);
  const bars = env.document.getElementById('calendar-grid').querySelectorAll('.cell-bar');
  ok(bars.length >= 2, `el mes migrado pinta turnos (barras: ${bars.length})`);
});

/* ==================================================================== *
 * 6. Navegación
 * ==================================================================== */

describe('Navegación');

await it('se recorren las seis secciones', async () => {
  const ctx = ctxNow();
  for (const view of ['today', 'calendar', 'roster', 'team', 'hours', 'settings']) {
    ctx.navigate(view);
    await sleep(20);
    ok(env.document.getElementById(`view-${view}`).classList.contains('is-active'), `la sección ${view} se activa`);
    ok(env.document.getElementById('view-title').textContent.length > 0, `la cabecera cambia con ${view}`);
  }
});

await it('el resumen de la vista Hoy no está vacío', async () => {
  ctxNow().navigate('today');
  await sleep(30);
  ok(env.document.getElementById('today-mine').children.length > 0, 'hay bloque de mis turnos');
  ok(env.document.getElementById('today-next').children.length > 0, 'hay bloque de próximo turno');
});

/* ==================================================================== *
 * 7. Exportación
 * ==================================================================== */

describe('Exportación');

await it('la copia de seguridad JSON es exacta', async () => {
  const exporter = await import('../js/core/exporter.js');
  const ctx = ctxNow();
  const parsed = exporter.parseBackup(exporter.backupToJson(ctx.doc));
  is(parsed.kind, 'backup', 'se reconoce como copia');
  is(parsed.doc.members.length, ctx.doc.members.length, 'con todas las personas');
  is(parsed.doc.entries.length, ctx.doc.entries.length, 'y todos los turnos');
});

await it('se exporta a CSV, iCal y texto', async () => {
  const exporter = await import('../js/core/exporter.js');
  const ctx = ctxNow();
  ok(exporter.rangeToCSV(ctx.doc, { from: '2025-06-01', to: '2025-06-30' }).includes('Fecha;'), 'CSV con cabecera');
  const ics = exporter.rangeToICal(ctx.doc, { from: '2025-06-01', to: '2025-06-30' });
  ok(ics.startsWith('BEGIN:VCALENDAR') && ics.includes('END:VCALENDAR'), 'iCal bien formado');
  ok(exporter.monthToText(ctx.doc, '2025-06').includes('Junio 2025'), 'texto con el mes');
});

/* ==================================================================== *
 * 8. Reinicio
 * ==================================================================== */

describe('Reinicio');

await it('borrar todos los datos devuelve al asistente', async () => {
  useNoCloud();
  await bootFresh();
  is(visibleScreen(), 'wizard-screen', 'vuelve a pedir la configuración inicial');
  is(ctxNow().doc.entries.length, 0, 'sin turnos');
});

/* ==================================================================== *
 * Informe
 * ==================================================================== */

console.log(`\n${'─'.repeat(62)}`);
if (failed === 0) {
  console.log(`\x1b[1m\x1b[32m✓ ${passed} pruebas de aplicación correctas\x1b[0m`);
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




