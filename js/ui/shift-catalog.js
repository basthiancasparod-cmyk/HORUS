/**
 * HORUS — js/ui/shift-catalog.js
 * El CATÁLOGO de tipos de turno: la lista y las acciones de crear, modificar,
 * archivar y eliminar. Es el contenido de la vista «Turnos»
 * (js/ui/views/shifts.js).
 *
 * Por qué es un módulo aparte y no código suelto dentro de la vista:
 *  - El catálogo no se toca solo desde su vista: el Cuadrante (roster.js) y
 *    `ctx.openType()` traen al usuario AQUÍ, y necesitan poder señalar un turno
 *    concreto (`focusShiftCatalog`).
 *  - Y, sobre todo, el CATÁLOGO es configuración, no cuadrante. Antes se podía
 *    abrir el editor de un turno desde la rejilla, y un clic cambiaba el horario
 *    de todo el equipo creyendo que se cambiaba un día.
 *
 * Contrato (docs/VIEW-CONTRACT.md): este módulo NO es una vista; no se registra
 * con `registerRenderer` ni conoce la navegación. La vista que lo hospeda le da
 * el hueco y lo repinta:
 *  - `mount()` captura las referencias y cablea los listeners UNA sola vez
 *    (delegación sobre la lista, porque las filas se reconstruyen enteras).
 *  - `render()` no recibe argumentos, lee el estado con `getContext()` y vuelve
 *    a construir la lista.
 *  - El alta y la edición reutilizan `openTypeEditor` de dialogs.js: funciona,
 *    está probado y no merece la pena reescribirlo. Lo que cambia es quién
 *    manda: el formulario no decide nada por su cuenta, se lo cuenta a este
 *    módulo (borrado incluido).
 *  - El horario de cada turno se ve SIN abrir nada.
 */

import { byId, el, clear, icon, readableOn, on } from '../core/utils.js';
import {
  formatBlocks, formatDuration, blockMinutes, normalizeBlocks, crossesMidnight, humanTime,
} from '../core/date.js';
import { shiftTypeById } from '../core/model.js';
import * as teams from '../core/teams.js';
import { getContext } from './context.js';
import { notify, confirmAction, closeDialog } from './toolkit.js';
import { openTypeEditor } from './dialogs.js';

/* ------------------------------------------------------------------ *
 * Referencias y cableado
 * ------------------------------------------------------------------ */

/**
 * Los ids del HTML de la vista se escriben literales en cada `byId()` (y no en
 * constantes) porque `tools/check.mjs` comprueba así que existen de verdad en
 * `index.html`: con una constante, un id mal escrito pasaría desapercibido.
 */
let refs = null;

/**
 * Los listeners se cablean una sola vez, aunque la vista se vuelva a montar
 * (al cerrar sesión y entrar con otro store, por ejemplo).
 */
let wired = false;

const KIND_LABELS = {
  work: 'Turno trabajado',
  leave: 'Vacaciones',
  sick: 'Baja',
  free: 'Libre',
  rest: 'Festivo',
};

/* ------------------------------------------------------------------ *
 * Montaje
 * ------------------------------------------------------------------ */

/**
 * Monta el catálogo: referencias + listeners (una sola vez).
 * @param {object} [ctx] contexto de la aplicación (no se guarda: el contrato
 *   manda leer el estado vivo con `getContext()` en cada pintado)
 */
export function mount(ctx) {
  void ctx;
  const root = byId('view-shifts');
  if (!root) return;

  refs = {
    root,
    list: byId('shift-catalog-list'),
    add: byId('shift-catalog-add'),
    sub: byId('shifts-sub'),
  };

  if (wired) return;
  wired = true;

  refs.add?.addEventListener('click', () => abrirEditor(null));
  if (refs.list) {
    // Delegación: las filas se reconstruyen enteras en cada `render()`, así que
    // el clic se escucha en el contenedor y se decide por `data-action`.
    on(refs.list, 'click', '[data-action]', (event, button) => {
      void event;
      const typeId = button.closest('[data-type-id]')?.getAttribute('data-type-id');
      if (!typeId) return;
      const action = button.getAttribute('data-action');
      if (action === 'editar') abrirEditor(typeId);
      else if (action === 'archivar') alternarArchivado(typeId);
      else if (action === 'eliminar') pedirBorrado(typeId);
    });
  }
}

/* ------------------------------------------------------------------ *
 * Pintado
 * ------------------------------------------------------------------ */

