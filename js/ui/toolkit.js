/**
 * HORUS — js/ui/toolkit.js
 * Piezas de interfaz compartidas por todas las vistas: avisos flotantes,
 * diálogos, confirmaciones, hojas inferiores, estados vacíos, barras y
 * ayudantes de pintado. Nada de esto conoce el modelo de datos.
 */

import { el, $, $$, byId, icon, clear, esc, copyToClipboard, readableOn, withAlpha, clamp } from '../core/utils.js';

/* ==================================================================== *
 * AVISOS FLOTANTES (toast)
 * ==================================================================== */

let toastRegion = null;
const liveToasts = new Map();

/**
 * Muestra un aviso breve.
 * @param {string} message
 * @param {{type?:'info'|'success'|'error'|'warning', duration?:number,
 *          action?:{label:string, onClick:Function}, icon?:string}} [opts]
 */
export function toast(message, opts = {}) {
  const { type = 'info', duration = 3200, action = null, icon: iconName = null } = opts;
  if (!toastRegion) toastRegion = byId('toasts');
  if (!toastRegion) return null;

  // Evita spamear el mismo mensaje repetido
  const key = `${type}:${message}`;
  if (liveToasts.has(key)) {
    const existing = liveToasts.get(key);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => dismissToast(existing.node, key), duration);
    return existing.node;
  }

  const defaultIcon = { success: 'check', error: 'alert', warning: 'alert', info: 'info' }[type] || 'info';
  const node = el('div', { class: `toast toast-${type}`, role: 'status' }, [
    icon(iconName || defaultIcon, 17),
    el('span', { class: 'grow' }, message),
  ]);

  if (action) {
    node.appendChild(el('button', {
      type: 'button',
      class: 'toast-action',
      onclick: () => { action.onClick(); dismissToast(node, key); },
    }, action.label));
  }

  toastRegion.appendChild(node);
  const record = { node, timer: setTimeout(() => dismissToast(node, key), duration) };
  liveToasts.set(key, record);

  // Máximo tres avisos a la vez
  const all = $$('.toast', toastRegion);
  if (all.length > 3) dismissToast(all[0], null);

  return node;
}

function dismissToast(node, key) {
  if (!node?.isConnected) return;
  if (key) liveToasts.delete(key);
  node.classList.add('is-leaving');
  setTimeout(() => node.remove(), 200);
}

export const notify = {
  info: (m, o) => toast(m, { ...o, type: 'info' }),
  success: (m, o) => toast(m, { ...o, type: 'success' }),
  error: (m, o) => toast(m, { ...o, type: 'error', duration: 5200 }),
  warning: (m, o) => toast(m, { ...o, type: 'warning', duration: 4400 }),
};

/* ==================================================================== *
 * DIÁLOGOS
 * ==================================================================== */

/** Abre un <dialog> de forma accesible guardando quién tenía el foco. */
export function openDialog(dialog, { focus = null } = {}) {
  if (!dialog || dialog.open) return;
  dialog.__returnFocus = document.activeElement;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  document.body.dataset.locked = 'true';

  const target = focus
    || dialog.querySelector('[data-autofocus]')
    || dialog.querySelector('input:not([type=hidden]), select, textarea, button');
  // En móvil, enfocar un campo abre el teclado y tapa el contenido: solo se
  // enfoca automáticamente si el usuario está en un dispositivo con puntero fino.
  if (target && window.matchMedia?.('(pointer: fine)').matches) {
    setTimeout(() => { try { target.focus(); } catch { /* nada */ } }, 60);
  }
}

export function closeDialog(dialog, returnValue = undefined) {
  if (!dialog?.open) return;
  const focus = dialog.__returnFocus;
  if (typeof dialog.close === 'function') dialog.close(returnValue);
  else dialog.removeAttribute('open');
  if (!$('dialog[open]')) document.body.dataset.locked = 'false';
  if (focus?.isConnected) setTimeout(() => { try { focus.focus(); } catch { /* nada */ } }, 30);
}

/** Cierra el diálogo más alto que esté abierto (para la tecla Escape). */
export function closeTopDialog() {
  const open = $$('dialog[open]');
  if (!open.length) return false;
  closeDialog(open[open.length - 1]);
  return true;
}

/**
 * Confirmación con diálogo propio (nunca `confirm()`, que bloquea y no se
 * puede estilar). Devuelve una promesa que resuelve true/false.
 *
 * @param {{title:string, message?:string, confirmLabel?:string, cancelLabel?:string,
 *          danger?:boolean, extra?:HTMLElement|null}} opts
 */
