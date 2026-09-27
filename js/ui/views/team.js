/**
 * HORUS — js/ui/views/team.js
 * Vista «Equipo»: las personas del cuadrante, su carga de trabajo del mes en
 * foco y los avisos que conviene atender (jornada semanal superada,
 * solapamientos, días sin nadie asignado y turnos pendientes de aprobar).
 *
 * Contrato (docs/VIEW-CONTRACT.md): `mount(ctx)` se llama UNA sola vez y es
 * donde se toman las referencias del DOM y se cablean los listeners; `render()`
 * no recibe argumentos, lee el estado vivo con `getContext()` y reconstruye
 * únicamente los nodos hijos (los elementos estáticos del HTML se reutilizan).
 */

import { byId, el, clear, icon, plural } from '../../core/utils.js';
import {
  getContext, getFocusDate, invalidate, registerRenderer, setFilter,
} from '../context.js';
import { avatar, barRow, emptyState, notify, confirmAction } from '../toolkit.js';
import * as dialogs from '../dialogs.js';
import {
  analyzeMonth, findConflicts, summarizeMonth, weeklyBreakdown,
} from '../../core/coverage.js';
import {
  MIN_PER_DAY, formatDuration, formatHours, formatShortDate, monthKeyOf, todayKey,
} from '../../core/date.js';

/** Nombre de la vista; debe coincidir con context.VIEWS. */
export const VIEW = 'team';

/** Etiquetas humanas de los roles del modelo. */
const ROLE_LABEL = {
  owner: 'Propietario',
  admin: 'Administrador',
  member: 'Miembro',
  viewer: 'Solo lectura',
};

/** Insignia de los roles destacados («member» no lleva insignia). */
const ROLE_BADGE = { owner: 'badge-accent', admin: 'badge-info', viewer: 'badge' };

/** Un mes equivale a 4,33 semanas (52 semanas ÷ 12 meses). */
const WEEKS_PER_MONTH = 4.33;

/** Margen de desviación tolerado antes de marcar un aviso (±5 %). */
const TOLERANCE = 0.05;

/** A partir de este tiempo sin cubrir el aviso de huecos pasa a rojo. */
const DANGER_GAP_MINUTES = 8 * 60;

/** Nº máximo de solapamientos que se listan uno a uno. */
const MAX_CONFLICT_ALERTS = 5;

/** Referencias del DOM tomadas en `mount()`. */
let refs = null;

/* ------------------------------------------------------------------ *
 * Utilidades internas
 * ------------------------------------------------------------------ */

/** Escribe texto en un nodo si existe. */
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

/** "40 h" / "37,5 h" a partir de un número de horas. */
function hoursLabel(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n)) return '—';
  return `${String(Math.round(n * 10) / 10).replace('.', ',')} h`;
}

/** Equivalente mensual de una jornada semanal, redondeado en horas. */
function monthlyHours(weeklyHours) {
  return Math.round(Number(weeklyHours) * WEEKS_PER_MONTH);
}

/**
 * Jornada semanal de referencia de una persona: su contrato si lo tiene y, si
 * no, la jornada de los ajustes (`hours.overtimeAfter`).
 */
function weeklyTargetHours(doc, member) {
  const own = Number(member?.weeklyHours);
  if (Number.isFinite(own) && own > 0) return own;
  const fromSettings = Number(doc?.settings?.hours?.overtimeAfter);
  if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings;
  return 40;
}

/** Personas ordenadas: primero la cuenta actual (`doc.meId`) y luego por nombre. */
function orderedMembers(doc) {
  return [...(doc.members || [])].sort((a, b) => {
    if (a.id === doc.meId && b.id !== doc.meId) return -1;
    if (b.id === doc.meId && a.id !== doc.meId) return 1;
    return String(a.name || '').localeCompare(String(b.name || ''), 'es');
  });
}

