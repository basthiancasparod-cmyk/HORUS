/**
 * HORUS — js/ui/dialogs.js
 * Todos los diálogos de la aplicación: asignar un turno, editar un día, el
 * catálogo de turnos, las personas, las rotaciones y la exportación.
 *
 * Cada función `open…` recibe un contexto mínimo ({ doc, actions }) y prepara
 * el formulario; el envío llama a las acciones del store. Así ninguna vista
 * necesita conocer la estructura de los diálogos.
 */

import { byId, el, clear, icon, $$, clamp, readableOn } from '../core/utils.js';
import {
  formatLongDate, formatBlocks, blockMinutes, normalizeBlocks,
  monthDays, todayKey, addDays, monthKeyOf, DOW_SHORT, humanTime, formatDuration,
  isValidTime, minToTime, crossesMidnight, formatShortDate, timeToMin,
} from '../core/date.js';
import {
  entryBlocks, entryType, memberById, shiftTypeById, entryLabel,
  createEntry, PALETTE, NON_WORKING_CODES,
} from '../core/model.js';
import { analyzeDate, summarize, findConflicts } from '../core/coverage.js';
import * as exporter from '../core/exporter.js';
import { REGIONS, holidaysFor } from '../core/holidays.js';
import * as teams from '../core/teams.js';
import {
  openDialog, closeDialog, confirmAction, toast, notify, typeBadge, avatar,
  colorPicker, switchControl, fillSelect, readNumber, emptyState,
} from './toolkit.js';

/* ==================================================================== *
 * Utilidades internas
 * ==================================================================== */

const debounce = (fn, ms) => {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

/**
 * GUARDA DE SOLO LECTURA.
 *
 * Todos los diálogos de aquí escriben en el cuadrante. Si el rol del usuario en
 * el equipo del documento no permite escribir (`viewer`, o un rol que la app no
 * reconoce), no se abre el diálogo: se explica por qué. La seguridad de verdad
 * la impone el servidor con RLS; esto es para no ofrecer algo que va a fallar.
 *
 * Se pregunta a `core/teams.js`, que es el único sitio donde se decide qué
 * puede hacer cada rol. Así el Calendario y la vista Hoy —que abren estos
 * diálogos— quedan cubiertos sin tocar sus archivos.
 *
 * @returns {boolean} true si el diálogo NO debe abrirse
 */
function bloqueadoPorRol(ctx) {
  if (!teams.soloLectura(ctx?.doc)) return false;
  notify.warning(teams.motivoSoloLectura());
  return true;
}

/** Cablea un <dialog>: cierre con backdrop, botones [data-close] y Escape. */
export function wireDialog(dialog) {
  if (!dialog || dialog.__wired) return dialog;
  dialog.__wired = true;

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  for (const btn of $$('[data-close]', dialog)) {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      closeDialog(dialog);
    });
  }
  return dialog;
}

/** Cablea todos los diálogos declarados en el HTML. */
export function wireAllDialogs() {
  $$('dialog').forEach(wireDialog);
}

/* ==================================================================== *
 * Editor del catálogo de tipos de turno
 * ==================================================================== */

let editingTypeId = null;
let typeBlocksDraft = [];

export function openTypeEditor(ctx, typeId = null, { onSaved = null } = {}) {
  if (bloqueadoPorRol(ctx)) return;
  const { actions } = ctx;
  const dialog = byId('dialog-type');
  wireDialog(dialog);

  const type = typeId ? shiftTypeById(ctx.doc, typeId) : null;
  editingTypeId = type?.id ?? null;
  typeBlocksDraft = type ? type.blocks.map((b) => ({ ...b })) : [{ start: '09:00', end: '17:00' }];

  byId('type-title').textContent = type ? 'Editar turno' : 'Nuevo turno';
  byId('type-sub').textContent = type
    ? `Se usa en ${ctx.doc.entries.filter((e) => e.typeId === type.id).length} turno(s) del cuadrante.`
    : 'Aparecerá en el catálogo y al asignar turnos.';

  byId('type-code').value = type?.code ?? '';
  byId('type-label').value = type?.label ?? '';
  byId('type-kind').value = type?.kind ?? 'work';
  byId('type-demand').value = String(type?.demand ?? 1);

  // Selector de color
  const colorBox = byId('type-colors');
  clear(colorBox);
  colorBox.appendChild(colorPicker(
    PALETTE,
    type?.hex ?? PALETTE[ctx.doc.shiftTypes.length % PALETTE.length],
    () => {},
  ));

  renderTypeBlocks();
  syncTypeKindUi();

  const deleteBtn = byId('type-delete');
  deleteBtn.hidden = !type;
  deleteBtn.onclick = async () => {
    const used = ctx.doc.entries.filter((e) => e.typeId === type.id).length;
    const ok = await confirmAction({
      title: `¿Eliminar «${type.label}»?`,
      message: used
        ? `Hay ${used} turno(s) en el cuadrante con este tipo. No se perderán: quedarán como turnos con su horario, pero sin tipo asociado.`
        : 'Se quitará del catálogo de turnos.',
      confirmLabel: 'Eliminar',
    });
    if (!ok) return;
    actions.removeShiftType(type.id);
    closeDialog(dialog);
    notify.success(`«${type.label}» eliminado del catálogo`);
    onSaved?.();
  };

  byId('form-type').onsubmit = (event) => {
    event.preventDefault();
    const code = byId('type-code').value.trim().toUpperCase();
    const label = byId('type-label').value.trim();
    if (!code) { notify.error('El código no puede estar vacío.'); return; }
    if (!label) { notify.error('Ponle un nombre al turno.'); return; }

    const duplicated = ctx.doc.shiftTypes.find((s) => s.code === code && s.id !== editingTypeId);
    if (duplicated) { notify.error(`Ya existe un turno con el código «${code}».`); return; }

    const selected = colorBox.querySelector('[aria-pressed="true"]');
    const hex = selected
      ? PALETTE.find((c) => selected.getAttribute('aria-label') === `Color ${c}`) || PALETTE[0]
      : PALETTE[0];
    const kind = byId('type-kind').value;
    const demand = readNumber(byId('type-demand'), { min: 0, max: 99, fallback: 1 });
    const blocks = kind === 'work' ? normalizeBlocks(typeBlocksDraft) : [];

    if (kind === 'work' && !blocks.length) {
      notify.error('Un turno trabajado necesita al menos un tramo de horario válido.');
      return;
    }

    const payload = { code, label, short: code.slice(0, 4), hex, kind, demand, blocks };

    if (editingTypeId) {
      actions.updateShiftType(editingTypeId, payload);
      notify.success(`«${label}» actualizado`);
    } else {
      actions.addShiftType(payload);
      notify.success(`«${label}» añadido al catálogo`);
    }
    closeDialog(dialog);
    onSaved?.();
  };

  openDialog(dialog, { focus: byId('type-label') });
}

