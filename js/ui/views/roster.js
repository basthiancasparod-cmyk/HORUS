/**
 * HORUS — js/ui/views/roster.js
 * Vista CUADRANTE: la rejilla personas × días (el "cuadrante" de toda la vida).
 *
 * Es la vista insignia del producto: una fila por persona y una columna por día
 * del mes en foco, con el total de horas de cada persona a la derecha y una
 * franja de cobertura al pie. Toda la información se lee de un vistazo y
 * cualquier casilla se puede tocar para asignar o cambiar el turno.
 *
 * Decisiones de integración (ver docs/VIEW-CONTRACT.md):
 *  - `mount(ctx)` guarda las referencias del DOM y cablea los listeners UNA sola
 *    vez, con delegación de eventos sobre `#roster-table`, porque el contenido de
 *    `thead`/`tbody`/`tfoot` se reconstruye entero en cada pintado.
 *  - `render()` no recibe argumentos y lee el estado con `getContext()`.
 *  - Nunca se usa `innerHTML` con datos del documento: todo con `el()`.
 *  - Ningún `document` se toca en el nivel superior del módulo: el módulo se
 *    puede importar en Node (pruebas) sin DOM.
 *
 * Atajos de ratón/tacto:
 *  - Casilla de turno        → asignar o cambiar el turno de esa persona ese día.
 *  - Cabecera de columna     → editor del día completo.
 *  - Franja de cobertura     → lo mismo que la cabecera de su columna.
 *  - Cabecera de fila        → editor de esa persona (más útil que reasignar a
 *                              ciegas; para asignar está la propia casilla).
 *  - Arrastrar una píldora   → mueve el turno a otra casilla (`moveEntry`).
 */

import {
  byId, el, clear, icon, readableOn, groupBy, formatHours, formatDuration,
  copyToClipboard, clamp,
} from '../../core/utils.js';
import {
  monthDays, monthKeyOf, todayKey, addDays, addMonths, daysInMonth,
  formatMonth, isoWeek, DOW_SHORT, normalizeBlocks, timeToMin,
} from '../../core/date.js';
import {
  entryBlocks, entryType, entryMinutes, entryIsWork,
} from '../../core/model.js';
import {
  analyzeMonth, summarizeMonth, findConflicts,
} from '../../core/coverage.js';
import * as exporter from '../../core/exporter.js';
import {
  getContext, getFocusDate, setFocusDate, onFocusDateChange, getFilters,
  invalidate, registerRenderer,
} from '../context.js';
import {
  notify, confirmAction, avatar, fillSelect, emptyState,
} from '../toolkit.js';
import * as dialogs from '../dialogs.js';

/** Identificador de la vista; debe coincidir con `context.VIEWS`. */
export const VIEW = 'roster';

/* ==================================================================== *
 * Referencias del DOM (se rellenan en mount)
 * ==================================================================== */

let dom = null;

/** Mes que se está pintando ahora mismo ("YYYY-MM"). */
let shownMonth = null;

/** Estado del arrastre en curso (ratón). */
const dragState = { entryId: null, originCell: null, cell: null };

/* ==================================================================== *
 * Montaje
 * ==================================================================== */

/**
 * Monta la vista: referencias, listeners (una sola vez) y primer pintado.
 * @param {object} ctx contexto de la aplicación
 */
export function mount(ctx) {
  void ctx;

  dom = {
    sub: byId('roster-sub'),
    copy: byId('roster-copy'),
    print: byId('roster-print'),
    prev: byId('roster-prev'),
    next: byId('roster-next'),
    title: byId('roster-title'),
    subtitle: byId('roster-subtitle'),
    table: byId('roster-table'),
    head: byId('roster-head'),
    body: byId('roster-body'),
    foot: byId('roster-foot'),
    legend: byId('roster-legend'),
    rotate: byId('roster-rotate'),
    pattern: byId('roster-pattern'),
    copyweek: byId('roster-copyweek'),
    holiday: byId('roster-holiday'),
    import: byId('roster-import'),
  };

  // Si no hay fecha en foco, el cuadrante arranca en el mes de hoy. Se hace
  // aquí (y no al importar el módulo) para no tocar el estado compartido antes
  // de que la aplicación esté lista.
  if (!getFocusDate()) setFocusDate(todayKey());

  wireStaticControls();
  wireTableInteractions();

  // El calendario y el cuadrante comparten fecha: si el foco cambia de mes,
  // hay que repintar. Dentro del mismo mes no hace falta (no cambia la rejilla).
  onFocusDateChange(() => {
    const month = focusMonth();
    if (month !== shownMonth) invalidate(VIEW);
  });

  registerRenderer(VIEW, render);
  render();
}