/** Reconstruye la lista de turnos con su horario y sus acciones. */
export function render() {
  if (!refs?.list) return;
  const ctx = getContext();
  const doc = ctx.doc;
  const solo = teams.soloLectura(doc);
  const tipos = ordenar(doc.shiftTypes);

  clear(refs.list);
  if (refs.add) refs.add.disabled = solo;

  if (refs.sub) {
    const archivados = tipos.filter((t) => t.archived).length;
    const partes = [`${tipos.length} turno${tipos.length === 1 ? '' : 's'}`];
    if (archivados) partes.push(`${archivados} archivado${archivados === 1 ? '' : 's'}`);
    partes.push('el horario se ve aquí; se cambia con «Editar»');
    refs.sub.textContent = solo
      ? `${partes.join(' · ')}. Solo lectura: no puedes cambiar el catálogo.`
      : `${partes.join(' · ')}.`;
  }

  if (!tipos.length) {
    refs.list.appendChild(el('p', { class: 'field-hint' },
      'No hay ningún turno en el catálogo. Añade el primero para poder asignarlo en el cuadrante.'));
    return;
  }

  for (const type of tipos) refs.list.appendChild(fila(doc, type, solo));
}

/**
 * Una fila por turno: código, nombre, horario, color, si cuenta horas, su
 * demanda, si está archivado y lo que se puede hacer con él.
 */
function fila(doc, type, solo) {
  const usos = doc.entries.filter((e) => e.typeId === type.id).length;
  const bloques = normalizeBlocks(type.blocks);
  const horario = bloques.length ? formatBlocks(bloques) : 'sin horario';
  const minutos = bloques.reduce((acc, b) => acc + blockMinutes(b), 0);

  const nombre = el('div', { class: 'type-name' }, type.label);
  if (type.archived) {
    nombre.appendChild(el('span', { class: 'badge badge-warning', style: { marginLeft: 'var(--sp-2)' } }, 'Archivado'));
  }

  const detalle = el('div', { class: 'type-detail' }, [
    `${KIND_LABELS[type.kind] || type.kind} · `,
    el('strong', {}, horario),
    bloques.length ? ` · ${formatDuration(minutos)}` : '',
  ]);

  const datos = [
    type.countsHours ? 'Cuenta horas' : 'No cuenta horas',
    `hacen falta ${type.demand}`,
    usos === 1 ? '1 día del cuadrante' : `${usos} días del cuadrante`,
  ].join(' · ');

  const avisoMedianoche = avisoDeMedianoche(bloques);

  return el('div', {
    class: `type-card ${type.archived ? 'is-archived' : ''}`.trim(),
    'data-type-id': type.id,
    'data-archived': String(!!type.archived),
    'data-counts-hours': String(!!type.countsHours),
    style: { '--type-color': type.hex || 'var(--border)', marginBottom: 'var(--sp-2)' },
  }, [
    el('span', {
      class: 'type-code',
      style: { background: type.hex, color: readableOn(type.hex) },
      title: `Color ${type.hex}`,
    }, type.code),
    el('div', { class: 'grow' }, [
      nombre,
      detalle,
      el('div', { class: 't-2xs t-muted' }, datos),
      bloques.length ? barraDeHorario(type) : null,
      avisoMedianoche,
    ]),
    el('div', { class: 'type-actions' }, [
      el('button', {
        type: 'button',
        class: 'icon-btn',
        'data-action': 'editar',
        title: `Editar ${type.label}`,
        'aria-label': `Editar ${type.label}`,
        disabled: solo,
      }, icon('edit', 16)),
      el('button', {
        type: 'button',
        class: 'btn btn-sm btn-ghost',
        'data-action': 'archivar',
        title: type.archived
          ? `${type.label} archivado: no aparece al asignar turnos`
          : `Archivar ${type.label} (deja de aparecer al asignar turnos, sin perder el histórico)`,
        'aria-label': type.archived ? `Desarchivar ${type.label}` : `Archivar ${type.label}`,
        disabled: solo,
      }, type.archived ? 'Desarchivar' : 'Archivar'),
      el('button', {
        type: 'button',
        class: 'icon-btn t-danger',
        'data-action': 'eliminar',
        title: `Eliminar ${type.label} del catálogo`,
        'aria-label': `Eliminar ${type.label} del catálogo`,
        disabled: solo,
      }, icon('trash', 16)),
    ]),
  ]);
}

