/**
 * HORUS — js/core/exporter.js
 * Exportación e importación de datos.
 *
 * Formatos soportados:
 *   - JSON  : copia de seguridad completa del documento (ida y vuelta exacta).
 *   - CSV   : una fila por turno, para abrir en Excel/Sheets. También permite
 *             importar un cuadrante pegado desde una hoja de cálculo.
 *   - iCal  : para suscribirse desde Google Calendar, Outlook o Apple
 *             Calendar. Los turnos nocturnos se exportan con la hora de fin
 *             correcta (al día siguiente).
 *   - Texto : cuadrante legible para pegar en WhatsApp o imprimir.
 *
 * Todo es puro respecto al DOM salvo `downloadText`, que ya vive en utils.
 */

import {
  monthDays, formatMonth, formatLongDate, formatDuration,
  addDays, timeToMin, blockMinutes, fromKey, toKey, DOW_FULL, stamp,
} from './date.js';
import {
  normalizeDocument, migrateFromLegacy, entryBlocks, entryType,
  memberById, entryMinutes, entryIsWork, entryLabel,
} from './model.js';
import { summarize, analyzeMonth, findConflicts } from './coverage.js';
import { toCSV, csvToObjects, downloadText } from './utils.js';
import { APP } from '../config.js';

/* ------------------------------------------------------------------ *
 * JSON — copia de seguridad
 * ------------------------------------------------------------------ */

/**
 * Envuelve el documento con metadatos para que la copia sea autoexplicativa.
 */
export function documentToBackup(doc) {
  return {
    format: 'horus.backup',
    version: APP.version,
    schema: doc.schema,
    exportedAt: new Date().toISOString(),
    app: APP.name,
    counts: {
      members: doc.members.length,
      shiftTypes: doc.shiftTypes.length,
      entries: doc.entries.length,
      patterns: doc.patterns.length,
      dayMeta: Object.keys(doc.dayMeta || {}).length,
    },
    document: doc,
  };
}

export function backupToJson(doc, { pretty = true } = {}) {
  return JSON.stringify(documentToBackup(doc), null, pretty ? 2 : 0);
}

/**
 * Acepta indistintamente una copia con envoltorio, un documento suelto o un
 * blob de la versión antigua. Devuelve { doc, kind, warnings }.
 */