function syncTypeKindUi() {
  const kind = byId('type-kind').value;
  const blocksField = byId('type-blocks-field');
  const hint = byId('type-kind-hint');
  const demand = byId('type-demand');

  const texts = {
    work: 'Cuenta como horas trabajadas y ocupa hueco en la cobertura.',
    leave: 'Vacaciones: ocupa el día en el cuadrante pero no suma horas trabajadas.',
    sick: 'Baja médica: no suma horas trabajadas.',
    free: 'Descanso o libre: no suma horas y no exige cobertura.',
    rest: 'Festivo: día no laborable.',
  };
  hint.textContent = texts[kind] || '';
  blocksField.hidden = kind !== 'work';
  if (kind !== 'work') demand.value = '0';
}

/** Pinta el editor de tramos horarios de un tipo. */
function renderTypeBlocks() {
  const box = byId('type-blocks');
  clear(box);

  typeBlocksDraft.forEach((block, index) => {
    const row = el('div', { class: 'row', style: { gap: 'var(--sp-2)', alignItems: 'flex-end' } }, [
      el('div', { class: 'grow' }, [
        el('span', { class: 'field-label' }, `Inicio ${typeBlocksDraft.length > 1 ? index + 1 : ''}`.trim()),
        el('input', {
          class: 'input', type: 'time', value: block.start,
          oninput: (e) => { block.start = e.target.value; updateBlockPreview(row, block); },
        }),
      ]),
      el('div', { class: 'grow' }, [
        el('span', { class: 'field-label' }, `Fin ${typeBlocksDraft.length > 1 ? index + 1 : ''}`.trim()),
        el('input', {
          class: 'input', type: 'time', value: block.end,
          oninput: (e) => { block.end = e.target.value; updateBlockPreview(row, block); },
        }),
      ]),
      typeBlocksDraft.length > 1
        ? el('button', {
          type: 'button', class: 'icon-btn', 'aria-label': `Quitar el tramo ${index + 1}`,
          onclick: () => { typeBlocksDraft.splice(index, 1); renderTypeBlocks(); },
        }, icon('trash', 16))
        : null,
    ]);
    const preview = el('div', { class: 'field-hint' });
    row.appendChild(preview);
    updateBlockPreview(row, block);
    box.appendChild(row);
  });

  byId('type-add-block').hidden = typeBlocksDraft.length >= 4;
}

function updateBlockPreview(row, block) {
  const hint = row.lastElementChild;
  if (!isValidTime(block.start) || !isValidTime(block.end)) {
    hint.textContent = 'Horas incompletas.';
    hint.className = 'field-hint t-danger';
    return;
  }
  const minutes = blockMinutes(block);
  hint.className = 'field-hint';
  hint.textContent = crossesMidnight(block)
    ? `${formatDuration(minutes)} · cruza medianoche (termina a las ${humanTime(block.end)} del día siguiente)`
    : `${formatDuration(minutes)} de trabajo`;
}

/* ==================================================================== *
 * Editor de persona
 * ==================================================================== */

let editingMemberId = null;

export function openMemberEditor(ctx, memberId = null, { onSaved = null } = {}) {
  if (bloqueadoPorRol(ctx)) return;
  const { actions } = ctx;
  const dialog = byId('dialog-member');
  wireDialog(dialog);

  const member = memberId ? memberById(ctx.doc, memberId) : null;
  editingMemberId = member?.id ?? null;

  byId('member-title').textContent = member ? 'Editar persona' : 'Añadir persona';
  byId('member-sub').textContent = member
    ? `${ctx.doc.entries.filter((e) => e.memberId === member.id).length} turno(s) en el cuadrante.`
    : 'Se añadirá al equipo y podrás asignarle turnos.';

  byId('member-name').value = member?.name ?? '';
  byId('member-initials').value = member?.initials ?? '';
  byId('member-role').value = member?.role ?? 'member';
  byId('member-hours').value = member?.weeklyHours == null ? '' : String(member.weeklyHours);

  const isMe = member && ctx.doc.meId === member.id;
  const setMeBtn = byId('member-set-me');
  setMeBtn.textContent = isMe ? 'Eres tú' : 'Marcar';
  setMeBtn.disabled = !!isMe;
  setMeBtn.onclick = () => {
    if (!editingMemberId) { notify.warning('Guarda la persona primero.'); return; }
    actions.setActiveMember(editingMemberId);
    setMeBtn.textContent = 'Eres tú';
    setMeBtn.disabled = true;
    notify.success('Ahora el cuadrante te destaca a ti');
  };

  const activeSwitch = switchControl('member-active', member?.active !== false, () => {}, { label: 'Activo en el cuadrante' });
  byId('member-active').replaceWith(activeSwitch);

  // Selector de color
  const colorBox = byId('member-colors');
  clear(colorBox);
  const currentHex = member?.hex ?? PALETTE[ctx.doc.members.length % PALETTE.length];
  const preview = byId('member-preview');
  colorBox.appendChild(colorPicker(PALETTE, currentHex, (hex) => {
    preview.style.setProperty('--avatar-color', hex);
    preview.style.setProperty('--avatar-fg', readableOn(hex));
  }));

  const refreshPreview = () => {
    const name = byId('member-name').value.trim() || '?';
    const initials = byId('member-initials').value.trim().toUpperCase() || name.slice(0, 2).toUpperCase();
    preview.textContent = initials;
    const selected = colorBox.querySelector('[aria-pressed="true"]');
    const hex = selected
      ? PALETTE.find((c) => selected.getAttribute('aria-label') === `Color ${c}`) || currentHex
      : currentHex;
    preview.style.setProperty('--avatar-color', hex);
    preview.style.setProperty('--avatar-fg', readableOn(hex));
  };
  refreshPreview();
  byId('member-name').oninput = refreshPreview;
  byId('member-initials').oninput = refreshPreview;

  const deleteBtn = byId('member-delete');
  deleteBtn.hidden = !member;
  deleteBtn.disabled = ctx.doc.members.length <= 1;
  deleteBtn.onclick = async () => {
    const count = ctx.doc.entries.filter((e) => e.memberId === member.id).length;
    const others = ctx.doc.members.filter((m) => m.id !== member.id);
    const reassign = el('div', { class: 'field' }, [
      el('label', { class: 'field-label' }, 'Traspasar sus turnos a'),
      (() => {
        const select = el('select', { class: 'select', id: 'member-reassign' }, [
          el('option', { value: '' }, '— Borrarlos también —'),
          ...others.map((m) => el('option', { value: m.id }, m.name)),
        ]);
        return select;
      })(),
    ]);

    const ok = await confirmAction({
      title: `¿Eliminar a ${member.name}?`,
      message: `Tiene ${count} turno(s) en el cuadrante. Puedes traspasárselos a otra persona para no perderlos.`,
      confirmLabel: 'Eliminar',
      extra: count ? reassign : null,
    });
    if (!ok) return;
    const target = byId('member-reassign')?.value || null;
    actions.removeMember(member.id, { reassignTo: target });
    closeDialog(dialog);
    notify.success(target ? 'Turnos traspasados y persona eliminada' : `${member.name} eliminado del equipo`);
    onSaved?.();
  };

  byId('form-member').onsubmit = (event) => {
    event.preventDefault();
    const name = byId('member-name').value.trim();
    if (!name) { notify.error('La persona necesita un nombre.'); return; }
    const duplicated = ctx.doc.members.find((m) => m.id !== editingMemberId && m.name.toLowerCase() === name.toLowerCase());
    if (duplicated) { notify.error(`Ya hay alguien que se llama «${name}».`); return; }

    const selected = colorBox.querySelector('[aria-pressed="true"]');
    const hex = selected
      ? PALETTE.find((c) => selected.getAttribute('aria-label') === `Color ${c}`) || currentHex
      : currentHex;
    const patch = {
      name,
      initials: byId('member-initials').value.trim().toUpperCase(),
      hex,
      role: byId('member-role').value,
      weeklyHours: byId('member-hours').value.trim() === ''
        ? null
        : readNumber(byId('member-hours'), { min: 0, max: 80, fallback: null }),
      active: activeSwitch.getAttribute('aria-checked') === 'true',
    };

    if (editingMemberId) {
      actions.updateMember(editingMemberId, patch);
      notify.success('Persona actualizada');
    } else {
      actions.addMember(patch);
      notify.success(`${name} añadido al equipo`);
    }
    closeDialog(dialog);
    onSaved?.();
  };

  openDialog(dialog, { focus: byId('member-name') });
}

