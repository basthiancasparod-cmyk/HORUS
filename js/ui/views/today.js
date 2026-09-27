/**
 * HORUS — js/ui/views/today.js
 * Vista «Hoy»: la pantalla que se abre de pie, en el vestuario, con prisa.
 * Responde de un vistazo a: ¿qué hora es?, ¿quién está de guardia?, ¿qué falta
 * por cubrir?, ¿cuál es mi próximo turno?
 */

import { byId, el, clear, icon, debounce } from '../../core/utils.js';
import {
  todayKey, addDays, formatLongDate, formatDuration, formatBlocks,
  formatRelative, formatClock, humanTime, crossesMidnight, isoWeek, weekDays,
  DOW_SHORT, formatShortDate, minToTime,
} from '../../core/date.js';
import {
  entryBlocks, entryType, memberById, entryIsWork, entryMinutes, shiftTypeById,
} from '../../core/model.js';
import {
  analyzeDate, whoIsNow, nextShift, upcomingShifts, summarizeMonth,
} from '../../core/coverage.js';
import { getContext, registerRenderer, getFocusDate, setFocusDate, invalidate } from '../context.js';
import {
  emptyState, avatar, typeBadge, notify, barRow, progressBar,
} from '../toolkit.js';
import { renderCoverageStrip, coverageSummary, minLabel, openAssignDialog } from '../dialogs.js';

export const VIEW = 'today';

let refs = null;
let clockTicker = null;

/* ------------------------------------------------------------------ *
 * Montaje
 * ------------------------------------------------------------------ */

export function mount(ctx) {
  refs = {
    clock: byId('today-clock'),
    date: byId('today-date'),
    week: byId('today-week'),
    count: byId('today-count'),
    next: byId('today-next'),
    onduty: byId('today-onduty'),
    ondutyCount: byId('today-onduty-count'),
    coverage: byId('today-coverage'),
    gapsSection: byId('today-gaps-section'),
    gaps: byId('today-gaps'),
    mine: byId('today-mine'),
    conflictsSection: byId('today-conflicts-section'),
    conflicts: byId('today-conflicts'),
    editButton: byId('today-edit'),
    tomorrowButton: byId('today-tomorrow'),
    portraitButton: byId('today-portrait'),
    dismissConflicts: byId('today-conflicts-dismiss'),
  };

  // Cableado único: nada de volver a enganchar listeners en cada pintado.
  refs.editButton.addEventListener('click', () => {
    ctx.openAssign({ date: currentDate(), memberIds: [ctx.doc.meId].filter(Boolean) });
  });

  refs.portraitButton.addEventListener('click', () => ctx.openDay(currentDate()));

  refs.tomorrowButton.addEventListener('click', () => {
    const next = addDays(currentDate(), 1);
    setFocusDate(next);
    notify.info(`Mostrando ${formatLongDate(next)}`);
    invalidate('today');
  });

  refs.dismissConflicts.addEventListener('click', () => {
    ctx.sync?.acknowledgeConflicts?.();
    notify.info('Conflictos descartados');
    invalidate('today');
  });

  registerRenderer(VIEW, render);
  render();

  // El reloj se refresca solo; el resto se repinta por eventos del store.
  if (clockTicker) clearInterval(clockTicker);
  clockTicker = setInterval(() => {
    if (document.hidden) return;
    paintClock();
  }, 15000);
}

/** Fecha que muestra la vista: la fecha en foco, o hoy. */
function currentDate() {
  const focus = getFocusDate();
  // Solo se acepta la fecha en foco si es hoy, mañana o ayer; para cualquier
  // otra el usuario vendrá desde el calendario y querrá ver ese día.
  return focus || todayKey();
}

/* ------------------------------------------------------------------ *
 * Pintado
 * ------------------------------------------------------------------ */