export function parseBackup(text) {
  let raw;
  try {
    raw = JSON.parse(String(text || ''));
  } catch (err) {
    return { doc: null, kind: 'invalid', error: `El archivo no es JSON válido: ${err.message}` };
  }
  if (!raw || typeof raw !== 'object') {
    return { doc: null, kind: 'invalid', error: 'El archivo está vacío o no contiene un objeto.' };
  }

  const warnings = [];

  // Copia nueva con envoltorio
  if (raw.format === 'horus.backup' && raw.document) {
    const doc = normalizeDocument(raw.document);
    if (Number(raw.schema) > doc.schema) {
      warnings.push(`La copia es de una versión más nueva (esquema ${raw.schema}). Puede que falten datos.`);
    }
    return { doc, kind: 'backup', warnings, exportedAt: raw.exportedAt || null };
  }

  // Documento nuevo suelto
  if (raw.schema >= 4 && Array.isArray(raw.entries) && Array.isArray(raw.members)) {
    return { doc: normalizeDocument(raw), kind: 'document', warnings };
  }

  // Blob de la versión antigua (state con days/shiftTypes/profiles)
  if (raw.days || raw.profiles || (raw.shiftTypes && !Array.isArray(raw.shiftTypes))) {
    const doc = migrateFromLegacy(raw);
    warnings.push('Se ha detectado un archivo de la versión antigua de HORUS y se ha convertido.');
    if (doc.migration?.warnings) warnings.push(...doc.migration.warnings);
    return { doc, kind: 'legacy', warnings };
  }

  return { doc: null, kind: 'invalid', error: 'No se reconoce el formato del archivo.' };
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

const CSV_HEADERS = [
  'Fecha', 'Día', 'Persona', 'Turno', 'Código', 'Inicio', 'Fin',
  'Horas', 'Tipo de día', 'Aprobado', 'Notas',
];

const DAY_TYPE_LABEL = { normal: 'Normal', holiday: 'Festivo', event: 'Evento', swap: 'Cambio' };

/**
 * Exporta un rango de fechas a CSV.
 * @param {object} doc
 * @param {{from:string,to:string,memberIds?:string[]}} opts
 */
export function rangeToCSV(doc, { from, to, memberIds = null }) {
  const rows = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard++ < 4000) {
    const date = cursor;
    const dt = fromKey(date);
    const dayLabel = dt ? DOW_FULL[(dt.getDay() + 6) % 7] : '';
    const entries = doc.entries
      .filter((e) => e.date === date && (!memberIds || memberIds.includes(e.memberId)))
      .sort((a, b) => {
        const sa = timeToMin(entryBlocks(doc, a)[0]?.start || '99:99');
        const sb = timeToMin(entryBlocks(doc, b)[0]?.start || '99:99');
        return sa - sb;
      });
    for (const entry of entries) {
      const type = entryType(doc, entry);
      const blocks = entryBlocks(doc, entry);
      const member = memberById(doc, entry.memberId);
      const minutes = entryMinutes(doc, entry);
      const dayType = doc.dayMeta?.[date]?.dayType || entry.dayType || 'normal';
      rows.push([
        date,
        dayLabel,
        member?.name || '',
        type?.label || (blocks.length ? 'Turno suelto' : '—'),
        type?.code || '',
        blocks.map((b) => b.start).join(' + '),
        blocks.map((b) => b.end).join(' + '),
        minutes ? (minutes / 60).toFixed(2).replace('.', ',') : '0',
        DAY_TYPE_LABEL[dayType] || dayType,
        entry.approved === false ? 'No' : 'Sí',
        (entry.notes || '').replace(/\r?\n/g, ' '),
      ]);
    }
    cursor = addDays(cursor, 1);
  }
  return toCSV(CSV_HEADERS, rows);
}

/** Exporta un mes completo a CSV. */
export function monthToCSV(doc, monthKey, opts = {}) {
  const days = monthDays(monthKey);
  return rangeToCSV(doc, { from: days[0], to: days[days.length - 1], ...opts });
}

/**
 * Exporta un resumen de horas por persona (para nóminas o control horario).
 */
export function summaryToCSV(doc, from, to) {
  const summary = summarize(doc, { from, to });
  const headers = ['Persona', 'Turnos', 'Días trabajados', 'Horas totales', 'Horas nocturnas', 'Turnos de noche', 'Fin de semana (h)'];
  const num = (minutes) => (minutes / 60).toFixed(2).replace('.', ',');
  const rows = summary.perMember.map((m) => [
    m.member?.name || '(desconocido)',
    m.shifts,
    m.workDays,
    num(m.minutes),
    num(m.nightMinutes || 0),
    m.overnight,
    num(m.weekendMinutes),
  ]);
  rows.push([]);
  rows.push([
    'TOTAL EQUIPO',
    summary.shifts,
    summary.workDays,
    num(summary.totalMinutes),
    num(summary.totalNightMinutes || 0),
    summary.overnight,
    num(summary.weekendMinutes),
  ]);
  return toCSV(headers, rows);
}

/**
 * Interpreta un CSV de turnos. Es deliberadamente flexible con los nombres de
 * columna (acepta "nombre", "persona", "empleado"…).
 *
 * @returns {{rows:object[], errors:string[], headers:string[]}}
 */
