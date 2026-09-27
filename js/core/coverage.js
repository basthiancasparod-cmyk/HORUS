/**
 * HORUS — core/coverage.js
 * Motor de análisis del cuadrante: cobertura, huecos, solapamientos y estadísticas.
 *
 * Idea central: "cobertura" significa que en cada momento del día alguien está
 * de turno. Para un calendario COMPARTIDO esto es lo importante: no solo quién
 * trabaja, sino cuándo el equipo se queda descubierto.
 *
 * Manejo de turnos nocturnos: un turno del 12 que va de 22:00 a 06:00 cuenta
 * como cobertura del 12 (22:00–24:00) y del 13 (00:00–06:00). Por eso cada día
 * se analiza con las entradas de ese día MÁS las del día anterior.
 */

import {
  MIN_PER_DAY, timeToMin, blockMinutes, normalizeBlocks, blockSpans, addDays,
  monthDays, toKey, fromKey,
} from './date.js';
import {
  entryBlocks, entryType, memberById, shiftTypeById, entryIsWork,
} from './model.js';

/* ------------------------------------------------------------------ *
 * Proyección de entradas sobre un día concreto
 * ------------------------------------------------------------------ */

/**
 * Proyecta una entrada sobre la línea de tiempo [0,1440) del día `date`,
 * recortando lo que caiga fuera de ese día.
 *
 * @param {object} doc
 * @param {object} entry
 * @param {string} date día sobre el que se proyecta
 * @returns {{start:number,end:number,entry:object,type:object|null,member:object|null,
 *            isWork:boolean,demand:number,continuedFromPrevDay:boolean,continuesNextDay:boolean}|null}
 */
export function projectEntryOntoDate(doc, entry, date) {
  const blocks = normalizeBlocks(entryBlocks(doc, entry));
  const type = entryType(doc, entry);
  // Una entrada que apunta a un tipo inexistente y no tiene bloques propios no
  // aporta nada al cuadrante.
  if (!entry.blocks?.length && entry.typeId && !type) return null;

  const isSameDay = entry.date === date;
  const isPrevDay = entry.date === addDays(date, -1);
  if (!isSameDay && !isPrevDay) return null;

  const member = memberById(doc, entry.memberId);
  const work = entryIsWork(doc, entry);
  const base = {
    entry,
    type,
    member,
    isWork: work,
    demand: effectiveDemand(doc, entry, date),
    // Una ausencia (vacaciones, baja, libre, festivo) no tiene franja horaria
    // pero SÍ forma parte del día: hay que poder mostrarla.
    zeroLength: !work,
    continuedFromPrevDay: false,
    continuesNextDay: false,
  };

  if (!work) return { ...base, start: 0, end: 0 };

  if (!blocks.length) return null;

  // `shift` sitúa el inicio del turno en la línea de tiempo del día pedido:
  // 0 si empieza hoy, 1440 si empezó ayer (y por tanto invade la madrugada).
  const shift = isSameDay ? 0 : MIN_PER_DAY;

  // Importante: se calcula el rango en coordenadas ABSOLUTAS (relativas al día
  // en que empieza el turno) y solo después se traslada y se recorta al día
  // pedido. Recortar antes daría un resultado al revés en turnos nocturnos.
  let absStart = Infinity;
  let absEnd = -Infinity;
  for (const b of blocks) {
    const s = timeToMin(b.start);
    absStart = Math.min(absStart, s);
    absEnd = Math.max(absEnd, s + blockMinutes(b));
  }
  if (!Number.isFinite(absStart) || !Number.isFinite(absEnd)) return null;

  const start = Math.max(0, absStart - shift);
  const end = Math.min(MIN_PER_DAY, absEnd - shift);
  if (end <= start) return null;   // el turno no toca este día en absoluto

  return {
    ...base,
    start,
    end,
    continuedFromPrevDay: !isSameDay,
    // ¿Este turno sigue después de la medianoche que cierra el día pedido?
    continuesNextDay: absEnd - shift > MIN_PER_DAY,
  };
}

/**
 * Demanda efectiva (cuántas personas hacen falta) para una entrada:
 * override de la entrada → demanda del tipo de turno → override del día →
 * valor por defecto de los ajustes.
 */