/** Estado vacío de un miembro sin turnos ese mes. */
const EMPTY_MEMBER_STATS = {
  minutes: 0, shifts: 0, workDays: 0, nightMinutes: 0, weekendMinutes: 0, overnight: 0,
};

/** Abre el día indicado (o el calendario si no hay fecha concreta). */
function gotoDay(ctx, date) {
  if (date && typeof ctx.openDay === 'function') ctx.openDay(date);
  else ctx.navigate('calendar');
}

/* ------------------------------------------------------------------ *
 * Montaje
 * ------------------------------------------------------------------ */

export function mount(ctx) {
  refs = {
    sub: byId('team-sub'),
    add: byId('team-add'),
    stats: byId('team-stats'),
    count: byId('team-count'),
    list: byId('team-list'),
    workload: byId('team-workload'),
    workloadNote: byId('team-workload-note'),
    byType: byId('team-by-type'),
    alertsSection: byId('team-alerts-section'),
    alerts: byId('team-alerts'),
  };

  // «Añadir» abre el editor de personas en blanco.
  refs.add?.addEventListener('click', () => {
    dialogs.openMemberEditor(ctx, null);
  });

  registerRenderer(VIEW, render);
  render();
}

/* ------------------------------------------------------------------ *
 * Pintado
 * ------------------------------------------------------------------ */

function render() {
  if (!refs) return;
  const ctx = getContext();
  const doc = ctx.doc;

  // El mes en foco es el de la fecha compartida (calendario / cuadrante / horas).
  const monthKey = monthKeyOf(getFocusDate(todayKey()));
  const summary = summarizeMonth(doc, monthKey);
  const days = analyzeMonth(doc, monthKey);
  const from = days[0]?.date || `${monthKey}-01`;
  const to = days[days.length - 1]?.date || `${monthKey}-01`;

  // Estadísticas por persona del mes (una sola pasada).
  const byMember = new Map((summary.perMember || []).map((p) => [p.memberId, p]));
  const members = orderedMembers(doc);

  // Desglose semanal por persona: se calcula una vez y se reutiliza en las
  // tarjetas y en los avisos (weeklyBreakdown recorre las entradas del rango).
  const weeksByMember = new Map();
  for (const member of members) {
    weeksByMember.set(member.id, weeklyBreakdown(doc, { from, to, memberId: member.id }));
  }

  const conflicts = findConflicts(doc, { from, to });
  const conflictsByMember = new Map();
  for (const conflict of conflicts) {
    const id = conflict.member?.id;
    if (!id) continue;
    conflictsByMember.set(id, (conflictsByMember.get(id) || 0) + 1);
  }

  /* ---------- Subtítulo ---------- */
  const withContract = members.filter((m) => m.weeklyHours != null);
  const deviating = withContract.reduce((acc, member) => {
    const target = weeklyTargetHours(doc, member) * WEEKS_PER_MONTH * 60;
    const minutes = byMember.get(member.id)?.minutes || 0;
    if (target <= 0) return acc;
    const ratio = (minutes - target) / target;
    if (ratio > TOLERANCE) acc.over++;
    else if (ratio < -TOLERANCE) acc.under++;
    return acc;
  }, { over: 0, under: 0 });

  const subParts = [
    `${plural(members.length, 'persona', 'personas')}`,
    `${plural(summary.shifts, 'turno', 'turnos')} este mes`,
  ];
  if (withContract.length) {
    subParts.push(`${deviating.over} por encima y ${deviating.under} por debajo de su contrato`);
  }
  setText(refs.sub, subParts.join(' · '));

  /* ---------- Tarjetas de estadísticas ---------- */
  const gapDays = days.filter((day) => day.gapMin > 0);
  const uncovered = gapDays.reduce((sum, day) => sum + day.gapMin, 0);
  // Misma fórmula que coverageRate(), pero reutilizando los días ya analizados.
  const totalMinutesOfMonth = days.length * MIN_PER_DAY;
  const coveredMinutes = days.reduce((sum, day) => sum + day.coverageMin, 0);
  const rate = totalMinutesOfMonth > 0 ? coveredMinutes / totalMinutesOfMonth : 0;
  const activeCount = (doc.members || []).filter((m) => m.active !== false).length;

  const statNodes = [
    statCard({
      value: String(summary.shifts),
      label: 'Turnos asignados',
      sub: `${plural(summary.workDays, 'día trabajado', 'días trabajados')}`,
    }),
    statCard({
      value: formatDuration(summary.totalMinutes),
      label: 'Horas del equipo',
      sub: `media de ${formatDuration(summary.averageMinutesPerMember)} por persona`,
    }),
    statCard({
      value: String(summary.distinctMembers),
      label: 'Personas con turnos',
      sub: `de ${plural(activeCount, 'persona activa', 'personas activas')}`,
    }),
    statCard({
      value: String(gapDays.length),
      label: 'Días con huecos de cobertura',
      sub: gapDays.length
        ? `${formatDuration(uncovered)} sin cubrir · ${Math.round(rate * 100)} % del mes cubierto`
        : 'Cobertura completa todo el mes',
      valueClass: gapDays.length === 0 ? '' : (uncovered >= DANGER_GAP_MINUTES ? 't-danger' : 't-warning'),
    }),
  ];
  // `#team-stats` ya trae la clase .grid-3 desde el HTML: se pintan las tarjetas
  // directamente sobre él para no anidar rejillas.
  if (refs.stats) {
    clear(refs.stats);
    for (const node of statNodes) refs.stats.appendChild(node);
  }

  /* ---------- Contador de personas ---------- */
  setText(refs.count, plural(members.length, 'persona', 'personas'));

  /* ---------- Lista de personas ---------- */
  renderMemberList(ctx, doc, members, byMember, weeksByMember, conflictsByMember);

  /* ---------- Carga de trabajo ---------- */
  renderWorkload(ctx, doc, members, byMember);

  /* ---------- Reparto por tipo de turno ---------- */
  renderByType(summary);

  /* ---------- Avisos ---------- */
  renderAlerts(ctx, doc, { members, weeksByMember, conflicts, days, from, to });
}