export function parseScheduleCSV(text) {
  const { headers, objects } = csvToObjects(text);
  const errors = [];
  const rows = [];
  if (!objects.length) {
    return { rows, errors: ['El archivo no tiene filas de datos.'], headers };
  }

  const pick = (obj, ...candidates) => {
    for (const c of candidates) {
      if (obj[c] !== undefined && obj[c] !== '') return obj[c];
    }
    return '';
  };

  objects.forEach((obj, i) => {
    const line = i + 2; // +2: cabecera + índice base 1
    const dateRaw = pick(obj, 'fecha', 'date', 'dia', 'día');
    const person = pick(obj, 'persona', 'nombre', 'empleado', 'member', 'trabajador');
    const code = pick(obj, 'codigo', 'código', 'code', 'turno', 'shift');
    const notes = pick(obj, 'notas', 'notes', 'observaciones');

    const date = normalizeDateInput(dateRaw);
    if (!date) {
      errors.push(`Fila ${line}: la fecha "${dateRaw}" no se entiende (usa AAAA-MM-DD o DD/MM/AAAA).`);
      return;
    }
    if (!person) {
      errors.push(`Fila ${line}: falta el nombre de la persona.`);
      return;
    }
    rows.push({ date, person: String(person).trim(), code: String(code || '').trim(), notes: String(notes || '').trim(), line });
  });

  return { rows, errors, headers };
}

