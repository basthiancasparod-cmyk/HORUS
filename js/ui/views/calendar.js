/**
 * HORUS — js/ui/views/calendar.js
 * Vista «Calendario»: el mes en rejilla (una casilla por día, con las barras de
 * turno y el punto de cobertura), la semana en tarjetas (una por día, de lunes
 * a domingo) y la lista de días con su línea de tiempo de 24 h.
 *
 * Decisiones que no se ven en el contrato y conviene tener presentes:
 *
 *  - **El periodo que se pinta se deriva siempre de la fecha en foco**
 *    (`getFocusDate()`), que comparten Calendario, Cuadrante y Horas. Así no hay
 *    dos «meses» (ni dos semanas) distintos en la aplicación: pasar de mes o de
 *    semana es cambiar la fecha en foco, y si otra vista la cambia, el
 *    calendario la sigue.
 *  - **El modo (mes/semana/lista) es estado local** de la vista. Al montar se
 *    toma la única pista que ofrece el contexto: `doc.settings.defaultView === 'list'`.
 *  - **La semana es la ISO**: lunes a domingo, la misma que numeran `isoWeek()`
 *    y la que usan el Cuadrante y «Copiar semana». No sigue
 *    `settings.weekStartsOn` a propósito: una «vista por semana» que empiece en
 *    domingo no cuadra ni con el número de semana ni con el resto de la app.
 *  - **Las tarjetas de la semana reutilizan los trozos del modo lista**
 *    (`buildDayMeta`, `buildDayTrack`, `buildDayFlags`): así la fecha, los
 *    turnos con su color y su horario y el estado de cobertura se cuentan
 *    exactamente igual en los dos modos, sin dos verdades distintas.
 *  - **Texto de las barras de la casilla**: con una sola persona filtrada se
 *    muestra el código del turno (hay sitio y es lo útil); si no, las iniciales
 *    de la persona, que es lo que distingue una barra de otra en una casilla de
 *    74 px. En los turnos que no son trabajo (vacaciones, baja, libre, festivo)
 *    se muestra el código del tipo: informa más que unas iniciales sobre un
 *    color que ya es distintivo y ocupa menos.
 *  - **`role="row"` con `display: contents`**: el HTML trae `role="grid"` en
 *    `.month-grid`, que es una rejilla CSS plana de 42 casillas. Para poder
 *    ofrecer filas ARIA sin romper el `grid-template-columns` del CSS (que no se
 *    puede tocar), cada fila de 7 días es un contenedor con `role="row"` y
 *    `display: contents`, de modo que sus casillas siguen siendo hijas de la
 *    rejilla a efectos de maquetación.
 */

import { byId, el, clear, icon, initials, readableOn } from '../../core/utils.js';
import {
  todayKey, fromKey, dateKey, addDays, addMonths, daysInMonth, monthDays,
  monthGrid, weekDays, isoWeek, monthKeyOf, startOfWeek, formatMonth,
  formatLongDate, formatHours, DOW_SHORT, MONTHS, MIN_PER_DAY,
} from '../../core/date.js';
import { analyzeDate, analyzeMonth } from '../../core/coverage.js';
import {
  getContext, getFocusDate, setFocusDate, getFilters, setFilter, clearFilters,
  invalidate, registerRenderer,
} from '../context.js';
import { emptyState, switchControl } from '../toolkit.js';
import { openDayEditor, openExportDialog, minLabel } from '../dialogs.js';

export const VIEW = 'calendar';

/* ==================================================================== *
 * Estado local de la vista (nunca del documento)
 * ==================================================================== */

let refs = null;              // referencias del DOM, cacheadas en mount()
let mode = 'month';           // 'month' | 'week' | 'list'
let cellByDate = new Map();   // fecha → botón de la casilla (solo modo mes)

/** Modos que admite el conmutador del calendario. */
const MODES = ['month', 'week', 'list'];

/** Cuántas casillas de turno caben en una celda del mes antes del «+N». */
const MAX_BARS = 3;

/** Salto de fila/columna de las flechas del teclado. */
const ARROW_STEP = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

/* ==================================================================== *
 * Montaje
 * ==================================================================== */

export function mount(ctx) {
  const view = byId('view-calendar');

  refs = {
    ctx,
    monthBox: byId('calendar-month'),
    weekBox: byId('calendar-week'),
    listBox: byId('calendar-list'),
    dow: byId('calendar-dow'),
    grid: byId('calendar-grid'),
    legend: byId('calendar-legend'),
    axis: byId('calendar-axis'),
    days: byId('calendar-days'),
    title: byId('calendar-title'),
    subtitle: byId('calendar-subtitle'),
    prev: byId('calendar-prev'),
    next: byId('calendar-next'),
    todayBtn: byId('calendar-today'),
    exportBtn: byId('calendar-export'),
    filterBtn: byId('calendar-filter'),
    filterLabel: byId('calendar-filter-label'),
    filterPanel: byId('calendar-filters'),
    modeButtons: view ? [...view.querySelectorAll('[data-calendar-mode]')] : [],
    // El panel de filtros se rellena en buildFilterPanel().
    memberChips: new Map(),
    typeChips: new Map(),
    mineSwitch: null,
    hiddenNote: null,
    clearBtn: null,
    panelSignature: '',
    dowSignature: '',
  };

  // Modo inicial: primera pista disponible en los ajustes del documento.
  mode = ctx.doc.settings?.defaultView === 'list' ? 'list' : 'month';

  /* --- Cableado único de listeners (nunca dentro de render) ---
   * Se asignan propiedades `on…` en lugar de `addEventListener` para que el
   * montaje sea reentrante: volver a montar la vista (las pruebas lo hacen)
   * reemplaza el manejador en vez de acumular uno nuevo por montaje. */
  refs.prev.onclick = () => shiftPeriod(-1);
  refs.next.onclick = () => shiftPeriod(1);
  refs.todayBtn.onclick = goToday;
  refs.exportBtn.onclick = exportPeriod;
  refs.filterBtn.onclick = toggleFilterPanel;
  refs.grid.onclick = onGridClick;
  refs.grid.onkeydown = onGridKeydown;
  refs.days.onclick = onListClick;
  refs.weekBox.onclick = onWeekClick;
  for (const button of refs.modeButtons) {
    button.onclick = () => setMode(button.dataset.calendarMode);
  }

  buildFilterPanel(ctx.doc);

  registerRenderer(VIEW, render);
  render();
}