/* ------------------------------------------------------------------ *
 * Lista de personas
 * ------------------------------------------------------------------ */

function renderMemberList(ctx, doc, members, byMember, weeksByMember, conflictsByMember) {
  if (!refs.list) return;
  clear(refs.list);

  if (!members.length) {
    refs.list.appendChild(emptyState({
      iconName: 'users',
      title: 'Todavía no hay nadie en el equipo',
      message: 'Añade a la primera persona para empezar a repartir turnos.',
      action: { label: 'Añadir persona', onClick: () => dialogs.openMemberEditor(getContext(), null) },
    }));
    return;
  }

  for (const member of members) {
    refs.list.appendChild(memberCard(ctx, doc, member, {
      stats: byMember.get(member.id) || EMPTY_MEMBER_STATS,
      weeks: weeksByMember.get(member.id) || [],
      conflicts: conflictsByMember.get(member.id) || 0,
    }));
  }
}

/** Tarjeta `.member-card` de una persona. */
function memberCard(ctx, doc, member, { stats, weeks, conflicts }) {
  const isMe = doc.meId === member.id;
  const inactive = member.active === false;
  const role = member.role || 'member';

  const card = el('div', {
    // `t-muted` da el aspecto apagado de las personas inactivas sin CSS nuevo.
    class: `member-card ${isMe ? 'is-me' : ''} ${inactive ? 't-muted' : ''}`.trim(),
  });

  card.appendChild(avatar(member, { size: 'md' }));

  const nameRow = el('div', { class: 'member-name' }, [member.name || 'Sin nombre']);
  if (ROLE_BADGE[role]) {
    nameRow.appendChild(el('span', { class: `badge ${ROLE_BADGE[role]}`, title: 'Rol en el equipo' }, ROLE_LABEL[role] || role));
  }
  if (isMe) nameRow.appendChild(el('span', { class: 'badge badge-accent' }, 'Tú'));
  if (inactive) nameRow.appendChild(el('span', { class: 'badge' }, 'Inactivo'));

  const sub = el('div', { class: 'member-sub' }, [el('span', {}, [
    `${ROLE_LABEL[role] || 'Miembro'} · `,
    `${plural(stats.shifts, 'turno', 'turnos')} · `,
    formatDuration(stats.minutes),
  ].join(''))]);

  if (member.weeklyHours != null) {
    sub.appendChild(el('span', {}, ` · de ${hoursLabel(member.weeklyHours)}`));
  }

  // Aviso por persona: primero los solapamientos (más graves) y, si no hay,
  // las semanas en que supera su jornada semanal.
  if (conflicts > 0) {
    sub.appendChild(el('span', { class: 't-warning' }, ` · ⚠ ${plural(conflicts, 'solapamiento', 'solapamientos')}`));
  } else {
    const overWeeks = countOverWeeks(weeks, weeklyTargetHours(doc, member) * 60);
    if (overWeeks > 0) {
      sub.appendChild(el('span', { class: 't-warning' }, ` · ⚠ supera su jornada en ${plural(overWeeks, 'semana', 'semanas')}`));
    }
  }

  const info = el('div', { class: 'grow' }, [nameRow, sub]);
  card.appendChild(info);

  const actions = el('div', { class: 'member-actions' });

  actions.appendChild(el('button', {
    type: 'button',
    class: 'icon-btn',
    title: `Editar a ${member.name || 'esta persona'}`,
    'aria-label': `Editar a ${member.name || 'esta persona'}`,
    onclick: () => dialogs.openMemberEditor(getContext(), member.id),
  }, icon('edit', 16)));

  if (!isMe) {
    actions.appendChild(el('button', {
      type: 'button',
      class: 'icon-btn',
      title: 'Soy yo',
      'aria-label': `Marcar a ${member.name || 'esta persona'} como mi cuenta`,
      onclick: () => {
        getContext().actions.setActiveMember(member.id);
        notify.success(`Ahora el cuadrante te destaca como ${member.name || 'esta persona'}`);
      },
    }, icon('star', 16)));
  }

  actions.appendChild(el('button', {
    type: 'button',
    class: 'icon-btn',
    title: 'Asignar turno',
    'aria-label': `Asignar un turno a ${member.name || 'esta persona'}`,
    onclick: () => dialogs.openAssignDialog(getContext(), { memberIds: [member.id] }),
  }, icon('calendar', 16)));

  card.appendChild(actions);
  return card;
}

