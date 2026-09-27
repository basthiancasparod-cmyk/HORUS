/**
 * HORUS — core/date.js
 * Utilidades de fecha/hora. Sin dependencias, sin estado.
 *
 * Convenios del proyecto (importante, se usan en TODOS los módulos):
 *  - Una fecha se representa SIEMPRE como string "YYYY-MM-DD" (clave de calendario).
 *  - Una hora se representa SIEMPRE como string "HH:MM" de 24h.
 *  - Un bloque de turno es { start:"HH:MM", end:"HH:MM" } donde end <= start
 *    significa que el turno CRUZA MEDIANOCHE (p. ej. 16:15 → 00:45).
 *  - Las duraciones se miden en MINUTOS desde el inicio del bloque.
 *  - La semana empieza en LUNES (ISO). Semana 1 = la que contiene el primer jueves.
 */

export const DAY_MS = 86400000;
export const MIN_PER_DAY = 1440;

export const DOW_SHORT = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
export const DOW_FULL = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
export const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];
export const MONTHS_SHORT = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
];

/* ------------------------------------------------------------------ *
 * Claves de fecha
 * ------------------------------------------------------------------ */

/** "YYYY-MM-DD" a partir de componentes. */
export function dateKey(year, monthIndex, day) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "YYYY-MM-DD" de un objeto Date (usa hora LOCAL, nunca UTC). */
export function toKey(date) {
  return dateKey(date.getFullYear(), date.getMonth(), date.getDate());
}

/** "YYYY-MM-DD" de hoy. */
export function todayKey(d = new Date()) {
  return toKey(d);
}

/** Parsea "YYYY-MM-DD" a Date local a medianoche. Devuelve null si es inválido. */
export function fromKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const dt = new Date(y, mo, d);
  // Rechaza fechas imposibles (2025-02-31 → 3 de marzo)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
  return dt;
}

/** ¿Es una clave "YYYY-MM-DD" válida? */
export function isValidKey(key) {
  return fromKey(key) !== null;
}

/** Suma (o resta) días a una clave de fecha. */
export function addDays(key, days) {
  const dt = fromKey(key);
  if (!dt) return key;
  dt.setDate(dt.getDate() + days);
  return toKey(dt);
}

/** Suma meses a una clave, anclando al día 1 para evitar desbordes de mes. */
export function addMonths(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  const total = (y * 12) + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  return `${ny}-${String(nm + 1).padStart(2, '0')}`;
}

/** Nº de días del mes de una clave "YYYY-MM-DD" o "YYYY-MM". */
export function daysInMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** "YYYY-MM" de una clave de fecha o Date. */
export function monthKeyOf(key) {
  if (key instanceof Date) return toKey(key).slice(0, 7);
  return String(key || todayKey()).slice(0, 7);
}

/** Todas las claves de un mes, en orden. */
export function monthDays(monthKey) {
  const n = daysInMonth(monthKey);
  const [y, m] = monthKey.split('-').map(Number);
  const out = [];
  for (let d = 1; d <= n; d++) out.push(dateKey(y, m - 1, d));
  return out;
}

/**
 * Rejilla completa de 6x7 semanas que cubre el mes, empezando en lunes.
 * @returns {{key:string, inMonth:boolean, day:number, iso:number}[]} 42 celdas
 */
export function monthGrid(monthKey, weekStart = 1) {
  const first = `${monthKey}-01`;
  const dim = daysInMonth(monthKey);
  const lastDow = fromKey(`${monthKey}-${String(dim).padStart(2, '0')}`).getDay();
  const firstDow = fromKey(first).getDay();
  // Días desde el lunes hasta el día 1 (0..6)
  const lead = (firstDow - weekStart + 7) % 7;
  const start = addDays(first, -lead);
  const rowMod = (lastDow - weekStart + 7) % 7;
  const trailing = 6 - rowMod;
  const total = lead + dim + trailing;

  const cells = [];
  for (let i = 0; i < total; i++) {
    const key = addDays(start, i);
    const dt = fromKey(key);
    cells.push({
      key,
      day: dt.getDate(),
      dow: dt.getDay(),
      iso: isoWeek(key).week,
      inMonth: key.slice(0, 7) === monthKey,
      isWeekend: dt.getDay() === 0 || dt.getDay() === 6,
    });
  }
  return cells;
}

/** Lunes de la semana ISO a la que pertenece la fecha. */
export function startOfWeek(key, weekStart = 1) {
  const dt = fromKey(key);
  if (!dt) return key;
  const shift = (dt.getDay() - weekStart + 7) % 7;
  return addDays(key, -shift);
}