/* ==================================================================== *
 * Pintado
 * ==================================================================== */

export function render() {
  if (!refs) return;
  const ctx = getContext();
  const doc = ctx.doc;

  const focus = getFocusDate() || todayKey();
  const monthKey = monthKeyOf(focus);
  const today = todayKey();
  const fs = resolveFilters(doc);

  // Días visibles: la semana ISO (lunes a domingo) o el mes natural.
  const days = mode === 'week' ? weekDays(focus) : monthDays(monthKey);

  // Un solo análisis del periodo visible. En modo mes se analiza el mes entero
  // (los días de fuera de mes de la rejilla se analizan bajo demanda en
  // renderMonth, son como mucho 11); en modo semana, los siete días, que pueden
  // caer en dos meses distintos.
  const analyses = new Map();
  if (mode === 'month') {
    for (const analysis of analyzeMonth(doc, monthKey)) analyses.set(analysis.date, analysis);
  } else {
    for (const key of days) analyses.set(key, analyzeDate(doc, key));
  }

  const stats = periodStats(days, analyses, fs);

  applyMode();
  paintHeader({ mode, monthKey, days }, stats);
  paintFilterState(doc, fs, countHidden(doc, days, fs));

  if (mode === 'month') renderMonth(doc, monthKey, { focus, today, fs, analyses });
  else if (mode === 'week') renderWeek(doc, days, { today, fs, analyses });
  else renderList(doc, { today, fs, analyses, days });
}

/** Enseña el contenedor del modo activo y sincroniza el conmutador. */
function applyMode() {
  refs.monthBox.hidden = mode !== 'month';
  refs.weekBox.hidden = mode !== 'week';
  refs.listBox.hidden = mode !== 'list';
  for (const button of refs.modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.calendarMode === mode));
  }
  // Las flechas mueven un mes o una semana según el modo: que lo diga también
  // quien use lector de pantalla.
  const step = mode === 'week' ? 'Semana' : 'Mes';
  refs.prev.setAttribute('aria-label', `${step} anterior`);
  refs.next.setAttribute('aria-label', `${step} siguiente`);
}

/** Título del periodo y subtítulo (horas del equipo y días con huecos). */
function paintHeader(period, stats) {
  const isWeek = period.mode === 'week';
  const last = period.days[period.days.length - 1];
  const text = isWeek ? weekRangeLabel(period.days[0], last) : formatMonth(period.monthKey);

  // `#calendar-title` trae el <small id="calendar-subtitle"> en el HTML: se
  // conserva y solo se reemplaza el nodo de texto del periodo.
  const small = refs.subtitle;
  clear(refs.title);
  refs.title.appendChild(document.createTextNode(text));
  if (small) refs.title.appendChild(small);
  // El CSS del título aplica `text-transform: capitalize`; en modo semana eso
  // dejaría «Semana Del 6 Al 12 De Octubre», así que ahí se desactiva.
  refs.title.classList.toggle('is-range', isWeek);

  const gaps = stats.gapDays
    ? `${stats.gapDays} ${stats.gapDays === 1 ? 'día con huecos' : 'días con huecos'}`
    : 'sin huecos de cobertura';
  if (small) small.textContent = `${formatHours(stats.totalMinutes)} del equipo · ${gaps}`;
}

/**
 * «Semana del 6 al 12 de octubre». Si la semana cruza de mes se nombran los dos
 * meses, y si cruza de año, también los dos años.
 */
function weekRangeLabel(startKey, endKey) {
  const from = fromKey(startKey);
  const to = fromKey(endKey);
  if (!from || !to) return `Semana del ${startKey} al ${endKey}`;

  const startMonth = MONTHS[from.getMonth()].toLowerCase();
  const endMonth = MONTHS[to.getMonth()].toLowerCase();

  if (from.getFullYear() !== to.getFullYear()) {
    return `Semana del ${from.getDate()} de ${startMonth} de ${from.getFullYear()} al ${to.getDate()} de ${endMonth} de ${to.getFullYear()}`;
  }
  if (from.getMonth() !== to.getMonth()) {
    return `Semana del ${from.getDate()} de ${startMonth} al ${to.getDate()} de ${endMonth}`;
  }
  return `Semana del ${from.getDate()} al ${to.getDate()} de ${endMonth}`;
}

/* ------------------------------------------------------------------ *
 * Modo mes
 * ------------------------------------------------------------------ */