/** Acepta 2025-06-04, 04/06/2025, 4-6-2025 y 04.06.2025. */
export function normalizeDateInput(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const [, y, mo, d] = m;
    const key = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return fromKey(key) ? key : null;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    const key = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return fromKey(key) ? key : null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * iCal
 * ------------------------------------------------------------------ */

/** Escapa texto según RFC 5545. */
function icalEscape(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** "YYYY-MM-DDTHH:MM:SS" en hora local (formato flotante de iCal: sin Z). */
function icalLocal(dateKey, time) {
  return `${dateKey.replace(/-/g, '')}T${String(time || '00:00').replace(':', '')}00`;
}

function icalDateTimeStamp(date = new Date()) {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/** Pliega líneas largas a 75 octetos, como exige el RFC. */
function foldLine(line) {
  if (line.length <= 73) return line;
  const out = [];
  let rest = line;
  out.push(rest.slice(0, 73));
  rest = rest.slice(73);
  while (rest.length) {
    out.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  return out.join('\r\n');
}

/**
 * Genera un calendario iCal para un rango.
 *
 * @param {object} doc
 * @param {{from:string,to:string,memberIds?:string[],alarms?:boolean,alarmMinutes?:number,calendarName?:string}} opts
 * @returns {string}
 */
export function rangeToICal(doc, opts = {}) {
  const {
    from, to, memberIds = null, alarms = true,
    alarmMinutes = 30, calendarName = null,
  } = opts;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HORUS//Cuadrante de turnos//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icalEscape(calendarName || doc.name || 'HORUS')}`,
    'X-WR-TIMEZONE:Europe/Madrid',
  ];

  let cursor = from;
  let guard = 0;
  let count = 0;

  while (cursor <= to && guard++ < 4000) {
    const date = cursor;
    const entries = doc.entries
      .filter((e) => e.date === date && (!memberIds || memberIds.includes(e.memberId)))
      .filter((e) => entryIsWork(doc, e) || entryType(doc, e));
    const dayMeta = doc.dayMeta?.[date];

    if (dayMeta?.dayType === 'holiday' || dayMeta?.dayType === 'event') {
      lines.push(
        'BEGIN:VEVENT',
        `UID:horus-daymeta-${date}@horus`,
        `DTSTAMP:${icalDateTimeStamp()}`,
        `DTSTART;VALUE=DATE:${date.replace(/-/g, '')}`,
        `DTEND;VALUE=DATE:${addDays(date, 1).replace(/-/g, '')}`,
        `SUMMARY:${icalEscape(dayMeta.label || (dayMeta.dayType === 'holiday' ? 'Festivo' : 'Evento'))}`,
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
      count++;
    }

    for (const entry of entries) {
      const blocks = entryBlocks(doc, entry);
      const type = entryType(doc, entry);
      const member = memberById(doc, entry.memberId);
      const title = `${type?.label || 'Turno'} · ${member?.name || ''}`.trim();

      if (!blocks.length) {
        // Ausencia de día completo
        lines.push(
          'BEGIN:VEVENT',
          `UID:horus-${entry.id}@horus`,
          `DTSTAMP:${icalDateTimeStamp()}`,
          `DTSTART;VALUE=DATE:${date.replace(/-/g, '')}`,
          `DTEND;VALUE=DATE:${addDays(date, 1).replace(/-/g, '')}`,
          `SUMMARY:${icalEscape(title)}`,
          entry.notes ? `DESCRIPTION:${icalEscape(entry.notes)}` : 'DESCRIPTION:Toda la jornada',
          'TRANSP:TRANSPARENT',
          'END:VEVENT',
        );
        count++;
        continue;
      }

      blocks.forEach((block, index) => {
        const minutes = blockMinutes(block);
        // El fin se cuenta desde la fecha de inicio: si cruza medianoche, cae
        // en el día siguiente, que es lo que espera cualquier calendario.
        const startMin = timeToMin(block.start);
        const endTotal = startMin + minutes;
        const endDate = toKey(new Date(
          fromKey(date).getFullYear(),
          fromKey(date).getMonth(),
          fromKey(date).getDate() + Math.floor(endTotal / 1440),
        ));
        const endTime = `${String(Math.floor((endTotal % 1440) / 60)).padStart(2, '0')}:${String(endTotal % 60).padStart(2, '0')}`;

        lines.push(
          'BEGIN:VEVENT',
          `UID:horus-${entry.id}-${index}@horus`,
          `DTSTAMP:${icalDateTimeStamp()}`,
          `DTSTART:${icalLocal(date, block.start)}`,
          `DTEND:${icalLocal(endDate, endTime)}`,
          `SUMMARY:${icalEscape(title)}`,
          `DESCRIPTION:${icalEscape([
            member?.name ? `Persona: ${member.name}` : '',
            `Turno: ${type?.label || 'suelto'}${type?.code ? ` (${type.code})` : ''}`,
            `Horario: ${block.start}–${block.end}${minutes > timeToMin(block.end) - timeToMin(block.start) + 1 ? ' (cruza medianoche)' : ''}`,
            `Duración: ${formatDuration(minutes)}`,
            entry.notes ? `Notas: ${entry.notes}` : '',
          ].filter(Boolean).join('\n'))}`,
          `CATEGORIES:${icalEscape(type?.label || 'Turno')}`,
          `X-HORUS-MEMBER:${icalEscape(member?.name || '')}`,
          'TRANSP:OPAQUE',
        );
        if (alarms && alarmMinutes > 0) {
          lines.push(
            'BEGIN:VALARM',
            `TRIGGER:-PT${Math.round(alarmMinutes)}M`,
            'ACTION:DISPLAY',
            `DESCRIPTION:${icalEscape(`Turno en ${alarmMinutes} min`)}`,
            'END:VALARM',
          );
        }
        lines.push('END:VEVENT');
        count++;
      });
    }

    cursor = addDays(cursor, 1);
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Exporta un mes a iCal. */
export function monthToICal(doc, monthKey, opts = {}) {
  const days = monthDays(monthKey);
  return rangeToICal(doc, { from: days[0], to: days[days.length - 1], ...opts });
}

/* ------------------------------------------------------------------ *
 * Texto plano — para pegar en WhatsApp o imprimir
 * ------------------------------------------------------------------ */

/**
 * Cuadrante en texto: una línea por día con quién trabaja y en qué horario.
 * Es el formato que la gente acaba pegando en el grupo del trabajo.
 */
export function monthToText(doc, monthKey, { memberIds = null, compact = false } = {}) {
  const members = memberIds
    ? doc.members.filter((m) => memberIds.includes(m.id))
    : doc.members.filter((m) => m.active);
  const out = [];
  out.push(`📅 ${formatMonth(monthKey)} — ${doc.name}`);
  out.push('');

  for (const date of monthDays(monthKey)) {
    const entries = doc.entries
      .filter((e) => e.date === date && members.some((m) => m.id === e.memberId))
      .sort((a, b) => timeToMin(entryBlocks(doc, a)[0]?.start || '99:99') - timeToMin(entryBlocks(doc, b)[0]?.start || '99:99'));
    const meta = doc.dayMeta?.[date];
    if (!entries.length && !meta) {
      if (!compact) out.push(`${date}  ·  —`);
      continue;
    }
    const dayLabel = formatLongDate(date).replace(/^\w/, (c) => c.toUpperCase());
    const flags = [];
    if (meta?.dayType === 'holiday') flags.push('🎉 Festivo');
    if (meta?.dayType === 'event') flags.push('📌 Evento');
    if (meta?.label && meta.dayType === 'normal') flags.push(meta.label);
    out.push(`${dayLabel}${flags.length ? `  [${flags.join(' · ')}]` : ''}`);

    for (const entry of entries) {
      const member = memberById(doc, entry.memberId);
      const blocks = entryBlocks(doc, entry);
      const minutes = entryMinutes(doc, entry);
      const hours = minutes ? `(${formatDuration(minutes)})` : '';
      const time = blocks.length ? blocks.map((b) => `${b.start}-${b.end}`).join(' + ') : 'todo el día';
      const notes = entry.notes ? `  📝 ${entry.notes}` : '';
      out.push(`   ${member?.initials || '??'}  ${member?.name || '?'} → ${entryLabel(doc, entry)} ${time} ${hours}${notes}`);
    }
  }

  const summary = summarize(doc, {
    from: monthDays(monthKey)[0],
    to: monthDays(monthKey)[monthDays(monthKey).length - 1],
    memberId: null,
  });
  out.push('');
  out.push('── Total del mes ──');
  for (const m of summary.perMember) {
    out.push(`   ${m.member?.initials || '??'}  ${m.member?.name || '?'}: ${formatDuration(m.minutes)} en ${m.shifts} turno(s)`);
  }
  out.push(`   Equipo: ${formatDuration(summary.totalMinutes)}`);
  return out.join('\n');
}

/**
 * Cuadrante en texto para un rango arbitrario. Es el mismo formato que
 * `monthToText` pero sin estar atado a un mes natural.
 */
export function rangeToText(doc, { from, to, memberIds = null } = {}) {
  const members = memberIds
    ? doc.members.filter((m) => memberIds.includes(m.id))
    : doc.members.filter((m) => m.active);
  const out = [`📅 ${formatShortDate(from)} → ${formatShortDate(to)} — ${doc.name}`, ''];

  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard++ < 1200) {
    const date = cursor;
    const entries = doc.entries
      .filter((e) => e.date === date && members.some((m) => m.id === e.memberId))
      .sort((a, b) => timeToMin(entryBlocks(doc, a)[0]?.start || '99:99') - timeToMin(entryBlocks(doc, b)[0]?.start || '99:99'));
    const meta = doc.dayMeta?.[date];

    if (entries.length || meta) {
      const dayLabel = formatLongDate(date);
      const flags = [];
      if (meta?.dayType === 'holiday') flags.push('🎉 Festivo');
      if (meta?.dayType === 'event') flags.push('📌 Evento');
      if (meta?.label && meta.dayType === 'normal') flags.push(meta.label);
      out.push(`${dayLabel}${flags.length ? `  [${flags.join(' · ')}]` : ''}`);

      for (const entry of entries) {
        const member = memberById(doc, entry.memberId);
        const blocks = entryBlocks(doc, entry);
        const minutes = entryMinutes(doc, entry);
        const hours = minutes ? `(${formatDuration(minutes)})` : '';
        const time = blocks.length ? blocks.map((b) => `${b.start}-${b.end}`).join(' + ') : 'todo el día';
        const notes = entry.notes ? `  📝 ${entry.notes}` : '';
        out.push(`   ${member?.initials || '??'}  ${member?.name || '?'} → ${entryLabel(doc, entry)} ${time} ${hours}${notes}`);
      }
    }
    cursor = addDays(cursor, 1);
  }

  const summary = summarize(doc, { from, to });
  out.push('', '── Totales del periodo ──');
  for (const m of summary.perMember) {
    out.push(`   ${m.member?.initials || '??'}  ${m.member?.name || '?'}: ${formatDuration(m.minutes)} en ${m.shifts} turno(s)`);
  }
  out.push(`   Equipo: ${formatDuration(summary.totalMinutes)}`);
  return out.join('\n');
}

/** Un solo día, en texto. */
export function dayToText(doc, date) {
  const entries = doc.entries.filter((e) => e.date === date);
  const meta = doc.dayMeta?.[date];
  const out = [formatLongDate(date)];
  if (meta?.label) out.push(meta.label);
  if (!entries.length) {
    out.push('Sin turnos.');
    return out.join('\n');
  }
  for (const entry of entries) {
    const member = memberById(doc, entry.memberId);
    const blocks = entryBlocks(doc, entry);
    const time = blocks.length ? blocks.map((b) => `${b.start}-${b.end}`).join(' + ') : 'todo el día';
    out.push(`· ${member?.name || '?'}: ${entryLabel(doc, entry)} ${time}`);
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * Resumen de cobertura (lo que un jefe quiere ver)
 * ------------------------------------------------------------------ */

export function monthCoverageToText(doc, monthKey) {
  const analyses = analyzeMonth(doc, monthKey);
  const out = [`Cobertura de ${formatMonth(monthKey)}`, ''];
  let daysWithGaps = 0;
  let totalGap = 0;
  let totalCovered = 0;

  for (const day of analyses) {
    totalCovered += day.coverageMin;
    if (day.gapMin > 0) {
      daysWithGaps++;
      totalGap += day.gapMin;
      const gaps = day.gaps
        .map((g) => `${minLabel(g.start)}–${minLabel(g.end)}`)
        .join(', ');
      out.push(`${day.date}: ${formatDuration(day.gapMin)} sin cubrir (${gaps})`);
    }
  }

  out.push('');
  out.push(`Días con huecos: ${daysWithGaps} de ${analyses.length}`);
  out.push(`Tiempo sin cubrir: ${formatDuration(totalGap)}`);
  out.push(`Cobertura total: ${(totalCovered / 1440 / analyses.length * 100).toFixed(1)}%`);

  const conflicts = findConflicts(doc, { from: monthDays(monthKey)[0], to: monthDays(monthKey)[monthDays(monthKey).length - 1] });
  if (conflicts.length) {
    out.push('');
    out.push(`⚠ ${conflicts.length} solapamiento(s):`);
    for (const c of conflicts.slice(0, 20)) {
      out.push(`  ${c.date} · ${c.member?.name || '?'} — ${c.detail}`);
    }
  }
  return out.join('\n');
}

function minLabel(min) {
  const m = Math.round(min) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Descargas directas
 * ------------------------------------------------------------------ */

const safeName = (text) => String(text || 'horus').replace(/[^\w.-]+/g, '_').slice(0, 60);

export function downloadBackup(doc) {
  const name = `${APP.exportPrefix}-copia-${safeName(doc.name)}-${stamp()}.json`;
  downloadText(name, backupToJson(doc), 'application/json;charset=utf-8');
  return name;
}

export function downloadMonthCSV(doc, monthKey, opts = {}) {
  const name = `${APP.exportPrefix}-${monthKey}.csv`;
  downloadText(name, monthToCSV(doc, monthKey, opts), 'text/csv;charset=utf-8');
  return name;
}

export function downloadSummaryCSV(doc, from, to) {
  const name = `${APP.exportPrefix}-horas-${from}_${to}.csv`;
  downloadText(name, summaryToCSV(doc, from, to), 'text/csv;charset=utf-8');
  return name;
}

export function downloadICal(doc, from, to, opts = {}) {
  const name = `${APP.exportPrefix}-${from}_${to}.ics`;
  downloadText(name, rangeToICal(doc, { from, to, ...opts }), 'text/calendar;charset=utf-8');
  return name;
}

export function downloadText_(filename, text) {
  downloadText(filename, text, 'text/plain;charset=utf-8');
  return filename;
}