/** Las 7 claves de la semana que contiene `key`. */
export function weekDays(key, weekStart = 1) {
  const start = startOfWeek(key, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/**
 * Semana y año ISO-8601. Lunes = primer día; la semana 1 es la que contiene
 * el primer jueves del año.
 * @returns {{week:number, year:number}}
 */
export function isoWeek(key) {
  const dt = fromKey(key);
  if (!dt) return { week: 1, year: 0 };
  const t = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  // Jueves de esta semana define el año ISO
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const year = t.getFullYear();
  const jan4 = new Date(year, 0, 4);
  jan4.setDate(jan4.getDate() + 3 - ((jan4.getDay() + 6) % 7));
  const week = 1 + Math.round((t - jan4) / (7 * DAY_MS));
  return { week, year };
}

/** Lunes de la semana ISO `week` del año `year`. */
export function isoWeekStart(year, week) {
  const jan4 = new Date(year, 0, 4);
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (week - 1) * 7);
  return toKey(monday);
}

/* ------------------------------------------------------------------ *
 * Horas y bloques
 * ------------------------------------------------------------------ */

const RE_TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** ¿Es un "HH:MM" válido? */
export function isValidTime(t) {
  return RE_TIME.test(String(t ?? ''));
}

/** "HH:MM" → minutos desde medianoche. Devuelve NaN si es inválido. */
export function timeToMin(t) {
  const m = RE_TIME.exec(String(t ?? ''));
  if (!m) return NaN;
  return (+m[1]) * 60 + (+m[2]);
}

/** Minutos desde medianoche → "HH:MM". Acepta valores fuera de 0..1439 y los da la vuelta. */
export function minToTime(min) {
  let m = Math.round(Number(min) || 0);
  m = ((m % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** ¿El bloque cruza medianoche? */
export function crossesMidnight(block) {
  if (!block) return false;
  const s = timeToMin(block.start), e = timeToMin(block.end);
  if (Number.isNaN(s) || Number.isNaN(e)) return false;
  return e <= s;
}

/**
 * Duración de un bloque en minutos. Maneja el cruce de medianoche.
 * Si `end === start` se interpreta como 24 h (turno de día completo).
 */
export function blockMinutes(block) {
  if (!block) return 0;
  const s = timeToMin(block.start), e = timeToMin(block.end);
  if (Number.isNaN(s) || Number.isNaN(e)) return 0;
  if (e > s) return e - s;
  if (e === s) return MIN_PER_DAY;
  return (MIN_PER_DAY - s) + e;
}

/** Normaliza un bloque: recorta espacios y valida. Devuelve null si es inservible. */
export function normalizeBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const start = String(block.start ?? '').trim();
  const end = String(block.end ?? '').trim();
  if (!isValidTime(start) || !isValidTime(end)) return null;
  return { start, end };
}

/** Lista de bloques válidos, ordenados por hora de inicio y sin solapamientos. */
export function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const clean = blocks.map(normalizeBlock).filter(Boolean);
  clean.sort((a, b) => timeToMin(a.start) - timeToMin(b.start));
  const out = [];
  for (const b of clean) {
    const prev = out[out.length - 1];
    if (prev && !crossesMidnight(prev) && timeToMin(b.start) < timeToMin(prev.end)) {
      // Solapado: se fusiona con el anterior
      prev.end = timeToMin(b.end) > timeToMin(prev.end) ? b.end : prev.end;
    } else {
      out.push({ ...b });
    }
  }
  return out;
}

/** Suma de minutos de varios bloques, sin contar dos veces los solapamientos. */
export function totalMinutes(blocks) {
  return normalizeBlocks(blocks).reduce((acc, b) => acc + blockMinutes(b), 0);
}

/**
 * Convierte bloques a tramos absolutos [startMin, endMin) sobre la línea de
 * tiempo del DÍA EN QUE EMPIEZA el turno. endMin puede pasar de 1440.
 */
export function blockSpans(blocks) {
  return normalizeBlocks(blocks).map((b) => {
    const s = timeToMin(b.start);
    return { start: s, end: s + blockMinutes(b), startTime: b.start, endTime: b.end, overnight: crossesMidnight(b) };
  });
}

/** ¿Está `minute` (0..1439) cubierto por alguno de los bloques? */
export function isMinuteCovered(blocks, minute) {
  return blockSpans(blocks).some((sp) => minute >= sp.start && minute < sp.end);
}

/**
 * Genera intervalos libres dentro de [0, 1440) no cubiertos por los bloques.
 * @returns {{start:number, end:number}[]}
 */
export function freeIntervals(blocks) {
  const spans = blockSpans(blocks)
    .map((sp) => ({ start: Math.max(0, sp.start), end: Math.min(MIN_PER_DAY, sp.end) }))
    .filter((sp) => sp.end > sp.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  let cursor = 0;
  for (const sp of spans) {
    if (sp.start > cursor) out.push({ start: cursor, end: sp.start });
    cursor = Math.max(cursor, sp.end);
  }
  if (cursor < MIN_PER_DAY) out.push({ start: cursor, end: MIN_PER_DAY });
  return out;
}

/** "HH:MM" → minutos, con fallback y sin NaN (para entradas de usuario). */
export function safeTimeToMin(t, fallback = 0) {
  const v = timeToMin(t);
  return Number.isNaN(v) ? fallback : v;
}

/* ------------------------------------------------------------------ *
 * Minutos transcurridos de un turno (para "quién trabaja ahora")
 * ------------------------------------------------------------------ */

/**
 * Estado temporal de un turno nocturno respecto a "ahora".
 * @param {string} startKey fecha en que EMPIEZA el turno
 * @param {object[]} blocks bloques del turno
 * @param {Date} now
 * @returns {{isNow:boolean, startsAt:Date, endsAt:Date|null, progress:number}}
 */
export function shiftRuntime(startKey, blocks, now = new Date()) {
  const spans = blockSpans(blocks);
  if (!spans.length) return null;
  const base = fromKey(startKey);
  if (!base) return null;
  const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const nowMs = now.getTime();
  let startsAt = Infinity, endsAt = -Infinity, isNow = false, progress = 0;

  for (const sp of spans) {
    const s = dayStart.getTime() + sp.start * 60000;
    const e = dayStart.getTime() + sp.end * 60000;
    startsAt = Math.min(startsAt, s);
    endsAt = Math.max(endsAt, e);
    if (nowMs >= s && nowMs < e) {
      isNow = true;
      progress = (nowMs - s) / (e - s);
    }
  }
  return {
    isNow,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    progress,
    minutesToStart: Math.round((startsAt - nowMs) / 60000),
    minutesToEnd: Math.round((endsAt - nowMs) / 60000),
  };
}

/* ------------------------------------------------------------------ *
 * Formateo para mostrar
 * ------------------------------------------------------------------ */

/** "5 h 30 min" / "45 min" / "8 h". */
export function formatDuration(minutes) {
  const m = Math.max(0, Math.round(Math.abs(minutes)));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${h} h ${r} min`;
  if (h) return `${h} h`;
  return `${r} min`;
}

/** "5,5 h" — formato compacto para tablas. */
export function formatHours(minutes, decimals = 1) {
  return `${(Math.max(0, minutes) / 60).toFixed(decimals).replace('.', ',')} h`;
}

/** "miércoles, 4 de junio" */
export function formatLongDate(key) {
  const dt = fromKey(key);
  if (!dt) return key;
  const s = dt.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "4 jun 2025" */
export function formatShortDate(key) {
  const dt = fromKey(key);
  if (!dt) return key;
  return `${dt.getDate()} ${MONTHS_SHORT[dt.getMonth()]} ${dt.getFullYear()}`;
}

/** "Junio 2025" */
export function formatMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** Distancia relativa legible: "en 3 h 20 min", "hace 2 días". */
export function formatRelative(ms) {
  const future = ms >= 0;
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60000);
  let text;
  if (mins < 1) text = 'menos de un minuto';
  else if (mins < 60) text = `${mins} min`;
  else if (mins < 60 * 24) text = formatDuration(mins);
  else {
    const days = Math.round(mins / 60 / 24);
    text = days === 1 ? '1 día' : `${days} días`;
  }
  return future ? `en ${text}` : `hace ${text}`;
}

/** "HH:MM" de un Date. */
export function formatClock(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** "HH:MM" → "8:30" (sin cero inicial, más natural en español). */
export function humanTime(t) {
  return String(t || '').replace(/^0/, '');
}

/** Rango legible de bloques: "8:30–17:00 · 19:00–23:00". */
export function formatBlocks(blocks) {
  return normalizeBlocks(blocks)
    .map((b) => `${humanTime(b.start)}–${humanTime(b.end)}`)
    .join(' · ');
}

/** Fechas ISO para el nombre de un archivo exportado. */
export function stamp(d = new Date()) {
  return `${toKey(d)}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}
