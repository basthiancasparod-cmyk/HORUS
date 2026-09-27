/**
 * HORUS — js/app.js
 * Punto de entrada: arranque, sesión, asistente de configuración, navegación,
 * sincronización y atajos de teclado.
 *
 * Orden de arranque:
 *   1. Cargar el documento local (migrando el formato antiguo si hiciera falta).
 *   2. Elegir pantalla: acceso, asistente o aplicación.
 *   3. Montar las vistas y empezar a pintar.
 *   4. Registrar el service worker y arrancar avisos y sincronización.
 */

import { byId, $$, $, el, icon, debounce, prefersReducedMotion } from './core/utils.js';
import {
  todayKey, addDays, monthKeyOf, formatLongDate, stamp,
} from './core/date.js';
import {
  normalizeDocument, migrateFromLegacy, bootstrapDocument,
} from './core/model.js';
import { createStore } from './core/store.js';
import * as storage from './core/storage.js';
import * as auth from './core/auth.js';
import { createSyncEngine, hasLegacyBlob, importLegacyBlob } from './core/sync.js';
import { createScheduler } from './core/reminders.js';
import * as exporter from './core/exporter.js';
import { cloudConfig, APP } from './config.js';

import {
  setContext, getContext, VIEWS, VIEW_TITLES, setCurrentView, getCurrentView,
  setFocusDate, getFocusDate, registerRenderer, invalidate, renderCurrent,
} from './ui/context.js';
import { notify, openDialog, closeDialog, confirmAction, switchControl, emptyState } from './ui/toolkit.js';
import { wireAllDialogs, openAssignDialog, openDayEditor, openMemberEditor, openTypeEditor, openExportDialog, fillRegionSelect, applyHolidays } from './ui/dialogs.js';
import { openImportDialog } from './ui/import-review.js';

import { mount as mountToday } from './ui/views/today.js';
import { mount as mountCalendar } from './ui/views/calendar.js';
import { mount as mountRoster } from './ui/views/roster.js';
import { mount as mountTeam } from './ui/views/team.js';
import { mount as mountHours } from './ui/views/hours.js';
import { mount as mountSettings } from './ui/views/settings.js';

/* ==================================================================== *
 * Estado de la aplicación
 * ==================================================================== */

const THEME_KEY = 'horus.theme';
const REGION_KEY = 'horus.region';

let store = null;
let sync = null;
let scheduler = null;
let uiState = null;
let localMode = false;
let clockTimer = null;
let syncPendingTimer = null;
let mediaTheme = null;

const mounted = new Set();

/* ==================================================================== *
 * Tema
 * ==================================================================== */

