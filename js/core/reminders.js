/**
 * HORUS — js/core/reminders.js
 * Alarmas de turno y avisos.
 *
 * Lo que estaba mal en la versión anterior:
 *  - Se programaban `setTimeout` de hasta 48 h que se perdían al cerrar la
 *    pestaña, al recargar o al suspender el móvil, sin forma de recuperarlos.
 *  - No había registro de lo ya avisado, así que volver a abrir la app podía
 *    repetir el aviso o saltárselo entero.
 *
 * Cómo funciona ahora:
 *  1. `scheduleTimeouts()` programa temporizadores solo para lo que ocurre en
 *     las próximas horas: es lo único en lo que se puede confiar de verdad.
 *  2. `tick()` se ejecuta cada 30 s (y al volver a la pestaña, al recuperar
 *     conexión y al despertar del móvil) y comprueba la lista de alarmas
 *     pendientes contra la hora actual. Si alguna debería haber sonado en los
 *     últimos minutos y no está registrada como avisada, la dispara.
 *  3. Los avisos entregados se anotan en localStorage, de modo que recargar la
 *     app no duplica ni pierde nada dentro de la ventana de gracia.
 */

import {
  timeToMin, blockMinutes, normalizeBlocks, addDays, todayKey, toKey,
  formatDuration, formatClock, formatBlocks,
} from './date.js';
import { entryBlocks, entryType, memberById, entryIsWork } from './model.js';
import { analyzeDate, whoIsNow, nextShift } from './coverage.js';
import { storage } from './storage.js';

const FIRED_KEY = 'horus.alarms.fired';
/** Ventana hacia atrás en la que un aviso perdido todavía merece la pena. */
const GRACE_MINUTES = 10;
/** Horizonte de los temporizadores reales (más allá se confía en `tick`). */
const TIMEOUT_HORIZON_MS = 6 * 3600 * 1000;
const MAX_TIMEOUTS = 40;
const TICK_INTERVAL_MS = 30000;
/** Tope de registros de avisos entregados (suficiente y barato de guardar). */
const MAX_FIRED = 500;

/* ------------------------------------------------------------------ *
 * Registro de avisos ya entregados
 * ------------------------------------------------------------------ */

/**
 * Carga el registro de avisos.
 *
 * Ojo: NO se filtra por fecha. Una versión anterior recortaba el registro a
 * los avisos de hoy y ayer buscando la fecha dentro de la clave, pero las
 * claves de los avisos de turno se basan en el id de la entrada y la hora de
 * aviso, no en la fecha; el filtro borraba justo las entradas que había que
 * recordar y los avisos se repetían al recargar. Se conserva todo, con un tope.
 */