/* ==================================================================== *
 * Asignar un turno
 * ==================================================================== */

const assignState = {
  dates: [],
  memberIds: new Set(),
  typeId: null,
  notes: '',
  rangeMode: false,
  until: '',
  weekdays: new Set([1, 2, 3, 4, 5]),
  skipExisting: true,
};

/**
 * Abre el diálogo de asignación.
 *
 * `skipExisting` («No sobrescribir») es una red de seguridad para las
 * operaciones en LOTE: rellenar un rango entero con un patrón no debería pisar
 * lo que ya hay. Pero cuando el preset fija UN día y UN miembro —que es lo que
 * pasa al tocar una casilla del cuadrante para corregirla— sobrescribir ES la
 * intención del usuario. Con el valor por defecto, corregir un turno equivocado
 * no hacía nada y encima el aviso no explicaba por qué: un callejón sin salida.
 *
 * @param {object} ctx
 * @param {{date?:string, memberIds?:string[], typeId?:string|null, entryId?:string|null,
 *          rangeMode?:boolean, dates?:string[], skipExisting?:boolean}} [preset]
 */
export function openAssignDialog(ctx, preset = {}) {
  if (bloqueadoPorRol(ctx)) return;
  const { actions } = ctx;
  const dialog = byId('dialog-assign');
  wireDialog(dialog);

  const baseDate = preset.date || todayKey();
  assignState.dates = preset.dates?.length ? [...preset.dates] : [baseDate];
  assignState.rangeMode = !!preset.rangeMode;
  assignState.until = preset.until || addDays(baseDate, 6);
  // Es una corrección puntual (un día, una persona) si no se dice lo contrario.
  const correccionPuntual = !preset.rangeMode && assignState.dates.length === 1
    && (preset.memberIds?.length === 1);
  assignState.skipExisting = preset.skipExisting ?? !correccionPuntual;
  assignState.notes = preset.notes || '';
  assignState.memberIds = new Set(preset.memberIds?.length ? preset.memberIds : [ctx.doc.meId].filter(Boolean));
  assignState.typeId = preset.typeId ?? null;
  assignState.weekdays = new Set(preset.weekdays || [1, 2, 3, 4, 5]);

  byId('assign-sub').textContent = assignState.dates.length === 1
    ? formatLongDate(baseDate)
    : `${assignState.dates.length} días seleccionados`;

  const dateInput = byId('assign-date');
  dateInput.value = baseDate;
  byId('assign-until').value = assignState.until;
  byId('assign-notes').value = assignState.notes;
  byId('assign-repeat-details').open = assignState.rangeMode;

  // --- Personas ---
  const memberBox = byId('assign-members');
  const renderMembers = () => {
    clear(memberBox);
    const active = ctx.doc.members.filter((m) => m.active || assignState.memberIds.has(m.id));
    for (const member of active) {
      const chip = el('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(assignState.memberIds.has(member.id)),
        style: {
          '--chip-color': member.hex,
          '--chip-soft': `color-mix(in srgb, ${member.hex} 18%, transparent)`,
          '--chip-fg': member.hex,
        },
        onclick: () => {
          if (assignState.memberIds.has(member.id)) assignState.memberIds.delete(member.id);
          else assignState.memberIds.add(member.id);
          renderMembers();
          updateAssignSummary();
        },
      }, [
        el('span', { class: 'dot', style: { background: member.hex } }),
        member.name,
        ctx.doc.meId === member.id ? el('span', { class: 't-muted' }, ' (yo)') : null,
      ]);
      memberBox.appendChild(chip);
    }
  };

  // --- Tipos ---
  const typeBox = byId('assign-types');
  const renderTypes = () => {
    clear(typeBox);
    for (const type of ctx.doc.shiftTypes) {
      const chip = el('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(assignState.typeId === type.id),
        style: {
          '--chip-color': type.hex,
          '--chip-soft': `color-mix(in srgb, ${type.hex} 18%, transparent)`,
          '--chip-fg': type.hex,
        },
        onclick: () => {
          assignState.typeId = assignState.typeId === type.id ? null : type.id;
          renderTypes();
          updateAssignSummary();
        },
      }, [
        el('span', { class: 'dot', style: { background: type.hex } }),
        type.label,
        type.blocks.length ? el('span', { class: 't-muted t-2xs' }, formatBlocks(type.blocks)) : null,
      ]);
      typeBox.appendChild(chip);
    }
    // Opción explícita de "quitar el turno"
    typeBox.appendChild(el('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(assignState.typeId === null),
      onclick: () => { assignState.typeId = null; renderTypes(); updateAssignSummary(); },
    }, [icon('close', 14), 'Sin turno']));
  };

  // --- Días de la semana ---
  const weekBox = byId('assign-weekdays');
  const renderWeekdays = () => {
    clear(weekBox);
    for (let i = 0; i < 7; i++) {
      const dow = (i + 1) % 7; // empieza en lunes
      weekBox.appendChild(el('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(assignState.weekdays.has(dow)),
        onclick: () => {
          if (assignState.weekdays.has(dow)) assignState.weekdays.delete(dow);
          else assignState.weekdays.add(dow);
          renderWeekdays();
          updateAssignSummary();
        },
      }, DOW_SHORT[i]));
    }
  };

  const skipSwitch = switchControl('assign-skip', assignState.skipExisting, (v) => { assignState.skipExisting = v; }, { label: 'No sobrescribir' });
  byId('assign-skip').replaceWith(skipSwitch);

  const summary = el('p', { class: 'field-hint', id: 'assign-summary' });
  byId('assign-repeat-details').after(summary);

  function updateAssignSummary() {
    const count = countTargetDays();
    const people = assignState.memberIds.size;
    if (!people) { summary.textContent = 'Elige al menos una persona.'; return; }
    if (assignState.rangeMode) {
      summary.textContent = count
        ? `Se asignará a ${people} persona(s) en ${count} día(s).`
        : 'Ningún día del rango coincide con los días marcados.';
    } else {
      summary.textContent = `Se asignará a ${people} persona(s).`;
    }
  }

  /** Días que se verán afectados según el rango y los días marcados. */
  function targetDates() {
    if (!assignState.rangeMode) return assignState.dates.length ? [...assignState.dates] : [dateInput.value];
    const from = dateInput.value || todayKey();
    const to = byId('assign-until').value || from;
    if (to < from) return [];
    const out = [];
    let cursor = from;
    let guard = 0;
    while (cursor <= to && guard++ < 800) {
      const dow = new Date(`${cursor}T00:00:00`).getDay();
      if (assignState.weekdays.has(dow)) out.push(cursor);
      cursor = addDays(cursor, 1);
    }
    return out;
  }

  function countTargetDays() {
    return targetDates().length;
  }

  byId('assign-all').onclick = () => {
    assignState.memberIds = new Set(ctx.doc.members.filter((m) => m.active).map((m) => m.id));
    renderMembers();
    updateAssignSummary();
  };
  byId('assign-none').onclick = () => {
    assignState.memberIds.clear();
    renderMembers();
    updateAssignSummary();
  };
  byId('assign-today').onclick = () => { dateInput.value = todayKey(); updateAssignSummary(); };
  dateInput.onchange = updateAssignSummary;
  byId('assign-until').onchange = updateAssignSummary;
  byId('assign-repeat-details').ontoggle = () => {
    assignState.rangeMode = byId('assign-repeat-details').open;
    updateAssignSummary();
  };

  renderMembers();
  renderTypes();
  renderWeekdays();
  updateAssignSummary();

  byId('form-assign').onsubmit = async (event) => {
    event.preventDefault();
    if (!assignState.memberIds.size) { notify.error('Elige al menos una persona.'); return; }
    const dates = targetDates();
    if (!dates.length) { notify.error('No hay ningún día seleccionado.'); return; }

    const memberIds = [...assignState.memberIds];
    const typeId = assignState.typeId;
    const notes = byId('assign-notes').value.trim();
    const type = typeId ? shiftTypeById(ctx.doc, typeId) : null;
    const label = type ? type.label : 'Sin turno';

    let changed = 0;
    let yaTenían = 0;
    ctx.batch(`asignar ${label}`, () => {
      for (const date of dates) {
        for (const memberId of memberIds) {
          const ocupado = ctx.doc.entries.some((e) => e.memberId === memberId && e.date === date);
          if (assignState.skipExisting && ocupado) {
            yaTenían++;
            continue;
          }
          const ok = actions.setEntry({ memberId, date, typeId, notes: notes || undefined });
          if (ok) changed++;
        }
      }
    });

    /* Si no se cambió nada PORQUE los días ya tenían turno, no se deja al usuario
       mirando un aviso que no explica nada: se le ofrece reemplazarlos ahí mismo.
       Antes salía «No se cambió nada: esos días ya tenían turno» y ahí se acababa
       todo, sin decir que el interruptor «No sobrescribir» era el culpable. */
    if (!changed && yaTenían) {
      const ok = await confirmAction({
        title: 'Esos días ya tienen turno',
        message: `${yaTenían} día(s) ya tenían turno y está activado «No sobrescribir». `
          + `¿Quieres reemplazarlos por «${label}»?`,
        confirmLabel: 'Reemplazar',
        danger: true,
      });
      if (!ok) return;

      ctx.batch(`reemplazar ${label}`, () => {
        for (const date of dates) {
          for (const memberId of memberIds) {
            const ok2 = actions.setEntry({ memberId, date, typeId, notes: notes || undefined });
            if (ok2) changed++;
          }
        }
      });
      if (!changed) {
        notify.warning('No había nada que reemplazar.');
        return;
      }
    } else if (!changed) {
      notify.warning('No había nada que cambiar.');
      return;
    }

    closeDialog(dialog);
    const people = `${memberIds.length} persona${memberIds.length === 1 ? '' : 's'}`;
    const days = `${dates.length} día${dates.length === 1 ? '' : 's'}`;
    notify.success(`${label} · ${people} · ${days}`, {
      action: { label: 'Deshacer', onClick: () => ctx.undo() },
    });
  };

  openDialog(dialog, { focus: null });
}