function resolveTheme(preference) {
  if (preference === 'auto' || !preference) {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return preference === 'light' ? 'light' : 'dark';
}

function applyTheme(preference) {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b0d12' : '#f4f6fa');
  return resolved;
}

function currentThemePreference() {
  return storage.storage.get(THEME_KEY) || store?.doc?.settings?.theme || 'dark';
}

function setThemePreference(preference) {
  storage.storage.set(THEME_KEY, preference);
  applyTheme(preference);
  if (store && store.doc.settings.theme !== preference) {
    store.actions.updateSettings({ theme: preference });
  }
}

function watchSystemTheme() {
  if (mediaTheme) mediaTheme.removeEventListener('change', onSystemThemeChange);
  mediaTheme = window.matchMedia?.('(prefers-color-scheme: light)');
  mediaTheme?.addEventListener('change', onSystemThemeChange);
}

function onSystemThemeChange() {
  if (currentThemePreference() === 'auto') applyTheme('auto');
}

/* ==================================================================== *
 * Textos de la cabecera según la vista
 * ==================================================================== */

const VIEW_SUBTITLES = {
  today: () => formatLongDate(getFocusDate() || todayKey()),
  calendar: () => `Semana ${isoWeekOf(getFocusDate() || todayKey())}`,
  roster: () => 'Todas las personas y todos los días',
  team: () => `${store.doc.members.filter((m) => m.active).length} personas en el equipo`,
  hours: () => 'Control de horas y objetivos',
  settings: () => `${APP.name} ${APP.version}`,
};

function isoWeekOf(key) {
  // Import perezoso para no arrastrar el módulo entero a la cabecera
  const dt = new Date(`${key}T00:00:00`);
  const t = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const jan4 = new Date(t.getFullYear(), 0, 4);
  jan4.setDate(jan4.getDate() + 3 - ((jan4.getDay() + 6) % 7));
  return 1 + Math.round((t - jan4) / (7 * 86400000));
}

function paintHeader() {
  const view = getCurrentView();
  const titleNode = byId('view-title');
  const subNode = byId('view-sub');
  if (titleNode) titleNode.textContent = VIEW_TITLES[view] || 'HORUS';
  if (subNode) subNode.textContent = (VIEW_SUBTITLES[view] || (() => ''))();

  // En móvil, la cabecera muestra el nombre de la sección; en escritorio da
  // contexto del documento.
  const brand = $('.topbar-brand .name');
  if (brand && window.innerWidth >= 900) brand.textContent = store.doc.name || 'HORUS';
}

/* ==================================================================== *
 * Navegación
 * ==================================================================== */

function navigate(view, { focus = false } = {}) {
  if (!VIEWS.includes(view)) return;
  setCurrentView(view);
  storage.saveUI({ lastView: view });

  for (const section of $$('.view')) {
    const active = section.dataset.view === view;
    section.classList.toggle('is-active', active);
    section.hidden = !active;
  }
  for (const button of $$('.nav-item')) {
    const active = button.dataset.view === view;
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  paintHeader();
  // Se repinta al entrar: puede que el estado haya cambiado mientras estaba
  // oculta (el repintado solo se ejecuta para la vista visible).
  const renderer = mounted.has(view);
  if (renderer) renderCurrent();
  if (focus) byId('main')?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/* ==================================================================== *
 * Barra de estado (sincronización, conexión, conflictos)
 * ==================================================================== */

let statusHideTimer = null;

function setStatus({ text, kind = 'offline', action = null, sticky = false }) {
  const bar = byId('status-bar');
  const textNode = byId('status-text');
  const dot = byId('status-dot');
  const actionBtn = byId('status-action');
  if (!bar) return;

  clearTimeout(statusHideTimer);
  bar.hidden = !text;
  if (!text) return;

  bar.className = `status-bar is-${kind}`;
  dot.className = `status-dot is-${kind === 'success' ? 'online' : kind}`;
  textNode.textContent = text;

  if (action) {
    actionBtn.hidden = false;
    actionBtn.textContent = action.label;
    actionBtn.onclick = action.onClick;
  } else {
    actionBtn.hidden = true;
    actionBtn.onclick = null;
  }

  // Los avisos de éxito se van solos; los problemas se quedan.
  if (!sticky && (kind === 'success' || kind === 'syncing')) {
    statusHideTimer = setTimeout(() => { bar.hidden = true; }, 2600);
  }
}

function paintConnectivity() {
  if (!navigator.onLine) {
    setStatus({
      text: 'Sin conexión · trabajando en local. Los cambios se guardarán solos.',
      kind: 'offline',
      sticky: true,
    });
    return;
  }
  if (localMode || !cloudConfig().configured || !auth.isSignedIn()) {
    setStatus({
      text: localMode
        ? 'Modo local · tus datos están solo en este dispositivo'
        : 'Sin cuenta · tus datos están solo en este dispositivo',
      kind: 'offline',
      sticky: false,
      action: cloudConfig().configured && !localMode
        ? { label: 'Iniciar sesión', onClick: () => showAuthScreen() }
        : null,
    });
    return;
  }
  const pending = sync?.pendingCount?.() ?? 0;
  if (pending > 0) {
    setStatus({
      text: `${pending} cambio(s) pendientes de subir`,
      kind: 'warning',
      sticky: true,
      action: { label: 'Sincronizar', onClick: () => runSync({ manual: true }) },
    });
    return;
  }
  setStatus({ text: '' });
}

/* ==================================================================== *
 * Sincronización
 * ==================================================================== */

async function runSync({ manual = false, full = false } = {}) {
  if (!sync) return;
  if (!auth.isSignedIn()) {
    if (manual) notify.warning('Inicia sesión para sincronizar con la nube.');
    return;
  }
  if (!navigator.onLine) {
    if (manual) notify.warning('Sin conexión: se sincronizará cuando vuelvas a estar en línea.');
    return;
  }

  const icon = byId('sync-icon');
  const button = byId('btn-sync');
  button.disabled = true;
  icon?.classList.add('spin');
  if (manual) setStatus({ text: 'Sincronizando…', kind: 'syncing', sticky: true });

  try {
    const result = await sync.sync({ full });
    // `sync()` puede devolver null (o nada) si ya había otra sincronización en
    // marcha: sin esta guarda, leer `result.pushed` lanzaba un TypeError que se
    // veía en consola como «error de sincronización» sin más explicación.
    if (!result) {
      if (manual) setStatus({ text: 'Ya había una sincronización en marcha.', kind: 'syncing' });
      return;
    }
    if (result.skipped) {
      if (manual) {
        setStatus({
          text: result.reason === 'offline'
            ? 'Sin conexión: se reintentará solo.'
            : 'Sin cuenta configurada: los datos se quedan en este dispositivo.',
          kind: result.reason === 'offline' ? 'warning' : 'success',
        });
      }
      return;
    }
    const parts = [];
    if (result.pushed) parts.push(`${result.pushed} subido(s)`);
    if (result.applied) parts.push(`${result.applied} recibido(s)`);
    if (result.deleted) parts.push(`${result.deleted} borrado(s)`);

    if (result.conflicts?.length) {
      setStatus({
        text: `${result.conflicts.length} cambio(s) en conflicto: otra persona editó lo mismo.`,
        kind: 'warning',
        sticky: true,
        action: { label: 'Ver', onClick: () => navigate('today') },
      });
      invalidate('today');
    } else if (parts.length) {
      setStatus({ text: `Sincronizado · ${parts.join(' · ')}`, kind: 'success' });
      if (manual) notify.success(`Sincronizado · ${parts.join(' · ')}`);
    } else if (manual) {
      setStatus({ text: 'Todo estaba al día.', kind: 'success' });
      notify.success('Todo estaba al día.');
    }
    store.markSynced();
    if (store.doc.migration) {
      // La migración del formato antiguo ya no está pendiente una vez subida
      store.apply((d) => { delete d.migration; }, { label: 'limpiar aviso de migración', touch: false });
    }
  } catch (err) {
    console.error('[app] error de sincronización:', err);
    setStatus({
      text: `No se pudo sincronizar: ${err.message}`,
      kind: 'error',
      sticky: true,
      action: { label: 'Reintentar', onClick: () => runSync({ manual: true }) },
    });
    if (manual) notify.error(`No se pudo sincronizar: ${err.message}`);
  } finally {
    icon?.classList.remove('spin');
    button.disabled = false;
  }
}

/** Programa una sincronización perezosa tras un cambio local. */
function scheduleSyncPush() {
  if (!auth.isSignedIn() || !navigator.onLine || localMode) return;
  clearTimeout(syncPendingTimer);
  syncPendingTimer = setTimeout(() => { runSync(); }, 4000);
}

/* ==================================================================== *
 * Persistencia del documento
 * ==================================================================== */

const persist = debounce(() => {
  if (!store) return;
  const ok = storage.writeDocument(store.doc);
  if (!ok) notify.error('No se pudo guardar en este dispositivo. Puede que no quede espacio.');
}, 350);

function startPersistence() {
  store.subscribe(() => {
    persist();
    scheduleSyncPush();
    scheduler?.reschedule();
    paintUndoState();
    invalidate();
  });
  // Guardado de seguridad al cerrar o cambiar de pestaña
  window.addEventListener('beforeunload', () => {
    clearTimeout(persist.cancel ? undefined : undefined);
    storage.writeDocument(store.doc, { backup: false });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') storage.writeDocument(store.doc);
  });
}

function paintUndoState() {
  const button = byId('btn-undo');
  if (!button || !store) return;
  button.disabled = !store.canUndo();
  const label = store.undoLabel();
  button.title = label ? `Deshacer: ${label} (Ctrl+Z)` : 'Nada que deshacer';
}

/* ==================================================================== *
 * Contexto para las vistas
 * ==================================================================== */

const context = {
  get store() { return store; },
  get doc() { return store.doc; },
  get actions() { return store.actions; },
  get sync() { return sync; },
  get scheduler() { return scheduler; },
  get auth() { return auth; },
  get ui() { return uiState; },

  undo: () => { if (store.undo()) notify.info(`Deshecho: ${store.redoLabel() || 'cambio'}`); },
  redo: () => { store.redo(); },
  canUndo: () => store.canUndo(),
  canRedo: () => store.canRedo(),
  batch: (label, fn) => store.batch(label, fn),

  navigate,
  // Fecha en foco compartida por calendario, cuadrante y horas
  setFocusDate: (key) => setFocusDate(key),
  setFilters: () => invalidate(),
  openAssign: (preset) => openAssignDialog(context, preset),
  openDay: (date) => openDayEditor(context, date),
  openType: (id, opts) => openTypeEditor(context, id, opts),
  openMember: (id, opts) => openMemberEditor(context, id, opts),
  openExport: (opts) => openExportDialog(context, opts),
  /** Importación de un cuadrante desde el PDF de la empresa. */
  openImport: (preset) => openImportDialog(context, preset),

  isLocalMode: () => localMode,
  region: () => storage.storage.get(REGION_KEY) || store?.doc?.settings?.region || 'ES',
  setRegion: (code) => { storage.storage.set(REGION_KEY, code); store.actions.updateSettings({ region: code }); },
  runSync,
  showAuth: () => showAuthScreen(),
  signOut: () => doSignOut(),
};

/* ==================================================================== *
 * Pantallas
 * ==================================================================== */

function showScreen(id) {
  for (const node of $$('#boot, #auth-screen, #wizard-screen, #app')) {
    if (node) node.hidden = node.id !== id;
  }
  if (id === 'app') {
    byId('app').hidden = false;
  }
}

function showAuthScreen() {
  stopTimers();
  wireAuth();
  showScreen('auth-screen');
  byId('auth-email')?.focus();
  paintCloudState();
}

function paintCloudState() {
  const node = byId('auth-cloud-state');
  if (!node) return;
  const config = cloudConfig();
  node.textContent = config.configured
    ? 'Tus datos se sincronizan entre dispositivos.'
    : 'Este dispositivo no tiene nube configurada: funcionará solo en local.';
}

/* ==================================================================== *
 * Autenticación
 * ==================================================================== */

function authError(message) {
  const node = byId('auth-error');
  const info = byId('auth-info');
  if (info) info.hidden = true;
  if (!node) return;
  node.textContent = message || '';
  node.hidden = !message;
}

function authInfo(message) {
  const node = byId('auth-info');
  const error = byId('auth-error');
  if (error) error.hidden = true;
  if (!node) return;
  node.textContent = message || '';
  node.hidden = !message;
}

function wireAuth() {
  let tab = 'signin';

  const selectTab = (next) => {
    tab = next;
    const isSignIn = next === 'signin';
    byId('tab-signin').setAttribute('aria-selected', String(isSignIn));
    byId('tab-signup').setAttribute('aria-selected', String(!isSignIn));
    byId('auth-submit').textContent = isSignIn ? 'Iniciar sesión' : 'Crear cuenta';
    byId('auth-password').setAttribute('autocomplete', isSignIn ? 'current-password' : 'new-password');
    byId('auth-password-hint').hidden = isSignIn;
    authError('');
    authInfo('');
  };

  byId('tab-signin').onclick = () => selectTab('signin');
  byId('tab-signup').onclick = () => selectTab('signup');

  byId('form-auth').onsubmit = async (event) => {
    event.preventDefault();
    const submit = byId('auth-submit');
    const email = byId('auth-email').value.trim();
    const password = byId('auth-password').value;

    authError('');
    authInfo('');
    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = 'Un momento…';

    try {
      if (tab === 'signin') {
        await auth.signIn(email, password);
        localMode = false;
        await afterSignIn();
      } else {
        const result = await auth.signUp(email, password);
        if (result.needsConfirmation) {
          authInfo('Cuenta creada. Revisa tu correo para confirmarla y después inicia sesión.');
          selectTab('signin');
        } else {
          localMode = false;
          await afterSignIn();
        }
      }
    } catch (err) {
      authError(err.message || 'No se pudo completar la operación.');
    } finally {
      submit.disabled = false;
      if (submit.textContent === 'Un momento…') submit.textContent = original;
    }
  };

  byId('auth-forgot').onclick = async () => {
    const email = byId('auth-email').value.trim();
    if (!email) {
      authError('Escribe tu correo arriba y vuelve a pulsar.');
      return;
    }
    try {
      await auth.sendPasswordReset(email);
      authInfo('Te hemos enviado un enlace para cambiar la contraseña.');
    } catch (err) {
      authError(err.message || 'No se pudo enviar el correo.');
    }
  };

  byId('auth-local').onclick = () => {
    localMode = true;
    authError('');
    authInfo('');
    startWithLocalData();
  };
}

/**
 * Entra en la aplicación sin cuenta (o retoma la configuración inicial si
 * todavía no hay cuadrante). Se recuerda la elección para que, en las siguientes
 * visitas, la app no vuelva a ofrecer la pantalla de acceso.
 */
function startWithLocalData() {
  storage.storage.set('horus.localmode', '1');
  const hasData = store.doc.entries.length > 0 || store.doc.settings.firstRun === false;
  if (hasData) {
    bootApp().catch((err) => {
      console.error('[app] no se pudo entrar en la aplicación:', err);
      notify.error(`No se pudo abrir el cuadrante: ${err.message}`);
    });
  } else {
    showWizard();
  }
}

async function afterSignIn() {
  // El cuadrante puede existir ya en este dispositivo: entonces no se pregunta
  // nada más y se entra directo.
  if (store.doc.settings.firstRun === false && store.doc.members.length) {
    await bootApp();
    await offerLegacyImport();
    runSync();
    return;
  }
  // Cuadrante vacío: puede que haya datos en la nube de una sesión anterior.
  try {
    await sync.pull({ full: true });
  } catch (err) {
    console.warn('[app] no se pudieron traer los datos de la nube:', err);
  }
  if (store.doc.settings.firstRun === false && store.doc.members.length) {
    await bootApp();
    runSync();
  } else {
    showWizard();
  }
}

/** Recupera el cuadrante de la versión antigua de HORUS, si existe. */
async function offerLegacyImport() {
  if (!auth.isSignedIn()) return;
  let exists = false;
  try {
    exists = await hasLegacyBlob();
  } catch {
    return;
  }
  if (!exists) return;
  if (storage.storage.get('horus.legacy.offered') === '1') return;
  storage.storage.set('horus.legacy.offered', '1');

  const ok = await confirmAction({
    title: 'Hemos encontrado tu cuadrante antiguo',
    message: 'En tu cuenta hay datos guardados por la versión anterior de HORUS. ¿Quieres traerlos a este dispositivo? Se añadirán a lo que ya tengas.',
    confirmLabel: 'Traerlos',
    danger: false,
  });
  if (!ok) return;

  try {
    const { imported, doc } = await importLegacyBlob(migrateFromLegacy);
    if (!imported) {
      notify.info('No había nada que importar.');
      return;
    }
    // Fusiona sin pisar lo que ya existe
    const merged = normalizeDocument(doc);
    merged.members = merged.members.length ? merged.members : store.doc.members;
    store.actions.importDocument(merged, { merge: true });
    notify.success('Cuadrante antiguo importado. Revísalo y guárdalo en la nube.');
    invalidate();
    runSync({ full: true });
  } catch (err) {
    notify.error(`No se pudo importar: ${err.message}`);
  }
}

async function doSignOut() {
  const ok = await confirmAction({
    title: '¿Cerrar sesión?',
    message: 'Tus datos seguirán guardados en este dispositivo y en la nube. Podrás volver a entrar cuando quieras.',
    confirmLabel: 'Cerrar sesión',
    danger: false,
  });
  if (!ok) return;
  stopTimers();
  await auth.signOut();
  store = createStore(storage.loadDocument().doc);
  sync = createSyncEngine({ getDoc: () => store.doc, replaceDoc: (d, m) => store.replaceDocument(d, { ...m, silent: true }) });
  showAuthScreen();
  notify.success('Sesión cerrada');
}

/* ==================================================================== *
 * Asistente de configuración
 * ==================================================================== */

const wizard = {
  step: 0,
  members: [],
  region: 'ES',
  notifications: false,
  minutesBefore: 30,
  name: '',
  weeklyHours: null,
};

function showWizard() {
  stopTimers();
  wireWizard();
  showScreen('wizard-screen');
  wizard.step = 0;
  wizard.members = [];
  wizard.region = 'ES';
  wizard.notifications = false;
  wizard.minutesBefore = 30;
  wizard.name = store.doc.members[0]?.name && store.doc.members[0].name !== 'Yo'
    ? store.doc.members[0].name
    : '';
  wizard.weeklyHours = null;
  byId('wizard-name').value = wizard.name;
  byId('wizard-hours').value = '';
  byId('wizard-member-input').value = '';
  byId('wizard-lead').value = '30';
  byId('wizard-region').value = 'ES';
  renderWizardMembers();
  paintWizard();
}

function paintWizard() {
  for (const step of $$('#wizard-screen .wizard-step')) {
    step.classList.toggle('is-active', Number(step.dataset.wizardStep) === wizard.step);
  }
  for (const dot of $$('#wizard-screen [data-wizard-dot]')) {
    const index = Number(dot.dataset.wizardDot);
    dot.classList.toggle('is-active', index === wizard.step);
    dot.classList.toggle('is-done', index < wizard.step);
  }
  for (const line of $$('#wizard-screen [data-wizard-line]')) {
    line.classList.toggle('is-done', Number(line.dataset.wizardLine) < wizard.step);
  }
  byId('wizard-prev').hidden = wizard.step === 0;
  byId('wizard-next').textContent = wizard.step === 2 ? 'Empezar' : 'Siguiente';
}

function renderWizardMembers() {
  const box = byId('wizard-members');
  if (!box) return;
  box.replaceChildren();
  for (let i = 0; i < wizard.members.length; i++) {
    const name = wizard.members[i];
    box.appendChild(el('span', { class: 'member-tag chip' }, [
      name,
      el('button', {
        type: 'button', 'aria-label': `Quitar a ${name}`,
        style: { marginLeft: '4px', color: 'var(--text-dim)' },
        onclick: () => { wizard.members.splice(i, 1); renderWizardMembers(); },
      }, icon('close', 13)),
    ]));
  }
  byId('wizard-members-empty').hidden = wizard.members.length > 0;
}

function wireWizard() {
  fillRegionSelect(byId('wizard-region'), 'ES');
  const notifSwitch = switchControl('wizard-notif', false, async (checked) => {
    if (checked && auth.isSignedIn()) {
      const result = await import('./core/reminders.js').then((m) => m.requestPermission());
      if (!result.ok) {
        notify.warning('El navegador no ha dado permiso para las notificaciones.');
        notifSwitch.setAttribute('aria-checked', 'false');
        wizard.notifications = false;
        return;
      }
    }
    wizard.notifications = checked;
    void auth;
  }, { label: 'Avisarme antes de cada turno', large: true });
  byId('wizard-notif').replaceWith(notifSwitch);

  const addMember = () => {
    const input = byId('wizard-member-input');
    const name = input.value.trim();
    if (!name) return;
    if (wizard.members.some((m) => m.toLowerCase() === name.toLowerCase())) {
      notify.warning('Ya está en la lista.');
      return;
    }
    if (wizard.members.length >= 60) {
      notify.warning('Demasiadas personas. Añade el resto desde Equipo.');
      return;
    }
    wizard.members.push(name);
    input.value = '';
    input.focus();
    renderWizardMembers();
  };

  byId('wizard-add-member').onclick = addMember;
  byId('wizard-member-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addMember(); }
  });

  byId('wizard-import').onclick = async () => {
    const { pickTextFile } = await import('./core/utils.js');
    const file = await pickTextFile('.csv,.txt');
    if (!file?.text) return;
    try {
      const { rows, errors } = exporter.parseScheduleCSV(file.text);
      if (!rows.length) {
        notify.error(errors[0] || 'No se pudo leer ninguna fila del archivo.');
        return;
      }
      const names = [...new Set(rows.map((r) => r.person))];
      for (const name of names) {
        if (!wizard.members.some((m) => m.toLowerCase() === name.toLowerCase())) wizard.members.push(name);
      }
      renderWizardMembers();
      // Guarda las filas para aplicarlas al terminar
      wizard.pendingImport = rows;
      notify.success(`Leídas ${rows.length} fila(s) de ${names.length} persona(s).`);
      if (errors.length) notify.warning(`${errors.length} fila(s) tenían problemas y se ignorarán.`);
    } catch (err) {
      notify.error(`No se pudo leer el archivo: ${err.message}`);
    }
  };

  byId('wizard-prev').onclick = () => {
    if (wizard.step > 0) { wizard.step--; paintWizard(); }
  };

  byId('form-wizard').onsubmit = async (event) => {
    event.preventDefault();
    if (wizard.step === 0) {
      const name = byId('wizard-name').value.trim();
      if (!name) { notify.error('Escribe tu nombre para continuar.'); return; }
      wizard.name = name;
      const hours = byId('wizard-hours').value.trim();
      wizard.weeklyHours = hours === '' ? null : Number(hours);
      wizard.step = 1;
      paintWizard();
      return;
    }
    if (wizard.step === 1) {
      wizard.step = 2;
      paintWizard();
      return;
    }
    // Paso 3: crear todo
    await finishWizard();
  };
}

async function finishWizard() {
  const button = byId('wizard-next');
  button.disabled = true;
  button.textContent = 'Preparando…';

  try {
    wizard.region = byId('wizard-region').value || 'ES';
    wizard.minutesBefore = Number(byId('wizard-lead').value) || 30;
    storage.storage.set(REGION_KEY, wizard.region);

    // Construye el documento desde cero con lo que ha dicho el usuario
    const doc = bootstrapDocument({
      name: wizard.name,
      coworkers: wizard.members,
      notifications: wizard.notifications,
      minutesBefore: wizard.minutesBefore,
      weeklyHours: wizard.weeklyHours,
    });
    doc.settings.region = wizard.region;
    store.replaceDocument(doc, { label: 'crear el cuadrante' });

    // Festivos de la región elegida para el año en curso
    try {
      applyHolidaysFor(store, { year: new Date().getFullYear(), region: wizard.region, silent: true });
    } catch (err) {
      console.warn('[app] no se pudieron cargar los festivos:', err);
    }

    // Turnos importados del CSV, si los hay
    if (wizard.pendingImport?.length) {
      applyImportedRows(store, wizard.pendingImport);
    }

    storage.saveUI({ lastView: 'today' });

    // Se guarda AQUÍ y no solo al entrar en la aplicación: si montar las vistas
    // fallara, el usuario no debería perder el equipo y los festivos que acaba
    // de configurar. Los guardados posteriores ya van con retardo.
    storage.writeDocument(store.doc);

    await bootApp();
    notify.success('¡Listo! Este es tu cuadrante.', { duration: 4200 });

    if (auth.isSignedIn()) runSync({ full: true });
  } catch (err) {
    console.error('[app] fallo al terminar el asistente:', err);
    notify.error(`No se pudo preparar el cuadrante: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Empezar';
  }
}

/** Aplica filas { date, person, code, notes } leídas de un CSV. */
function applyImportedRows(targetStore, rows) {
  const { doc, actions } = targetStore;
  const byName = new Map(doc.members.map((m) => [m.name.toLowerCase(), m]));
  const byCode = new Map(doc.shiftTypes.map((t) => [t.code.toLowerCase(), t]));
  const byLabel = new Map(doc.shiftTypes.map((t) => [t.label.toLowerCase(), t]));

  let applied = 0;
  targetStore.batch('importar cuadrante', () => {
    for (const row of rows) {
      const member = byName.get(row.person.toLowerCase());
      if (!member) continue;
      const type = row.code
        ? (byCode.get(row.code.toLowerCase()) || byLabel.get(row.code.toLowerCase()) || null)
        : null;
      if (actions.setEntry({
        memberId: member.id,
        date: row.date,
        typeId: type ? type.id : null,
        notes: row.notes || undefined,
      })) applied++;
    }
  });

  if (applied) notify.success(`${applied} turno(s) importados del archivo.`);
  else notify.warning('No se pudo importar ningún turno: revisa que los códigos de turno coincidan.');
}

/** Carga los festivos de un año y región en dayMeta. */
function applyHolidaysFor(targetStore, { year, region, silent = false }) {
  const count = applyHolidays({
    // Getters, no valores: `applyHolidays` consulta `ctx.doc.dayMeta` para no
    // pisar los días marcados a mano, y el documento se reemplaza en cada
    // cambio. Una referencia capturada aquí apuntaría al documento anterior.
    get doc() { return targetStore.doc; },
    get actions() { return targetStore.actions; },
    batch: (label, fn) => targetStore.batch(label, fn),
  }, { year, region });
  if (!silent && count) {
    notify.success(`${count} festivo(s) marcados en el calendario.`, {
      action: { label: 'Deshacer', onClick: () => targetStore.undo() },
    });
  }
  return count;
}

/* ==================================================================== *
 * Arranque de la aplicación
 * ==================================================================== */

async function bootApp() {
  showScreen('app');
  await mountViews();

  const lastView = storage.loadUI().lastView;
  navigate(VIEWS.includes(lastView) ? lastView : 'today');

  startPersistence();
  startClock();
  startNetworkWatchers();
  paintUndoState();
  paintConnectivity();

  // Navegador: atajos y botones globales
  wireTopbar();

  // Avisos
  if (!scheduler) {
    scheduler = createScheduler({
      getDoc: () => store.doc,
      onFire: (alarm) => {
        if (alarm.kind === 'shift') notify.info(`Aviso enviado: ${alarm.title}`);
      },
    });
  }
  // `context.scheduler` es un getter que lee esta variable: no hay que asignarlo
  scheduler.start();

  // Sincronización
  wireSyncEngine();
  if (auth.isSignedIn() && navigator.onLine) runSync();
}

async function mountViews() {
  const mounters = [
    ['today', mountToday],
    ['calendar', mountCalendar],
    ['roster', mountRoster],
    ['team', mountTeam],
    ['hours', mountHours],
    ['settings', mountSettings],
  ];
  for (const [view, mount] of mounters) {
    if (mounted.has(view)) continue;
    try {
      mount(context);
      mounted.add(view);
    } catch (err) {
      console.error(`[app] la vista "${view}" no se pudo montar:`, err);
      const section = byId(`view-${view}`);
      if (section) {
        section.replaceChildren(emptyState({
          iconName: 'alert',
          title: `La sección «${VIEW_TITLES[view]}» no se pudo cargar`,
          message: err.message,
        }));
      }
      registerRenderer(view, () => {});
      mounted.add(view);
    }
  }
}

function wireTopbar() {
  if (wireTopbar.done) return;
  wireTopbar.done = true;

  byId('btn-theme').onclick = () => {
    const order = ['dark', 'light', 'auto'];
    const next = order[(order.indexOf(currentThemePreference()) + 1) % order.length];
    setThemePreference(next);
    const label = { dark: 'Tema oscuro', light: 'Tema claro', auto: 'Tema automático' }[next];
    notify.info(label);
    invalidate('settings');
  };

  byId('btn-sync').onclick = () => runSync({ manual: true });

  byId('btn-undo').onclick = () => {
    if (!store.canUndo()) return;
    const label = store.undoLabel();
    store.undo();
    notify.info(`Deshecho: ${label || 'cambio'}`, {
      action: store.canRedo() ? { label: 'Rehacer', onClick: () => store.redo() } : null,
    });
  };

  for (const button of $$('.nav-item')) {
    button.addEventListener('click', () => navigate(button.dataset.view, { focus: true }));
  }
  for (const button of $$('[data-go]')) {
    button.addEventListener('click', () => navigate(button.dataset.go, { focus: true }));
  }

  // Diálogos comunes
  wireAllDialogs();

  // Cerrar diálogos con Escape (los <dialog> ya lo hacen, pero así se limpian
  // los estados internos de las vistas).
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const open = $$('dialog[open]');
      if (open.length) return; // el propio <dialog> se encarga
      const filters = byId('calendar-filters');
      if (filters && !filters.hidden) filters.hidden = true;
    }
  });

  wireKeyboardShortcuts();
}

function wireKeyboardShortcuts() {
  // Atajos de una sola tecla, solo cuando no se está escribiendo
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || target?.isContentEditable;
    if (typing || $$('dialog[open]').length) return;

    const mod = event.ctrlKey || event.metaKey;

    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) store.redo();
      else store.undo();
      invalidate();
      return;
    }
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      runSync({ manual: true });
      return;
    }
    if (mod) return;

    switch (event.key.toLowerCase()) {
      case 'h': navigate('today'); break;
      case 'c': navigate('calendar'); break;
      case 'u': navigate('roster'); break;
      case 'e': navigate('team'); break;
      case 'o': navigate('hours'); break;
      case 'a': navigate('settings'); break;
      case 'n':
        event.preventDefault();
        openAssignDialog(context, { date: getFocusDate() || todayKey() });
        break;
      case 't':
        setFocusDate(todayKey());
        invalidate();
        break;
      case '?':
        showShortcuts();
        break;
      default:
        return;
    }
  });

  // Navegación entre días/meses de la fecha en foco
  document.addEventListener('keydown', (event) => {
    if ($$('dialog[open]').length) return;
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (typing || (event.ctrlKey || event.metaKey)) return;
    const view = getCurrentView();
    if (view !== 'calendar' && view !== 'roster') return;

    const current = getFocusDate() || todayKey();
    if (event.key === 'ArrowLeft' && event.altKey) {
      event.preventDefault();
      setFocusDate(addDays(current, -1));
      invalidate(view);
    } else if (event.key === 'ArrowRight' && event.altKey) {
      event.preventDefault();
      setFocusDate(addDays(current, 1));
      invalidate(view);
    } else if (event.key === '[') {
      event.preventDefault();
      setFocusDate(`${addMonthsKey(monthKeyOf(current), -1)}-01`);
      invalidate();
    } else if (event.key === ']') {
      event.preventDefault();
      setFocusDate(`${addMonthsKey(monthKeyOf(current), 1)}-01`);
      invalidate();
    }
  });
}

function addMonthsKey(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  const total = (y * 12) + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String(((total % 12) + 12) % 12 + 1).padStart(2, '0')}`;
}

function showShortcuts() {
  const rows = [
    ['H', 'Ir a Hoy'],
    ['C', 'Ir al Calendario'],
    ['U', 'Ir al Cuadrante'],
    ['E', 'Ir a Equipo'],
    ['O', 'Ir a Horas'],
    ['A', 'Ir a Ajustes'],
    ['N', 'Asignar un turno'],
    ['T', 'Volver a hoy'],
    ['Alt + ← / →', 'Día anterior / siguiente'],
    ['[ / ]', 'Mes anterior / siguiente'],
    ['Ctrl + Z', 'Deshacer'],
    ['Ctrl + Mayús + Z', 'Rehacer'],
    ['Ctrl + S', 'Sincronizar ahora'],
    ['?', 'Esta ayuda'],
  ];
  const list = el('div', { class: 'stack-sm' });
  for (const [key, label] of rows) {
    list.appendChild(el('div', { class: 'row-between' }, [
      el('span', { class: 't-sm' }, label),
      el('span', { class: 'badge t-mono' }, key),
    ]));
  }
  const wrapper = el('div', {}, [
    el('p', { class: 'field-hint', style: { marginBottom: 'var(--sp-3)' } },
      'Los atajos funcionan cuando no estás escribiendo en un campo.'),
    list,
  ]);

  // Reutiliza el diálogo de confirmación como visor, sin acción destructiva
  const dialog = byId('dialog-confirm');
  byId('confirm-title').textContent = 'Atajos de teclado';
  byId('confirm-sub').textContent = '';
  byId('confirm-message').hidden = true;
  const extra = byId('confirm-extra');
  extra.replaceChildren(wrapper);
  byId('confirm-ok').textContent = 'Entendido';
  byId('confirm-ok').className = 'btn btn-primary';
  byId('confirm-cancel').hidden = true;
  openDialog(dialog);

  const cleanup = () => {
    byId('confirm-ok').onclick = null;
    byId('confirm-cancel').hidden = false;
    dialog.removeEventListener('close', cleanup);
  };
  byId('confirm-ok').onclick = () => closeDialog(dialog);
  dialog.addEventListener('close', cleanup);
}

/* ==================================================================== *
 * Reloj y red
 * ==================================================================== */

function startClock() {
  stopClock();
  const tick = () => {
    const now = new Date();
    const clock = byId('today-clock');
    if (clock) {
      clock.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }
    // La línea de "ahora" solo avanza cada minuto, así que no hace falta más
    if (getCurrentView() === 'today') invalidate('today');
  };
  tick();
  clockTimer = setInterval(tick, 30000);
}

function stopClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}

function stopTimers() {
  stopClock();
  clearTimeout(syncPendingTimer);
  scheduler?.stop();
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', onOffline);
}

function startNetworkWatchers() {
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
}

function onOnline() {
  notify.success('Conexión restaurada');
  paintConnectivity();
  runSync();
}

function onOffline() {
  paintConnectivity();
  notify.warning('Sin conexión: sigues trabajando en local.', { duration: 2600 });
}

/* ==================================================================== *
 * Motor de sincronización
 * ==================================================================== */

function wireSyncEngine() {
  if (wireSyncEngine.done) return;
  wireSyncEngine.done = true;
  if (sync) {
    sync.subscribe(() => {
      paintConnectivity();
      invalidate('today');
    });
  }
}

/* ==================================================================== *
 * Service worker
 * ==================================================================== */

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('sw.js', { scope: './' });
    // Si hay una versión nueva esperando, se activa en la siguiente visita
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          notify.info('Hay una versión nueva de HORUS. Cierra y vuelve a abrir para actualizarla.', {
            duration: 6000,
            icon: 'refresh',
          });
        }
      });
    });
  } catch (err) {
    console.warn('[app] el service worker no se pudo registrar:', err);
  }
}

