/**
 * HORUS — core/utils.js
 * Utilidades transversales: DOM, texto, tiempo de espera, archivos, CSV.
 */

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function byId(id) {
  return document.getElementById(id);
}

/**
 * Crea elementos: el('div', {class:'x', onclick:fn}, [hijos])
 * Los hijos pueden ser nodos, strings (se escapan) o arrays.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') {
      // En un <option> (y en un botón de formulario), `value` es lo que se envía
      // y lo que lee el código: tiene que quedar como ATRIBUTO. Asignarlo solo
      // como propiedad deja el atributo sin poner y el navegador devuelve el
      // texto de la opción en lugar de su valor.
      if (tag === 'option' || tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select') {
        node.setAttribute('value', String(v));
        node.value = v;
      } else {
        node.value = v;
      }
    }
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') {
      // Estos sí funcionan como propiedad y además conviene reflejarlos como
      // atributo para que el HTML resultante sea inspeccionable.
      node[k] = !!v;
      if (v) node.setAttribute(k, '');
      else node.removeAttribute(k);
    }
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  appendChildren(node, children);
  return node;
}

export function appendChildren(node, children) {
  if (children == null || children === false) return node;
  if (Array.isArray(children)) {
    for (const c of children) appendChildren(node, c);
    return node;
  }
  node.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
  return node;
}

/** Escapa texto para insertarlo como HTML (nunca confíes en datos del usuario). */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Vacía un nodo y devuelve el nodo. */
export function clear(node) {
  while (node?.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Delegación de eventos: on(root, 'click', '.chip', handler) */
export function on(root, type, selector, handler, opts) {
  root.addEventListener(type, (event) => {
    const target = event.target.closest?.(selector);
    if (target && root.contains(target)) handler(event, target);
  }, opts);
}

/* ------------------------------------------------------------------ *
 * SVG inline (iconos)
 * ------------------------------------------------------------------ */

const ICON_PATHS = {
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  sun: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.2"/><circle cx="3.5" cy="12" r="1.2"/><circle cx="3.5" cy="18" r="1.2"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  repeat: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  moonStars: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/><line x1="5" y1="3" x2="5" y2="5"/><line x1="4" y1="4" x2="6" y2="4"/>',
  arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
};

/** Devuelve un <svg> con el icono pedido. */
export function icon(name, size = 20, extraClass = '') {
  const path = ICON_PATHS[name] || ICON_PATHS.info;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (extraClass) svg.setAttribute('class', extraClass);
  svg.innerHTML = path;
  return svg;
}

/** Igual que icon() pero devuelve el markup, para plantillas. */
export function iconHTML(name, size = 20, extraClass = '') {
  const path = ICON_PATHS[name] || ICON_PATHS.info;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extraClass ? ` class="${extraClass}"` : ''}>${path}</svg>`;
}

/* ------------------------------------------------------------------ *
 * Tiempo
 * ------------------------------------------------------------------ */

export function debounce(fn, wait = 250) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  wrapped.flush = (...args) => { clearTimeout(timer); timer = null; fn(...args); };
  return wrapped;
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      clearTimeout(timer);
      timer = null;
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(...args); }, remaining);
    }
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Agrupa llamadas en el siguiente frame. */
export function raf(fn) {
  return requestAnimationFrame(() => requestAnimationFrame(fn));
}

/* ------------------------------------------------------------------ *
 * Números y texto
 * ------------------------------------------------------------------ */

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function sum(list, pick = (x) => x) {
  return list.reduce((a, x) => a + (Number(pick(x)) || 0), 0);
}

export function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/** Normaliza para buscar: sin acentos, minúsculas. */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Resalta coincidencias devolviendo HTML seguro. */
export function highlight(text, query) {
  const q = fold(query);
  if (!q) return esc(text);
  const idx = fold(text).indexOf(q);
  if (idx < 0) return esc(text);
  const raw = String(text);
  return `${esc(raw.slice(0, idx))}<mark>${esc(raw.slice(idx, idx + q.length))}</mark>${esc(raw.slice(idx + q.length))}`;
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Iniciales cortas para avatares. */
export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Color de texto legible sobre un fondo hex dado. */
export function readableOn(hex) {
  const c = String(hex || '#888888').replace('#', '');
  if (c.length !== 6) return '#fff';
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  // Luminancia relativa (WCAG)
  const lum = (0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b));
  return lum > 0.45 ? '#101319' : '#FFFFFF';
}

function srgb(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Mezcla un hex con transparencia → rgba(). */
export function withAlpha(hex, alpha = 0.15) {
  const c = String(hex || '#888888').replace('#', '');
  if (c.length !== 6) return `rgba(136,136,136,${alpha})`;
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Aclara u oscurece un hex (amount -1..1). */
export function shade(hex, amount) {
  const c = String(hex || '#888888').replace('#', '');
  if (c.length !== 6) return hex;
  const to = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  const parts = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16);
    return Math.round(v + (to - v) * p).toString(16).padStart(2, '0');
  });
  return `#${parts.join('')}`;
}

/* ------------------------------------------------------------------ *
 * Archivos
 * ------------------------------------------------------------------ */

/** Dispara la descarga de un texto como archivo. */
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Descarga un Blob directamente. */
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Abre un selector de archivos y devuelve el texto elegido. */
export function pickTextFile(accept = '.json,.csv,.txt') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      try {
        resolve({ name: file.name, text: await file.text(), size: file.size });
      } catch (err) {
        resolve({ name: file.name, text: null, error: err });
      }
    });
    input.click();
  });
}