/** Semanas (del desglose) en que se supera la jornada semanal. */
function countOverWeeks(weeks, weeklyTargetMinutes) {
  if (!weeklyTargetMinutes || weeklyTargetMinutes <= 0) return 0;
  return weeks.filter((week) => week.minutes > weeklyTargetMinutes * (1 + TOLERANCE)).length;
}

/* ------------------------------------------------------------------ *
 * Carga de trabajo y reparto por tipo
 * ------------------------------------------------------------------ */

function renderWorkload(ctx, doc, members, byMember) {
  if (!refs.workload) return;
  clear(refs.workload);

  const rows = members
    .map((member) => ({ member, minutes: byMember.get(member.id)?.minutes || 0, shifts: byMember.get(member.id)?.shifts || 0 }))
    .filter((row) => row.minutes > 0);

  if (!rows.length) {
    refs.workload.appendChild(el('p', { class: 'field-hint' }, 'Nadie tiene horas asignadas este mes.'));
    setText(refs.workloadNote, '');
    return;
  }

  // El máximo nunca es 0: evita dividir por cero dentro de barRow.
  const max = Math.max(1, ...rows.map((row) => row.minutes));

  for (const row of rows) {
    const node = barRow({
      label: row.member.name || 'Sin nombre',
      value: row.minutes,
      max,
      color: row.member.hex,
      valueText: formatHours(row.minutes),
      sub: `· ${plural(row.shifts, 'turno', 'turnos')}`,
      onClick: () => {
        // Filtra el calendario por esta persona y salta a él.
        setFilter('memberIds', [row.member.id]);
        invalidate('calendar');
        ctx.navigate('calendar');
      },
    });

    // Con contrato semanal se marca la desviación sobre el equivalente mensual.
    if (row.member.weeklyHours != null) {
      const target = Number(row.member.weeklyHours) * WEEKS_PER_MONTH * 60;
      const value = node.querySelector('.bar-value');
      if (value && target > 0) {
        const ratio = (row.minutes - target) / target;
        if (ratio > TOLERANCE) value.classList.add('t-danger');
        else if (ratio < -TOLERANCE) value.classList.add('t-warning');
      }
    }

    refs.workload.appendChild(node);
  }

  // Nota con la referencia mensual (jornada semanal × 4,33).
  const withContract = members.filter((m) => m.weeklyHours != null);
  if (withContract.length) {
    const list = withContract
      .map((m) => `${m.name || 'Sin nombre'} ${monthlyHours(m.weeklyHours)} h`)
      .join(' · ');
    setText(refs.workloadNote, `Objetivo mensual (jornada semanal × ${String(WEEKS_PER_MONTH).replace('.', ',')}): ${list}.`);
  } else {
    const fallback = weeklyTargetHours(doc, null);
    setText(refs.workloadNote, `Nadie tiene jornada semanal en su ficha: la referencia de aviso son las ${hoursLabel(fallback)} de los ajustes.`);
  }
}