export function effectiveDemand(doc, entry, date = entry?.date) {
  if (entry?.demandOverride != null) return entry.demandOverride;
  const type = entryType(doc, entry);
  if (type && Number.isFinite(type.demand)) return type.demand;
  const meta = doc.dayMeta?.[date];
  if (meta?.demandOverride != null) return meta.demandOverride;
  return doc.settings?.coverage?.defaultDemand ?? 1;
}

/* ------------------------------------------------------------------ *
 * Cálculo de intervalos
 * ------------------------------------------------------------------ */

const sortByStart = (a, b) => a.start - b.start || a.end - b.end;

/**
 * Normaliza un instante que puede llegar como `Date` o como clave "YYYY-MM-DD".
 * Muchas funciones de análisis aceptan ambos, y olvidar la conversión producía
 * errores del tipo «date.getFullYear is not a function».
 */
function coerceDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const dt = fromKey(value);
    if (dt) return dt;
  }
  return new Date();
}

/**
 * Fusiona intervalos solapados o contiguos.
 * @param {{start:number,end:number}[]} intervals
 */
export function mergeIntervals(intervals) {
  const sorted = intervals.filter((i) => i.end > i.start).sort(sortByStart);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

/**
 * Dado un conjunto de proyecciones, calcula los tramos con distinto nivel de
 * cobertura. En los puntos de corte, `covered` es el número de personas
 * trabajando y `required` la demanda máxima de esas personas.
 *
 * @returns {{start:number,end:number,count:number,required:number,
 *            entries:object[], members:object[], status:'ok'|'under'|'over'|'none'}[]}
 */
export function coverageIntervals(projections) {
  const work = projections.filter((p) => p.isWork && p.end > p.start);
  if (!work.length) {
    return [{ start: 0, end: MIN_PER_DAY, count: 0, required: 0, entries: [], members: [], status: 'none' }];
  }

  // Puntos de corte
  const points = new Set([0, MIN_PER_DAY]);
  for (const p of work) {
    points.add(p.start);
    points.add(p.end);
  }
  const edges = [...points].filter((p) => p >= 0 && p <= MIN_PER_DAY).sort((a, b) => a - b);

  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i];
    const end = edges[i + 1];
    if (end <= start) continue;

    const active = work.filter((p) => p.start < end && p.end > start);
    const count = new Set(active.map((p) => p.member?.id || p.entry.id)).size;
    const required = active.reduce((max, p) => Math.max(max, p.demand || 0), 0);

    let status = 'ok';
    if (count === 0) status = 'none';
    else if (count < required) status = 'under';
    else if (count > required) status = 'over';

    const seg = {
      start,
      end,
      count,
      required,
      entries: active.map((p) => p.entry),
      members: active.map((p) => p.member).filter(Boolean),
      status,
    };

    // Fusiona con el tramo anterior si es homogéneo
    const prev = out[out.length - 1];
    if (prev && prev.end === start && prev.status === status && prev.count === count && prev.required === required) {
      prev.end = end;
    } else {
      out.push(seg);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Análisis de una fecha
 * ------------------------------------------------------------------ */

/**
 * @param {object} doc
 * @param {string} date
 * @returns {{
 *   date:string, projections:object[], intervals:object[],
 *   working:object[], off:object[], coverageMin:number, gapMin:number,
 *   gaps:{start:number,end:number}[], peak:number, headsOnShift:number,
 *   workMinutes:number, dayMeta:object, isHoliday:boolean, demand:number,
 *   status:'covered'|'gaps'|'empty'
 * }}
 */
export function analyzeDate(doc, date) {
  const projections = [];
  for (const entry of doc.entries) {
    const p = projectEntryOntoDate(doc, entry, date);
    if (p) projections.push(p);
  }
  projections.sort(sortByStart);

  const work = projections.filter((p) => p.isWork);
  const off = projections.filter((p) => !p.isWork);

  const intervals = coverageIntervals(projections);
  const covered = mergeIntervals(intervals.filter((i) => i.count > 0).map((i) => ({ start: i.start, end: i.end })));
  const gaps = [];
  let cursor = 0;
  for (const iv of covered) {
    if (iv.start > cursor) gaps.push({ start: cursor, end: iv.start });
    cursor = Math.max(cursor, iv.end);
  }
  if (cursor < MIN_PER_DAY) gaps.push({ start: cursor, end: MIN_PER_DAY });

  const coverageMin = covered.reduce((a, i) => a + (i.end - i.start), 0);
  const gapMin = gaps.reduce((a, i) => a + (i.end - i.start), 0);
  const peak = intervals.reduce((m, i) => Math.max(m, i.count), 0);

  const meta = doc.dayMeta?.[date] || null;
  const isHoliday = meta?.dayType === 'holiday' || meta?.dayType === 'event';
  // Los huecos solo se perdonan cuando el día tiene la demanda fijada a 0: eso
  // es lo que significa "este día no hace falta nadie". Un festivo normal sigue
  // mostrando sus huecos de cobertura, porque puede que sí haga falta servicio.
  const noCoverageExpected = meta?.demandOverride === 0;

  const headsOnShift = work.reduce((n, p) => n + (p.continuedFromPrevDay ? 0 : 1), 0);

  let status;
  if (noCoverageExpected) status = 'covered';
  else if (work.length === 0) status = 'empty';
  else status = gaps.length === 0 ? 'covered' : 'gaps';

  return {
    date,
    projections,
    intervals,
    working: work,
    off,
    coverageMin,
    gapMin: noCoverageExpected ? 0 : gapMin,
    gaps: noCoverageExpected ? [] : gaps,
    peak,
    headsOnShift,
    workMinutes: work.reduce((a, p) => a + (p.end - p.start), 0),
    dayMeta: meta,
    isHoliday,
    demand: work.reduce((m, p) => Math.max(m, p.demand || 0), 0),
    status,
  };
}

/** Analiza un rango de fechas (ambas inclusive). */
export function analyzeRange(doc, fromKey, toKey) {
  const keys = [];
  let cursor = fromKey;
  let guard = 0;
  while (cursor <= toKey && guard++ < 4000) {
    keys.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return keys.map((k) => analyzeDate(doc, k));
}

/** Analiza un mes completo. */
export function analyzeMonth(doc, monthKey) {
  return monthDays(monthKey).map((k) => analyzeDate(doc, k));
}

/* ------------------------------------------------------------------ *
 * "Ahora mismo"
 * ------------------------------------------------------------------ */

/**
 * Quién está trabajando en este instante, con progreso y hora de salida.
 * @param {object} doc
 * @param {Date} [when]
 */
export function whoIsNow(doc, when = new Date()) {
  const today = toKey(when);
  const yesterday = addDays(today, -1);
  const nowMin = when.getHours() * 60 + when.getMinutes();
  const out = [];

  const consider = (date, offset) => {
    for (const entry of doc.entries) {
      if (entry.date !== date) continue;
      const p = projectEntryOntoDate(doc, entry, today);
      if (!p || !p.isWork) continue;
      // Las de ayer solo cuentan si de verdad invaden el día de hoy.
      if (offset > 0 && !p.continuedFromPrevDay) continue;
      if (offset > 0 && p.end <= p.start) continue;
      if (nowMin >= p.start && nowMin < p.end) {
        const total = p.end - p.start;
        const elapsed = nowMin - p.start;
        out.push({
          entry,
          member: p.member,
          type: p.type,
          start: p.start,
          end: p.end,
          minutesLeft: p.end - nowMin,
          progress: total > 0 ? elapsed / total : 0,
          continued: offset > 0,
          // Hora real de salida (puede ser mañana)
          realEnd: p.end >= MIN_PER_DAY ? addDays(today, 1) : today,
          realStart: p.continuedFromPrevDay ? yesterday : today,
        });
      }
    }
  };
  consider(yesterday, 1);
  consider(today, 0);

  return out.sort((a, b) => a.end - b.end);
}

/**
 * El próximo turno de un miembro (o de todos si memberId es null).
 * @returns {{entry:object, member:object, startDate:string, startMin:number,
 *            minutesUntil:number, startsAt:Date}|null}
 */
export function nextShift(doc, memberId = null, when = new Date()) {
  const nowMs = when.getTime();
  let best = null;

  for (const entry of doc.entries) {
    if (memberId && entry.memberId !== memberId) continue;
    const blocks = normalizeBlocks(entryBlocks(doc, entry));
    if (!blocks.length) continue;
    if (!entryIsWork(doc, entry)) continue;
    const base = fromKey(entry.date);
    if (!base) continue;
    const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();

    // Un turno cuenta como "próximo" si empieza en el futuro o si ya empezó
    // pero todavía no ha terminado (entonces el próximo es el de mañana).
    for (const b of blocks) {
      const s = dayStart + timeToMin(b.start) * 60000;
      const e = s + blockMinutes(b) * 60000;
      if (e <= nowMs) continue;                  // ya terminó
      if (nowMs >= s && nowMs < e) continue;      // está en curso ahora mismo
      const minutesUntil = Math.round((s - nowMs) / 60000);
      if (!best || minutesUntil < best.minutesUntil) {
        best = {
          entry,
          member: memberById(doc, entry.memberId),
          type: entryType(doc, entry),
          startDate: entry.date,
          startMin: timeToMin(b.start),
          endMin: timeToMin(b.start) + blockMinutes(b),
          minutesUntil,
          startsAt: new Date(s),
          block: b,
        };
      }
    }
  }
  return best;
}

/**
 * Próximos turnos del equipo, ordenados (limitado).
 *
 * `from` admite tanto un `Date` como una clave "YYYY-MM-DD": las vistas suelen
 * tener la fecha en formato clave y forzar la conversión en cada llamada era una
 * fuente continua de errores.
 */
export function upcomingShifts(doc, { from = new Date(), limit = 20, memberId = null, onlyFromNow = true } = {}) {
  const fromDate = coerceDate(from);
  const start = toKey(fromDate);
  const out = [];
  for (const entry of doc.entries) {
    if (memberId && entry.memberId !== memberId) continue;
    if (entry.date < start) {
      if (onlyFromNow) {
        // Puede seguir en curso; se resuelve con nextShift si hace falta
        const blocks = normalizeBlocks(entryBlocks(doc, entry));
        const base = fromKey(entry.date);
        if (!blocks.length || !base) continue;
        const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
        const stillRunning = blocks.some((b) => dayStart + (timeToMin(b.start) + blockMinutes(b)) * 60000 > fromDate.getTime());
        if (!stillRunning) continue;
      }
    }
    const blocks = normalizeBlocks(entryBlocks(doc, entry));
    if (!blocks.length) continue;
    const base = fromKey(entry.date);
    if (!base) continue;
    const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
    blocks.forEach((b, i) => {
      const s = dayStart + timeToMin(b.start) * 60000;
      if (onlyFromNow && s < fromDate.getTime() && s + blockMinutes(b) * 60000 <= fromDate.getTime()) return;
      out.push({
        entry,
        member: memberById(doc, entry.memberId),
        type: entryType(doc, entry),
        date: entry.date,
        blockIndex: i,
        startMs: s,
        endMs: s + blockMinutes(b) * 60000,
        labels: b,
      });
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs).slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * Estadísticas
 * ------------------------------------------------------------------ */

/**
 * Resumen de horas y turnos de un miembro (o del equipo entero) en un rango.
 * @param {object} doc
 * @param {{from:string,to:string,memberId?:string|null}} opts
 */
export function summarize(doc, { from, to, memberId = null }) {
  const byMember = new Map();
  const byType = new Map();
  let totalMinutes = 0;
  let totalNightMinutes = 0;
  let workDays = 0;
  let shifts = 0;
  let overnight = 0;
  let weekendMinutes = 0;
  let holidayMinutes = 0;
  const workedDates = new Set();

  for (const entry of doc.entries) {
    if (entry.date < from || entry.date > to) continue;
    if (memberId && entry.memberId !== memberId) continue;
    const blocks = normalizeBlocks(entryBlocks(doc, entry));
    const type = entryType(doc, entry);
    // Las ausencias (vacaciones, baja, libre) no tienen horario pero SÍ son
    // información del cuadrante: cuentan como turno, no como horas trabajadas.
    if (!blocks.length && !type) continue;

    const minutes = entryIsWork(doc, entry) ? blocks.reduce((a, b) => a + blockMinutes(b), 0) : 0;
    const isOvernight = blocks.some((b) => timeToMin(b.end) <= timeToMin(b.start));
    const night = entryIsWork(doc, entry) ? nightMinutes(blocks) : 0;
    const dt = fromKey(entry.date);
    const weekend = dt ? (dt.getDay() === 0 || dt.getDay() === 6) : false;
    const holiday = doc.dayMeta?.[entry.date]?.dayType === 'holiday';

    shifts++;
    if (isOvernight) overnight++;
    totalMinutes += minutes;
    totalNightMinutes += night;
    if (minutes > 0) {
      workDays++;
      workedDates.add(entry.date);
    }
    if (weekend) weekendMinutes += minutes;
    if (holiday) holidayMinutes += minutes;

    const mKey = entry.memberId;
    const mPrev = byMember.get(mKey) || { memberId: mKey, member: memberById(doc, mKey), minutes: 0, shifts: 0, workDays: 0, overnight: 0, nightMinutes: 0, weekendMinutes: 0, types: new Map() };
    mPrev.minutes += minutes;
    mPrev.shifts++;
    if (minutes > 0) mPrev.workDays++;
    if (isOvernight) mPrev.overnight++;
    mPrev.nightMinutes += night;
    if (weekend) mPrev.weekendMinutes += minutes;
    mPrev.types.set(type?.id || '_', (mPrev.types.get(type?.id || '_') || 0) + 1);
    byMember.set(mKey, mPrev);

    const tKey = type?.id || '_';
    const tPrev = byType.get(tKey) || { typeId: tKey, type, minutes: 0, shifts: 0, members: new Set() };
    tPrev.minutes += minutes;
    tPrev.shifts++;
    tPrev.members.add(entry.memberId);
    byType.set(tKey, tPrev);
  }

  const perMember = [...byMember.values()]
    .map((m) => ({ ...m, types: [...m.types.entries()].map(([id, n]) => ({ id, n })) }))
    .sort((a, b) => b.minutes - a.minutes);
  const perType = [...byType.values()].map((t) => ({ ...t, members: [...t.members] })).sort((a, b) => b.minutes - a.minutes);

  const memberCount = memberId ? 1 : Math.max(1, doc.members.filter((m) => m.active).length);

  return {
    from,
    to,
    memberId,
    totalMinutes,
    totalHours: totalMinutes / 60,
    totalNightMinutes,
    totalNightHours: totalNightMinutes / 60,
    shifts,
    workDays: workedDates.size,
    overnight,
    weekendMinutes,
    holidayMinutes,
    perMember,
    perType,
    averageMinutesPerMember: totalMinutes / memberCount,
    distinctMembers: perMember.length,
  };
}

/** Resumen de un mes para todos o para un miembro. */
export function summarizeMonth(doc, monthKey, memberId = null) {
  const days = monthDays(monthKey);
  return summarize(doc, { from: days[0], to: days[days.length - 1], memberId });
}

/**
 * Desglose semanal (lunes a domingo) de minutos trabajados.
 * @returns {{weekStart:string, week:number, minutes:number, shifts:number, days:number}[]}
 */
export function weeklyBreakdown(doc, { from, to, memberId = null }) {
  const sum = summarize(doc, { from, to, memberId });
  const buckets = new Map();
  for (const entry of doc.entries) {
    if (entry.date < from || entry.date > to) continue;
    if (memberId && entry.memberId !== memberId) continue;
    const blocks = normalizeBlocks(entryBlocks(doc, entry));
    const type = entryType(doc, entry);
    if (!blocks.length && !type) continue;
    const minutes = entryIsWork(doc, entry) ? blocks.reduce((a, b) => a + blockMinutes(b), 0) : 0;
    const start = weekStartOf(entry.date, doc.settings?.weekStartsOn ?? 1);
    const b = buckets.get(start) || { weekStart: start, minutes: 0, shifts: 0, days: new Set() };
    b.minutes += minutes;
    b.shifts++;
    b.days.add(entry.date);
    buckets.set(start, b);
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, days: b.days.size }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map((b) => ({ ...b, week: isoWeekSafe(b.weekStart) }));
}

function weekStartOf(date, weekStartsOn) {
  const dt = fromKey(date);
  if (!dt) return date;
  const shift = (dt.getDay() - weekStartsOn + 7) % 7;
  dt.setDate(dt.getDate() - shift);
  return toKey(dt);
}

function isoWeekSafe(key) {
  try {
    // Import perezoso para no crear dependencia circular en el grafo de módulos
    const [, m, d] = key.split('-').map(Number);
    const dt = new Date(Number(key.slice(0, 4)), m - 1, d);
    const t = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
    const year = t.getFullYear();
    const jan4 = new Date(year, 0, 4);
    jan4.setDate(jan4.getDate() + 3 - ((jan4.getDay() + 6) % 7));
    return 1 + Math.round((t - jan4) / (7 * 86400000));
  } catch {
    return 0;
  }
}

/**
 * Detecta conflictos: la misma persona con dos turnos solapados el mismo día,
 * o un turno que empieza antes de que acabe el anterior.
 * @returns {{date:string, member:object, entries:object[], detail:string}[]}
 */
export function findConflicts(doc, { from, to, memberId = null } = {}) {
  const out = [];
  const byMemberDate = new Map();
  for (const entry of doc.entries) {
    if (from && entry.date < from) continue;
    if (to && entry.date > to) continue;
    if (memberId && entry.memberId !== memberId) continue;
    const k = `${entry.memberId}|${entry.date}`;
    if (!byMemberDate.has(k)) byMemberDate.set(k, []);
    byMemberDate.get(k).push(entry);
  }

  for (const [k, list] of byMemberDate) {
    if (list.length < 2) continue;
    const [memberId2, date] = k.split('|');
    // Ordena por minuto de inicio y comprueba solapamientos reales
    const spans = [];
    for (const entry of list) {
      for (const b of normalizeBlocks(entryBlocks(doc, entry))) {
        const s = timeToMin(b.start);
        spans.push({ start: s, end: s + blockMinutes(b), entry });
      }
    }
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i].start < spans[i - 1].end) {
        out.push({
          date,
          member: memberById(doc, memberId2),
          entries: [spans[i - 1].entry, spans[i].entry],
          detail: `Se solapan a las ${String(Math.floor(spans[i].start / 60)).padStart(2, '0')}:${String(spans[i].start % 60).padStart(2, '0')}`,
        });
        break;
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Días con exceso de gente frente a la demanda (sobrecobertura),
 * útil para detectar dónde se puede reasignar personal.
 */
export function findOverstaffed(doc, from, to, tolerance = 1) {
  const out = [];
  for (const day of analyzeRange(doc, from, to)) {
    const over = day.intervals.filter((i) => i.status === 'over' && (i.count - i.required) >= tolerance);
    if (over.length) {
      out.push({
        date: day.date,
        excessMinutes: over.reduce((a, i) => a + (i.end - i.start), 0),
        intervals: over,
      });
    }
  }
  return out;
}

/** Minutos cubiertos / minutos del rango, en porcentaje. */
export function coverageRate(doc, from, to) {
  const days = analyzeRange(doc, from, to);
  const total = days.length * MIN_PER_DAY;
  const covered = days.reduce((a, d) => a + d.coverageMin, 0);
  return total ? covered / total : 0;
}

/**
 * Minutos de un turno que caen en horario nocturno (22:00–06:00).
 * Se calcula sobre la línea absoluta del turno, así que un turno de 22:00 a
 * 06:00 cuenta entero como nocturno y uno de 16:15 a 00:45 cuenta 2 h 45 min.
 *
 * @param {object[]} blocks
 * @param {number} [nightStart] minuto de inicio de la noche (por defecto 22:00)
 * @param {number} [nightEnd] minuto de fin de la noche (por defecto 06:00)
 */
export function nightMinutes(blocks, nightStart = 22 * 60, nightEnd = 6 * 60) {
  const spans = blockSpans(blocks);
  let total = 0;
  for (const sp of spans) {
    // Cada día natural que atraviesa el turno aporta su ventana nocturna
    const firstDay = Math.floor(sp.start / MIN_PER_DAY);
    const lastDay = Math.floor((sp.end - 1) / MIN_PER_DAY);
    for (let day = firstDay; day <= lastDay; day++) {
      const winStart = day * MIN_PER_DAY + nightStart;
      const winEnd = (day + 1) * MIN_PER_DAY + nightEnd;
      const overlap = Math.min(sp.end, winEnd) - Math.max(sp.start, winStart);
      if (overlap > 0) total += overlap;
    }
  }
  return total;
}

/** Minutos de un turno que caen en sábado o domingo. */
export function weekendMinutesOf(entry, blocks) {
  if (!entry) return 0;
  const base = fromKey(entry.date);
  if (!base) return 0;
  const dow = base.getDay();
  if (dow !== 0 && dow !== 6) return 0;
  return normalizeBlocks(blocks).reduce((a, b) => a + blockMinutes(b), 0);
}

/**
 * Minutos que tiene un día. Se reexporta porque las vistas que pintan líneas de
 * tiempo necesitan la constante y suelen importarla junto al análisis.
 */
export { MIN_PER_DAY };