function render() {
  const ctx = getContext();
  const doc = ctx.doc;
  const date = currentDate();
  const isToday = date === todayKey();

  paintClock();

  /* ---------- Cabecera de la tarjeta ---------- */
  refs.date.textContent = formatLongDate(date);
  refs.date.style.cursor = 'pointer';
  refs.date.onclick = () => ctx.navigate('calendar');

  const week = isoWeek(date);
  refs.week.textContent = `Semana ${week.week} · ${week.year}`;

  const analysis = analyzeDate(doc, date);
  refs.count.textContent = analysis.headsOnShift
    ? `${analysis.headsOnShift} turno${analysis.headsOnShift === 1 ? '' : 's'} hoy`
    : 'sin turnos';

  // El botón de "ver mañana" vuelve a hoy si ya estamos en mañana
  refs.tomorrowButton.textContent = isToday ? 'Ver mañana' : 'Volver a hoy';
  refs.tomorrowButton.onclick = () => {
    const target = isToday ? addDays(todayKey(), 1) : todayKey();
    setFocusDate(target);
    invalidate('today');
  };

  /* ---------- Próximo turno ---------- */
  paintNext(doc, ctx);

  /* ---------- De guardia ahora ---------- */
  paintOnDuty(doc);

  /* ---------- Cobertura ---------- */
  paintCoverage(doc, analysis);

  /* ---------- Huecos ---------- */
  paintGaps(analysis);

  /* ---------- Mis turnos ---------- */
  paintMine(doc, ctx);

  /* ---------- Conflictos de sincronización ---------- */
  paintConflicts(ctx);
}

function paintClock() {
  if (!refs?.clock) return;
  const now = new Date();
  refs.clock.textContent = formatClock(now);
}

/** Tarjeta del próximo turno: cuenta atrás si es inminente. */
function paintNext(doc, ctx) {
  const box = refs.next;
  clear(box);

  const now = new Date();
  const mine = doc.meId ? nextShift(doc, doc.meId, now) : null;
  const team = mine ? null : nextShift(doc, null, now);

  if (!mine && !team) {
    // Sin turnos: o no hay ninguno, o todos han pasado ya
    const upcoming = upcomingShifts(doc, { from: addDays(todayKey(), 1), limit: 1 });
    box.appendChild(el('div', { class: 'row-between' }, [
      el('div', {}, [
        el('div', { class: 't-sm t-dim' }, 'No tienes turnos próximos'),
        el('div', { class: 'field-hint' }, upcoming.length
          ? `El siguiente del equipo es el ${formatShortDate(upcoming[0].date)}.`
          : 'Añade turnos para verlos aquí.'),
      ]),
      el('button', {
        type: 'button', class: 'btn btn-sm btn-primary',
        onclick: () => ctx.openAssign({ date: currentDate() }),
      }, 'Asignar'),
    ]));
    return;
  }

  const target = mine || team;
  const minutes = target.minutesUntil;
  const soon = minutes <= 120;

  const card = el('div', { class: 'next-card' }, [
    avatar(target.member, { size: 'md' }),
    el('div', { class: 'grow', style: { minWidth: '0' } }, [
      el('div', { class: 't-2xs t-upper t-muted' }, mine ? 'Tu próximo turno' : 'Próximo turno del equipo'),
      el('div', { class: 't-md t-semibold' }, [
        target.member?.name || 'Alguien',
        target.type ? ` · ${target.type.label}` : '',
      ].join('')),
      el('div', { class: 't-xs t-dim' }, [
        formatBlocks([target.block]),
        crossesMidnight(target.block) ? ' (cruza medianoche)' : '',
        target.entry.notes ? ` · ${target.entry.notes}` : '',
      ].join('')),
    ]),
    el('div', { class: 'text-right shrink-0' }, [
      el('div', { class: 'countdown' }, formatRelative(minutes * 60000).replace(/^en /, 'en ')),
      el('div', { class: 't-2xs t-muted' }, formatClock(new Date(target.startsAt))),
    ]),
  ]);

  if (soon) {
    card.style.animation = 'pulse-soft 2.4s var(--ease-in-out) infinite';
  }
  box.appendChild(card);

  // Si hay huecos de cobertura hoy, avisarlo aquí también
  const analysis = analyzeDate(doc, currentDate());
  if (analysis.gapMin > 0) {
    box.appendChild(el('p', { class: 'field-hint', style: { marginTop: 'var(--sp-3)' } },
      `${formatDuration(analysis.gapMin)} de hoy siguen sin cubrirse.`));
  }
}