function renderByType(summary) {
  if (!refs.byType) return;
  clear(refs.byType);

  const rows = summary.perType || [];
  if (!rows.length) {
    refs.byType.appendChild(el('p', { class: 'field-hint' }, 'Sin turnos asignados este mes.'));
    return;
  }

  // El tipo más cargado marca la escala (nunca 0).
  const max = Math.max(1, ...rows.map((row) => row.minutes));

  for (const row of rows) {
    refs.byType.appendChild(barRow({
      label: row.type ? row.type.label : 'Sin tipo asignado',
      value: row.minutes,
      max,
      color: row.type?.hex || 'var(--text-muted)',
      valueText: formatHours(row.minutes),
      sub: `· ${plural(row.shifts, 'turno', 'turnos')}`,
    }));
  }
}

/* ------------------------------------------------------------------ *
 * Avisos
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Fichas duplicadas: detectarlas y unirlas
 * ------------------------------------------------------------------ */

const soloNombre = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .trim().replace(/\s+/g, ' ').toUpperCase();

/** Turnos que tiene una ficha (para saber cuál conviene conservar). */
function entradasDe(doc, memberId) {
  return (doc.entries || []).filter((e) => e.memberId === memberId).length;
}

/**
 * Grupos de fichas que se llaman igual (mismo nombre normalizado).
 *
 * Solo se avisa cuando el nombre coincide EXACTAMENTE tras normalizar: unir
 * «Javier» con «Javier Pérez» a lo bruto podría juntar a dos personas distintas,
 * así que eso no se propone solo.
 */
export function gruposDuplicados(doc) {
  const porNombre = new Map();
  for (const m of doc.members || []) {
    const k = soloNombre(m.name);
    if (!k) continue;
    if (!porNombre.has(k)) porNombre.set(k, []);
    porNombre.get(k).push(m);
  }
  return [...porNombre.values()].filter((g) => g.length > 1);
}