function hasDom() {
  return !!(dom && dom.table && dom.head && dom.body && dom.foot);
}

function focusMonth() {
  return monthKeyOf(getFocusDate() ?? todayKey());
}

/* ==================================================================== *
 * Cableado de los controles estáticos
 * ==================================================================== */

function wireStaticControls() {
  if (!dom) return;

  if (dom.prev) dom.prev.onclick = () => shiftMonth(-1);
  if (dom.next) dom.next.onclick = () => shiftMonth(1);

  if (dom.copy) {
    dom.copy.onclick = async () => {
      try {
        const doc = getContext().doc;
        const text = exporter.monthToText(doc, focusMonth(), {});
        const ok = await copyToClipboard(text);
        if (ok) notify.success('Cuadrante del mes copiado. Pégalo donde quieras.');
        else notify.error('No se pudo copiar. Selecciona el texto y cópialo a mano.');
      } catch (err) {
        console.error('[cuadrante] no se pudo generar el texto del mes:', err);
        notify.error('No se pudo preparar el cuadrante para copiar.');
      }
    };
  }

  if (dom.print) {
    dom.print.onclick = () => {
      try { window.print(); } catch (err) { console.error('[cuadrante] la impresión falló:', err); }
    };
  }

  if (dom.rotate) dom.rotate.onclick = () => dialogs.openPatternDialog(getContext(), { mode: 'rotate' });
  if (dom.pattern) dom.pattern.onclick = () => dialogs.openPatternDialog(getContext(), { mode: 'pattern' });
  if (dom.copyweek) dom.copyweek.onclick = () => openCopyWeekDialog();
  if (dom.holiday) dom.holiday.onclick = () => openHolidayDialog();
  if (dom.import) dom.import.onclick = () => getContext().openImport();
}

/** Mueve el mes en foco `delta` meses y repinta. */
function shiftMonth(delta) {
  const month = addMonths(focusMonth(), delta);
  // Se ancla al día 1 para que el mes mostrado sea siempre el pedido.
  setFocusDate(`${month}-01`);
  invalidate(VIEW);
}

/* ==================================================================== *
 * Interacción con la rejilla (delegación: las celdas se recrean)
 * ==================================================================== */

function wireTableInteractions() {
  const table = dom?.table;
  if (!table) return;

  table.addEventListener('click', onTableClick);

  // --- Arrastrar y soltar (solo ratón; en táctil se usa el toque en la casilla) ---
  table.addEventListener('dragstart', onDragStart);
  table.addEventListener('dragover', onDragOver);
  table.addEventListener('dragleave', onDragLeave);
  table.addEventListener('drop', onDrop);
  table.addEventListener('dragend', () => clearDragMarks());
}

