/**
 * HORUS — js/ui/views/today.js
 * Vista «Hoy»: la pantalla que se abre de pie, en el vestuario, con prisa.
 * Responde de un vistazo a: ¿qué hora es?, ¿cuál es mi próximo turno?,
 * ¿qué turnos míos vienen?, ¿hay conflictos?
 */

import { byId, el, clear, icon } from '../../core/utils.js';
import {
  todayKey, addDays, formatLongDate, formatDuration, formatBlocks,
  formatRelative, formatClock, humanTime, crossesMidnight, isoWeek, weekDays,
  DOW_SHORT, formatShortDate, minToTime,
} from '../../core/date.js';
import {
  analyzeDate, nextShift, upcomingShifts, whoIsNow,
} from '../../core/coverage.js';
import { getContext, registerRenderer, getFocusDate, setFocusDate, invalidate } from '../context.js';
import {
  emptyState, avatar, typeBadge, notify, progressBar,
} from '../toolkit.js';
import { memberById } from '../../core/model.js';
import { openAssignDialog, minLabel } from '../dialogs.js';

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
    notify.info(`Mostrando ${formatLongDate(target)}`);
    invalidate('today');
  };

  /* ---------- Tu próximo turno (lo principal) ---------- */
  paintNext(doc, ctx);

  /* ---------- De guardia ahora ---------- */
  paintOnDuty(doc);

  /* ---------- Tus próximos turnos ---------- */
  paintMine(doc, ctx);

  /* ---------- Conflictos de sincronización ---------- */
  paintConflicts(ctx);
}

function paintClock() {
  if (!refs?.clock) return;
  const now = new Date();
  refs.clock.textContent = formatClock(now);
}

/* ------------------------------------------------------------------ *
 * Tu próximo turno (lo principal): destaca si es tuyo con "Eres tú"
 * ------------------------------------------------------------------ */

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
  const isMine = !!mine;

  const card = el('div', { class: `next-card ${isMine ? 'is-mine' : 'is-team'}` }, [
    avatar(target.member, { size: 'md' }),
    el('div', { class: 'grow', style: { minWidth: '0' } }, [
      el('div', { class: 'next-label' }, isMine ? 'Tu próximo turno' : 'Próximo turno del equipo'),
      el('div', { class: 'next-who' }, [
        el('span', { class: 'next-name' }, target.member?.name || 'Alguien'),
        isMine ? el('span', { class: 'badge badge-accent next-me' }, 'Eres tú') : null,
        target.type ? el('span', { class: 'next-type' }, target.type.label) : null,
      ]),
      el('div', { class: 't-xs t-dim' }, [
        formatBlocks([target.block]),
        crossesMidnight(target.block) ? ' (cruza medianoche)' : '',
        target.entry?.notes ? ` · ${target.entry.notes}` : '',
      ].join('')),
    ]),
    el('div', { class: 'next-when' }, [
      el('div', { class: 'countdown' }, formatRelative(minutes * 60000).replace(/^en /, 'en ')),
      el('div', { class: 't-2xs t-muted' }, formatClock(new Date(target.startsAt))),
    ]),
  ]);

  if (soon) {
    card.style.animation = 'pulse-soft 2.4s var(--ease-in-out) infinite';
  }
  box.appendChild(card);
}

/* ------------------------------------------------------------------ *
 * De guardia ahora
 * ------------------------------------------------------------------ */

function paintOnDuty(doc) {
  const box = refs.onduty;
  clear(box);

  const now = new Date();
  const onDuty = whoIsNow(doc, now);
  refs.ondutyCount.textContent = String(onDuty.length);

  if (!onDuty.length) {
    box.appendChild(el('div', { class: 'onduty-empty' }, [
      el('span', { class: 'onduty-empty-icon' }, icon('moon', 18)),
      el('div', { class: 'grow' }, [
        el('div', { class: 't-sm t-semibold' }, 'Nadie de guardia ahora mismo'),
        el('div', { class: 'field-hint' }, nextOnDutyHint(doc, now)),
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
          el('span', { class: 'onduty-name' }, duty.member?.name || 'Alguien'),
          duty.member?.id && duty.member.id === doc.meId
            ? el('span', { class: 'badge badge-accent' }, 'Eres tú')
            : null,
          duty.continued ? el('span', { class: 'badge' }, 'desde ayer') : null,
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

/* ------------------------------------------------------------------ *
 * Tus próximos turnos (lista)
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Conflictos de sincronización
 * ------------------------------------------------------------------ */

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