/**
 * Une un grupo de fichas en una sola.
 *
 * Se conserva la que más turnos tiene (y si hay empate, la que es «yo»): es la
 * que casi siempre tiene los datos buenos. Los turnos de las otras se pasan a la
 * que se queda, y si una fecha ya estaba ocupada en la ficha buena NO se pisa:
 * se cuenta y se avisa, porque decidir cuál de los dos turnos vale es cosa del
 * usuario, no de la app.
 */
export async function unirFichas(ctx, doc, grupo) {
  const { actions } = ctx;
  /* Se conserva TU ficha si está en el grupo: así no se pierde quién eres y no
     hay que reapuntar `meId` (que es lo que hacía que «mi próximo turno» siguiera
     vacío después de unir). Si no eres ninguna, se conserva la que más turnos
     tiene, que es la que casi siempre trae los datos buenos. */
  const orden = [...grupo].sort((a, b) => {
    const yo = (m) => (m.id === doc.meId ? 1 : 0);
    return (yo(b) - yo(a)) || (entradasDe(doc, b.id) - entradasDe(doc, a.id));
  });
  const queda = orden[0];
  const otras = orden.slice(1);

  const ok = await confirmAction({
    title: `Unir ${grupo.length} fichas en una`,
    message: `Se conservará «${queda.name}» con sus ${plural(entradasDe(doc, queda.id), 'turno', 'turnos')}, `
      + `y se le pasarán los turnos de ${otras.map((m) => `«${m.name}»`).join(' y ')}. `
      + 'Las fichas sobrantes desaparecen. Si una fecha ya tiene turno en la ficha que se queda, se respeta el suyo.',
    confirmLabel: 'Unir',
  });
  if (!ok) return;

  const fechasDe = (id) => new Set((doc.entries || []).filter((e) => e.memberId === id).map((e) => e.date));
  const ocupadas = fechasDe(queda.id);

  let movidos = 0;
  let respetados = 0;

  ctx.batch('unir fichas duplicadas', () => {
    for (const otra of otras) {
      for (const entrada of (doc.entries || []).filter((e) => e.memberId === otra.id)) {
        if (ocupadas.has(entrada.date)) { respetados++; continue; }
        actions.setEntry({
          memberId: queda.id,
          date: entrada.date,
          typeId: entrada.typeId,
          notes: entrada.notes || undefined,
        });
        ocupadas.add(entrada.date);
        movidos++;
      }
      actions.removeMember(otra.id);
    }

    // Red de seguridad: si por lo que sea tu ficha se ha ido, «yo» pasa a ser la
    // que se queda, para que el dashboard no se quede sin saber quién eres.
    if (doc.meId !== queda.id && grupo.some((m) => m.id === doc.meId)) {
      actions.setMe(queda.id);
    }
  });

  notify.success(
    `Fichas unidas en «${queda.name}» · ${movidos} turno(s) movidos`
    + (respetados ? ` · ${respetados} fecha(s) ya tenían turno y se han respetado` : ''),
    { duration: 8000, action: { label: 'Deshacer', onClick: () => ctx.undo() } },
  );
}