function onTableClick(event) {
  if (!hasDom()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;

  // 1) Casilla de turno: asignar ese día a esa persona.
  const cell = target.closest('td.shift-cell[data-date][data-member-id]');
  if (cell && dom.table.contains(cell)) {
    const { date, memberId } = cell.dataset;
    setFocusDate(date);
    dialogs.openAssignDialog(getContext(), { date, memberIds: [memberId] });
    return;
  }

  // 2) Cabecera de columna: editor del día.
  const dayHead = target.closest('th[data-date]');
  if (dayHead && dom.table.contains(dayHead)) {
    const { date } = dayHead.dataset;
    setFocusDate(date);
    dialogs.openDayEditor(getContext(), date);
    return;
  }

  // 3) Franja de cobertura del pie: lo mismo que su cabecera.
  const strip = target.closest('.coverage-strip[data-date]');
  if (strip && dom.table.contains(strip)) {
    const { date } = strip.dataset;
    setFocusDate(date);
    dialogs.openDayEditor(getContext(), date);
    return;
  }

  // 4) Cabecera de fila: editor de la persona.
  const rowHead = target.closest('th.col-name[data-member-id]');
  if (rowHead && dom.table.contains(rowHead)) {
    dialogs.openMemberEditor(getContext(), rowHead.dataset.memberId);
  }
}

function onDragStart(event) {
  const pill = event.target instanceof Element ? event.target.closest('.shift-pill[data-entry-id]') : null;
  if (!pill) return;
  dragState.entryId = pill.dataset.entryId;
  dragState.originCell = pill.closest('td.shift-cell') || null;
  pill.classList.add('is-dragging');
  try {
    event.dataTransfer.effectAllowed = 'move';
    // Algunos navegadores exigen datos para iniciar el arrastre.
    event.dataTransfer.setData('text/plain', dragState.entryId || '');
  } catch { /* sin dataTransfer el arrastre sigue siendo válido */ }
}

function onDragOver(event) {
  const cell = event.target instanceof Element ? event.target.closest('td.shift-cell[data-date]') : null;
  if (!cell) return;
  // Imprescindible para que el navegador permita soltar aquí.
  event.preventDefault();
  if (dragState.cell && dragState.cell !== cell) dragState.cell.classList.remove('is-drop-target');
  dragState.cell = cell;
  cell.classList.add('is-drop-target');
}

function onDragLeave(event) {
  const cell = event.target instanceof Element ? event.target.closest('td.shift-cell') : null;
  if (cell && cell === dragState.cell) {
    cell.classList.remove('is-drop-target');
    dragState.cell = null;
  }
}

function onDrop(event) {
  const cell = event.target instanceof Element ? event.target.closest('td.shift-cell[data-date][data-member-id]') : null;
  if (!cell) return;
  event.preventDefault();
  const entryId = dragState.entryId;
  const origin = dragState.originCell;
  const { date, memberId } = cell.dataset;
  clearDragMarks();

  if (!entryId) return;
  // Soltar en la casilla de origen no hace nada (evita un paso de deshacer inútil).
  if (origin && origin.dataset.date === date && origin.dataset.memberId === memberId) return;

  try {
    const ctx = getContext();
    const ok = ctx.actions?.moveEntry?.(entryId, date, memberId);
    notify.success(ok === false ? 'No se pudo mover el turno' : 'Turno movido', {
      action: ok === false ? null : { label: 'Deshacer', onClick: () => ctx.undo?.() },
    });
  } catch (err) {
    console.error('[cuadrante] el movimiento del turno falló:', err);
    notify.error('No se pudo mover el turno.');
  }
}

/** Quita las marcas visuales del arrastre y limpia su estado. */
function clearDragMarks() {
  if (!hasDom()) return;
  dom.table.querySelectorAll('.is-dragging').forEach((n) => n.classList.remove('is-dragging'));
  dom.table.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'));
  dragState.entryId = null;
  dragState.originCell = null;
  dragState.cell = null;
}

/* ==================================================================== *
 * Pintado
 * ==================================================================== */

/**
 * Repinta la rejilla completa. `thead`, `tbody`, `tfoot` y la leyenda se
 * reconstruyen; los elementos estáticos del HTML se reutilizan.
 */
export function render() {
  if (!hasDom()) return;
  const ctx = getContext();
  const doc = ctx.doc;
  const month = focusMonth();
  shownMonth = month;

  const days = monthDays(month);
  const from = days[0];
  const to = days[days.length - 1];
  const today = todayKey();

  const members = sortMembers(doc);
  const entriesByDate = indexEntriesByDate(doc, days);
  const totals = minutesByMember(doc, days, members);
  const conflicts = conflictIndex(doc, from, to);
  const filters = getFilters();

  paintSubtitle(doc, month);

  paintHead(days, today, members.length);
  paintBody({ doc, days, today, members, entriesByDate, totals, conflicts, filters });
  paintFoot(doc, month, days);
  paintLegend(doc, ctx);
}

/* ------------------------------------------------------------------ *
 * Cabecera: título, subtítulo y controles
 * ------------------------------------------------------------------ */

function paintSubtitle(doc, month) {
  if (dom.title) {
    // Se conserva el <small id="roster-subtitle"> que ya está en el HTML.
    const small = dom.title.querySelector('small');
    clear(dom.title);
    dom.title.appendChild(document.createTextNode(formatMonth(month)));
    if (small) dom.title.appendChild(small);
    else dom.title.appendChild(el('small', { id: 'roster-subtitle' }));
  }

  const subtitle = byId('roster-subtitle');
  if (subtitle) {
    const summary = summarizeMonth(doc, month);
    const people = doc.members.filter((m) => m.active).length;
    subtitle.textContent = `${formatHours(summary.totalMinutes)} de trabajo · ${people} ${people === 1 ? 'persona' : 'personas'}`;
  }

  if (dom.sub) {
    dom.sub.textContent = 'Todas las personas y todos los días, de un vistazo. Toca una casilla para asignar el turno.';
  }
}

/* ------------------------------------------------------------------ *
 * thead — una columna por día + nombre + total
 * ------------------------------------------------------------------ */

function paintHead(days, today, memberCount) {
  clear(dom.head);
  const row = el('tr', {}, [
    el('th', { class: 'col-name', scope: 'col' }, [
      el('span', { class: 't-2xs t-upper t-muted' }, 'Persona'),
      memberCount ? el('span', { class: 't-2xs t-muted' }, ` (${memberCount})`) : null,
    ]),
  ]);

  for (const date of days) {
    const dt = new Date(`${date}T00:00:00`);
    const dow = Number.isNaN(dt.getTime()) ? 1 : dt.getDay();
    const classes = ['day-col'];
    if (dow === 0 || dow === 6) classes.push('is-weekend');
    if (date === today) classes.push('is-today');
    row.appendChild(el('th', {
      class: classes.join(' '),
      scope: 'col',
      'data-date': date,
      title: `Ver y editar el día ${date}`,
    }, [
      el('span', { class: 'th-dow' }, DOW_SHORT[(dow + 6) % 7]),
      el('span', { class: 'th-num' }, String(dt.getDate())),
    ]));
  }

  row.appendChild(el('th', { class: 'col-total', scope: 'col', title: 'Horas del mes' }, 'Total'));
  dom.head.appendChild(row);
}

/* ------------------------------------------------------------------ *
 * tbody — una fila por persona
 * ------------------------------------------------------------------ */

function paintBody({ doc, days, today, members, entriesByDate, totals, conflicts, filters }) {
  clear(dom.body);

  if (!members.length) {
    dom.body.appendChild(el('tr', {}, [
      el('td', { class: 'col-name' }, '—'),
      el('td', { colspan: String(days.length || 1) }, emptyState({
        iconName: 'users',
        title: 'Todavía no hay nadie en el equipo',
        message: 'Añade personas desde la vista Equipo y aparecerán aquí.',
      })),
      el('td', { class: 'col-total' }, '—'),
    ]));
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const member of members) {
    const dimmed = !matchesFilters(member, doc, filters);
    const row = el('tr', {
      class: dimmed ? 'is-dimmed' : '',
      'data-member-id': member.id,
      // El contrato pide atenuar (no ocultar) las filas filtradas para que la
      // rejilla siga alineada. En css/app.css no hay ninguna clase de atenuación
      // reutilizable (`.is-muted` solo existe como `.chip.is-muted`), así que se
      // atenúa con opacidad en línea en lugar de inventar una clase sin estilo.
      style: dimmed ? { opacity: '0.45' } : null,
    });

    row.appendChild(paintRowHead(doc, member, totals.get(member.id) ?? 0));

    for (const date of days) {
      row.appendChild(paintDayCell({
        doc,
        member,
        date,
        today,
        entries: entriesByDate.get(date)?.get(member.id) ?? [],
        conflict: conflicts.get(`${member.id}|${date}`) ?? null,
      }));
    }

    row.appendChild(paintTotalCell(member, totals.get(member.id) ?? 0));
    fragment.appendChild(row);
  }

  dom.body.appendChild(fragment);
}

/** Cabecera de fila: avatar, nombre y horas del mes. */
function paintRowHead(doc, member, minutes) {
  const inactive = member.active === false;
  const line = el('span', { class: 'member-line' }, [
    avatar(member, { size: 'xs' }),
    el('span', { class: 'member-name' }, member.name),
    doc.meId === member.id ? el('span', { class: 't-2xs t-muted' }, ' (yo)') : null,
  ]);

  return el('th', {
    class: `col-name ${inactive ? 'is-inactive' : ''}`.trim(),
    scope: 'row',
    'data-member-id': member.id,
    title: `${member.name} · ${formatDuration(minutes)} este mes. Pulsa para editar la persona.`,
    style: inactive ? { opacity: '0.55' } : null,
  }, [
    line,
    el('span', { class: 'member-hours' }, formatHours(minutes)),
  ]);
}

/** Casilla de un día: la píldora del turno o una casilla vacía que responde. */
function paintDayCell({ doc, member, date, today, entries, conflict }) {
  const dt = new Date(`${date}T00:00:00`);
  const dow = Number.isNaN(dt.getTime()) ? 1 : dt.getDay();
  const meta = doc.dayMeta?.[date];
  const isHoliday = meta?.dayType === 'holiday' || meta?.dayType === 'event';

  const classes = ['shift-cell'];
  if (dow === 0 || dow === 6) classes.push('is-weekend');
  if (isHoliday) classes.push('is-holiday');
  if (date === today) classes.push('is-today');

  const cell = el('td', {
    class: classes.join(' '),
    'data-date': date,
    'data-member-id': member.id,
    title: cellTitle(doc, member, date, entries, meta),
  });

  const pills = entries.filter(isRenderable);
  const visible = pills.slice(0, 2);

  for (const entry of visible) cell.appendChild(paintPill(doc, entry, member));
  if (pills.length > 2) {
    cell.appendChild(el('span', { class: 'badge' }, `+${pills.length - 1}`));
  }

  if (conflict) {
    // Marca discreta de solapamiento. Posicionamiento en línea (permitido por el
    // contrato); el color y el punto los pone `.badge-warning` de components.css.
    cell.appendChild(el('span', {
      class: 'badge-warning',
      style: { position: 'absolute', top: '0', right: '0', padding: '0 2px', fontSize: '7px', lineHeight: '1.2' },
      title: `Conflicto: ${conflict.detail}`,
      'aria-label': `Conflicto: ${conflict.detail}`,
    }, '!'));
  }

  return cell;
}

/** ¿La entrada aporta algo visible al cuadrante? */
function isRenderable(entry) {
  if (!entry) return false;
  if (entry.typeId) return true;
  return Array.isArray(entry.blocks) && entry.blocks.length > 0;
}

/** Píldora coloreada de un turno o de una ausencia. */
function paintPill(doc, entry, member) {
  const type = entryType(doc, entry);
  const blocks = entryBlocks(doc, entry);
  const work = entryIsWork(doc, entry);
  const overnight = work && blocks.some((b) => timeToMin(b.end) <= timeToMin(b.start));

  const hex = type?.hex || '#8A93A8';
  const classes = ['shift-pill'];
  if (!work) classes.push('is-absence');
  if (overnight) classes.push('is-overnight');

  const code = shiftCode(type, blocks, work);
  const timeRange = blocks.length ? blockRange(blocks) : '';

  const pill = el('span', {
    class: classes.join(' '),
    draggable: 'true',
    'data-entry-id': entry.id,
    style: { '--type-color': hex, '--type-fg': readableOn(hex) },
    title: pillTitle(member, type, blocks, work, entry),
  }, [
    el('span', { class: 'pill-code' }, code),
    // Solo se muestra el horario cuando la celda puede con él: con códigos
    // cortos (lo normal) y sin bloques partidos que no cabrían a 34 px.
    work && timeRange && code.length <= 3 && blocks.length === 1
      ? el('span', { class: 'pill-time' }, timeRange)
      : null,
  ]);

  return pill;
}

/** Código del turno, o una etiqueta corta si es un turno suelto sin tipo. */
function shiftCode(type, blocks, work) {
  if (type?.code) return type.code;
  if (!work) return '·';
  const first = normalizeBlocks(blocks)[0];
  if (!first) return '·';
  return humanShort(first.start);
}

/** "8:30" a partir de un "08:30". */
function humanShort(time) {
  return String(time || '').replace(/^0/, '');
}

/** "8:30–17:00" del primero y el último tramo. */
function blockRange(blocks) {
  const list = normalizeBlocks(blocks);
  if (!list.length) return '';
  const first = list[0];
  const last = list[list.length - 1];
  return `${humanShort(first.start)}–${humanShort(last.end)}`;
}

/** Texto emergente de una casilla: persona, día, turnos y marcas del día. */
function cellTitle(doc, member, date, entries, meta) {
  const parts = [`${member.name} · ${date}`];
  if (meta?.dayType === 'holiday') parts.push(meta.label || 'Festivo');
  else if (meta?.dayType === 'event') parts.push(meta.label || 'Evento');
  else if (meta?.label) parts.push(meta.label);

  const visible = entries.filter(isRenderable);
  if (!visible.length) {
    parts.push('Sin turno · toca para asignar');
    return parts.join(' · ');
  }

  for (const entry of visible) {
    const type = entryType(doc, entry);
    const blocks = normalizeBlocks(entryBlocks(doc, entry));
    const where = !entryIsWork(doc, entry) ? 'todo el día'
      : (blocks.length ? blockRange(blocks) : 'sin horario');
    parts.push(`${type?.label || 'Turno suelto'} (${where})`);
    if (entry.notes) parts.push(entry.notes);
  }
  return parts.join(' · ');
}

function pillTitle(member, type, blocks, work, entry) {
  const what = type?.label || (work ? 'Turno suelto' : 'Sin turno');
  const time = blocks.length ? blockRange(blocks) : 'todo el día';
  const notes = entry?.notes ? ` · ${entry.notes}` : '';
  return `${member.name}: ${what} (${time})${notes}`;
}

/** Última columna: horas del mes, en rojo si se pasa del objetivo. */
function paintTotalCell(member, minutes) {
  const target = monthlyTarget(member);
  const over = target != null && target > 0 && minutes > target;
  return el('td', {
    class: `col-total ${over ? 't-danger' : ''}`.trim(),
    title: target == null
      ? `${formatDuration(minutes)} este mes`
      : `${formatDuration(minutes)} de ${formatDuration(Math.round(target))} objetivo`,
  }, formatHours(minutes));
}

/* ------------------------------------------------------------------ *
 * tfoot — franja de cobertura
 * ------------------------------------------------------------------ */

function paintFoot(doc, month, days) {
  clear(dom.foot);

  const analysis = safeAnalyzeMonth(doc, month);
  const byDate = new Map(analysis.map((day) => [day.date, day]));

  const row = el('tr', {}, [
    el('th', { class: 'foot-label', scope: 'row' }, 'Cobertura'),
  ]);

  for (const date of days) {
    const day = byDate.get(date);
    const cell = el('td', { 'data-date': date });
    if (day) {
      const strip = dialogs.renderCoverageStrip(day);
      // `renderCoverageStrip` devuelve un nodo `.coverage-strip` que se puede
      // colocar tal cual dentro de la celda.
      strip.dataset.date = date;
      strip.title = dialogs.coverageSummary(day);
      cell.appendChild(strip);
    }
    row.appendChild(cell);
  }

  row.appendChild(el('td', { class: 'col-total' }, summaryGapLabel(analysis)));
  dom.foot.appendChild(row);
}

/** Texto corto del hueco total del mes para la última celda del pie. */
function summaryGapLabel(analysis) {
  const gap = analysis.reduce((a, d) => a + (d.gapMin || 0), 0);
  if (!gap) return '✓';
  return `-${Math.round(gap / 60)} h`;
}

/* ------------------------------------------------------------------ *
 * Leyenda
 * ------------------------------------------------------------------ */

function paintLegend(doc, ctx) {
  clear(dom.legend);

  for (const type of doc.shiftTypes) {
    const hex = type.hex || '#8A93A8';
    const blocks = normalizeBlocks(type.blocks);
    dom.legend.appendChild(el('button', {
      type: 'button',
      class: 'badge badge-solid',
      style: { '--type-color': hex, '--type-fg': readableOn(hex) },
      title: blocks.length ? `${type.label} · ${blockRange(blocks)}` : type.label,
      onclick: () => dialogs.openTypeEditor(ctx, type.id),
    }, [
      el('span', { class: 'dot', style: { background: hex } }),
      `${type.code} · ${type.label}`,
    ]));
  }

  dom.legend.appendChild(el('span', { class: 't-2xs t-muted' }, '🌙 cruza medianoche'));

  dom.legend.appendChild(el('button', {
    type: 'button',
    class: 'btn btn-ghost btn-sm',
    onclick: () => {
      setFocusDate(todayKey());
      invalidate(VIEW);
    },
  }, [icon('calendar', 14), 'Ir a hoy']));
}

/* ==================================================================== *
 * Datos derivados (puros)
 * ==================================================================== */

/**
 * Orden de las filas: primero la persona actual, luego el resto de activas por
 * nombre, y por último las inactivas (atenuadas).
 */
function sortMembers(doc) {
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es');
  const active = doc.members.filter((m) => m.active !== false).sort(byName);
  const inactive = doc.members.filter((m) => m.active === false).sort(byName);
  const me = active.find((m) => m.id === doc.meId) || inactive.find((m) => m.id === doc.meId);
  if (me) {
    return [
      me,
      ...active.filter((m) => m.id !== me.id),
      ...inactive.filter((m) => m.id !== me.id),
    ];
  }
  return [...active, ...inactive];
}

/** ¿La persona pasa los filtros compartidos? */
function matchesFilters(member, doc, filters) {
  if (!filters?.active) return true;
  if (filters.onlyMine) return member.id === doc.meId;
  if (filters.memberIds?.length) return filters.memberIds.includes(member.id);
  return true;
}

/** Índice `fecha → miembro → entradas`, en una sola pasada por el documento. */
function indexEntriesByDate(doc, days) {
  const inMonth = new Set(days);
  const out = new Map();
  for (const date of days) out.set(date, new Map());

  const relevant = doc.entries.filter((e) => inMonth.has(e.date));
  const byDate = groupBy(relevant, (e) => e.date);
  for (const [date, list] of byDate) {
    out.set(date, groupBy(list, (e) => e.memberId));
  }
  return out;
}

/** Minutos trabajados por persona en el mes. */
function minutesByMember(doc, days, members) {
  const out = new Map();
  for (const member of members) out.set(member.id, 0);
  const inMonth = new Set(days);
  const known = new Set(members.map((m) => m.id));

  for (const entry of doc.entries) {
    if (!inMonth.has(entry.date)) continue;
    if (!known.has(entry.memberId)) continue;
    const minutes = entryMinutes(doc, entry);
    if (!minutes) continue;
    out.set(entry.memberId, (out.get(entry.memberId) || 0) + minutes);
  }
  return out;
}

/** Objetivo mensual de una persona, escalando su jornada semanal. */
function monthlyTarget(member) {
  const weekly = Number(member?.weeklyHours);
  if (!Number.isFinite(weekly) || weekly <= 0) return null;
  const month = shownMonth || focusMonth();
  const dayCount = daysInMonth(month);
  return clamp((weekly * dayCount) / 7, 0, 744);
}

/** Mapa `miembro|fecha → conflicto` para marcar las casillas afectadas. */
function conflictIndex(doc, from, to) {
  const out = new Map();
  let list = [];
  try {
    list = findConflicts(doc, { from, to }) || [];
  } catch (err) {
    console.error('[cuadrante] no se pudieron calcular los conflictos:', err);
  }
  for (const conflict of list) {
    const memberId = conflict.member?.id;
    if (memberId && conflict.date) out.set(`${memberId}|${conflict.date}`, conflict);
  }
  return out;
}

/** `analyzeMonth` a prueba de documentos vacíos o raros. */
function safeAnalyzeMonth(doc, month) {
  try {
    const list = analyzeMonth(doc, month);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.error('[cuadrante] el análisis de cobertura del mes falló:', err);
    return [];
  }
}

/* ==================================================================== *
 * Semanas del mes (para copiar una semana sobre otra)
 * ==================================================================== */

/**
 * Semanas (lunes a domingo) que tocan el mes en foco.
 * @returns {{start:string, end:string, label:string, inMonth:boolean}[]}
 */
function weeksOfMonth(days) {
  const weeks = [];
  let cursor = null;
  let index = -1;

  for (const date of days) {
    const dt = new Date(`${date}T00:00:00`);
    const dow = Number.isNaN(dt.getTime()) ? 1 : dt.getDay();
    if (dow === 1 || cursor === null) {
      index++;
      cursor = addDays(date, -((dow + 6) % 7));
      const start = cursor;
      const end = addDays(start, 6);
      const iso = isoWeek(start).week;
      weeks[index] = {
        start,
        end,
        label: `Semana ${iso} (${shortDay(start)}–${shortDay(end)})`,
        inMonth: days.includes(start) || days.includes(end),
      };
    }
  }
  // Las semanas que empiezan antes del día 1 no entran: copiar "media semana"
  // fuera del mes mostrado sería confuso.
  return weeks.filter((w) => w && w.inMonth);
}

/** "2 jun" a partir de "2025-06-02". */
function shortDay(key) {
  const dt = new Date(`${key}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return key;
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${dt.getDate()} ${months[dt.getMonth()]}`;
}

/* ==================================================================== *
 * Diálogos propios de la vista
 * ==================================================================== */

/** Copiar una semana del mes sobre otra (`actions.copyRange`). */
async function openCopyWeekDialog() {
  const months = focusMonth();
  const days = monthDays(months);
  const weeks = weeksOfMonth(days);

  if (weeks.length < 2) {
    notify.info('Este mes no tiene dos semanas completas que copiar.');
    return;
  }

  const options = weeks.map((w, i) => ({ value: String(i), label: w.label }));
  const fromSelect = el('select', { class: 'select', id: 'roster-copyweek-from' });
  const toSelect = el('select', { class: 'select', id: 'roster-copyweek-to' });
  fillSelect(fromSelect, options, { selected: String(0) });
  fillSelect(toSelect, options, { selected: String(1) });

  const extra = el('div', { class: 'stack-sm' }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'field-label', for: 'roster-copyweek-from' }, 'Copiar la semana'),
      fromSelect,
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'field-label', for: 'roster-copyweek-to' }, 'Sobre la semana'),
      toSelect,
    ]),
    el('p', { class: 'field-hint' }, 'Los turnos de la semana de destino se reemplazan. Podrás deshacerlo.'),
  ]);

  const ok = await confirmAction({
    title: 'Copiar una semana sobre otra',
    message: 'Se copiarán todos los turnos de la semana de origen, personas incluidas.',
    confirmLabel: 'Copiar',
    danger: false,
    extra,
  });
  if (!ok) return;

  const source = weeks[Number(fromSelect.value)];
  const target = weeks[Number(toSelect.value)];
  if (!source || !target) return;

  const ctx = getContext();
  let count = 0;
  try {
    ctx.batch?.('copiar semana', () => {
      count = ctx.actions.copyRange({ from: source.start, to: source.end, targetFrom: target.start }) || 0;
    });
  } catch (err) {
    console.error('[cuadrante] la copia de semana falló:', err);
    notify.error('No se pudo copiar la semana.');
    return;
  }

  if (!count) {
    notify.warning('La semana de origen no tenía turnos que copiar.');
    return;
  }
  notify.success(`${count} turno(s) copiados sobre la ${target.label.toLowerCase()}`, {
    action: { label: 'Deshacer', onClick: () => ctx.undo?.() },
  });
}

