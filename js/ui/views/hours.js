/**
 * HORUS — js/ui/views/hours.js
 * Vista «Horas»: resumen de horas del equipo por periodo (mes, trimestre o
 * año), desglose por persona con su objetivo, evolución semanal, reparto por
 * tipo de turno y exportación (CSV y texto para el grupo).
 *
 * Contrato (docs/VIEW-CONTRACT.md): `mount(ctx)` se llama UNA sola vez y cablea
 * los listeners; `render()` no recibe argumentos, lee el estado vivo con
 * `getContext()` y reconstruye solo los nodos hijos.
 */

import { byId, el, clear, plural, copyToClipboard, downloadText, $$ } from '../../core/utils.js';
import { getContext, getFocusDate, registerRenderer } from '../context.js';
import { barRow, emptyState, notify } from '../toolkit.js';
import { summarize, weeklyBreakdown } from '../../core/coverage.js';
import * as exporter from '../../core/exporter.js';
import {
  MONTHS, addDays, dateKey, daysInMonth, formatDuration, formatHours,
  formatShortDate, fromKey, monthKeyOf, todayKey,
} from '../../core/date.js';

/** Nombre de la vista; debe coincidir con context.VIEWS. */
export const VIEW = 'hours';

/** Periodos disponibles en el selector segmentado. */
const RANGES = ['month', 'quarter', 'year'];

/** Nº máximo de barras semanales que se pintan. */
const MAX_WEEK_BARS = 20;

/** Margen de desviación tolerado sobre el objetivo antes de avisar (±5 %). */
const TOLERANCE = 0.05;

/**
 * Periodo elegido por el usuario. Es estado de interfaz de la sesión: no se
 * persiste en el documento ni en los ajustes.
 */
let rangeKind = 'month';

/** Referencias del DOM tomadas en `mount()`. */
let refs = null;

/* ------------------------------------------------------------------ *
 * Utilidades internas
 * ------------------------------------------------------------------ */

/** Escribe texto en un nodo si existe (tolera HTML incompleto). */
function setText(node, text) {
  if (node) node.textContent = text;
}

/** Tarjeta `.stat` reutilizable. */
function statCard({ value, label, sub = '', valueClass = '' }) {
  return el('div', { class: 'stat' }, [
    el('div', { class: `stat-value ${valueClass}`.trim() }, value),
    el('div', { class: 'stat-label' }, label),
    sub ? el('div', { class: 'stat-sub' }, sub) : null,
  ]);
}

/** "1 de junio" / "1 de junio de 2025". */
function fechaLarga(key, { conAnio = false } = {}) {
  const dt = fromKey(key);
  if (!dt) return key;
  const mes = MONTHS[dt.getMonth()].toLowerCase();
  return conAnio ? `${dt.getDate()} de ${mes} de ${dt.getFullYear()}` : `${dt.getDate()} de ${mes}`;
}

/** Nº de días de un rango inclusivo (0 si las claves no son válidas). */
function countDays(from, to) {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000) + 1);
}

/**
 * Rango [from, to] del periodo pedido a partir de la fecha de referencia.
 * @param {'month'|'quarter'|'year'} kind
 * @param {string} refKey "YYYY-MM-DD"
 */
function rangeFor(kind, refKey) {
  const dt = fromKey(refKey) || new Date();
  const year = dt.getFullYear();
  const month = dt.getMonth(); // 0–11

  if (kind === 'year') {
    return { from: dateKey(year, 0, 1), to: dateKey(year, 11, 31) };
  }

  if (kind === 'quarter') {
    const firstMonth = Math.floor(month / 3) * 3;   // 0, 3, 6 o 9
    const lastMonth = firstMonth + 2;
    const lastDay = daysInMonth(`${year}-${String(lastMonth + 1).padStart(2, '0')}`);
    return { from: dateKey(year, firstMonth, 1), to: dateKey(year, lastMonth, lastDay) };
  }

  const lastDay = daysInMonth(monthKeyOf(refKey));
  return { from: dateKey(year, month, 1), to: dateKey(year, month, lastDay) };
}

/** Rango del periodo elegido ahora mismo. */
function currentRange() {
  return rangeFor(RANGES.includes(rangeKind) ? rangeKind : 'month', getFocusDate(todayKey()));
}

/** Jornada semanal de referencia de una persona (contrato o ajustes). */
function weeklyTargetHours(doc, member) {
  const own = Number(member?.weeklyHours);
  if (Number.isFinite(own) && own > 0) return own;
  const fromSettings = Number(doc?.settings?.hours?.weeklyTarget);
  if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings;
  return 40;
}

/**
 * Objetivo de horas del periodo para una persona.
 *
 * Fórmula: `jornada semanal × (días del periodo ÷ 7)`. Es decir, se prorratea
 * el contrato semanal por el nº de semanas que dura el rango elegido.
 */
