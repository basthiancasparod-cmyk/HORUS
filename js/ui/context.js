/**
 * HORUS — js/ui/context.js
 * Contexto compartido por las vistas: el store, los motores y el estado de
 * navegación. Evita pasar dependencias por parámetro en cada llamada y, sobre
 * todo, evita importar `js/app.js` desde las vistas (que crearía un ciclo).
 */

let ctx = null;

export function setContext(next) {
  ctx = next;
  return ctx;
}

export function getContext() {
  if (!ctx) throw new Error('[ui] el contexto todavía no está listo');
  return ctx;
}

/* ------------------------------------------------------------------ *
 * Navegación
 * ------------------------------------------------------------------ */

export const VIEWS = ['today', 'calendar', 'roster', 'team', 'hours', 'settings'];

export const VIEW_TITLES = {
  today: 'Hoy',
  calendar: 'Calendario',
  roster: 'Cuadrante',
  team: 'Equipo',
  hours: 'Horas',
  settings: 'Ajustes',
};

let currentView = 'today';
const viewListeners = new Set();

export function getCurrentView() {
  return currentView;
}

export function setCurrentView(view) {
  if (!VIEWS.includes(view) || view === currentView) return currentView;
  currentView = view;
  for (const fn of [...viewListeners]) {
    try { fn(view); } catch (err) { console.error('[ui] suscriptor de vista con error:', err); }
  }
  return currentView;
}

export function onViewChange(fn, { immediate = false } = {}) {
  viewListeners.add(fn);
  if (immediate) fn(currentView);
  return () => viewListeners.delete(fn);
}

/* ------------------------------------------------------------------ *
 * Fecha en foco
 *
 * Es la fecha "activa" que comparten el calendario, el cuadrante y las horas.
 * Se guarda como clave "YYYY-MM-DD".
 * ------------------------------------------------------------------ */

let focusDate = null;
const focusListeners = new Set();

export function getFocusDate(fallback = null) {
  return focusDate || fallback;
}

export function setFocusDate(key) {
  if (!key || key === focusDate) return focusDate;
  focusDate = key;
  for (const fn of [...focusListeners]) {
    try { fn(key); } catch (err) { console.error('[ui] suscriptor de fecha con error:', err); }
  }
  return focusDate;
}

export function onFocusDateChange(fn, { immediate = false } = {}) {
  focusListeners.add(fn);
  if (immediate && focusDate) fn(focusDate);
  return () => focusListeners.delete(fn);
}

/* ------------------------------------------------------------------ *
 * Filtros compartidos (personas y tipos de turno visibles)
 * ------------------------------------------------------------------ */

const filters = {
  memberIds: new Set(),
  typeIds: new Set(),
  onlyMine: false,
};

const filterListeners = new Set();

export function getFilters() {
  return {
    memberIds: [...filters.memberIds],
    typeIds: [...filters.typeIds],
    onlyMine: filters.onlyMine,
    active: filters.memberIds.size > 0 || filters.typeIds.size > 0 || filters.onlyMine,
  };
}

export function isMemberVisible(memberId) {
  if (filters.onlyMine) return false; // lo resuelve la vista, que conoce el doc
  return filters.memberIds.size === 0 || filters.memberIds.has(memberId);
}

export function isTypeVisible(typeId) {
  return filters.typeIds.size === 0 || filters.typeIds.has(typeId ?? '_');
}

export function setFilter(kind, values) {
  if (kind === 'memberIds') filters.memberIds = new Set(values);
  else if (kind === 'typeIds') filters.typeIds = new Set(values);
  else if (kind === 'onlyMine') filters.onlyMine = !!values;
  for (const fn of [...filterListeners]) {
    try { fn(getFilters()); } catch (err) { console.error('[ui] suscriptor de filtros con error:', err); }
  }
  return getFilters();
}

export function clearFilters() {
  filters.memberIds.clear();
  filters.typeIds.clear();
  filters.onlyMine = false;
  for (const fn of [...filterListeners]) {
    try { fn(getFilters()); } catch (err) { console.error('[ui] suscriptor de filtros con error:', err); }
  }
  return getFilters();
}

export function onFiltersChange(fn, { immediate = false } = {}) {
  filterListeners.add(fn);
  if (immediate) fn(getFilters());
  return () => filterListeners.delete(fn);
}

/* ------------------------------------------------------------------ *
 * Repintado coordinado
 *
 * Un cambio en el store puede afectar a varias vistas. En lugar de que cada
 * una se repinte por su cuenta, se apunta cuál está visible y se repinta solo
 * esa, una vez por frame.
 * ------------------------------------------------------------------ */

const renderers = new Map();
let scheduled = false;
const dirty = new Set();

/** Registra la función de pintado de una vista. */
export function registerRenderer(view, fn) {
  renderers.set(view, fn);
}

/** Marca una vista (o todas) como pendiente de repintar. */
export function invalidate(view = null) {
  if (view) dirty.add(view);
  else for (const v of renderers.keys()) dirty.add(v);
  scheduleFlush();
}

function scheduleFlush() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const pending = [...dirty];
    dirty.clear();
    // Solo se repinta lo que el usuario puede ver
    const visible = pending.filter((v) => v === currentView);
    const targets = visible.length ? visible : (pending.includes(currentView) ? [currentView] : []);
    for (const view of targets) {
      const fn = renderers.get(view);
      if (!fn) continue;
      try {
        fn();
      } catch (err) {
        console.error(`[ui] la vista "${view}" falló al pintarse:`, err);
      }
    }
  });
}

/** Fuerza el repintado inmediato de la vista visible. */
export function renderCurrent() {
  const fn = renderers.get(currentView);
  if (!fn) return;
  try {
    fn();
  } catch (err) {
    console.error(`[ui] la vista "${currentView}" falló al pintarse:`, err);
  }
}