/** Copia al portapapeles con fallback para navegadores antiguos. */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* sigue con el fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

/**
 * Serializa filas a CSV (con BOM para que Excel en español lo abra bien).
 * @param {string[]} headers
 * @param {(string|number|boolean|null|undefined)[][]} rows
 */
export function toCSV(headers, rows, { separator = ';', bom = true } = {}) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    if (s.includes('"') || s.includes(separator) || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.map(cell).join(separator)];
  for (const row of rows) lines.push(row.map(cell).join(separator));
  return (bom ? '\uFEFF' : '') + lines.join('\r\n');
}

/**
 * Parser CSV tolerante (detecta separador, soporta comillas y saltos internos).
 * @returns {string[][]}
 */
export function parseCSV(text, separator) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return [];
  let sep = separator;
  if (!sep) {
    const firstLine = raw.split(/\r?\n/, 1)[0] || '';
    const counts = [';', ',', '\t', '|'].map((s) => [s, (firstLine.match(new RegExp(`\\${s}`, 'g')) || []).length]);
    counts.sort((a, b) => b[1] - a[1]);
    sep = counts[0][1] > 0 ? counts[0][0] : ',';
  }

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch === '\r') {
      // ignora; el \n hará el corte
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** Convierte filas CSV en objetos usando la primera fila como cabecera. */
export function csvToObjects(text, separator) {
  const rows = parseCSV(text, separator);
  if (rows.length < 2) return { headers: rows[0] || [], objects: [] };
  const [headers, ...rest] = rows;
  const keys = headers.map((h) => fold(h).replace(/[^a-z0-9]+/g, ''));
  const objects = rest.map((r) => {
    const o = {};
    keys.forEach((k, i) => { o[k] = (r[i] ?? '').trim(); });
    return o;
  });
  return { headers, objects };
}

/* ------------------------------------------------------------------ *
 * Vapor de pruebas / depuración
 * ------------------------------------------------------------------ */

export function isMac() {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/**
 * Reexportado por comodidad desde `date.js`: muchas vistas formatean duraciones
 * y acaban importando también utilidades, así que se evita el doble import.
 */
export { formatDuration, formatHours, formatBlocks, formatClock } from './date.js';

export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

export function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