/* ==================================================================== *
 * Arranque
 * ==================================================================== */

/**
 * Decide qué pantalla mostrar al abrir la aplicación.
 *
 * El criterio es «local primero»: la aplicación nunca pide una cuenta para
 * trabajar. Si ya hay un cuadrante en este dispositivo, se entra directamente;
 * si no lo hay y tampoco hay nada que recuperar, se configura en local desde el
 * asistente (que además ofrece iniciar sesión).
 *
 * Reglas, por orden:
 *   1. Enlace de recuperación de contraseña → acceso. Es el único caso en el que
 *      el usuario viene a propósito a la pantalla de cuenta.
 *   2. Sin nube configurada → asistente, o directa si ya hay datos.
 *   3. El usuario trabaja en local sin sesión → directa.
 *   4. Con sesión iniciada → directa.
 *   5. Con nube configurada, sin sesión y sin datos locales: puede tener su
 *      cuadrante en la nube (otro dispositivo), así que se ofrece entrar. Desde
 *      la pantalla de acceso se puede seguir en local con un solo toque.
 *
 * @returns {'auth'|'wizard'|'app'}
 */
function decideInitialScreen({ hasData, redirect, signedIn, configured, localPref }) {
  if (redirect === 'recovery') return 'auth';
  if (!configured) return hasData ? 'app' : 'wizard';
  if (localPref && !signedIn) return hasData ? 'app' : 'wizard';
  if (signedIn) return 'app';
  if (!hasData) return 'auth';
  return 'app';
}