function loadFired() {
  try {
    const raw = storage.get(FIRED_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return {};
    const out = {};
    for (const [key, value] of parsed.slice(-MAX_FIRED)) {
      if (typeof key === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function saveFired(fired) {
  try {
    storage.set(FIRED_KEY, JSON.stringify(Object.entries(fired).slice(-MAX_FIRED)));
  } catch { /* sin espacio: no es crítico */ }
}

export function clearFired() {
  storage.remove(FIRED_KEY);
}

/* ------------------------------------------------------------------ *
 * Permisos y entrega
 * ------------------------------------------------------------------ */

export function notificationsSupported() {
  if (typeof window === 'undefined') return false;
  return typeof window.Notification === 'function';
}

export function permissionState() {
  if (!notificationsSupported()) return 'unsupported';
  return window.Notification.permission; // 'default' | 'granted' | 'denied'
}

/** Pide permiso. Solo debe llamarse tras una acción del usuario. */
export async function requestPermission() {
  if (!notificationsSupported()) return { ok: false, reason: 'unsupported' };
  if (window.Notification.permission === 'granted') return { ok: true, reason: 'granted' };
  try {
    const result = await window.Notification.requestPermission();
    return { ok: result === 'granted', reason: result };
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }
}

/**
 * Muestra una notificación. Se prefiere el service worker porque sus avisos
 * sobreviven mejor en segundo plano y respetan el icono de la app instalada.
 */
export async function deliver(title, body, { tag, data = {}, requireInteraction = false, silent = false } = {}) {
  const options = {
    body,
    tag,
    data,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-96.png',
    vibrate: silent ? undefined : [180, 90, 180],
    requireInteraction,
    silent,
  };

  // 1) Vía service worker
  try {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'SHOW_NOTIFICATION',
        payload: { title, ...options },
      });
      return { ok: true, via: 'service-worker' };
    }
    const registration = await navigator.serviceWorker?.ready;
    if (registration) {
      await registration.showNotification(title, options);
      return { ok: true, via: 'registration' };
    }
  } catch (err) {
    console.warn('[reminders] el service worker no pudo mostrar el aviso:', err);
  }

  // 2) Respaldo: notificación directa de la página
  try {
    if (notificationsSupported() && window.Notification.permission === 'granted') {
      // eslint-disable-next-line no-new -- el constructor ya muestra el aviso
      new window.Notification(title, options);
      return { ok: true, via: 'window' };
    }
  } catch (err) {
    console.warn('[reminders] no se pudo mostrar la notificación:', err);
  }
  return { ok: false, via: null };
}

/* ------------------------------------------------------------------ *
 * Cálculo de alarmas pendientes
 * ------------------------------------------------------------------ */

/**
 * Lista de alarmas que deberían existir para las próximas horas.
 * Es una función pura respecto al estado: recibe el documento y devuelve datos.
 *
 * @param {object} doc
 * @param {{from?:Date, hoursAhead?:number, memberId?:string|null, now?:Date}} [opts]
 * @returns {{key:string, at:Date, title:string, body:string, tag:string,
 *            entryId:string|null, kind:'shift'|'briefing'|'coverage'}[]}
 */
export function pendingAlarms(doc, opts = {}) {
  const {
    now = new Date(),
    hoursAhead = 48,
    memberId = null,
  } = opts;

  const settings = doc.settings?.notifications || {};
  const lead = Number(settings.minutesBefore) || 30;
  const alarms = [];
  const horizon = new Date(now.getTime() + hoursAhead * 3600 * 1000);
  const windowStart = new Date(now.getTime() - GRACE_MINUTES * 60000);

  // --- Alarmas de turno ---
  const from = toKey(now);
  const to = toKey(horizon);
  let cursor = from;
  let guard = 0;

  while (cursor <= to && guard++ < 10) {
    const base = new Date(`${cursor}T00:00:00`);
    for (const entry of doc.entries) {
      if (entry.date !== cursor) continue;
      if (memberId && entry.memberId !== memberId) continue;
      if (!entryIsWork(doc, entry)) continue;

      const type = entryType(doc, entry);
      const member = memberById(doc, entry.memberId);
      for (const block of normalizeBlocks(entryBlocks(doc, entry))) {
        const startMs = base.getTime() + timeToMin(block.start) * 60000;
        const at = new Date(startMs - lead * 60000);
        if (at < windowStart || at > horizon) continue;
        const minutes = blockMinutes(block);
        alarms.push({
          key: `shift:${entry.id}:${block.start}:${at.toISOString().slice(0, 16)}`,
          at,
          kind: 'shift',
          entryId: entry.id,
          title: minutes >= 600
            ? `Turno de ${formatDuration(minutes)} en ${lead} min`
            : `Turno a las ${block.start}`,
          body: [
            member?.name ? `${member.name} · ${type?.label || 'turno'}` : (type?.label || 'Turno'),
            `${block.start}–${block.end}`,
            minutes ? `(${formatDuration(minutes)})` : '',
          ].filter(Boolean).join('  '),
          tag: `horus-shift-${entry.id}-${block.start}`,
          data: { kind: 'shift', date: cursor, entryId: entry.id },
        });
      }
    }
    cursor = addDays(cursor, 1);
  }

  // --- Resumen diario (opcional) ---
  if (settings.dailyBriefing && settings.briefingHour) {
    for (const offset of [0, 1]) {
      const day = addDays(todayKey(now), offset);
      const [h, m] = String(settings.briefingHour).split(':').map(Number);
      const at = new Date(`${day}T00:00:00`);
      at.setHours(Number.isFinite(h) ? h : 20, Number.isFinite(m) ? m : 0, 0, 0);
      if (at < windowStart || at > horizon) continue;

      // Se avisa del día siguiente al momento del resumen
      const target = offset === 0 && at.getHours() < 12 ? day : addDays(day, 1);
      const mine = doc.entries.filter((e) => e.date === target && entryIsWork(doc, e)
        && (!memberId || e.memberId === memberId));
      const lines = mine.slice(0, 4).map((e) => {
        const member = memberById(doc, e.memberId);
        return `${member?.name || '?'}: ${entryLabelShort(doc, e)}`;
      });
      const analysis = analyzeDate(doc, target);
      const gapNote = analysis.gapMin > 0 ? `⚠ ${formatDuration(analysis.gapMin)} sin cubrir` : 'Cobertura completa';

      alarms.push({
        key: `briefing:${at.toISOString().slice(0, 13)}:${target}`,
        at,
        kind: 'briefing',
        entryId: null,
        title: `Mañana hay ${mine.length} turno${mine.length === 1 ? '' : 's'}`,
        body: [lines.join(' · ') || 'Nadie tiene turno.', gapNote].filter(Boolean).join('\n'),
        tag: `horus-briefing-${target}`,
        data: { kind: 'briefing', date: target },
      });
    }
  }

  // --- Avisó de huecos de cobertura (opcional) ---
  if (settings.coverageAlerts) {
    for (const offset of [0, 1]) {
      const day = addDays(todayKey(now), offset);
      const at = new Date(`${day}T00:00:00`);
      at.setHours(8, 0, 0, 0); // revisión a las 8:00
      if (at < windowStart || at > horizon) continue;
      const analysis = analyzeDate(doc, day);
      if (analysis.gapMin <= 0) continue;
      const gaps = analysis.gaps.slice(0, 3).map((g) => `${minLabel(g.start)}–${minLabel(g.end)}`).join(', ');
      alarms.push({
        key: `coverage:${day}`,
        at,
        kind: 'coverage',
        entryId: null,
        title: `${analysis.gaps.length} hueco(s) de cobertura`,
        body: `${formatDuration(analysis.gapMin)} sin cubrir el ${day}: ${gaps}${analysis.gaps.length > 3 ? '…' : ''}`,
        tag: `horus-coverage-${day}`,
        data: { kind: 'coverage', date: day },
      });
    }
  }

  alarms.sort((a, b) => a.at - b.at);
  return alarms;
}

function entryLabelShort(doc, entry) {
  const type = entryType(doc, entry);
  if (type) return type.label;
  const blocks = normalizeBlocks(entryBlocks(doc, entry));
  return blocks.length ? formatBlocks(blocks) : 'turno';
}

function minLabel(min) {
  const m = Math.round(min) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Planificador
 * ------------------------------------------------------------------ */

/**
 * Crea el planificador. Mantiene sus propios temporizadores y el registro de
 * avisos entregados.
 *
 * @param {{
 *   getDoc: () => object,
 *   onFire?: (alarm:object, result:object) => void,
 * }} deps
 */
export function createScheduler({ getDoc, onFire = null }) {
  let timeouts = [];
  let tickTimer = null;
  let fired = loadFired();
  let running = false;
  let lastTickAt = 0;

  const listeners = new Set();

  function emit(event) {
    for (const fn of [...listeners]) {
      try { fn(event); } catch (err) { console.error('[reminders] suscriptor con error:', err); }
    }
  }

  function subscribe(fn, { immediate = false } = {}) {
    listeners.add(fn);
    if (immediate) fn({ type: 'state', scheduled: timeouts.length, running });
    return () => listeners.delete(fn);
  }

  function clearTimeouts() {
    for (const id of timeouts) clearTimeout(id);
    timeouts = [];
  }

  /** Dispara una alarma y la registra como entregada. */
  async function fire(alarm) {
    if (fired[alarm.key]) return { ok: false, reason: 'already-fired' };
    const settings = getDoc().settings?.notifications || {};
    if (!settings.enabled) return { ok: false, reason: 'disabled' };
    if (permissionState() !== 'granted') return { ok: false, reason: 'no-permission' };

    fired[alarm.key] = Date.now();
    saveFired(fired);

    const result = await deliver(alarm.title, alarm.body, {
      tag: alarm.tag,
      data: alarm.data,
      requireInteraction: alarm.kind === 'shift',
    });
    const event = { type: 'fired', alarm, result };
    emit(event);
    if (onFire) {
      try { onFire(alarm, result); } catch (err) { console.error('[reminders] onFire falló:', err); }
    }
    return result;
  }

  /**
   * Comprueba si alguna alarma debería haber sonado ya. Es el mecanismo de
   * recuperación: cubre recargas, pestañas cerradas y móviles suspendidos.
   */
  async function tick() {
    lastTickAt = Date.now();
    const doc = getDoc();
    if (!doc.settings?.notifications?.enabled) return { fired: 0 };
    if (permissionState() !== 'granted') return { fired: 0 };

    const now = new Date();
    let count = 0;
    // Ventana corta: solo lo que debería haber sonado hace poco
    const alarms = pendingAlarms(doc, { now, hoursAhead: 0.25 });
    for (const alarm of alarms) {
      if (alarm.at > now) continue;
      if (now - alarm.at > GRACE_MINUTES * 60000) {
        // Demasiado tarde: se marca como visto para no avisar a destiempo
        if (!fired[alarm.key]) { fired[alarm.key] = 0; saveFired(fired); }
        continue;
      }
      const result = await fire(alarm);
      if (result.ok) count++;
    }
    if (count) emit({ type: 'tick', fired: count });
    return { fired: count };
  }

  /** Recalcula los temporizadores reales. */
  function scheduleTimeouts() {
    clearTimeouts();
    const doc = getDoc();
    const settings = doc.settings?.notifications || {};
    if (!settings.enabled || permissionState() !== 'granted') {
      emit({ type: 'state', scheduled: 0, running });
      return 0;
    }

    const now = new Date();
    const alarms = pendingAlarms(doc, { now, hoursAhead: TIMEOUT_HORIZON_MS / 3600000 })
      .filter((a) => a.at > now && !fired[a.key]);

    let scheduled = 0;
    for (const alarm of alarms) {
      if (scheduled >= MAX_TIMEOUTS) break;
      const delay = alarm.at.getTime() - now.getTime();
      if (delay <= 0 || delay > TIMEOUT_HORIZON_MS) continue;
      // setTimeout no es fiable más allá de ~24 días y se degrada en segundo
      // plano; por eso el horizonte es corto y `tick()` cubre el resto.
      const id = setTimeout(() => { fire(alarm); }, delay);
      timeouts.push(id);
      scheduled++;
    }
    emit({ type: 'state', scheduled, running });
    return scheduled;
  }

  function start() {
    if (running) return;
    running = true;
    scheduleTimeouts();
    tickTimer = setInterval(() => { tick(); }, TICK_INTERVAL_MS);

    // Revalidar cuando la app vuelve a primer plano o cambia la conectividad
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('pageshow', onOnline);
    tick();
  }

  function stop() {
    running = false;
    clearTimeouts();
    clearInterval(tickTimer);
    tickTimer = null;
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pageshow', onOnline);
  }

  function onVisible() {
    if (document.visibilityState === 'visible') { tick(); scheduleTimeouts(); }
  }
  function onFocus() { tick(); }
  function onOnline() { tick(); scheduleTimeouts(); }

  /** Llamar tras cualquier cambio en el documento. */
  function reschedule() {
    scheduleTimeouts();
  }

  /** Fuerza un aviso inmediato (botón "probar notificación"). */
  async function testNotification() {
    const permission = await requestPermission();
    if (!permission.ok) return { ok: false, reason: permission.reason };
    const result = await deliver(
      'HORUS funciona',
      'Así se verán tus avisos de turno. Puedes desactivarlos en Ajustes.',
      { tag: 'horus-test', data: { kind: 'test' } },
    );
    return result;
  }

  /** Resumen de lo que está programado, para mostrarlo en Ajustes. */
  function inspect() {
    const doc = getDoc();
    const now = new Date();
    const alarms = pendingAlarms(doc, { now, hoursAhead: 72 })
      .filter((a) => a.at > now)
      .slice(0, 8);
    return {
      running,
      permission: permissionState(),
      enabled: !!doc.settings?.notifications?.enabled,
      timeouts: timeouts.length,
      lastTickAt,
      upcoming: alarms.map((a) => ({ at: a.at, title: a.title, kind: a.kind })),
    };
  }

  /** Estado de guardia ahora mismo (para el panel de Hoy). */
  function onDuty(now = new Date()) {
    return whoIsNow(getDoc(), now);
  }

  /** Próximo turno de una persona. */
  function nextFor(memberId, now = new Date()) {
    return nextShift(getDoc(), memberId, now);
  }

  return {
    start,
    stop,
    reschedule,
    tick,
    inspect,
    onDuty,
    nextFor,
    subscribe,
    fire,
    testNotification,
    clearFired: () => { fired = {}; clearFired(); },
    get running() { return running; },
  };
}

/** Resumen legible para el panel de Hoy: "Ana y Luis, hasta las 17:00". */
export function describeOnDuty(onDutyList) {
  if (!onDutyList.length) return 'Nadie de guardia ahora mismo';
  const names = onDutyList.map((d) => d.member?.name || 'Alguien');
  const last = onDutyList.reduce((max, d) => Math.max(max, d.end), 0);
  const endText = last >= 1440 ? 'mañana' : minLabel(last);
  if (names.length === 1) return `${names[0]}, hasta las ${endText}`;
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}, hasta las ${endText}`;
}

export { minLabel, formatClock };