export function confirmAction(opts = {}) {
  const {
    title = '¿Seguro?',
    message = '',
    confirmLabel = 'Confirmar',
    cancelLabel = 'Cancelar',
    danger = true,
    extra = null,
  } = opts;

  const dialog = byId('dialog-confirm');
  byId('confirm-title').textContent = title;
  byId('confirm-sub').textContent = opts.sub || '';
  const msg = byId('confirm-message');
  msg.textContent = message;
  msg.hidden = !message;

  const extraBox = byId('confirm-extra');
  clear(extraBox);
  if (extra) extraBox.appendChild(extra);

  const okBtn = byId('confirm-ok');
  const cancelBtn = byId('confirm-cancel');
  okBtn.textContent = confirmLabel;
  cancelBtn.textContent = cancelLabel;
  okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
      closeDialog(dialog);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onClose = () => finish(false);

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    openDialog(dialog, { focus: cancelBtn });
  });
}

/* ==================================================================== *
 * PRIMITIVAS DE PINTADO
 * ==================================================================== */

/** Estado vacío con icono, título y acción opcional. */
export function emptyState({ iconName = 'info', title, message = '', action = null } = {}) {
  const node = el('div', { class: 'empty-state' }, [
    el('div', { class: 'empty-icon' }, icon(iconName, 26)),
    el('h3', {}, title),
  ]);
  if (message) node.appendChild(el('p', {}, message));
  if (action) {
    node.appendChild(el('button', {
      type: 'button', class: 'btn btn-primary btn-sm', onclick: action.onClick,
    }, action.label));
  }
  return node;
}

/**
 * Fila de barra con etiqueta, valor y color.
 * @param {{label:string, value:number, max:number, color?:string,
 *          valueText:string, sub?:string, onClick?:Function}} opts
 */
export function barRow({ label, value, max, color, valueText, sub = '', onClick = null }) {
  const pct = max > 0 ? clamp((value / max) * 100, value > 0 ? 1.5 : 0, 100) : 0;
  const node = el(onClick ? 'button' : 'div', {
    class: 'bar-row',
    type: onClick ? 'button' : null,
    style: onClick ? { width: '100%', textAlign: 'left', cursor: 'pointer' } : null,
    onclick: onClick || null,
  }, [
    el('span', { class: 't-truncate', title: label }, [label, sub ? el('span', { class: 't-muted' }, ` ${sub}`) : null]),
    el('span', { class: 'bar-track' }, el('span', {
      class: 'bar-fill',
      style: { width: `${pct}%`, ...(color ? { '--bar-color': color } : {}) },
    })),
    el('span', { class: 'bar-value' }, valueText),
  ]);
  return node;
}

/** Barra de progreso. */
export function progressBar(value, max, { className = '', label = '' } = {}) {
  const pct = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
  return el('div', {
    class: `progress ${className}`.trim(),
    role: 'progressbar',
    'aria-valuenow': String(Math.round(pct)),
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-label': label,
  }, el('span', { style: { width: `${pct}%` } }));
}

/** Avatar con iniciales y color. */
export function avatar(member, { size = 'md', title = null, ring = false } = {}) {
  const sizeClass = { xs: 'avatar-xs', sm: 'avatar-sm', md: '', lg: 'avatar-lg' }[size] ?? '';
  const name = member?.name || '?';
  const initials = member?.initials || name.slice(0, 2).toUpperCase();
  const hex = member?.hex || '#8a93a8';
  return el('span', {
    class: `avatar ${sizeClass} ${ring ? 'avatar-ring' : ''}`.trim(),
    style: { '--avatar-color': hex, '--avatar-fg': readableOn(hex) },
    title: title || name,
    'aria-hidden': 'true',
  }, initials);
}

/** Fila de avatares solapados. */
export function avatarStack(members, { max = 5, size = 'sm' } = {}) {
  const shown = members.slice(0, max);
  const rest = members.length - shown.length;
  const node = el('span', { class: 'avatar-stack' });
  for (const m of shown) node.appendChild(avatar(m, { size }));
  if (rest > 0) {
    node.appendChild(el('span', {
      class: `avatar ${size === 'sm' ? 'avatar-sm' : ''}`.trim(),
      style: { '--avatar-color': 'var(--surface-3)', '--avatar-fg': 'var(--text-dim)' },
      title: `${rest} más`,
    }, `+${rest}`));
  }
  return node;
}

/**
 * Píldora de un tipo de turno (código corto, coloreada).
 * @param {object} type
 */
export function typeBadge(type, { showLabel = false, overnight = false } = {}) {
  if (!type) return el('span', { class: 'badge' }, '—');
  const hex = type.hex || '#8a93a8';
  return el('span', {
    class: 'badge badge-solid',
    style: { '--type-color': hex, '--type-fg': readableOn(hex) },
    title: type.label,
  }, [`${type.code}${overnight ? ' 🌙' : ''}`, showLabel ? ` ${type.label}` : null]);
}