function renderMonth(doc, monthKey, { focus, today, fs, analyses }) {
  const weekStart = weekStartOf(doc);
  const cells = monthGrid(monthKey, weekStart);

  paintDowHeader(weekStart);
  clear(refs.grid);
  cellByDate = new Map();

  // Un calendario sin personas no tiene nada que enseñar: estado vacío.
  if (!doc.members.length) {
    clear(refs.legend);
    refs.grid.removeAttribute('role');
    refs.grid.appendChild(emptyState({
      iconName: 'users',
      title: 'Todavía no hay nadie en el equipo',
      message: 'Añade personas para poder repartir turnos en el calendario.',
      action: { label: 'Ir a Equipo', onClick: () => refs.ctx.navigate('team') },
    }));
    return;
  }
  refs.grid.setAttribute('role', 'grid');

  const analysisOf = (key) => {
    if (!analyses.has(key)) analyses.set(key, analyzeDate(doc, key));
    return analyses.get(key);
  };
  const singleMember = !!fs.memberIds && fs.memberIds.size === 1;
  const showWeeks = doc.settings?.showWeekNumbers !== false;
  const types = new Map();
  let row = null;

  for (let i = 0; i < cells.length; i++) {
    if (i % 7 === 0) {
      // Ver la nota de cabecera: `display: contents` mantiene la rejilla CSS.
      row = el('div', { role: 'row', style: { display: 'contents' } });
      refs.grid.appendChild(row);
    }
    const cell = cells[i];
    const info = dayInfo(analysisOf(cell.key), fs);
    for (const projection of info.projections) {
      if (!projection.type) continue;
      const seen = types.get(projection.type.id) || { type: projection.type, count: 0 };
      seen.count++;
      types.set(projection.type.id, seen);
    }
    row.appendChild(buildCell(cell, i, info, { focus, today, showWeeks, singleMember }));
  }

  paintLegend(types);
}

/** Cabecera L M X J V S D rotada según `settings.weekStartsOn`. */
function paintDowHeader(weekStart) {
  if (refs.dowSignature === String(weekStart)) return;
  refs.dowSignature = String(weekStart);
  clear(refs.dow);
  for (let i = 0; i < 7; i++) {
    // `dow` es el día real (0 = domingo) porque la rejilla empieza en
    // `weekStart`; `DOW_SHORT` empieza en lunes, así que hay que girar el índice.
    const dow = (weekStart + i) % 7;
    refs.dow.appendChild(el('span', {
      class: dow === 0 || dow === 6 ? 'is-weekend' : null,
      'aria-hidden': 'true',
    }, DOW_SHORT[(dow + 6) % 7]));
  }
}

/** Una casilla del mes: número, semana, barras de turno y punto de cobertura. */
function buildCell(cell, index, info, { focus, today, showWeeks, singleMember }) {
  const isToday = cell.key === today;
  const selected = cell.key === focus;

  const classes = ['month-cell'];
  if (!cell.inMonth) classes.push('is-outside');
  if (cell.isWeekend) classes.push('is-weekend');
  if (isToday) classes.push('is-today');
  if (info.holiday) classes.push('is-holiday');
  if (selected) classes.push('is-selected');

  const head = el('div', { class: 'cell-head' }, [
    el('div', { class: 'cell-day' }, String(cell.day)),
    // El número de semana solo se repite una vez por fila (la primera casilla).
    showWeeks && index % 7 === 0 ? el('div', { class: 'cell-week' }, `S${cell.iso}`) : null,
  ]);

  const bars = el('div', { class: 'cell-bars' });
  const shown = info.projections.slice(0, MAX_BARS);
  for (const projection of shown) {
    const hex = projection.type?.hex || projection.member?.hex || '#8A93A8';
    const barClasses = ['cell-bar'];
    if (!projection.isWork) barClasses.push('is-absence');
    if (projection.continuedFromPrevDay || projection.continuesNextDay) barClasses.push('is-overnight');
    bars.appendChild(el('div', {
      class: barClasses.join(' '),
      style: { '--type-color': hex },
      title: projectionTitle(projection),
    }, [
      el('span', { class: 'bar-dot' }),
      el('span', { class: 'bar-text' }, projectionLabel(projection, singleMember)),
    ]));
  }
  const hidden = info.projections.length - shown.length;
  if (hidden > 0) bars.appendChild(el('div', { class: 'cell-more' }, `+${hidden}`));

  const node = el('button', {
    type: 'button',
    class: classes.join(' '),
    role: 'gridcell',
    tabindex: selected ? '0' : '-1',
    dataset: { date: cell.key },
    title: daySummary(cell.key, info),
    'aria-label': dayAriaLabel(cell.key, info),
    'aria-current': isToday ? 'date' : null,
  }, [
    head,
    bars,
    el('span', { class: `cell-coverage ${coverageClass(info.status)}`, title: coverageTitle(info) }),
  ]);

  cellByDate.set(cell.key, node);
  return node;
}

/** Leyenda: solo los tipos que aparecen de verdad en el mes visible. */
function paintLegend(types) {
  clear(refs.legend);

  if (!types.size) {
    refs.legend.appendChild(emptyState({
      iconName: 'calendar',
      title: 'Sin turnos que mostrar',
      message: refs.ctx.doc.entries.length
        ? 'Ningún turno de este mes coincide con los filtros activos.'
        : 'Toca cualquier día para asignar el primer turno.',
    }));
    return;
  }

  const list = [...types.values()].sort((a, b) => (a.type.order ?? 0) - (b.type.order ?? 0));
  for (const { type, count } of list) {
    refs.legend.appendChild(el('span', {
      class: 'chip',
      style: { '--chip-color': type.hex || '#8A93A8' },
      title: `${type.label} · ${count} ${count === 1 ? 'turno' : 'turnos'} este mes`,
    }, [
      el('span', { class: 'dot' }),
      `${type.code} · ${type.label}`,
    ]));
  }
  refs.legend.appendChild(el('span', { class: 't-2xs t-muted' }, '🌙 cruza medianoche'));
}

/* ------------------------------------------------------------------ *
 * Modo semana
 * ------------------------------------------------------------------ */

/**
 * La semana ISO que contiene la fecha en foco: siete tarjetas de día, de lunes
 * a domingo, con la misma información que una fila del modo lista (fecha,
 * turnos con su tipo y su horario, y estado de cobertura).
 */