/* ==================================================================== *
 * Editar un día completo
 * ==================================================================== */

let dayEditorDate = null;

export function openDayEditor(ctx, date) {
  if (bloqueadoPorRol(ctx)) return;
  const { actions } = ctx;
  const dialog = byId('dialog-day');
  wireDialog(dialog);
  dayEditorDate = date;

  const meta = ctx.doc.dayMeta?.[date];
  byId('day-title').textContent = formatLongDate(date);
  byId('day-sub').textContent = describeDaySubtitle(ctx.doc, date);
  byId('day-notes').value = meta?.notes || '';
  byId('day-label').value = meta?.label || '';
  byId('day-demand').value = meta?.demandOverride == null ? '' : String(meta.demandOverride);

  const marksBox = byId('day-clear-marks');
  const holidayBtn = byId('day-mark-holiday');
  const eventBtn = byId('day-mark-event');

  const syncMarks = () => {
    const current = ctx.doc.dayMeta?.[date]?.dayType || 'normal';
    holidayBtn.classList.toggle('btn-primary', current === 'holiday');
    eventBtn.classList.toggle('btn-primary', current === 'event');
    marksBox.hidden = current === 'normal';
  };
  syncMarks();

  holidayBtn.onclick = () => {
    const current = ctx.doc.dayMeta?.[date]?.dayType;
    actions.setDayMeta(date, { dayType: current === 'holiday' ? 'normal' : 'holiday', label: current === 'holiday' ? '' : (byId('day-label').value || 'Festivo') });
    syncMarks();
    renderDayEditor(ctx);
  };
  eventBtn.onclick = () => {
    const current = ctx.doc.dayMeta?.[date]?.dayType;
    actions.setDayMeta(date, { dayType: current === 'event' ? 'normal' : 'event', label: current === 'event' ? '' : (byId('day-label').value || 'Evento') });
    syncMarks();
    renderDayEditor(ctx);
  };
  marksBox.onclick = () => {
    actions.setDayMeta(date, { dayType: 'normal', label: '' });
    syncMarks();
    renderDayEditor(ctx);
  };

  renderDayEditor(ctx);

  byId('day-add-entry').onclick = () => {
    openAssignDialog(ctx, { date, memberIds: [] });
  };

  byId('day-save').onclick = () => {
    actions.setDayMeta(date, {
      label: byId('day-label').value.trim(),
      notes: byId('day-notes').value.trim(),
      demandOverride: byId('day-demand').value === '' ? null : Number(byId('day-demand').value),
      dayType: ctx.doc.dayMeta?.[date]?.dayType || 'normal',
    });
    closeDialog(dialog);
    notify.success('Día guardado');
  };

  byId('day-delete').onclick = async () => {
    const entries = ctx.doc.entries.filter((e) => e.date === date);
    const ok = await confirmAction({
      title: '¿Borrar este día?',
      message: entries.length
        ? `Se quitarán ${entries.length} turno(s) y también la marca y las notas del día.`
        : 'Se quitará la marca y las notas del día.',
      confirmLabel: 'Borrar',
    });
    if (!ok) return;
    ctx.batch('borrar el día', () => {
      actions.removeEntriesInRange({ from: date, to: date });
      if (ctx.doc.dayMeta?.[date]) actions.setDayMeta(date, { dayType: 'normal', label: '', notes: '', demandOverride: null });
    });
    closeDialog(dialog);
    notify.success('Día borrado', { action: { label: 'Deshacer', onClick: () => ctx.undo() } });
  };

  byId('form-day').onsubmit = (event) => { event.preventDefault(); byId('day-save').click(); };

  openDialog(dialog);
}