async function boot() {
  // 1) Tema, antes de pintar nada para que no haya destello
  const storedTheme = storage.storage.get(THEME_KEY);
  applyTheme(storedTheme || 'dark');
  watchSystemTheme();

  // 2) Documento local (con migración del formato antiguo si procede)
  const loaded = storage.loadDocument();
  store = createStore(loaded.doc);
  uiState = storage.loadUI();

  if (loaded.migrated && loaded.source === 'legacy') {
    loaded.legacySummary = store.doc.migration;
  }

  // 3) Motores
  sync = createSyncEngine({
    getDoc: () => store.doc,
    replaceDoc: (doc, meta) => store.replaceDocument(doc, { ...meta, silent: true }),
    getAuthUserId: () => auth.currentUser()?.id ?? null,
  });

  setContext(context);

  // 4) Sesión
  auth.restoreSession();
  const redirect = await auth.consumeAuthRedirect().catch(() => ({ type: 'none' }));

  // 5) Decidir pantalla
  const cloud = cloudConfig();
  const hasData = store.doc.entries.length > 0 || store.doc.settings.firstRun === false;
  const signedIn = auth.isSignedIn();
  const localPref = localModePreference();

  const screen = decideInitialScreen({
    hasData,
    redirect: redirect?.type || 'none',
    signedIn,
    configured: !!cloud.configured,
    localPref,
  });

  // La app solo funciona como local si no hay nube o el usuario lo pidió
  localMode = !cloud.configured || (localPref && !signedIn);

  if (screen === 'wizard') {
    showWizard();
    return;
  }

  if (screen === 'app') {
    await bootApp();
    if (redirect?.type === 'recovery') {
      // Tras recuperar la contraseña, avisar de dónde cambiarla
      notify.info('Ya puedes cambiar tu contraseña desde Ajustes → Cuenta.', { duration: 7000 });
    }
    if (signedIn) await offerLegacyImport();
    else if (hasData) {
      setStatus({
        text: cloud.configured
          ? 'Tienes un cuadrante local. Inicia sesión para verlo en tus otros dispositivos.'
          : 'Modo local · tus datos están solo en este dispositivo',
        kind: 'warning',
        sticky: true,
        action: cloud.configured
          ? { label: 'Iniciar sesión', onClick: () => showAuthScreen() }
          : null,
      });
    }
    return;
  }

  showAuthScreen();

  if (loaded.migrated && loaded.source === 'legacy') {
    const summary = store.doc.migration || {};
    notify.success(
      `Hemos traído tu cuadrante anterior: ${summary.entries ?? 0} turno(s) y ${summary.members ?? 0} persona(s).`,
      { duration: 7000 },
    );
    const warnings = summary.warnings || [];
    if (warnings.length) {
      setTimeout(() => notify.warning(warnings.join(' '), { duration: 9000 }), 900);
    }
  }
}