/** Cabecera de sección con título y acción. */
export function sectionHeader(title, action = null, { tag = 'h2', className = 't-md' } = {}) {
  return el('header', {}, [
    el(tag, { class: className }, title),
    action ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: action.onClick }, action.label) : null,
  ]);
}

/** Interruptor accesible ya cableado. */
export function switchControl(id, checked, onChange, { label = '', large = false } = {}) {
  const node = el('div', {
    class: `switch ${large ? 'switch-lg' : ''}`.trim(),
    id,
    role: 'switch',
    tabindex: '0',
    'aria-checked': String(!!checked),
    'aria-label': label,
  });
  const toggle = () => {
    const next = node.getAttribute('aria-checked') !== 'true';
    node.setAttribute('aria-checked', String(next));
    onChange(next);
  };
  node.addEventListener('click', toggle);
  node.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
  });
  return node;
}

/** Fila de ajuste con etiqueta, descripción y control. */
export function settingRow({ label, sub, control, onClick = null }) {
  const node = el(onClick ? 'button' : 'div', {
    class: `setting-row ${onClick ? 'is-clickable' : ''}`.trim(),
    type: onClick ? 'button' : null,
    onclick: onClick || null,
    style: onClick ? { width: '100%', textAlign: 'left' } : null,
  }, [
    el('div', { class: 'grow' }, [
      el('div', { class: 'label' }, label),
      sub ? el('div', { class: 'sub' }, sub) : null,
    ]),
    control ? el('div', { class: 'control' }, control) : null,
  ]);
  return node;
}

/**
 * Lista de selección de colores.
 * @param {string[]} palette
 * @param {string} current
 * @param {(hex:string)=>void} onPick
 */
export function colorPicker(palette, current, onPick) {
  const node = el('div', { class: 'swatch-grid', role: 'group' });
  for (const hex of palette) {
    node.appendChild(el('button', {
      type: 'button',
      class: 'swatch',
      style: { background: hex },
      'aria-pressed': String(hex.toUpperCase() === String(current || '').toUpperCase()),
      'aria-label': `Color ${hex}`,
      onclick: () => {
        $$('.swatch', node).forEach((s) => s.setAttribute('aria-pressed', 'false'));
        node.querySelector(`[aria-label="Color ${hex}"]`)?.setAttribute('aria-pressed', 'true');
        onPick(hex);
      },
    }));
  }
  return node;
}

/** Botón que copia un texto y avisa del resultado. */
export function copyButton(getText, { label = 'Copiar', successMessage = 'Copiado al portapapeles' } = {}) {
  return el('button', {
    type: 'button',
    class: 'btn btn-sm',
    onclick: async (event) => {
      const text = typeof getText === 'function' ? getText() : getText;
      const ok = await copyToClipboard(text);
      if (ok) notify.success(successMessage);
      else notify.error('No se pudo copiar. Selecciona el texto y cópialo a mano.');
      void event;
    },
  }, [icon('copy', 15), label]);
}

/** Formatea minutos como texto corto de duración (delegado en date.js). */
export function hexWithAlpha(hex, alpha) {
  return withAlpha(hex, alpha);
}

/** Lee un valor numérico de un input con límites. */
export function readNumber(input, { min = -Infinity, max = Infinity, fallback = 0 } = {}) {
  const raw = String(input?.value ?? '').trim().replace(',', '.');
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, min, max);
}

/** Devuelve una opción de <select>. */
export function option(value, label, selected = false) {
  return el('option', { value, selected }, label);
}

/** Rellena un <select> con opciones. */
export function fillSelect(select, items, { selected = null, keepFirst = false } = {}) {
  if (!select) return;
  const first = keepFirst ? select.firstElementChild : null;
  clear(select);
  if (first) select.appendChild(first);
  for (const item of items) {
    const value = typeof item === 'object' ? item.value : item;
    const label = typeof item === 'object' ? item.label : item;
    const disabled = typeof item === 'object' ? !!item.disabled : false;
    select.appendChild(el('option', {
      value: String(value),
      disabled,
      selected: selected != null && String(value) === String(selected),
    }, label));
  }
}

/** Punto de estado de sincronización. */
export function syncDot(state) {
  const map = { syncing: 'is-syncing', error: 'is-error', offline: 'is-offline', idle: 'is-online', conflict: 'is-error' };
  return el('span', { class: `status-dot ${map[state] || ''}`.trim() });
}

/** Texto seguro (evita inyección al construir HTML a mano). */
export { esc };