function describeDaySubtitle(doc, date) {
  const analysis = analyzeDate(doc, date);
  const parts = [];
  if (analysis.isHoliday) parts.push(doc.dayMeta?.[date]?.label || 'Festivo');
  // Se cuentan los turnos que EMPIEZAN este día. Las continuaciones de ayer no son
  // turnos de hoy: si se contaran, el mismo turno de madrugada sumaría dos veces.
  const empiezanHoy = analysis.projections.filter((p) => p.entry?.date === date).length;
  parts.push(`${empiezanHoy} turno${empiezanHoy === 1 ? '' : 's'}`);
  if (analysis.gapMin > 0) parts.push(`${formatDuration(analysis.gapMin)} sin cubrir`);
  else if (analysis.headsOnShift) parts.push('cobertura completa');
  return parts.join(' · ');
}

/** Repinta el contenido variable del editor de día. */
function renderDayEditor(ctx) {
  const actions = ctx.actions;
  const date = dayEditorDate;
  if (!date) return;

  const analysis = analyzeDate(ctx.doc, date);

  // --- Cobertura del día ---
  const coverageBox = byId('day-coverage');
  clear(coverageBox);
  coverageBox.appendChild(renderCoverageStrip(analysis));

  // --- Lista de turnos ---
  const box = byId('day-entries');
  clear(box);

  /* SOLO los turnos que EMPIEZAN este día.
     `analysis.projections` trae además los de ayer que cruzan la medianoche hasta
     esta madrugada, y esos NO son turnos de hoy: listarlos hacía que el compañero
     apareciera dos veces con el mismo turno. Se editan en el día al que pertenecen.
     La cobertura sí sigue contando con ellos: de 00:00 a la hora de fin hay alguien
     trabajando, y eso no cambia. */
  const deHoy = analysis.projections
    .filter((p) => p.entry?.date === date)
    .sort((a, b) => (a.isWork === b.isWork ? 0 : a.isWork ? -1 : 1));

  if (!deHoy.length) {
    box.appendChild(emptyState({
      iconName: 'calendar',
      title: 'Nadie empieza turno este día',
      message: 'Usa «Añadir un turno» para asignar el primero.',
    }));
    return;
  }

  for (const projection of deHoy) {
    box.appendChild(renderEntryRow(ctx, projection, () => renderDayEditor(ctx)));
  }

  void actions;
}