function localModePreference() {
  return storage.storage.get('horus.localmode') === '1';
}

/* ==================================================================== *
 * Arranque automático
 *
 * La aplicación se arranca sola SOLO cuando la carga un navegador. Las pruebas
 * necesitan preparar el entorno (configuración, almacenamiento, sesión) antes
 * de que se decida qué pantalla mostrar; si el arranque fuera incondicional al
 * importar el módulo, esa preparación llegaría tarde y siempre se vería la
 * pantalla de acceso. En Node, por tanto, `boot()` se invoca a mano.
 * ==================================================================== */

const isBrowserDocument = typeof window !== 'undefined'
  && typeof window.document !== 'undefined'
  && window.document === globalThis.document
  && typeof window.location?.href === 'string';

if (isBrowserDocument) {
  boot().catch((err) => {
    console.error('[app] fallo al arrancar:', err);
    const bootNode = byId('boot');
    if (bootNode) {
      bootNode.replaceChildren(el('div', { class: 'empty-state' }, [
        el('div', { class: 'empty-icon' }, icon('alert', 26)),
        el('h3', {}, 'No se pudo iniciar HORUS'),
        el('p', {}, err.message || 'Error desconocido.'),
        el('button', {
          type: 'button', class: 'btn btn-primary btn-sm',
          onclick: () => window.location.reload(),
        }, 'Recargar'),
      ]));
    }
  });
}

// Exponer un mínimo para depurar desde la consola
if (typeof window !== 'undefined') {
  window.__HORUS__ = {
    get ctx() { return getContext(); },
    get doc() { return store?.doc; },
    get store() { return store; },
    get sync() { return sync; },
    version: APP.version,
    exportAll: () => exporter.backupToJson(store.doc),
    stamp,
  };
}

export { boot, navigate, applyTheme, getContext };