function targetMinutesFor(doc, member, days) {
  return weeklyTargetHours(doc, member) * (days / 7) * 60;
}

/** Personas que entran en el informe: activas o con horas en el periodo. */
function reportMembers(doc, byMember) {
  return (doc.members || [])
    .filter((member) => member.active !== false || (byMember.get(member.id)?.minutes || 0) > 0)
    .sort((a, b) => {
      const ma = byMember.get(a.id)?.minutes || 0;
      const mb = byMember.get(b.id)?.minutes || 0;
      if (mb !== ma) return mb - ma;
      return String(a.name || '').localeCompare(String(b.name || ''), 'es');
    });
}

/** Fila de la tabla con las cifras de una persona. */
function memberRow(doc, member, stats, targetMinutes) {
  const isMe = doc.meId === member.id;
  // Para destacar la fila de la cuenta actual se usan clases ya definidas
  // (.t-accent y .t-semibold), que se heredan a las celdas de la fila.
  const row = el('tr', { class: isMe ? 't-accent t-semibold' : '' });

  row.appendChild(el('td', {}, member.name || 'Sin nombre'));
  row.appendChild(el('td', { class: 'num' }, String(stats.shifts)));
  row.appendChild(el('td', { class: 'num' }, String(stats.workDays)));
  row.appendChild(el('td', { class: 'num' }, formatHours(stats.minutes)));
  row.appendChild(el('td', { class: 'num' }, formatHours(stats.nightMinutes || 0)));
  row.appendChild(el('td', { class: 'num' }, formatHours(stats.weekendMinutes || 0)));

  const targetCell = el('td', { class: 'num' });
  if (targetMinutes > 0) {
    const ratio = (stats.minutes - targetMinutes) / targetMinutes;
    const outside = Math.abs(ratio) > TOLERANCE;
    if (outside) targetCell.classList.add('t-danger');
    targetCell.textContent = `${outside ? '⚠' : '✔'} ${formatHours(targetMinutes)}`;
    targetCell.title = `${formatHours(stats.minutes)} de ${formatHours(targetMinutes)} `
      + `(${ratio >= 0 ? '+' : ''}${Math.round(ratio * 100)} %)`;
  } else {
    targetCell.classList.add('t-muted');
    targetCell.textContent = '—';
    targetCell.title = 'Sin jornada semanal definida';
  }
  row.appendChild(targetCell);
  return row;
}

/* ------------------------------------------------------------------ *
 * Montaje
 * ------------------------------------------------------------------ */

export function mount(ctx) {
  const view = byId('view-hours');
  refs = {
    view,
    sub: byId('hours-sub'),
    stats: byId('hours-stats'),
    targetNote: byId('hours-target-note'),
    body: byId('hours-body'),
    foot: byId('hours-foot'),
    weeks: byId('hours-weeks'),
    types: byId('hours-types'),
    exportBtn: byId('hours-export'),
    textBtn: byId('hours-text'),
    rangeButtons: view ? $$('[data-hours-range]', view) : [],
  };

  // Selector de periodo: se cablea una sola vez.
  for (const button of refs.rangeButtons) {
    button.addEventListener('click', () => {
      const next = button.dataset.hoursRange;
      if (!RANGES.includes(next) || next === rangeKind) return;
      rangeKind = next;
      render();
    });
  }

  refs.exportBtn?.addEventListener('click', () => exportCsv(ctx));
  refs.textBtn?.addEventListener('click', () => { void copyPlainSummary(ctx); });

  registerRenderer(VIEW, render);
  render();
}

/* ------------------------------------------------------------------ *
 * Pintado
 * ------------------------------------------------------------------ */