function renderWeek(doc, days, { today, fs, analyses }) {
  clear(refs.weekBox);

  if (!doc.members.length) {
    refs.weekBox.appendChild(emptyState({
      iconName: 'users',
      title: 'Todavía no hay nadie en el equipo',
      message: 'Añade personas para poder repartir turnos en el calendario.',
      action: { label: 'Ir a Equipo', onClick: () => refs.ctx.navigate('team') },
    }));
    return;
  }

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const singleMember = !!fs.memberIds && fs.memberIds.size === 1;
  const infos = days.map((key) => dayInfo(analyses.get(key), fs));

  // Etiqueta de la semana con su número ISO y las horas visibles del equipo.
  const minutes = infos.reduce(
    (total, info) => total + info.work.reduce((sum, p) => sum + (p.end - p.start), 0),
    0,
  );
  refs.weekBox.appendChild(el('div', {
    class: 'section-label',
    style: { margin: 'var(--sp-2) 0 var(--sp-1)' },
  }, `Semana ${isoWeek(days[0]).week} · ${formatHours(minutes)}`));

  for (let i = 0; i < days.length; i++) {
    refs.weekBox.appendChild(buildWeekCard(days[i], infos[i], { today, nowMinutes, singleMember }));
  }
}

/**
 * Tarjeta de un día de la semana. La fecha, la línea de tiempo y los chivatos
 * son los mismos nodos que en el modo lista (`buildDayMeta`, `buildDayTrack`,
 * `buildDayFlags`); lo único propio es la cabecera con la fecha larga y el
 * detalle escrito de cada turno, que en una tarjeta ancha sí cabe.
 */
function buildWeekCard(key, info, { today, nowMinutes, singleMember }) {
  const dt = fromKey(key);
  const dow = dt ? dt.getDay() : 1;
  const isToday = key === today;

  const classes = ['week-card'];
  if (isToday) classes.push('is-today');
  if (info.holiday) classes.push('is-holiday');
  else if (dow === 0 || dow === 6) classes.push('is-weekend');

  const head = el('div', { class: 'week-head' }, [
    buildDayMeta(key),
    el('div', { class: 'grow' }, [
      el('div', { class: 'week-date' }, formatLongDate(key)),
      el('div', { class: `week-coverage ${coverageClass(info.status)}` }, coverageTitle(info)),
    ]),
    buildDayFlags(info),
  ]);

  const shifts = el('div', { class: 'week-shifts' });
  if (info.projections.length) {
    for (const projection of info.projections) {
      const hex = projection.type?.hex || projection.member?.hex || '#8A93A8';
      shifts.appendChild(el('span', {
        class: 'chip',
        style: { '--chip-color': hex },
        title: projectionTitle(projection),
      }, [
        el('span', { class: 'dot' }),
        projection.member?.name || 'Alguien',
        el('span', { class: 't-2xs t-muted' }, projectionSchedule(projection)),
      ]));
    }
  } else {
    shifts.appendChild(el('span', { class: 't-2xs t-muted' }, 'Sin turnos asignados'));
  }

  return el('button', {
    type: 'button',
    class: classes.join(' '),
    dataset: { date: key },
    title: daySummary(key, info),
    'aria-label': dayAriaLabel(key, info),
    'aria-current': isToday ? 'date' : null,
  }, [
    head,
    buildDayTrack(key, info, { today, nowMinutes, singleMember }),
    shifts,
  ]);
}

/* ------------------------------------------------------------------ *
 * Modo lista
 * ------------------------------------------------------------------ */

function renderList(doc, { today, fs, analyses, days }) {
  clear(refs.axis);
  clear(refs.days);

  if (!doc.members.length) {
    refs.days.appendChild(emptyState({
      iconName: 'users',
      title: 'Todavía no hay nadie en el equipo',
      message: 'Añade personas para poder repartir turnos.',
      action: { label: 'Ir a Equipo', onClick: () => refs.ctx.navigate('team') },
    }));
    return;
  }

  // Eje horario: una etiqueta cada 3 h. Se empieza en las 3:00 para que la del
  // borde izquierdo no quede cortada por el `translateX(-50%)` del CSS.
  for (let hour = 3; hour < 24; hour += 3) {
    refs.axis.appendChild(el('span', { style: { left: percent(hour * 60) } }, minLabel(hour * 60)));
  }

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const singleMember = !!fs.memberIds && fs.memberIds.size === 1;

  // Primera pasada: análisis por día y minutos visibles de cada semana ISO.
  const rows = days.map((key) => {
    const info = dayInfo(analyses.get(key), fs);
    const week = isoWeek(key);
    return {
      key,
      info,
      week: week.week,
      weekKey: `${week.year}-${week.week}`,
      minutes: info.work.reduce((total, p) => total + (p.end - p.start), 0),
    };
  });
  const weekMinutes = new Map();
  for (const row of rows) {
    weekMinutes.set(row.weekKey, (weekMinutes.get(row.weekKey) || 0) + row.minutes);
  }

  // Segunda pasada: filas agrupadas por semana.
  let currentWeek = null;
  for (const row of rows) {
    if (row.weekKey !== currentWeek) {
      currentWeek = row.weekKey;
      refs.days.appendChild(el('div', {
        class: 'section-label',
        style: { margin: 'var(--sp-3) 0 var(--sp-1)' },
      }, `Semana ${row.week} · ${formatHours(weekMinutes.get(row.weekKey) || 0)}`));
    }
    refs.days.appendChild(buildDayRow(row.key, row.info, { today, nowMinutes, singleMember }));
  }
}