/** Fila editable de un turno dentro del editor de día. */
function renderEntryRow(ctx, projection, refresh) {
  const actions = ctx.actions;
  const { entry, member, type, isWork } = projection;
  const blocks = entryBlocks(ctx.doc, entry);
  const own = Array.isArray(entry.blocks) && entry.blocks.length > 0;

  const row = el('div', { class: 'card', style: { padding: 'var(--sp-3)' } });

  const header = el('div', { class: 'row', style: { gap: 'var(--sp-3)' } }, [
    avatar(member, { size: 'sm' }),
    el('div', { class: 'grow', style: { minWidth: '0' } }, [
      el('div', { class: 't-md t-semibold t-truncate' }, member?.name || 'Sin persona'),
      el('div', { class: 't-xs t-dim' }, [
        type ? type.label : (blocks.length ? 'Turno suelto' : 'Sin turno'),
        blocks.length ? ` · ${formatBlocks(blocks)}` : '',
        own ? ' · horario propio' : '',
      ].join('')),
    ]),
    type ? typeBadge(type, { overnight: crossesMidnight(blocks[0]) }) : null,
  ]);
  row.appendChild(header);

  // Selector rápido de tipo
  const chipRow = el('div', { class: 'chip-row', style: { marginTop: 'var(--sp-3)' } });
  for (const t of ctx.doc.shiftTypes) {
    chipRow.appendChild(el('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(entry.typeId === t.id),
      style: {
        '--chip-color': t.hex,
        '--chip-soft': `color-mix(in srgb, ${t.hex} 18%, transparent)`,
        '--chip-fg': t.hex,
      },
      onclick: () => {
        actions.setEntry({ memberId: entry.memberId, date: entry.date, typeId: t.id, keepNotes: true });
        refresh();
      },
    }, [el('span', { class: 'dot', style: { background: t.hex } }), t.code]));
  }
  chipRow.appendChild(el('button', {
    type: 'button',
    class: 'chip',
    'aria-pressed': String(!entry.typeId),
    onclick: () => {
      actions.setEntry({ memberId: entry.memberId, date: entry.date, typeId: null, keepNotes: true });
      refresh();
    },
  }, 'Sin turno'));
  row.appendChild(chipRow);

  // Horario propio (solo para turnos que cuentan horas)
  if (isWork) {
    const details = el('details', { style: { marginTop: 'var(--sp-3)' } });
    details.appendChild(el('summary', { class: 't-xs t-dim', style: { cursor: 'pointer' } },
      own ? 'Horario propio de este día' : 'Cambiar el horario solo este día'));
    const editor = el('div', { class: 'stack-sm', style: { marginTop: 'var(--sp-2)' } });

    const draft = blocks.length ? blocks.map((b) => ({ ...b })) : [{ start: '09:00', end: '17:00' }];

    const paint = () => {
      clear(editor);
      draft.forEach((block, index) => {
        editor.appendChild(el('div', { class: 'row', style: { gap: 'var(--sp-2)' } }, [
          el('input', {
            class: 'input', type: 'time', value: block.start, 'aria-label': `Inicio ${index + 1}`,
            onchange: (e) => { draft[index].start = e.target.value; },
          }),
          el('input', {
            class: 'input', type: 'time', value: block.end, 'aria-label': `Fin ${index + 1}`,
            onchange: (e) => { draft[index].end = e.target.value; },
          }),
          draft.length > 1
            ? el('button', {
              type: 'button', class: 'icon-btn', 'aria-label': 'Quitar tramo',
              onclick: () => { draft.splice(index, 1); paint(); },
            }, icon('trash', 15))
            : null,
        ]));
      });

      editor.appendChild(el('div', { class: 'row', style: { gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' } }, [
        el('button', {
          type: 'button', class: 'btn btn-sm',
          onclick: () => { draft.push({ start: '09:00', end: '17:00' }); paint(); },
        }, 'Añadir tramo'),
        el('span', { class: 'grow' }),
        own
          ? el('button', {
            type: 'button', class: 'btn btn-sm btn-ghost',
            onclick: () => {
              actions.updateEntry(entry.id, { blocks: null });
              notify.success('Este día vuelve a usar el horario del catálogo');
              refresh();
            },
          }, 'Volver al del catálogo')
          : null,
        el('button', {
          type: 'button', class: 'btn btn-sm btn-primary',
          onclick: () => {
            const clean = normalizeBlocks(draft);
            if (!clean.length) { notify.error('El horario no es válido.'); return; }
            actions.updateEntry(entry.id, { blocks: clean });
            notify.success('Horario de este día guardado');
            refresh();
          },
        }, 'Guardar horario'),
      ]));
    };
    paint();
    details.appendChild(editor);
    row.appendChild(details);
  }

  // Acciones
  const actions_row = el('div', { class: 'row', style: { gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' } }, [
    el('button', {
      type: 'button', class: 'btn btn-sm btn-ghost',
      onclick: () => {
        actions.toggleApproved(entry.id);
        refresh();
      },
    }, [icon(entry.approved === false ? 'alert' : 'check', 14), entry.approved === false ? 'Pendiente' : 'Aprobado']),
    el('span', { class: 'grow' }),
    el('button', {
      type: 'button', class: 'btn btn-sm btn-ghost t-danger',
      onclick: () => {
        actions.removeEntries({ memberId: entry.memberId, date: entry.date });
        notify.success('Turno quitado', { action: { label: 'Deshacer', onClick: () => ctx.undo() } });
        refresh();
      },
    }, [icon('trash', 14), 'Quitar']),
  ]);
  row.appendChild(actions_row);

  return row;
}

/* ==================================================================== *
 * Barra de cobertura reutilizable
 * ==================================================================== */

/** Barra horizontal de 24 h con los tramos cubiertos y los huecos. */
export function renderTimeline(analysis, { height = 22, showHourMarks = false } = {}) {
  const track = el('div', {
    class: 'day-track',
    style: { height: `${height}px`, position: 'relative' },
    role: 'img',
    'aria-label': describeCoverage(analysis),
  });

  for (const interval of analysis.intervals) {
    if (interval.count <= 0) continue;
    const left = (interval.start / 1440) * 100;
    const width = ((interval.end - interval.start) / 1440) * 100;
    // El color lo pone la primera persona del tramo: así se ve de un vistazo
    // quién está cubriendo cada momento del día.
    const color = interval.members[0]?.hex || '#8a93a8';
    track.appendChild(el('div', {
      class: 'block',
      style: {
        left: `${left}%`,
        width: `${width}%`,
        '--type-color': color,
        '--type-fg': readableOn(color),
      },
      title: `${minLabel(interval.start)}–${minLabel(interval.end)} · ${interval.count} persona(s)`,
    }));
  }

  if (showHourMarks) {
    for (let h = 3; h < 24; h += 3) {
      track.appendChild(el('div', {
        style: {
          position: 'absolute', left: `${(h / 24) * 100}%`, top: 0, bottom: 0,
          width: '1px', background: 'var(--grid-line-strong)', pointerEvents: 'none',
        },
      }));
    }
  }
  return track;
}

/** Texto alternativo que describe la cobertura (accesibilidad). */
function describeCoverage(analysis) {
  if (!analysis.workMinutes) return 'Sin turnos este día';
  const parts = [`${analysis.headsOnShift} persona(s) trabajando`];
  if (analysis.gapMin > 0) parts.push(`${formatDuration(analysis.gapMin)} sin cubrir`);
  return parts.join(', ');
}

/** Barra compacta de cobertura (verde cubierto / ámbar hueco / rojo vacío). */
export function renderCoverageStrip(analysis) {
  const strip = el('div', {
    class: 'coverage-strip',
    style: { height: '20px' },
    role: 'img',
    'aria-label': describeCoverage(analysis),
  });
  for (const interval of analysis.intervals) {
    const left = (interval.start / 1440) * 100;
    const width = ((interval.end - interval.start) / 1440) * 100;
    const cls = interval.count === 0 ? 'none' : (interval.status === 'ok' || interval.status === 'over' ? 'covered' : 'gap');
    strip.appendChild(el('div', {
      class: cls,
      style: { left: `${left}%`, width: `${width}%` },
      title: `${minLabel(interval.start)}–${minLabel(interval.end)} · ${interval.count} de ${interval.required} requeridas`,
    }));
  }
  return strip;
}

/** Texto de resumen de la cobertura de un día. */
export function coverageSummary(analysis) {
  if (!analysis.working.length) return 'Sin turnos asignados';
  if (analysis.gapMin === 0) return `${formatDuration(analysis.coverageMin)} cubiertas, sin huecos`;
  return `${formatDuration(analysis.coverageMin)} cubiertas · ${formatDuration(analysis.gapMin)} sin cubrir`;
}

/* ==================================================================== *
 * Rotaciones
 * ==================================================================== */

let patternCycle = [];
let patternId = null;

export function openPatternDialog(ctx, { memberId = null, mode = 'pattern' } = {}) {
  if (bloqueadoPorRol(ctx)) return;
  const { actions } = ctx;
  const dialog = byId('dialog-pattern');
  wireDialog(dialog);

  const isRotate = mode === 'rotate';
  byId('pattern-title').textContent = isRotate ? 'Rotar turnos' : 'Aplicar rotación';
  dialog.querySelector('.dialog-header .sub').textContent = isRotate
    ? 'Cada persona recibe el cuadrante de la siguiente en la lista.'
    : 'Repite un ciclo de turnos durante un periodo.';

  patternCycle = [];
  patternId = null;

  fillSelect(byId('pattern-member'), ctx.doc.members.filter((m) => m.active).map((m) => ({ value: m.id, label: m.name })), { selected: memberId || ctx.doc.meId });
  fillSelect(byId('pattern-saved'), [
    { value: '', label: '— Crear una nueva —' },
    ...ctx.doc.patterns.map((p) => ({ value: p.id, label: p.name })),
  ]);
  fillSelect(byId('pattern-add-type'), [
    { value: '', label: 'Añadir turno al ciclo…' },
    ...ctx.doc.shiftTypes.map((t) => ({ value: t.id, label: `${t.code} · ${t.label}` })),
    { value: '__none__', label: '— Libre (sin turno) —' },
  ]);

  const today = todayKey();
  byId('pattern-from').value = today;
  byId('pattern-to').value = addDays(today, 27);
  byId('pattern-name').value = '';
  byId('pattern-step').value = '1';

  const saveSwitch = switchControl('pattern-save', true, () => {}, { label: 'Guardar la rotación' });
  byId('pattern-save').replaceWith(saveSwitch);

  // Rotar y aplicar comparten diálogo pero cambian el formulario
  $$('#dialog-pattern .field, #dialog-pattern .setting-row').forEach((node) => { node.hidden = false; });
  if (isRotate) {
    byId('pattern-cycle').closest('.field').hidden = true;
    byId('pattern-step').closest('.field').hidden = true;
    byId('pattern-name').closest('.field').hidden = true;
    byId('pattern-saved').closest('.field').hidden = true;
    byId('pattern-save').closest('.setting-row').hidden = true;
    byId('pattern-member').closest('.field').hidden = true;
    byId('pattern-apply').textContent = 'Rotar';
  } else {
    byId('pattern-apply').textContent = 'Aplicar';
  }

  const renderCycle = () => {
    const box = byId('pattern-cycle');
    clear(box);
    patternCycle.forEach((step, index) => {
      const type = step.typeId ? shiftTypeById(ctx.doc, step.typeId) : null;
      const hex = type?.hex || '#8a93a8';
      box.appendChild(el('button', {
        type: 'button',
        class: 'chip',
        style: { '--chip-color': hex, '--chip-soft': `color-mix(in srgb, ${hex} 18%, transparent)`, '--chip-fg': hex },
        title: 'Pulsa para quitarlo del ciclo',
        onclick: () => { patternCycle.splice(index, 1); renderCycle(); },
      }, [
        el('span', { class: 'dot', style: { background: hex } }),
        `${index + 1}. ${type?.code || 'Libre'}`,
      ]));
    });

    const hint = byId('pattern-cycle-hint');
    if (!patternCycle.length) {
      hint.textContent = 'Sin pasos en el ciclo. Añade al menos uno.';
    } else {
      const stepDays = readNumber(byId('pattern-step'), { min: 1, max: 30, fallback: 1 });
      const totalDays = patternCycle.length * stepDays;
      hint.textContent = `${patternCycle.length} paso(s) × ${stepDays} día(s) = el ciclo se repite cada ${totalDays} día(s).`;
    }
  };

  byId('pattern-add').onclick = () => {
    const select = byId('pattern-add-type');
    const value = select.value;
    if (!value) return;
    patternCycle.push({ typeId: value === '__none__' ? null : value });
    select.value = '';
    renderCycle();
  };

  byId('pattern-step').oninput = renderCycle;

  byId('pattern-saved').onchange = () => {
    const chosen = ctx.doc.patterns.find((p) => p.id === byId('pattern-saved').value);
    if (!chosen) { patternCycle = []; patternId = null; renderCycle(); return; }
    patternId = chosen.id;
    patternCycle = chosen.cycle.map((c) => ({ ...c }));
    byId('pattern-name').value = chosen.name;
    byId('pattern-step').value = String(chosen.stepDays || 1);
    byId('pattern-from').value = chosen.startDate || todayKey();
    renderCycle();
  };

  byId('form-pattern').onsubmit = (event) => {
    event.preventDefault();
    const from = byId('pattern-from').value;
    const to = byId('pattern-to').value;
    if (!from || !to) { notify.error('Indica el periodo.'); return; }
    if (to < from) { notify.error('La fecha final es anterior a la inicial.'); return; }

    if (isRotate) {
      const ids = ctx.doc.members.filter((m) => m.active).map((m) => m.id);
      if (ids.length < 2) { notify.error('Hacen falta al menos dos personas para rotar.'); return; }
      const changed = actions.rotateTeam({ memberIds: ids, from, to, direction: 1 });
      closeDialog(dialog);
      notify.success(changed ? `${changed} turno(s) rotados` : 'No había turnos que rotar', {
        action: { label: 'Deshacer', onClick: () => ctx.undo() },
      });
      return;
    }

    if (!patternCycle.length) { notify.error('Añade al menos un turno al ciclo.'); return; }
    const memberId2 = byId('pattern-member').value;
    const stepDays = readNumber(byId('pattern-step'), { min: 1, max: 30, fallback: 1 });
    const savePattern = saveSwitch.getAttribute('aria-checked') === 'true';
    const name = byId('pattern-name').value.trim() || 'Rotación';

    let useId = patternId;
    if (savePattern) {
      if (useId) {
        actions.updatePattern(useId, { name, cycle: patternCycle, stepDays, startDate: from });
      } else {
        const created = actions.addPattern({ name, cycle: patternCycle, stepDays, startDate: from });
        useId = created.id;
      }
    }

    let changed = 0;
    if (useId) {
      changed = actions.applyPattern({ patternId: useId, memberId: memberId2, from, to });
    } else {
      // Sin guardar: se calcula al vuelo
      ctx.batch('aplicar rotación', () => {
        let cursor = from;
        let guard = 0;
        const fromMs = Date.parse(`${from}T00:00:00`);
        const startMs = Date.parse(`${from}T00:00:00`);
        while (cursor <= to && guard++ < 800) {
          const offset = Math.round((Date.parse(`${cursor}T00:00:00`) - startMs) / 86400000);
          const index = ((Math.floor(offset / stepDays) % patternCycle.length) + patternCycle.length) % patternCycle.length;
          const typeId = patternCycle[index]?.typeId ?? null;
          if (actions.setEntry({ memberId: memberId2, date: cursor, typeId })) changed++;
          cursor = addDays(cursor, 1);
        }
        void fromMs;
      });
    }

    closeDialog(dialog);
    notify.success(changed ? `${changed} día(s) rellenados` : 'No se cambió nada', {
      action: { label: 'Deshacer', onClick: () => ctx.undo() },
    });
  };

  renderCycle();
  openDialog(dialog);
}

/* ==================================================================== *
 * Exportar
 * ==================================================================== */

const EXPORT_FORMATS = [
  { id: 'csv', label: 'CSV para Excel', desc: 'Una fila por turno. Ideal para nóminas o para revisar en una hoja de cálculo.', ext: 'csv', mime: 'text/csv;charset=utf-8' },
  { id: 'summary', label: 'Resumen de horas (CSV)', desc: 'Horas, turnos y noches por persona. Para control horario.', ext: 'csv', mime: 'text/csv;charset=utf-8' },
  { id: 'ics', label: 'Calendario (.ics)', desc: 'Para suscribirte desde Google Calendar, Outlook o Apple Calendar.', ext: 'ics', mime: 'text/calendar;charset=utf-8' },
  { id: 'txt', label: 'Texto para el grupo', desc: 'Cuadrante legible para pegar en WhatsApp o Telegram.', ext: 'txt', mime: 'text/plain;charset=utf-8' },
  { id: 'coverage', label: 'Informe de cobertura', desc: 'Días con huecos, solapamientos y porcentaje de cobertura.', ext: 'txt', mime: 'text/plain;charset=utf-8' },
  { id: 'json', label: 'Copia de seguridad (JSON)', desc: 'Todo el cuadrante y la configuración. Sirve para restaurar.', ext: 'json', mime: 'application/json;charset=utf-8' },
];

export function openExportDialog(ctx, { from = null, to = null, presetMemberIds = null } = {}) {
    const dialog = byId('dialog-export');
  wireDialog(dialog);

  const today = todayKey();
  const monthStart = `${monthKeyOf(today)}-01`;
  const monthEnd = monthDays(monthKeyOf(today)).slice(-1)[0];

  byId('export-from').value = from || monthStart;
  byId('export-to').value = to || monthEnd;
  byId('export-sub').textContent = `${ctx.doc.members.filter((m) => m.active).length} personas · ${ctx.doc.entries.length} turnos en total`;

  let selectedFormat = 'csv';

  const formatsBox = byId('export-formats');
  clear(formatsBox);
  for (const format of EXPORT_FORMATS) {
    const check = el('span', { class: 'check' }, icon('check', 16));
    const row = el('button', {
      type: 'button',
      class: 'setting-row is-clickable',
      style: { width: '100%', textAlign: 'left' },
      'aria-pressed': String(format.id === selectedFormat),
      onclick: () => {
        selectedFormat = format.id;
        $$('#export-formats .setting-row').forEach((node) => node.setAttribute('aria-pressed', 'false'));
        row.setAttribute('aria-pressed', 'true');
        updatePreview();
      },
    }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'label' }, format.label),
        el('div', { class: 'sub' }, format.desc),
      ]),
      check,
    ]);
    formatsBox.appendChild(row);
  }

  const memberIds = presetMemberIds;

  function buildContent() {
    const doc = ctx.doc;
    const fromKey = byId('export-from').value || monthStart;
    const toKey = byId('export-to').value || monthEnd;
    switch (selectedFormat) {
      case 'csv': return exporter.rangeToCSV(doc, { from: fromKey, to: toKey, memberIds });
      case 'summary': return exporter.summaryToCSV(doc, fromKey, toKey);
      case 'ics': return exporter.rangeToICal(doc, { from: fromKey, to: toKey, memberIds, alarms: true });
      case 'txt': return exporter.rangeToText
        ? exporter.rangeToText(doc, { from: fromKey, to: toKey, memberIds })
        : exporter.monthToText(doc, monthKeyOf(fromKey), { memberIds });
      case 'coverage': return exporter.monthCoverageToText(doc, monthKeyOf(fromKey));
      case 'json': return exporter.backupToJson(doc);
      default: return '';
    }
  }

  const updatePreview = debounce(() => {
    try {
      const content = buildContent();
      const lines = content.split('\n').slice(0, 40).join('\n');
      byId('export-preview').textContent = lines + (content.split('\n').length > 40 ? '\n…' : '');
    } catch (err) {
      byId('export-preview').textContent = `No se pudo generar la vista previa: ${err.message}`;
    }
  }, 150);

  byId('export-from').onchange = updatePreview;
  byId('export-to').onchange = updatePreview;
  updatePreview();

  byId('export-download').onclick = () => {
    const fromKey = byId('export-from').value || monthStart;
    const toKey = byId('export-to').value || monthEnd;
    const format = EXPORT_FORMATS.find((f) => f.id === selectedFormat);
    const content = buildContent();
    const name = `horus-${selectedFormat}-${fromKey}_${toKey}.${format.ext}`;

    // La descarga se dispara desde utils para no duplicar lógica
    import('../core/utils.js').then(({ downloadText }) => {
      downloadText(name, content, format.mime);
      notify.success(`${format.label} descargado`);
      closeDialog(dialog);
    });
  };

  openDialog(dialog);
}