/** Marcar un rango de fechas como festivo (`actions.setDayMetaRange`). */
async function openHolidayDialog() {
  const days = monthDays(focusMonth());
  const focused = getFocusDate();
  const start = focused && focused.slice(0, 7) === focusMonth() ? focused : days[0];

  const fromInput = el('input', { class: 'input', type: 'date', id: 'roster-holiday-from', value: start });
  const toInput = el('input', { class: 'input', type: 'date', id: 'roster-holiday-to', value: start });

  const extra = el('div', { class: 'stack-sm' }, [
    el('div', { class: 'row', style: { gap: 'var(--sp-3)' } }, [
      el('div', { class: 'field grow' }, [
        el('label', { class: 'field-label', for: 'roster-holiday-from' }, 'Desde'),
        fromInput,
      ]),
      el('div', { class: 'field grow' }, [
        el('label', { class: 'field-label', for: 'roster-holiday-to' }, 'Hasta'),
        toInput,
      ]),
    ]),
    el('p', { class: 'field-hint' }, 'Los festivos se marcan en ámbar en el cuadrante y no cuentan como hueco si su demanda es 0.'),
  ]);

  const ok = await confirmAction({
    title: 'Marcar festivos',
    message: 'Se marcarán los días elegidos como festivo.',
    confirmLabel: 'Marcar',
    danger: false,
    extra,
  });
  if (!ok) return;

  const from = fromInput.value;
  const to = toInput.value;
  if (!from || !to) {
    notify.error('Indica las dos fechas del rango.');
    return;
  }
  if (to < from) {
    notify.error('La fecha final es anterior a la inicial.');
    return;
  }

  const ctx = getContext();
  let count = 0;
  try {
    count = ctx.actions.setDayMetaRange({ from, to, dayType: 'holiday', label: 'Festivo' }) || 0;
  } catch (err) {
    console.error('[cuadrante] no se pudieron marcar los festivos:', err);
    notify.error('No se pudieron marcar los festivos.');
    return;
  }

  if (!count) {
    notify.info('Esos días ya estaban marcados como festivo.');
    return;
  }
  notify.success(`${count} día(s) marcados como festivo`, {
    action: { label: 'Deshacer', onClick: () => ctx.undo?.() },
  });
}

/* Reexportaciones de apoyo para quien consuma esta vista desde pruebas. */
export { weeksOfMonth, monthlyTarget, sortMembers };