/**
 * Barra de 24 h con los tramos del turno. Es un apoyo visual del horario, que
 * ya está escrito en texto encima: el texto es lo que se lee y lo que se puede
 * comprobar.
 */
function barraDeHorario(type) {
  const box = el('div', { class: 'schedule-preview', style: { '--type-color': type.hex } });
  for (const block of normalizeBlocks(type.blocks)) {
    const [hh, mm] = String(block.start).split(':').map(Number);
    const start = (hh * 60) + (mm || 0);
    const minutes = blockMinutes(block);
    box.appendChild(el('div', {
      class: 'seg',
      style: {
        left: `${(start / 1440) * 100}%`,
        // Un turno que cruza medianoche se dibuja solo hasta el final del día:
        // la madrugada siguiente se cuenta en el día siguiente, no aquí.
        width: `${(Math.min(minutes, 1440 - start) / 1440) * 100}%`,
      },
      title: `${block.start}–${block.end}`,
    }));
  }
  return box;
}

/**
 * Aviso explícito del horario que cruza medianoche (o que dura 24 h).
 *
 * No es decorativo: un turno de 16:15 a 00:45 cuenta también para la cobertura
 * de la madrugada del día siguiente. Dejarlo escrito aquí evita que se descubra
 * después, mirando el cuadrante.
 * @returns {HTMLElement|null}
 */
function avisoDeMedianoche(bloques) {
  const cruzados = bloques.filter((b) => crossesMidnight(b));
  if (!cruzados.length) return null;
  const partes = cruzados.map((b) => (b.start === b.end
    ? `${humanTime(b.start)}–${humanTime(b.end)} son 24 h seguidas`
    : `termina a las ${humanTime(b.end)} del día siguiente`));
  // La coletilla de la madrugada solo vale para un cruce de verdad: en un turno
  // de 24 h no hay «día siguiente» al que irse.
  const cola = cruzados.some((b) => b.start !== b.end)
    ? ' Esa madrugada cuenta en el día siguiente.'
    : '';
  return el('div', { class: 'field-hint t-warning' },
    `🌙 cruza medianoche · ${partes.join('; ')}.${cola}`);
}