/* ==================================================================== *
 * Recuperar una copia de seguridad
 * ==================================================================== */

export async function openBackupRestoreDialog(ctx, backups, onRestore) {
  if (!backups.length) {
    notify.info('Todavía no hay versiones anteriores guardadas.');
    return;
  }

  const list = el('div', { class: 'stack-sm' });
  let chosen = { slot: backups[0].slot };

  for (const backup of backups) {
    const when = backup.savedAt
      ? new Date(backup.savedAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })
      : 'fecha desconocida';
    const row = el('button', {
      type: 'button',
      class: 'setting-row is-clickable',
      style: { width: '100%', textAlign: 'left' },
      'aria-pressed': String(chosen.slot === backup.slot),
      onclick: () => {
        chosen = { slot: backup.slot };
        $$('button', list).forEach((node) => node.setAttribute('aria-pressed', 'false'));
        row.setAttribute('aria-pressed', 'true');
      },
    }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'label' }, when),
        el('div', { class: 'sub' }, `${backup.entries} turnos · ${backup.members} personas`),
      ]),
      el('span', { class: 'check' }, icon('check', 16)),
    ]);
    list.appendChild(row);
  }

  const ok = await confirmAction({
    title: 'Recuperar una versión anterior',
    message: 'Se reemplazará el cuadrante actual por la versión elegida. Podrás deshacerlo justo después.',
    confirmLabel: 'Recuperar',
    danger: false,
    extra: list,
  });
  if (!ok) return;
  onRestore(chosen.slot);
}