function render() {
  if (!refs) return;
  const doc = getContext().doc;
  const { from, to } = currentRange();

  // `aria-pressed` refleja siempre el periodo activo (los botones son estáticos).
  for (const button of refs.rangeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.hoursRange === rangeKind));
  }

  const summary = summarize(doc, { from, to });
  const byMember = new Map((summary.perMember || []).map((p) => [p.memberId, p]));
  const members = reportMembers(doc, byMember);
  const days = countDays(from, to);

  /* ---------- Subtítulo ---------- */
  setText(refs.sub, `Del ${fechaLarga(from)} al ${fechaLarga(to, { conAnio: true })} · ${plural(members.length, 'persona', 'personas')}`);

  /* ---------- Tarjetas ---------- */
  const weekendShifts = (doc.entries || []).filter((entry) => {
    if (entry.date < from || entry.date > to) return false;
    const dt = fromKey(entry.date);
    return dt ? (dt.getDay() === 0 || dt.getDay() === 6) : false;
  }).length;

  const statNodes = [
    statCard({
      value: formatDuration(summary.totalMinutes),
      label: 'Horas del equipo',
      sub: `${plural(summary.shifts, 'turno', 'turnos')} · ${plural(summary.workDays, 'día trabajado', 'días trabajados')}`,
    }),
    statCard({
      value: formatDuration(summary.averageMinutesPerMember),
      label: 'Media por persona',
      sub: `entre ${plural(members.length, 'persona', 'personas')}`,
    }),
    statCard({
      value: formatDuration(summary.totalNightMinutes || 0),
      label: 'Horas nocturnas',
      sub: 'De 22:00 a 06:00',
    }),
    statCard({
      value: formatDuration(summary.weekendMinutes || 0),
      label: 'Horas de fin de semana',
      sub: `${plural(weekendShifts, 'turno en sábado o domingo', 'turnos en sábado o domingo')}`,
    }),
  ];
  if (refs.stats) {
    clear(refs.stats);
    for (const node of statNodes) refs.stats.appendChild(node);
  }

  /* ---------- Nota sobre el objetivo ---------- */
  const conContrato = members.filter((m) => m.weeklyHours != null).length;
  const semanas = days / 7;
  const semanasTexto = (Math.round(semanas * 100) / 100).toString().replace('.', ',');
  setText(refs.targetNote, `Objetivo = jornada semanal × ${semanasTexto} ${semanas === 1 ? 'semana' : 'semanas'} `
    + `(${days} días ÷ 7) · ⚠ si se desvía más del 5 %`
    + (conContrato ? '' : ' · sin jornada en las fichas, se usa la de Ajustes'));

  /* ---------- Tabla por persona ---------- */
  renderTable(doc, members, byMember, days, summary);

  /* ---------- Evolución semanal ---------- */
  renderWeeks(doc, members, from, to);

  /* ---------- Reparto por tipo ---------- */
  renderTypes(summary);
}

/** Cuerpo y pie de la tabla de horas. */
function renderTable(doc, members, byMember, days, summary) {
  if (refs.body) clear(refs.body);
  if (refs.foot) clear(refs.foot);
  if (!refs.body) return;

  if (!members.length) {
    const row = el('tr');
    row.appendChild(el('td', { colspan: '7' }, 'Todavía no hay personas en el equipo.'));
    refs.body.appendChild(row);
    return;
  }

  let totalTarget = 0;
  for (const member of members) {
    const stats = byMember.get(member.id) || {
      minutes: 0, shifts: 0, workDays: 0, nightMinutes: 0, weekendMinutes: 0,
    };
    const target = targetMinutesFor(doc, member, days);
    if (target > 0) totalTarget += target;
    refs.body.appendChild(memberRow(doc, member, stats, target));
  }

  if (refs.foot) {
    const footRow = el('tr');
    footRow.appendChild(el('td', {}, 'TOTAL EQUIPO'));
    footRow.appendChild(el('td', { class: 'num' }, String(summary.shifts)));
    footRow.appendChild(el('td', { class: 'num' }, String(summary.workDays)));
    footRow.appendChild(el('td', { class: 'num' }, formatHours(summary.totalMinutes)));
    footRow.appendChild(el('td', { class: 'num' }, formatHours(summary.totalNightMinutes || 0)));
    footRow.appendChild(el('td', { class: 'num' }, formatHours(summary.weekendMinutes || 0)));

    const totalCell = el('td', { class: 'num' });
    if (totalTarget > 0) {
      const ratio = (summary.totalMinutes - totalTarget) / totalTarget;
      const outside = Math.abs(ratio) > TOLERANCE;
      if (outside) totalCell.classList.add('t-danger');
      totalCell.textContent = `${outside ? '⚠' : '✔'} ${formatHours(totalTarget)}`;
      totalCell.title = `${formatHours(summary.totalMinutes)} de ${formatHours(totalTarget)} `
        + `(${ratio >= 0 ? '+' : ''}${Math.round(ratio * 100)} %)`;
    } else {
      totalCell.classList.add('t-muted');
      totalCell.textContent = '—';
    }
    footRow.appendChild(totalCell);
    refs.foot.appendChild(footRow);
  }
}

/** Barras de evolución semanal del periodo. */
function renderWeeks(doc, members, from, to) {
  if (!refs.weeks) return;
  clear(refs.weeks);

  const weeks = weeklyBreakdown(doc, { from, to });
  if (!weeks.length) {
    refs.weeks.appendChild(emptyState({
      iconName: 'chart',
      title: 'Sin turnos en este periodo',
      message: 'Cuando haya turnos asignados aparecerá aquí su evolución semanal.',
    }));
    return;
  }

  // Objetivo semanal del equipo: suma de las jornadas semanales de cada ficha.
  const teamWeekTarget = members.reduce((sum, member) => sum + weeklyTargetHours(doc, member) * 60, 0);
  const shown = weeks.slice(0, MAX_WEEK_BARS);
  const max = Math.max(1, ...shown.map((week) => week.minutes));

  for (const week of shown) {
    const exceeds = teamWeekTarget > 0 && week.minutes > teamWeekTarget;
    refs.weeks.appendChild(barRow({
      label: `Semana ${week.week}`,
      sub: `${formatShortDate(week.weekStart)} – ${formatShortDate(addDays(week.weekStart, 6))}`,
      value: week.minutes,
      max,
      color: exceeds ? 'var(--danger)' : 'var(--accent)',
      valueText: formatHours(week.minutes),
    }));
  }

  if (weeks.length > shown.length) {
    refs.weeks.appendChild(el('p', { class: 'field-hint' }, `…y ${weeks.length - shown.length} semanas más`));
  }
}