/** Quién está trabajando ahora mismo, con lo que le queda. */
function paintOnDuty(doc) {
  const box = refs.onduty;
  clear(box);

  const now = new Date();
  const onDuty = whoIsNow(doc, now);
  refs.ondutyCount.textContent = String(onDuty.length);

  if (!onDuty.length) {
    box.appendChild(el('div', { class: 'card', style: { padding: 'var(--sp-4)' } }, [
      el('div', { class: 'row', style: { gap: 'var(--sp-3)' } }, [
        el('span', { class: 'empty-icon', style: { width: '36px', height: '36px' } }, icon('moon', 18)),
        el('div', { class: 'grow' }, [
          el('div', { class: 't-sm t-semibold' }, 'Nadie de guardia ahora mismo'),
          el('div', { class: 'field-hint' }, nextOnDutyHint(doc, now)),
        ]),
      ]),
    ]));
    return;
  }

  for (const duty of onDuty) {
    const color = duty.type?.hex || duty.member?.hex || 'var(--accent)';
    box.appendChild(el('div', {
      class: 'onduty-item',
      style: { '--type-color': color },
    }, [
      avatar(duty.member, { size: 'sm' }),
      el('div', { class: 'grow' }, [
        el('div', { class: 'who' }, [
          duty.member?.name || 'Alguien',
          duty.continued ? el('span', { class: 'badge', style: { marginLeft: '6px' } }, 'desde ayer') : null,
        ]),
        el('div', { class: 'what' }, [
          duty.type ? duty.type.label : 'Turno',
          ` · ${minLabel(duty.start)}–${duty.end >= 1440 ? 'mañana ' : ''}${minLabel(duty.end)}`,
        ].join('')),
        progressBar(Math.round(duty.progress * 100), 100, {
          className: 'shift-progress',
          label: `Progreso del turno de ${duty.member?.name || ''}`,
        }),
      ]),
      el('div', { class: 'left' }, formatDuration(duty.minutesLeft)),
    ]));
  }
}

function nextOnDutyHint(doc, now) {
  const upcoming = upcomingShifts(doc, { from: now, limit: 1 });
  if (!upcoming.length) return 'No hay más turnos en el cuadrante.';
  const minutes = Math.round((upcoming[0].startMs - now.getTime()) / 60000);
  return `El siguiente turno empieza ${formatRelative(minutes * 60000)} (${upcoming[0].member?.name || 'alguien'}).`;
}

/** Barra de cobertura del día + resumen numérico. */
function paintCoverage(doc, analysis) {
  const box = refs.coverage;
  clear(box);

  const card = el('div', { class: 'card' });
  card.appendChild(renderCoverageStrip(analysis));

  const stats = el('div', { class: 'grid-3', style: { marginTop: 'var(--sp-3)' } }, [
    statBlock(formatDuration(analysis.coverageMin), 'cubiertas'),
    statBlock(formatDuration(analysis.gapMin), analysis.gapMin > 0 ? 'sin cubrir' : 'sin huecos',
      analysis.gapMin > 0 ? 't-warning' : 't-success'),
    statBlock(String(analysis.peak), 'a la vez como máximo'),
  ]);
  card.appendChild(stats);

  card.appendChild(el('div', { class: 'row wrap', style: { marginTop: 'var(--sp-3)', gap: 'var(--sp-3)' } }, [
    el('span', { class: 't-2xs t-muted' }, '00:00'),
    el('span', { class: 'grow' }),
    el('span', { class: 't-2xs t-muted' }, '12:00'),
    el('span', { class: 'grow' }),
    el('span', { class: 't-2xs t-muted' }, '24:00'),
  ]));

  card.appendChild(el('p', { class: 'field-hint', style: { marginTop: 'var(--sp-2)' } },
    coverageSummary(analysis)));

  box.appendChild(card);
}

function statBlock(value, label, className = '') {
  return el('div', {}, [
    el('div', { class: `stat-value t-lg ${className}`.trim(), style: { fontSize: 'var(--fs-lg)' } }, value),
    el('div', { class: 'stat-label' }, label),
  ]);
}

/** Lista de franjas horarias sin cubrir. */
function paintGaps(analysis) {
  const box = refs.gaps;
  clear(box);

  if (!analysis.gaps.length) {
    refs.gapsSection.hidden = false;
    box.appendChild(el('div', { class: 'gap-item', style: { background: 'var(--success-soft)', borderColor: 'color-mix(in srgb, var(--success) 28%, transparent)' } }, [
      icon('check', 16),
      el('span', { class: 'grow' }, 'El día está completamente cubierto.'),
    ]));
    return;
  }

  refs.gapsSection.hidden = false;
  const total = analysis.gaps.reduce((a, g) => a + (g.end - g.start), 0);
  for (const gap of analysis.gaps) {
    const duration = gap.end - gap.start;
    box.appendChild(el('div', {
      class: `gap-item${gap.start === 0 || gap.end === 1440 ? ' is-empty' : ''}`,
    }, [
      icon('alert', 16),
      el('span', { class: 'grow' }, `${minLabel(gap.start)} – ${minLabel(gap.end)}`),
      el('span', { class: 't-semibold t-nums' }, formatDuration(duration)),
    ]));
  }
  box.appendChild(el('p', { class: 'field-hint' },
    `${analysis.gaps.length} franja(s) · ${formatDuration(total)} descubiertas en total.`));
}