/** Una fila de día: meta, línea de tiempo de 24 h y chivatos. */
function buildDayRow(key, info, opts) {
  const dt = fromKey(key);
  const dow = dt ? dt.getDay() : 1;
  const isToday = key === opts.today;

  const classes = ['day-row'];
  if (isToday) classes.push('is-today');
  if (info.holiday) classes.push('is-holiday');
  else if (dow === 0 || dow === 6) classes.push('is-weekend');

  return el('button', {
    type: 'button',
    class: classes.join(' '),
    dataset: { date: key },
    title: daySummary(key, info),
    'aria-label': dayAriaLabel(key, info),
    'aria-current': isToday ? 'date' : null,
  }, [
    buildDayMeta(key),
    buildDayTrack(key, info, opts),
    buildDayFlags(info),
  ]);
}

/**
 * Número del día y su inicial. `DOW_SHORT` empieza en lunes y `getDay()` en
 * domingo, así que hay que girar el índice.
 */
function buildDayMeta(key) {
  const dt = fromKey(key);
  const dow = dt ? dt.getDay() : 1;
  return el('div', { class: 'day-meta' }, [
    el('div', { class: 'day-num' }, String(dt ? dt.getDate() : Number(key.slice(8)))),
    el('div', { class: 'day-dow' }, DOW_SHORT[(dow + 6) % 7]),
  ]);
}

/** Línea de tiempo de 24 h con los huecos, los turnos y la hora actual. */
function buildDayTrack(key, info, { today, nowMinutes, singleMember }) {
  const track = el('div', { class: 'day-track' });

  // Un día entero en rayado cuando no hay ningún turno es ruido: los huecos
  // solo se dibujan si el día tiene algo de trabajo visible.
  if (info.work.length) {
    for (const gap of info.gaps) {
      track.appendChild(el('div', {
        class: 'gap-mark',
        style: { left: percent(gap.start), width: percent(gap.end - gap.start) },
        title: `Sin cubrir de ${minLabel(gap.start)} a ${minLabel(gap.end)}`,
      }));
    }
  }

  for (const projection of info.work) {
    const hex = projection.type?.hex || projection.member?.hex || '#8A93A8';
    track.appendChild(el('div', {
      class: 'block',
      style: {
        left: percent(projection.start),
        width: percent(projection.end - projection.start),
        '--type-color': hex,
        '--type-fg': readableOn(hex),
      },
      title: projectionTitle(projection),
    }, el('span', { class: 'block-label' }, projectionLabel(projection, singleMember))));
  }

  if (key === today) {
    track.appendChild(el('div', {
      class: 'now-line',
      style: { left: percent(nowMinutes) },
      title: `Ahora: ${minLabel(nowMinutes)}`,
    }));
  }

  return track;
}

/** Chivatos del día: festivo, notas y estado de cobertura (verde/ámbar/rojo). */
function buildDayFlags(info) {
  const flags = el('div', { class: 'day-flags' });
  if (info.holiday) {
    const isEvent = info.meta?.dayType === 'event';
    flags.appendChild(el('span', {
      class: `badge ${isEvent ? 'badge-info' : 'badge-warning'}`,
      title: info.meta?.label || (isEvent ? 'Evento' : 'Festivo'),
    }, isEvent ? 'Event.' : 'Fest.'));
  }
  const notes = notesCount(info);
  if (notes) {
    flags.appendChild(el('span', {
      class: 'badge badge-info',
      title: `${notes} ${notes === 1 ? 'nota' : 'notas'}`,
    }, [icon('edit', 11), String(notes)]));
  }
  if (!info.work.length) {
    flags.appendChild(el('span', { class: 'badge badge-danger', title: 'Sin turnos asignados' }, '—'));
  } else if (info.gaps.length) {
    flags.appendChild(el('span', {
      class: 'badge badge-warning',
      title: `${info.gaps.length} ${info.gaps.length === 1 ? 'hueco' : 'huecos'} sin cubrir`,
    }, [icon('alert', 11), String(info.gaps.length)]));
  } else {
    flags.appendChild(el('span', { class: 'badge badge-success', title: 'Cobertura completa' }, icon('check', 11)));
  }
  return flags;
}

/* ==================================================================== *
 * Panel de filtros
 * ==================================================================== */

/**
 * Se construye una vez (y solo se reconstruye si cambia el catálogo de
 * personas o de tipos de turno). Los estados se refrescan en cada pintado.
 */
function buildFilterPanel(doc) {
  const signature = catalogSignature(doc);
  if (refs.panelSignature === signature) return;
  refs.panelSignature = signature;

  clear(refs.filterPanel);
  refs.memberChips = new Map();
  refs.typeChips = new Map();

  const mineSwitch = switchControl('calendar-only-mine', getFilters().onlyMine, (next) => {
    setFilter('onlyMine', next);
    afterFilterChange();
  }, { label: 'Mostrar solo mis turnos' });
  refs.mineSwitch = mineSwitch;

  const members = doc.members.filter((m) => m.active);
  const memberRow = el('div', { class: 'chip-row' });
  for (const member of members) {
    const chip = el('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': 'false',
      style: { '--chip-color': member.hex || '#8A93A8' },
      onclick: () => toggleMember(member.id),
    }, [el('span', { class: 'dot' }), member.name]);
    refs.memberChips.set(member.id, chip);
    memberRow.appendChild(chip);
  }

  const types = doc.shiftTypes.filter((type) => !type.archived);
  const typeRow = el('div', { class: 'chip-row' });
  for (const type of types) {
    const chip = el('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': 'false',
      style: { '--chip-color': type.hex || '#8A93A8' },
      title: type.label,
      onclick: () => toggleType(type.id),
    }, [el('span', { class: 'dot' }), `${type.code} · ${type.label}`]);
    refs.typeChips.set(type.id, chip);
    typeRow.appendChild(chip);
  }

  refs.hiddenNote = el('span', { class: 't-2xs t-muted' }, 'Sin entradas ocultas');
  refs.clearBtn = el('button', {
    type: 'button',
    class: 'btn btn-ghost btn-sm',
    onclick: () => {
      clearFilters();
      afterFilterChange();
    },
  }, [icon('close', 14), 'Quitar filtros']);

  refs.filterPanel.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'setting-row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'label' }, 'Solo yo'),
        el('div', { class: 'sub' }, 'Muestra únicamente tus propios turnos.'),
      ]),
      el('div', { class: 'control' }, mineSwitch),
    ]),
    el('div', { class: 'stack-sm', style: { marginTop: 'var(--sp-2)' } }, [
      el('div', { class: 'section-label' }, 'Personas'),
      members.length ? memberRow : el('p', { class: 'field-hint' }, 'No hay personas en el equipo.'),
      el('div', { class: 'section-label' }, 'Tipos de turno'),
      types.length ? typeRow : el('p', { class: 'field-hint' }, 'No hay tipos de turno definidos.'),
      el('div', { class: 'row-between' }, [refs.hiddenNote, refs.clearBtn]),
    ]),
  ]));
}