/* ==================================================================== *
 * Festivos
 * ==================================================================== */

/**
 * Pinta el selector de comunidad autónoma.
 * @param {HTMLSelectElement} select
 * @param {string} selected
 */
export function fillRegionSelect(select, selected = 'ES') {
  fillSelect(select, [
    { value: 'ES', label: 'Solo festivos nacionales' },
    ...REGIONS.filter((r) => r.code !== 'ES').map((r) => ({ value: r.code, label: r.name })),
  ], { selected });
}

/**
 * Marca en el calendario los festivos de un año y una comunidad.
 *
 * No pisa los días que el usuario haya etiquetado a mano: solo escribe en los
 * que están vacíos o en los que ya puso HORUS (`imported`). Los días que se
 * marcan quedan con la marca `imported: true` para poder quitarlos después sin
 * tocar los manuales.
 *
 * @param {{doc:object, actions:object, batch?:Function, undo?:Function}} ctx
 * @param {{year:number, region:string, shiftSundayToMonday?:boolean}} opts
 * @returns {number} cuántos días se marcaron
 */
export function applyHolidays(ctx, { year, region = 'ES', shiftSundayToMonday } = {}) {
  const shift = shiftSundayToMonday
    ?? ctx.doc.settings?.holidays?.shiftSundayToMonday
    ?? true;
  const holidays = holidaysFor(year, region, { shiftSundayToMonday: shift });
  if (!holidays.length) return 0;

  const run = (fn) => (typeof ctx.batch === 'function' ? ctx.batch(`cargar festivos de ${year}`, fn) : fn());

  let count = 0;
  run(() => {
    for (const holiday of holidays) {
      const existing = ctx.doc.dayMeta?.[holiday.date];
      // Un día marcado a mano manda: no se toca.
      if (existing && !existing.imported && existing.dayType !== 'normal') continue;
      const ok = ctx.actions.setDayMeta(holiday.date, {
        dayType: 'holiday',
        label: holiday.name,
        imported: true,
      });
      if (ok) count++;
    }
  });

  return count;
}

/* ==================================================================== *
 * Ayudantes de presentación
 * ==================================================================== */

/** "08:30" desde minutos. */
export function minLabel(minutes) {
  const m = Math.round(minutes) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Resumen corto de un turno: "M · 8:30–17:00". */
export function entrySummary(doc, entry) {
  const type = entryType(doc, entry);
  const blocks = entryBlocks(ctx.doc, entry);
  const time = blocks.length ? formatBlocks(blocks) : 'todo el día';
  return `${type ? `${type.code} · ` : ''}${time}`;
}

export {
  entryBlocks, entryType, memberById, shiftTypeById, entryLabel, createEntry,
  analyzeDate, summarize, findConflicts, timeToMin, minToTime, clamp,
  NON_WORKING_CODES, todayKey, addDays, monthKeyOf,
};
