/** Los próximos turnos de la persona que está usando la app. */
function paintMine(doc, ctx) {
  const box = refs.mine;
  clear(box);

  const meId = doc.meId;
  if (!meId) {
    box.appendChild(emptyState({
      iconName: 'users',
      title: 'No has indicado quién eres',
      message: 'Marca tu nombre en Equipo para ver aquí tus turnos.',
      action: { label: 'Ir a Equipo', onClick: () => ctx.navigate('team') },
    }));
    return;
  }

  const from = currentDate();
  const upcoming = upcomingShifts(doc, {
    from: new Date(`${from}T00:00:00`),
    memberId: meId,
    limit: 8,
    onlyFromNow: false,
  });

  if (!upcoming.length) {
    box.appendChild(emptyState({
      iconName: 'calendar',
      title: 'No tienes turnos a partir de esta fecha',
      message: 'Puedes asignarte uno o aplicar una rotación desde el cuadrante.',
      action: { label: 'Asignarme un turno', onClick: () => ctx.openAssign({ date: from, memberIds: [meId] }) },
    }));
    return;
  }

  for (const shift of upcoming) {
    const type = shift.type;
    const hex = type?.hex || '#8a93a8';
    const row = el('button', {
      type: 'button',
      class: 'list-item is-clickable',
      style: { width: '100%', textAlign: 'left' },
      onclick: () => { setFocusDate(shift.date); ctx.openDay(shift.date); },
    }, [
      el('span', {
        class: 'badge badge-solid',
        style: { '--type-color': hex, '--type-fg': readableOnHex(hex), minWidth: '38px', justifyContent: 'center' },
      }, type?.code || '·'),
      el('div', { class: 'grow' }, [
        el('div', { class: 'title' }, [
          formatShortDate(shift.date),
          shift.date === todayKey() ? ' · hoy' : (shift.date === addDays(todayKey(), 1) ? ' · mañana' : ''),
        ].join('')),
        el('div', { class: 'sub' }, [
          type?.label || 'Turno suelto',
          ` · ${humanTime(shift.labels.start)}–${humanTime(shift.labels.end)}`,
          crossesMidnight(shift.labels) ? ' (cruza medianoche)' : '',
        ].join('')),
      ]),
      el('span', { class: 't-xs t-muted t-nums' }, formatDuration(shift.endMs - shift.startMs)),
    ]);
    box.appendChild(row);
  }
}

function readableOnHex(hex) {
  const c = String(hex || '').replace('#', '');
  if (c.length !== 6) return '#fff';
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const lum = (0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b));
  return lum > 0.45 ? '#101319' : '#FFFFFF';
}

function srgb(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Aviso de cambios que otra persona pisó mientras estábamos sin conexión. */
function paintConflicts(ctx) {
  const conflicts = ctx.sync?.conflicts?.() || [];
  const section = refs.conflictsSection;
  const box = refs.conflicts;

  if (!conflicts.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  clear(box);

  const doc = ctx.doc;
  for (const conflict of conflicts.slice(0, 6)) {
    const when = conflict.remote ? new Date(conflict.remote) : null;
    const entry = conflict.id ? doc.entries.find((e) => e.id === conflict.id) : null;
    const member = entry ? memberById(doc, entry.memberId) : null;

    box.appendChild(el('div', { class: 'list-item' }, [
      icon('alert', 16),
      el('div', { class: 'grow' }, [
        el('div', { class: 'title' }, conflict.table === 'horus_entries'
          ? `Turno de ${member?.name || 'alguien'} del ${entry ? formatShortDate(entry.date) : ''}`
          : 'Un cambio del cuadrante'),
        el('div', { class: 'sub' }, [
          when ? `Otra persona lo modificó ${formatRelative(when.getTime() - Date.now())}` : 'Modificado en otro dispositivo',
          conflict.lost?.notes ? ` · tu nota era: «${conflict.lost.notes}»` : '',
        ].join('')),
      ]),
      entry
        ? el('button', {
          type: 'button', class: 'btn btn-sm',
          onclick: () => { setFocusDate(entry.date); ctx.openDay(entry.date); },
        }, 'Revisar')
        : null,
    ]));
  }
}

export { currentDate };