/** Primero los activos por su orden; los archivados, al final. */
function ordenar(tipos) {
  return [...tipos].sort((a, b) => {
    if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

/* ------------------------------------------------------------------ *
 * Acciones: crear, editar, archivar, eliminar
 * ------------------------------------------------------------------ */

/** Abre el formulario de siempre para crear (id null) o editar un turno. */
function abrirEditor(typeId) {
  const ctx = getContext();
  openTypeEditor(ctx, typeId, {
    onSaved: () => render(),
    // El borrado lo gobierna este módulo: es el único que avisa de cuántos días
    // del cuadrante se ven afectados y el que ofrece archivar. El formulario no
    // puede hacerlo bien por su cuenta (no conoce la lista del catálogo).
    onDelete: (id) => {
      closeDialog(byId('dialog-type'));
      pedirBorrado(id);
    },
  });
}

/**
 * Archiva o desarchiva. Es la salida SEGURA: el turno deja de ofrecerse al
 * asignar turnos, y ningún día del cuadrante se toca.
 *
 * Se comprueba que el cambio ha llegado DE VERDAD al documento antes de decir
 * que sí. La huella con la que el store decidía «¿ha cambiado algo?» era una
 * lista de campos escrita a mano que no miraba `archived`, así que archivar no
 * hacía nada; eso ya está arreglado en el núcleo, pero la comprobación se queda:
 * si algo no se puede, se dice en español, no se finge.
 */
function alternarArchivado(typeId) {
  const ctx = getContext();
  const type = shiftTypeById(ctx.doc, typeId);
  if (!type || teams.soloLectura(ctx.doc)) return;
  const archivar = !type.archived;

  ctx.actions.updateShiftType(type.id, { archived: archivar });

  const aplicado = shiftTypeById(getContext().doc, type.id)?.archived === archivar;
  if (!aplicado) {
    notify.warning(`No se ha podido archivar «${type.label}»: el cambio no ha llegado al cuadrante. `
      + 'No se ha borrado nada y el catálogo sigue igual.');
    return;
  }

  notify.success(archivar
    ? `«${type.label}» archivado: ya no se ofrece al asignar turnos`
    : `«${type.label}» vuelve a ofrecerse al asignar turnos`, {
    action: { label: 'Deshacer', onClick: () => getContext().undo() },
  });
  render();
}

/**
 * Borrado definitivo. Nunca en silencio y nunca sin decir antes lo que se
 * pierde: `removeShiftType` (core/store.js) deja los días que usaban el tipo
 * SIN tipo. Si el turno no tenía horario, esos días se quedan además sin horas,
 * así que dejan de verse en el cuadrante. Eso se dice aquí, antes de borrar.
 */
async function pedirBorrado(typeId) {
  const ctx = getContext();
  const type = shiftTypeById(ctx.doc, typeId);
  if (!type || teams.soloLectura(ctx.doc)) return;

  const usos = ctx.doc.entries.filter((e) => e.typeId === type.id).length;
  const patrones = ctx.doc.patterns.filter((p) => p.cycle?.some((c) => c.typeId === type.id)).length;
  const dias = usos === 1 ? '1 día' : `${usos} días`;

  const message = usos
    ? `El turno ${type.code} lo usan ${dias} del cuadrante. Si lo borras, esos días se quedarán sin tipo.`
    : `El turno ${type.code} no lo usa ningún día del cuadrante ahora mismo.`;

  const ok = await confirmAction({
    title: `¿Eliminar «${type.label}» del catálogo?`,
    message,
    confirmLabel: 'Eliminar de todas formas',
    extra: avisoDeBorrado(type, usos, patrones),
  });
  if (!ok) return;
  // El documento pudo cambiar mientras el usuario leía el aviso.
  if (!shiftTypeById(getContext().doc, type.id)) return;

  getContext().actions.removeShiftType(type.id);
  notify.success(`«${type.label}» eliminado del catálogo`, {
    action: { label: 'Deshacer', onClick: () => getContext().undo() },
  });
  render();
}

/**
 * Lo que se pone DENTRO de la confirmación de borrado: primero la alternativa
 * recomendada (archivar) y, si el borrado destruiría algo más que el tipo, se
 * dice cuál.
 */
function avisoDeBorrado(type, usos, patrones) {
  const box = el('div', { class: 'stack-sm' }, [
    el('p', { class: 'field-hint' },
      'Lo recomendable es archivar: deja de ofrecerse al asignar turnos (y en las rotaciones nuevas), y el histórico se queda intacto.'),
  ]);

  if (usos && !normalizeBlocks(type.blocks).length) {
    box.appendChild(el('p', { class: 'field-hint t-warning' },
      `Este turno no tiene horario: esos ${usos === 1 ? 'día' : 'días'} se quedarán sin tipo y sin horas, así que dejarán de verse en el cuadrante.`));
  }
  if (patrones) {
    box.appendChild(el('p', { class: 'field-hint t-warning' },
      `También se usa en ${patrones} rotación${patrones === 1 ? '' : 'es'}: ese paso se quedará sin turno.`));
  }

  box.appendChild(el('button', {
    type: 'button',
    class: 'btn btn-sm btn-primary',
    onclick: () => {
      // Cierra la confirmación (equivale a cancelar el borrado: la promesa se
      // resuelve en falso) y archiva, que es lo que no destruye nada.
      alternarArchivado(type.id);
      closeDialog(byId('dialog-confirm'));
    },
  }, 'Archivar en su lugar (recomendado)'));

  return box;
}

/* ------------------------------------------------------------------ *
 * Navegación hacia la vista
 * ------------------------------------------------------------------ */

/**
 * Deja el catálogo a la vista, con un turno señalado.
 *
 * Lo usa el Cuadrante: al tocar un turno de su leyenda ya no se abre ningún
 * editor dentro de la rejilla, se viene aquí. También `ctx.openType()`.
 *
 * @param {string|null} typeId turno que se quiere señalar
 */
export function focusShiftCatalog(typeId = null) {
  // La vista puede no haberse pintado todavía (el repintado va por frame), así
  // que la fila puede no existir: se pinta ahora y luego se busca.
  render();

  const root = byId('view-shifts');
  if (!root) return;
  const filas = [...root.querySelectorAll('[data-type-id]')];
  const objetivo = typeId ? filas.find((f) => f.getAttribute('data-type-id') === typeId) : null;
  const destino = objetivo || root;

  destino.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  // Poner el foco hace que «señalar el turno» sirva también con el teclado.
  (objetivo ? objetivo.querySelector('button:not([disabled])') : byId('shift-catalog-add'))?.focus?.();
}