function renderAlerts(ctx, doc, { members, weeksByMember, conflicts, days, from, to }) {
  if (!refs.alerts || !refs.alertsSection) return;
  clear(refs.alerts);

  /** @type {{text:string, detail?:string, serious?:boolean, action?:{label:string,onClick:Function}}[]} */
  const alerts = [];

  /* 0) FICHAS REPETIDAS.
     Al importar el cuadrante en dos dispositivos, o al importarlo dos veces (por
     PDF y con la IA, que escribe los nombres a su manera), es facil acabar con
     dos fichas de la misma persona. El sintoma tipico es ver al companero dos
     veces en el editor de un dia, con un turno distinto en cada una, y que «mi
     proximo turno» no encuentre nada porque la app apunta a la ficha vacia. */
  for (const grupo of gruposDuplicados(doc)) {
    const nombres = grupo.map((m) => `${m.name} (${plural(entradasDe(doc, m.id), 'turno', 'turnos')})`).join(' · ');
    alerts.push({
      text: `Puede haber ${grupo.length} fichas de la misma persona: ${grupo[0].name || 'sin nombre'}`,
      detail: `${nombres}. Unirlas deja una sola ficha con todos sus turnos.`,
      serious: true,
      action: { label: 'Unir fichas', onClick: () => unirFichas(ctx, doc, grupo) },
    });
  }

  // 1) Jornada semanal superada. Solo se avisa de las semanas que se pasan:
  //    las semanas parciales de los extremos del mes nunca dan falso positivo.
  for (const member of members) {
    const targetMinutes = weeklyTargetHours(doc, member) * 60;
    const weeks = weeksByMember.get(member.id) || [];
    const over = weeks.filter((week) => targetMinutes > 0 && week.minutes > targetMinutes * (1 + TOLERANCE));
    if (!over.length) continue;
    const first = over[0];
    alerts.push({
      text: `${member.name || 'Sin nombre'} supera su jornada semanal en ${plural(over.length, 'semana', 'semanas')}`,
      detail: `Semana ${first.week} (${formatShortDate(first.weekStart)}): ${formatDuration(first.minutes)} de ${formatDuration(targetMinutes)}`,
      action: { label: 'Ver día', onClick: () => gotoDay(getContext(), first.weekStart) },
    });
  }

  // 2) Solapamientos de turnos (los cinco primeros, uno por aviso).
  for (const conflict of conflicts.slice(0, MAX_CONFLICT_ALERTS)) {
    alerts.push({
      text: `Solapamiento · ${formatShortDate(conflict.date)} · ${conflict.member?.name || 'Sin persona'}`,
      detail: conflict.detail,
      serious: true,
      action: { label: 'Ver día', onClick: () => gotoDay(getContext(), conflict.date) },
    });
  }
  if (conflicts.length > MAX_CONFLICT_ALERTS) {
    alerts.push({
      text: `…y ${conflicts.length - MAX_CONFLICT_ALERTS} solapamiento(s) más este mes`,
      detail: 'Revísalos desde el calendario o el cuadrante.',
      action: { label: 'Ir al calendario', onClick: () => getContext().navigate('calendar') },
    });
  }

  // 3) Días del mes sin nadie asignado.
  const emptyDays = days.filter((day) => day.status === 'empty');
  if (emptyDays.length) {
    const sample = emptyDays.slice(0, MAX_CONFLICT_ALERTS).map((day) => formatShortDate(day.date)).join(' · ');
    alerts.push({
      text: `${plural(emptyDays.length, 'día del mes sin nadie asignado', 'días del mes sin nadie asignado')}`,
      detail: emptyDays.length > MAX_CONFLICT_ALERTS ? `${sample} · y más` : sample,
      serious: true,
      action: { label: 'Ver día', onClick: () => gotoDay(getContext(), emptyDays[0].date) },
    });
  }

  // 4) Turnos pendientes de aprobar.
  const pending = (doc.entries || []).filter((entry) => entry.date >= from && entry.date <= to && entry.approved === false);
  if (pending.length) {
    alerts.push({
      text: `${plural(pending.length, 'turno pendiente', 'turnos pendientes')} de aprobar`,
      detail: 'Apruébalos o corrígelos desde el calendario.',
      action: { label: 'Ir al calendario', onClick: () => getContext().navigate('calendar') },
    });
  }

  refs.alertsSection.hidden = alerts.length === 0;
  for (const alert of alerts) {
    refs.alerts.appendChild(el('div', {
      class: `gap-item ${alert.serious ? 'is-empty' : ''}`.trim(),
    }, [
      icon(alert.serious ? 'alert' : 'info', 16),
      el('div', { class: 'grow' }, [
        el('div', {}, alert.text),
        alert.detail ? el('div', { class: 't-2xs t-muted' }, alert.detail) : null,
      ]),
      alert.action
        ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: alert.action.onClick }, alert.action.label)
        : null,
    ]));
  }
}