/** Refresca chips, interruptor, contador y etiqueta del botón de filtros. */
function paintFilterState(doc, fs, hidden = null) {
  const raw = fs.raw;

  for (const [id, chip] of refs.memberChips) {
    chip.setAttribute('aria-pressed', String(raw.memberIds.includes(id)));
    chip.classList.toggle('is-muted', !!fs.memberIds && !fs.memberIds.has(id));
  }
  for (const [id, chip] of refs.typeChips) {
    chip.setAttribute('aria-pressed', String(raw.typeIds.includes(id)));
    chip.classList.toggle('is-muted', !!fs.typeIds && !fs.typeIds.has(id));
  }
  if (refs.mineSwitch) refs.mineSwitch.setAttribute('aria-checked', String(raw.onlyMine));
  if (refs.clearBtn) refs.clearBtn.disabled = !raw.active;
  if (refs.hiddenNote && hidden != null) {
    refs.hiddenNote.textContent = hidden
      ? `${hidden} ${hidden === 1 ? 'entrada oculta' : 'entradas ocultas'} por los filtros`
      : 'Sin entradas ocultas';
  }
  refs.filterLabel.textContent = filterLabel(doc, raw);
}

function toggleMember(id) {
  const next = new Set(getFilters().memberIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  setFilter('memberIds', [...next]);
  afterFilterChange();
}

function toggleType(id) {
  const next = new Set(getFilters().typeIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  setFilter('typeIds', [...next]);
  afterFilterChange();
}

/**
 * Los filtros son compartidos con Cuadrante y Horas: hay que repintar las tres.
 * El panel se refresca en el acto (sin esperar al frame) para que el usuario vea
 * el chip marcado al instante aunque su vista no sea la visible.
 */
function afterFilterChange() {
  paintFilterState(getContext().doc, resolveFilters(getContext().doc));
  invalidate(VIEW);
  invalidate('roster');
  invalidate('hours');
}

function toggleFilterPanel() {
  const opening = refs.filterPanel.hidden;
  refs.filterPanel.hidden = !opening;
  refs.filterBtn.setAttribute('aria-expanded', String(opening));
}

function catalogSignature(doc) {
  return [
    doc.members.map((m) => m.id).join(','),
    doc.shiftTypes.map((t) => `${t.id}:${t.archived ? 1 : 0}`).join(','),
    doc.meId || '',
  ].join('|');
}

/** Resumen del filtro activo: "Todo el equipo", "Ana +2", "Solo turnos de mañana". */
function filterLabel(doc, raw) {
  const parts = [];

  if (raw.onlyMine) {
    parts.push('Solo yo');
  } else if (raw.memberIds.length) {
    const names = raw.memberIds
      .map((id) => doc.members.find((m) => m.id === id)?.name)
      .filter(Boolean);
    if (names.length === 1) parts.push(names[0]);
    else if (names.length > 1) parts.push(`${names[0]} +${names.length - 1}`);
  }

  if (raw.typeIds.length === 1) {
    const type = doc.shiftTypes.find((t) => t.id === raw.typeIds[0]);
    const label = (type?.label || 'turno').toLowerCase();
    parts.push(parts.length ? label : `Solo turnos de ${label}`);
  } else if (raw.typeIds.length > 1) {
    parts.push(`${raw.typeIds.length} tipos de turno`);
  }

  return parts.length ? parts.join(' · ') : 'Todo el equipo';
}

/* ==================================================================== *
 * Navegación e interacción
 * ==================================================================== */

function setMode(next) {
  const value = MODES.includes(next) ? next : 'month';
  if (value === mode) return;
  mode = value;
  render();
}

/**
 * Mueve el periodo visible: en modo semana, siete días; en mes y lista, un mes
 * conservando el día del mes cuando existe en el mes destino.
 */
function shiftPeriod(delta, { focusCell: wantFocus = false } = {}) {
  const focus = getFocusDate() || todayKey();
  let target;

  if (mode === 'week') {
    target = addDays(focus, delta * 7);
  } else {
    const month = addMonths(monthKeyOf(focus), delta);
    const day = Math.min(Number(focus.slice(8, 10)) || 1, daysInMonth(month));
    target = dateKey(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, day);
  }

  setFocusDate(target);
  render();
  if (wantFocus) focusCell(target);
}

function goToday() {
  setFocusDate(todayKey());
  render();
}

/** Exporta justo el periodo que se está viendo (el mes o la semana). */
function exportPeriod() {
  const ctx = getContext();
  const days = visibleDays();
  const fs = resolveFilters(ctx.doc);
  openExportDialog(ctx, {
    from: days[0],
    to: days[days.length - 1],
    presetMemberIds: fs.memberIds ? [...fs.memberIds] : null,
  });
}

/** Los días que pinta el modo activo: la semana ISO o el mes natural del foco. */
function visibleDays() {
  const focus = getFocusDate() || todayKey();
  return mode === 'week' ? weekDays(focus) : monthDays(monthKeyOf(focus));
}

function onGridClick(event) {
  const cell = event.target.closest?.('.month-cell');
  if (!cell) return;
  const key = cell.dataset.date;
  setFocusDate(key);
  paintSelection(key);
  openDayEditor(refs.ctx, key);
}

function onListClick(event) {
  const row = event.target.closest?.('.day-row');
  if (!row) return;
  const key = row.dataset.date;
  setFocusDate(key);
  openDayEditor(refs.ctx, key);
}

/** Tocar una tarjeta de la semana abre el editor de ese día, como en el mes. */
function onWeekClick(event) {
  const card = event.target.closest?.('.week-card');
  if (!card) return;
  const key = card.dataset.date;
  setFocusDate(key);
  openDayEditor(refs.ctx, key);
}

/**
 * Un único listener en la rejilla (delegación) para todas las casillas:
 * flechas para moverse, Inicio/Fin para los extremos de la semana, AvPág/RePág
 * (o `[` / `]`) para cambiar de mes. Intro y espacio los resuelve el propio
 * `<button>`.
 */
function onGridKeydown(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const cell = event.target.closest?.('.month-cell');
  if (!cell) return;

  const key = cell.dataset.date;
  const weekStart = weekStartOf(getContext().doc);
  let handled = true;

  if (ARROW_STEP[event.key]) {
    moveFocus(addDays(key, ARROW_STEP[event.key]));
  } else if (event.key === 'PageUp' || event.key === '[' || event.code === 'BracketLeft') {
    shiftPeriod(-1, { focusCell: true });
  } else if (event.key === 'PageDown' || event.key === ']' || event.code === 'BracketRight') {
    shiftPeriod(1, { focusCell: true });
  } else if (event.key === 'Home') {
    moveFocus(startOfWeek(key, weekStart));
  } else if (event.key === 'End') {
    moveFocus(addDays(startOfWeek(key, weekStart), 6));
  } else {
    handled = false;
  }

  if (handled) event.preventDefault();
}

/** Mueve la fecha en foco; solo repinta la rejilla si cambia de mes. */
function moveFocus(key) {
  if (!key) return;
  const previous = getFocusDate() || todayKey();
  setFocusDate(key);
  if (monthKeyOf(key) !== monthKeyOf(previous)) render();
  else paintSelection(key);
  focusCell(key);
}

/** Índice móvil (roving tabindex): una sola casilla es tabulable. */
function paintSelection(key) {
  for (const [date, node] of cellByDate) {
    const selected = date === key;
    node.classList.toggle('is-selected', selected);
    node.tabIndex = selected ? 0 : -1;
  }
}

function focusCell(key) {
  cellByDate.get(key)?.focus();
}

/* ==================================================================== *
 * Filtros y análisis por día (puro)
 * ==================================================================== */

function weekStartOf(doc) {
  const value = Number(doc.settings?.weekStartsOn);
  return [0, 1, 6].includes(value) ? value : 1;
}

/**
 * Traduce el estado compartido de filtros a conjuntos resolubles.
 * `memberIds`/`typeIds` a `null` significa «sin filtro de ese tipo».
 * Si «Solo yo» está activo pero el documento no sabe quién eres, no se filtra
 * nada (mejor enseñar el equipo entero que una rejilla vacía).
 */
function resolveFilters(doc) {
  const raw = getFilters();
  let memberIds = null;
  if (raw.onlyMine) memberIds = doc.meId ? new Set([doc.meId]) : null;
  else if (raw.memberIds.length) memberIds = new Set(raw.memberIds);
  const typeIds = raw.typeIds.length ? new Set(raw.typeIds) : null;
  return { raw, memberIds, typeIds, active: !!(memberIds || typeIds) };
}

function entryVisible(entry, fs) {
  if (fs.memberIds && !fs.memberIds.has(entry.memberId)) return false;
  if (fs.typeIds && !fs.typeIds.has(entry.typeId ?? '_')) return false;
  return true;
}

/**
 * Análisis de un día ya filtrado. Sin filtros se reutiliza tal cual el del
 * motor de cobertura (misma verdad que el resto de la aplicación); con filtros
 * se recalcula la cobertura sobre las proyecciones visibles.
 */
function dayInfo(analysis, fs) {
  if (!analysis) {
    return { projections: [], work: [], status: 'empty', gaps: [], holiday: false, meta: null };
  }

  if (!fs.active) {
    return {
      projections: analysis.projections,
      work: analysis.working,
      status: analysis.status,
      gaps: analysis.gaps,
      holiday: analysis.isHoliday,
      meta: analysis.dayMeta,
    };
  }

  const projections = analysis.projections.filter((p) => entryVisible(p.entry, fs));
  const work = projections.filter((p) => p.isWork);
  const holiday = analysis.isHoliday;
  const meta = analysis.dayMeta;

  if (!work.length) return { projections, work, status: 'empty', gaps: [], holiday, meta };
  // Un día con la demanda puesta a 0 no espera a nadie (misma regla que el motor).
  if (analysis.dayMeta?.demandOverride === 0) {
    return { projections, work, status: 'covered', gaps: [], holiday, meta };
  }
  const gaps = gapsOf(work);
  return { projections, work, status: gaps.length ? 'gaps' : 'covered', gaps, holiday, meta };
}

/** Tramos del día sin nadie trabajando, a partir de las proyecciones visibles. */
function gapsOf(work) {
  const spans = work
    .map((p) => ({ start: Math.max(0, p.start), end: Math.min(MIN_PER_DAY, p.end) }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  const gaps = [];
  let cursor = 0;
  for (const span of merged) {
    if (span.start > cursor) gaps.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < MIN_PER_DAY) gaps.push({ start: cursor, end: MIN_PER_DAY });
  return gaps;
}

/** Horas del equipo y días con huecos del periodo visible, ya filtrado. */
function periodStats(days, analyses, fs) {
  let totalMinutes = 0;
  let gapDays = 0;
  for (const key of days) {
    const info = dayInfo(analyses.get(key), fs);
    totalMinutes += info.work.reduce((total, p) => total + (p.end - p.start), 0);
    if (info.status === 'gaps') gapDays++;
  }
  return { totalMinutes, gapDays };
}

/** Entradas que empiezan en los días visibles y el filtro deja fuera. */
function countHidden(doc, days, fs) {
  if (!fs.active) return 0;
  const visible = new Set(days);
  let hidden = 0;
  for (const entry of doc.entries) {
    if (!visible.has(entry.date)) continue;
    if (!entryVisible(entry, fs)) hidden++;
  }
  return hidden;
}

/* ==================================================================== *
 * Textos de apoyo (todos en español y sin datos del documento en HTML)
 * ==================================================================== */

/** Texto de la barra: código de turno o iniciales (ver nota de cabecera). */
function projectionLabel(projection, singleMember) {
  if (!projection.isWork) return projection.type?.code || '·';
  if (singleMember) return projection.type?.code || timeLabel(projection.start);
  return projection.member?.initials || initials(projection.member?.name) || '·';
}

/** "Ana · Mañana · 08:30–17:00 (+1 día)". */
function projectionTitle(projection) {
  const parts = [projection.member?.name || 'Alguien'];
  parts.push(projection.type?.label || 'Turno suelto');
  if (projection.isWork) {
    parts.push(`${timeLabel(projection.start)}–${timeLabel(projection.end)}${projection.continuesNextDay ? ' (+1 día)' : ''}`);
    if (projection.continuedFromPrevDay) parts.push('viene de ayer');
  } else {
    parts.push('sin horario');
  }
  return parts.join(' · ');
}

/** "Mañana · 08:30–17:00 (+1 día)" o "Vacaciones · todo el día". */
function projectionSchedule(projection) {
  const what = projection.type?.label || 'Turno suelto';
  if (!projection.isWork) return `${what} · todo el día`;
  const when = `${timeLabel(projection.start)}–${timeLabel(projection.end)}`;
  return `${what} · ${when}${projection.continuesNextDay ? ' · +1 día' : ''}`;
}

/** "Ana 08:30–17:00" — resumen compacto para el `title` de la casilla. */
function projectionShort(projection) {
  const who = projection.member?.name || 'Alguien';
  if (!projection.isWork) return `${who} (${projection.type?.label || 'ausencia'})`;
  return `${who} ${timeLabel(projection.start)}–${timeLabel(projection.end)}${projection.continuesNextDay ? ' +1' : ''}`;
}

/** Resumen de texto plano del día para el `title` (al pasar el ratón). */
function daySummary(key, info) {
  const parts = [formatLongDate(key)];

  if (info.meta?.label) parts.push(info.meta.label);
  else if (info.holiday) parts.push(info.meta?.dayType === 'event' ? 'Evento' : 'Festivo');

  const work = info.work;
  if (work.length) parts.push(work.map(projectionShort).join(' · '));
  for (const projection of info.projections) {
    if (!projection.isWork) parts.push(projectionShort(projection));
  }
  if (!info.projections.length) parts.push('Sin turnos');

  if (work.length && info.gaps.length) {
    parts.push(`Huecos: ${info.gaps.map((g) => `${timeLabel(g.start)}–${timeLabel(g.end)}`).join(', ')}`);
  } else if (work.length) {
    parts.push('Cobertura completa');
  }
  return parts.join(' · ');
}

/** Etiqueta accesible de la casilla: precisa y sin repetir el mes entero. */
function dayAriaLabel(key, info) {
  const parts = [formatLongDate(key)];
  if (info.work.length) parts.push(`${info.work.length} ${info.work.length === 1 ? 'turno' : 'turnos'}`);
  else parts.push('sin turnos');

  if (info.work.length && info.gaps.length) {
    parts.push(`${info.gaps.length} ${info.gaps.length === 1 ? 'hueco' : 'huecos'} de cobertura`);
  } else if (info.work.length) {
    parts.push('cobertura completa');
  }
  if (info.holiday) parts.push(info.meta?.dayType === 'event' ? 'evento' : 'festivo');
  return parts.join('. ');
}

function notesCount(info) {
  let count = info.meta?.notes ? 1 : 0;
  for (const projection of info.projections) if (projection.entry?.notes) count++;
  return count;
}

function coverageClass(status) {
  if (status === 'gaps') return 'is-gap';
  if (status === 'empty') return 'is-empty';
  return 'is-ok';
}

function coverageTitle(info) {
  if (info.status === 'empty') return 'Sin turnos asignados';
  if (info.status === 'gaps') {
    return info.gaps.map((g) => `${timeLabel(g.start)}–${timeLabel(g.end)}`).join(', ') + ' sin cubrir';
  }
  return 'Cobertura completa';
}

/** "08:30"; el final del día se escribe "24:00" y no "00:00". */
function timeLabel(minutes) {
  return minutes >= MIN_PER_DAY ? '24:00' : minLabel(minutes);
}

/** Posición porcentual dentro de la línea de 24 h del día. */
function percent(minutes) {
  return `${(minutes / MIN_PER_DAY) * 100}%`;
}