/** Barras de reparto por tipo de turno. */
function renderTypes(summary) {
  if (!refs.types) return;
  clear(refs.types);

  const rows = summary.perType || [];
  if (!rows.length) {
    refs.types.appendChild(el('p', { class: 'field-hint' }, 'Sin turnos en este periodo.'));
    return;
  }

  const max = Math.max(1, ...rows.map((row) => row.minutes));
  for (const row of rows) {
    refs.types.appendChild(barRow({
      label: row.type ? row.type.label : 'Sin tipo asignado',
      sub: `· ${plural(row.shifts, 'turno', 'turnos')}`,
      value: row.minutes,
      max,
      color: row.type?.hex || 'var(--text-muted)',
      valueText: formatHours(row.minutes),
    }));
  }
}

/* ------------------------------------------------------------------ *
 * Exportar y copiar
 * ------------------------------------------------------------------ */

/** Descarga el resumen de horas del periodo en CSV (mismo formato que Exportar). */
function exportCsv(ctx) {
  const { from, to } = currentRange();
  try {
    const csv = exporter.summaryToCSV(ctx.doc, from, to);
    downloadText(`horus-horas-${from}_${to}.csv`, csv, 'text/csv;charset=utf-8');
    notify.success(`Horas exportadas (${from} → ${to})`);
  } catch (err) {
    console.error('[horas] no se pudo generar el CSV:', err);
    notify.error('No se pudo generar el CSV de horas.');
  }
}

/**
 * Resumen en texto plano del periodo, listo para pegar en el grupo.
 * Se construye aquí (no en el exportador) porque solo se usa en esta vista.
 */
function plainSummary(doc, from, to) {
  const summary = summarize(doc, { from, to });
  const byMember = new Map((summary.perMember || []).map((p) => [p.memberId, p]));
  const members = reportMembers(doc, byMember);
  const days = countDays(from, to);

  const lines = [];
  lines.push('HORUS — Horas del equipo');
  lines.push(`Del ${fechaLarga(from)} al ${fechaLarga(to, { conAnio: true })}`);
  lines.push('');
  lines.push(`Equipo: ${plural(summary.shifts, 'turno', 'turnos')} · ${formatDuration(summary.totalMinutes)} · `
    + `${plural(summary.workDays, 'día trabajado', 'días trabajados')}`);
  lines.push(`Nocturnas: ${formatDuration(summary.totalNightMinutes || 0)} · `
    + `Fin de semana: ${formatDuration(summary.weekendMinutes || 0)}`);
  lines.push('');
  lines.push(`Media por persona: ${formatDuration(summary.averageMinutesPerMember)}`);

  for (const member of members) {
    const stats = byMember.get(member.id) || { minutes: 0, shifts: 0, workDays: 0, nightMinutes: 0, weekendMinutes: 0 };
    const target = targetMinutesFor(doc, member, days);
    const extra = [];
    if (stats.nightMinutes) extra.push(`${formatDuration(stats.nightMinutes)} nocturnas`);
    if (stats.weekendMinutes) extra.push(`${formatDuration(stats.weekendMinutes)} en fin de semana`);
    if (target > 0) extra.push(`objetivo ${formatHours(target)}`);
    lines.push(`• ${member.name || 'Sin nombre'}: ${plural(stats.shifts, 'turno', 'turnos')} · `
      + `${formatDuration(stats.minutes)}${extra.length ? ` (${extra.join(', ')})` : ''}`);
  }

  return lines.join('\n');
}

/** Copia el resumen en texto plano al portapapeles. */
async function copyPlainSummary(ctx) {
  const { from, to } = currentRange();
  let text = '';
  try {
    text = plainSummary(ctx.doc, from, to);
  } catch (err) {
    console.error('[horas] no se pudo componer el resumen:', err);
    notify.error('No se pudo componer el resumen de horas.');
    return;
  }
  const ok = await copyToClipboard(text);
  if (ok) notify.success('Resumen de horas copiado al portapapeles');
  else notify.error('No se pudo copiar. Selecciona el texto y cópialo a mano.');
}
