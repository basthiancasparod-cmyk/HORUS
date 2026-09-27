/**
 * HORUS — tests/dom.mjs
 * DOM mínimo para poder ejercitar las vistas en Node sin navegador.
 *
 * No pretende ser un navegador: implementa solo lo que HORUS usa de verdad
 * (crear elementos, atributos, clases, textContent, delegación de eventos,
 * <dialog>, formularios y un `querySelector` con selectores simples). Es
 * suficiente para ejecutar `mount()` y `render()` de cada vista y detectar
 * errores reales de integración, que es justo lo que no cubre una prueba
 * unitaria de la lógica.
 */

/* ==================================================================== *
 * Nodo
 * ==================================================================== */

let nodeCounter = 0;

class ClassList {
  constructor(node) { this.node = node; this.set = new Set(); }
  add(...names) { for (const n of names) if (n) this.set.add(String(n)); }
  remove(...names) { for (const n of names) this.set.delete(String(n)); }
  toggle(name, force) {
    const has = this.set.has(name);
    const next = force === undefined ? !has : !!force;
    if (next) this.set.add(name); else this.set.delete(name);
    return next;
  }
  contains(name) { return this.set.has(String(name)); }
  get value() { return [...this.set].join(' '); }
  toString() { return this.value; }
  [Symbol.iterator]() { return this.set[Symbol.iterator](); }
}

class DOMNode {
  constructor(nodeType, nodeName) {
    this.nodeType = nodeType;
    this.nodeName = String(nodeName || '').toUpperCase();
    this.uid = ++nodeCounter;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.classList = new ClassList(this);
    this.dataset = {};
    this._listeners = new Map();
    this._value = '';
    this._checked = false;
    this._id = '';
  }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) - 1] || null;
  }

  get className() { return this.classList.value; }
  set className(value) {
    this.classList.set = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  get id() { return this._id; }
  set id(value) { this._id = String(value || ''); }

  get textContent() {
    if (this.nodeType === 3) return this._text || '';
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(value) {
    this.childNodes = [];
    if (value !== '' && value != null) {
      const text = new DOMNode(3, '#text');
      text._text = String(value);
      text.parentNode = this;
      this.childNodes.push(text);
    }
  }

  get innerHTML() { return this._innerHTML ?? this.textContent; }
  set innerHTML(value) {
    this._innerHTML = String(value ?? '');
    this.childNodes = [];
  }

  get innerText() { return this.textContent; }
  set innerText(value) { this.textContent = value; }

  /** Las opciones de un <select>, como en el DOM real. */
  get options() {
    if (this.nodeName !== 'SELECT') return [];
    return this.children.filter((c) => c.nodeName === 'OPTION');
  }

  get selectedIndex() {
    const list = this.options;
    if (!list.length) return -1;
    const explicit = list.findIndex((o) => o.hasAttribute('selected'));
    if (explicit >= 0) return explicit;
    if (this._value) {
      const byValue = list.findIndex((o) => o.value === this._value);
      if (byValue >= 0) return byValue;
    }
    // El DOM real selecciona la primera opción cuando ninguna está marcada
    return 0;
  }

  set selectedIndex(index) {
    const list = this.options;
    list.forEach((option, i) => {
      if (i === Number(index)) option.setAttribute('selected', '');
      else option.removeAttribute('selected');
    });
    this._value = list[Number(index)]?.value ?? '';
  }

  get multiple() { return this.hasAttribute('multiple'); }

  get value() {
    if (this._value !== '') return this._value;
    // El DOM real devuelve la opción seleccionada y, si no hay ninguna marcada,
    // la PRIMERA del <select>. Sin esto, leer `.value` de un select recién
    // pintado devolvía cadena vacía y los formularios parecían no funcionar.
    if (this.nodeName === 'SELECT') {
      const list = this.options;
      const selected = list.find((o) => o.selected || o.hasAttribute('selected'));
      const chosen = selected || list[0];
      return chosen ? (chosen.getAttribute('value') ?? chosen.textContent) : '';
    }
    return this._value;
  }
  set value(v) { this._value = v == null ? '' : String(v); }

  get checked() { return this._checked; }
  set checked(v) { this._checked = !!v; }

  get selected() { return this.hasAttribute('selected'); }
  set selected(v) { if (v) this.setAttribute('selected', ''); else this.removeAttribute('selected'); }

  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }

  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === globalThis.document?.documentElement || node?.__isDocument === true;
  }

  setAttribute(name, value) {
    const key = String(name);
    this.attributes.set(key, value === true ? '' : String(value));
    if (key === 'class') this.className = value === true ? '' : String(value);
    if (key === 'id') this.id = value === true ? '' : String(value);
    if (key.startsWith('data-')) {
      const camel = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[camel] = String(value);
    }
    if (key === 'style' && typeof value === 'string') this._styleAttr = value;
  }

  getAttribute(name) {
    const key = String(name);
    if (key === 'class') return this.classList.value || null;
    if (key === 'style') return this._styleAttr ?? null;
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) { return this.attributes.has(String(name)); }
  removeAttribute(name) {
    const key = String(name);
    this.attributes.delete(key);
    if (key === 'class') this.classList.set.clear();
    if (key === 'id') this._id = '';
    if (key === 'hidden') { /* ya está fuera del mapa */ }
  }

  get style() {
    const self = this;
    if (!self._style) {
      self._style = new Proxy({
        setProperty(name, value) { self.setAttribute(`data-style-${name}`, value); },
        removeProperty(name) { self.removeAttribute(`data-style-${name}`); },
        getPropertyValue(name) { return self.getAttribute(`data-style-${name}`) || ''; },
        cssText: '',
      }, {
        set(target, prop, value) {
          target[prop] = value;
          self.setAttribute(`data-style-${String(prop)}`, value);
          return true;
        },
        get(target, prop) {
          if (prop in target) return target[prop];
          return self.getAttribute(`data-style-${String(prop)}`) || '';
        },
      });
    }
    return self._style;
  }

  appendChild(child) {
    if (!child) return child;
    // Un DocumentFragment no se inserta como nodo: sus hijos se mueven al
    // destino. Sin esto, `tbody.children` quedaría vacío y las pruebas darían
    // falsos negativos en cualquier vista que use fragmentos.
    if (child.nodeType === 11) {
      for (const node of [...child.childNodes]) {
        node.parentNode = this;
        this.childNodes.push(node);
      }
      child.childNodes = [];
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? new TextNode(n) : n); }

  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child);
    if (child.nodeType === 11) {
      for (const node of [...child.childNodes]) this.insertBefore(node, reference);
      child.childNodes = [];
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = this.childNodes.indexOf(reference);
    child.parentNode = this;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() { this.parentNode?.removeChild(this); }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    for (const n of nodes) this.appendChild(typeof n === 'string' ? new TextNode(n) : n);
  }

  replaceWith(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    parent.childNodes.splice(index, 1);
    this.parentNode = null;
    let offset = 0;
    for (const n of nodes) {
      const node = typeof n === 'string' ? new TextNode(n) : n;
      node.parentNode = parent;
      parent.childNodes.splice(index + offset, 0, node);
      offset++;
    }
  }

  /** Inserta nodos justo después de este (Node.after). */
  after(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    let offset = 1;
    for (const n of nodes) {
      const node = typeof n === 'string' ? new TextNode(n) : n;
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = parent;
      parent.childNodes.splice(index + offset, 0, node);
      offset++;
    }
  }

  /** Inserta nodos justo antes de este (Node.before). */
  before(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    let offset = 0;
    for (const n of nodes) {
      const node = typeof n === 'string' ? new TextNode(n) : n;
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = parent;
      parent.childNodes.splice(index + offset, 0, node);
      offset++;
    }
  }

  cloneNode(deep = false) {
    const copy = new DOMNode(this.nodeType, this.nodeName);
    copy._text = this._text;
    copy._value = this._value;
    copy._checked = this._checked;
    copy._id = this._id;
    copy.classList.set = new Set(this.classList.set);
    copy.attributes = new Map(this.attributes);
    copy.dataset = { ...this.dataset };
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }

  addEventListener(type, handler, options) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push({ handler, options });
  }

  removeEventListener(type, handler) {
    const list = this._listeners.get(type);
    if (!list) return;
    this._listeners.set(type, list.filter((entry) => entry.handler !== handler));
  }

  /**
   * Dispara un evento sintético que sube por el árbol (bubbling).
   *
   * Respeta tanto los manejadores de `addEventListener` como las propiedades
   * `onclick`/`onsubmit`/…, que es como el navegador se comporta de verdad y
   * como el proyecto cablea buena parte de los formularios.
   */
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    let node = this;
    let stopped = false;
    const originalStop = event.stopPropagation;
    event.stopPropagation = () => { stopped = true; if (originalStop) originalStop.call(event); };
    if (!event.preventDefault) event.preventDefault = () => { event.defaultPrevented = true; };

    while (node && !stopped) {
      const list = node._listeners?.get(event.type) || [];
      for (const { handler } of [...list]) {
        try {
          handler.call(node, event);
        } catch (err) {
          err.message = `[evento ${event.type} en <${String(node.nodeName).toLowerCase()}>] ${err.message}` + ' @@ ' + String(err.stack).split('\n').slice(1, 5).join(' » ');
          throw err;
        }
      }
      const propertyHandler = node[`on${event.type}`];
      if (typeof propertyHandler === 'function') {
        try {
          propertyHandler.call(node, event);
        } catch (err) {
          err.message = `[evento ${event.type} en <${String(node.nodeName).toLowerCase()}>] ${err.message}` + ' @@ ' + String(err.stack).split('\n').slice(1, 5).join(' » ');
          throw err;
        }
      }
      node = node.parentNode;
    }
    return !event.defaultPrevented;
  }

  click() {
    this.dispatchEvent(new DOMEvent('click', { bubbles: true }));
  }

  /** Envía el formulario como haría el navegador al pulsar su botón. */
  requestSubmit() {
    this.dispatchEvent(new DOMEvent('submit', { bubbles: true, cancelable: true }));
  }

  submit() { this.requestSubmit(); }

  focus() { globalThis.document.activeElement = this; }
  blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; }
  select() {}
  scrollIntoView() {}
  scrollTo() {}
  setSelectionRange() {}
  removeAttributeNS() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20, bottom: 20, right: 100 }; }

  /* ---------- Consultas ---------- */

  querySelector(selector) { return queryAll(this, selector)[0] || null; }
  querySelectorAll(selector) { return queryAll(this, selector); }

  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  matches(selector) { return matches(this, selector); }
  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentNode;
    }
    return false;
  }

  /** No implementado: ningún módulo de HORUS usa innerHTML con estructura. */
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML no está soportado en el DOM de pruebas'); }
}

class TextNode extends DOMNode {
  constructor(text) { super(3, '#text'); this._text = String(text); }
}

class DOMEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.defaultPrevented = false;
    this.target = init.target || null;
    this.key = init.key;
    this.altKey = !!init.altKey;
    this.ctrlKey = !!init.ctrlKey;
    this.metaKey = !!init.metaKey;
    this.shiftKey = !!init.shiftKey;
    this.detail = init.detail;
    this.dataTransfer = init.dataTransfer;
    this.preloadResponse = init.preloadResponse;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
}

/* ==================================================================== *
 * Selectores (subconjunto: etiqueta, .clase, #id y sus combinaciones)
 * ==================================================================== */

function matches(node, selector) {
  if (node.nodeType !== 1) return false;
  const parts = String(selector).trim().split(/\s+/);
  // Solo se soporta el último componente con combinaciones de tipo/clase/id;
  // los selectores descendientes se resuelven comprobando el ancestro.
  const last = parts[parts.length - 1];
  if (!matchSimple(node, last)) return false;

  let ancestor = node.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (ancestor) {
      if (ancestor.nodeType === 1 && matchSimple(ancestor, parts[i])) { found = true; ancestor = ancestor.parentNode; break; }
      ancestor = ancestor.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

function matchSimple(node, simple) {
  // Separa por comas el caso más común y se queda con el primero
  const selector = String(simple).split(',')[0].trim();
  if (!selector) return true;

  // [attr], [attr="v"], [attr^="v"], [attr$="v"], [attr*="v"]
  const attrRe = /\[([\w:-]+)(?:([~^$*|]?)=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let base = selector.replace(attrRe, '');
  let match;
  attrRe.lastIndex = 0;
  while ((match = attrRe.exec(selector))) {
    const [, name, op, v1, v2, v3] = match;
    const expected = v1 ?? v2 ?? v3 ?? null;
    if (!node.hasAttribute(name)) return false;
    if (expected !== null) {
      const actual = node.getAttribute(name) ?? '';
      if (op === '^' && !actual.startsWith(expected)) return false;
      else if (op === '$' && !actual.endsWith(expected)) return false;
      else if (op === '*' && !actual.includes(expected)) return false;
      else if (op === '~' && !actual.split(/\s+/).includes(expected)) return false;
      else if (!op && actual !== expected) return false;
    }
  }

  // Pseudo-clases
  const notMatch = /:not\(([^)]*)\)/.exec(base);
  if (notMatch) {
    base = base.replace(notMatch[0], '');
    if (matchSimple(node, notMatch[1])) return false;
  }
  if (/:disabled\b/.test(base) && !node.disabled) return false;
  if (/:enabled\b/.test(base) && node.disabled) return false;
  if (/:checked\b/.test(base) && !node.checked) return false;
  base = base.replace(/:(?:focus|focus-visible|hover|active|first-child|last-child|only-child|checked|disabled|enabled)\b/g, '');

  const idMatch = /#([\w-]+)/.exec(base);
  if (idMatch) {
    if (node.id !== idMatch[1]) return false;
    base = base.replace(idMatch[0], '');
  }

  const classMatches = [...base.matchAll(/\.([\w-]+)/g)];
  for (const cm of classMatches) {
    if (!node.classList.contains(cm[1])) return false;
    base = base.replace(cm[0], '');
  }

  const rest = base.trim();
  if (rest && rest !== '*') {
    const names = rest.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (names.length && !names.some((n) => n === node.nodeName || (n === 'DIALOG' && node.nodeName === 'DIALOG'))) return false;
  }

  // Pseudo-elementos al final: se ignoran
  return true;
}

function queryAll(root, selector) {
  const results = [];
  const selectors = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (selectors.some((sel) => matches(child, sel))) results.push(child);
      walk(child);
    }
  };
  walk(root);
  return results;
}

/* ==================================================================== *
 * Documento
 * ==================================================================== */

class Document extends DOMNode {
  constructor() {
    super(9, '#document');
    this.__isDocument = true;
    this.documentElement = new DOMNode(1, 'html');
    // El elemento raíz tiene que estar DENTRO de childNodes, no solo apuntado
    // por parentNode: si no, la búsqueda por descendencia desde el documento
    // (que es como se resuelve getElementById) no encuentra nada.
    this.documentElement.parentNode = this;
    this.childNodes.push(this.documentElement);

    this.head = new DOMNode(1, 'head');
    this.body = new DOMNode(1, 'body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);

    this.activeElement = this.body;
    this.visibilityState = 'visible';
    this.hidden = false;
    this.readyState = 'complete';
    this._dialogs = [];
  }

  createElement(tag) {
    const node = new DOMNode(1, tag);
    if (tag.toLowerCase() === 'dialog') {
      node.open = false;
      node.showModal = () => {
        node.open = true;
        this._dialogs.push(node);
        node.dispatchEvent(new DOMEvent('open'));
      };
      node.show = node.showModal;
      node.close = (value) => {
        if (!node.open) return;
        node.open = false;
        this._dialogs = this._dialogs.filter((d) => d !== node);
        node.returnValue = value;
        node.dispatchEvent(new DOMEvent('close'));
      };
      node.requestClose = node.close;
    }
    return node;
  }

  createElementNS(_ns, tag) { return this.createElement(tag); }

  createTextNode(text) { return new TextNode(text); }

  createDocumentFragment() { return new DOMNode(11, '#fragment'); }

  getElementById(id) {
    const found = queryAll(this, `#${id}`);
    return found[0] || null;
  }

  getElementsByTagName(tag) { return queryAll(this, tag); }
  getElementsByClassName(cls) { return queryAll(this, `.${cls}`); }

  addEventListener(type, handler) { super.addEventListener(type, handler); }
  removeEventListener(type, handler) { super.removeEventListener(type, handler); }
}

/* ==================================================================== *
 * Parser de HTML (suficiente para index.html)
 * ==================================================================== */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr', 'path', 'circle',
  'line', 'rect', 'polyline', 'polygon', 'use', 'stop',
]);

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

export function parseHTML(html, document) {
  let index = 0;
  // Se parte de un documento recién creado: <html>, <head> y <body> ya existen
  // y el parser los reutiliza en lugar de crear duplicados.
  document.documentElement.childNodes = [];
  document.head = null;
  document.body = null;

  const stack = [document.documentElement];
  let current = document.documentElement;

  // El contenido del <body> se irá colocando bajo <body>
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open < 0) break;

    // Texto antes de la etiqueta
    if (open > index) {
      const text = html.slice(index, open);
      if (text.trim()) current.appendChild(document.createTextNode(text.trim()));
    }

    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', open)) {
      const end = html.indexOf('>', open);
      index = end < 0 ? html.length : end + 1;
      continue;
    }

    const close = html.indexOf('>', open);
    if (close < 0) break;
    const raw = html.slice(open + 1, close);
    index = close + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase();
      // Cierra hasta encontrar el elemento correspondiente
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].nodeName.toLowerCase() === name) {
          stack.length = i;
          current = stack[stack.length - 1];
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const spaceIndex = raw.search(/\s/);
    const tagName = (spaceIndex < 0 ? raw : raw.slice(0, spaceIndex)).replace(/\/$/, '').toLowerCase();
    const attrText = spaceIndex < 0 ? '' : raw.slice(spaceIndex);

    // Los elementos <html>, <head> y <body> ya existen
    let node;
    if (tagName === 'html') {
      node = document.documentElement;
    } else if (tagName === 'head') {
      document.head = new DOMNode(1, 'head');
      document.head.parentNode = document.documentElement;
      document.documentElement.appendChild(document.head);
      node = document.head;
    } else if (tagName === 'body') {
      document.body = new DOMNode(1, 'body');
      document.body.parentNode = document.documentElement;
      document.documentElement.appendChild(document.body);
      node = document.body;
    } else {
      node = document.createElement(tagName);
      applyAttributes(node, attrText);
    }

    if (tagName !== 'html' && tagName !== 'head' && tagName !== 'body') {
      current.appendChild(node);
    }
    current = node;

    if (VOID_TAGS.has(tagName) || selfClosing) {
      current = node.parentNode || document.body;
      continue;
    }

    // Contenido de texto crudo (script/style)
    if (RAW_TEXT_TAGS.has(tagName)) {
      const closeTag = `</${tagName}`;
      const end = html.toLowerCase().indexOf(closeTag, index);
      const content = end < 0 ? '' : html.slice(index, end);
      if (content) node.appendChild(document.createTextNode(content));
      index = end < 0 ? html.length : html.indexOf('>', end) + 1;
      current = node.parentNode || document.body;
      continue;
    }

    stack.push(node);
  }

  if (!document.body) {
    document.body = new DOMNode(1, 'body');
    document.body.parentNode = document.documentElement;
    document.documentElement.appendChild(document.body);
  }
  return document;
}

function applyAttributes(node, attrText) {
  // Ojo: el regex se crea aquí dentro a propósito. Uno compartido a nivel de
  // módulo arrastraría `lastIndex` entre llamadas y saltaría atributos.
  const re = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = re.exec(attrText))) {
    const [, name, v1, v2, v3] = match;
    if (!name || name === '/') continue;
    const value = v1 ?? v2 ?? v3 ?? '';
    node.setAttribute(name, value);
  }
  // El acceso directo `node.id` debe reflejar el atributo ya desde el parseo
  const id = node.attributes.get('id');
  if (id) node._id = id;
  const cls = node.attributes.get('class');
  if (cls) node.className = cls;
}

/* ==================================================================== *
 * Instalación del entorno
 * ==================================================================== */

/** Copia las propiedades de un navigator falso sobre el global de Node. */
function redefineNavigator(fake) {
  const target = globalThis.navigator;
  if (!target) return;
  for (const key of Object.keys(fake)) {
    try {
      Object.defineProperty(target, key, {
        value: fake[key], configurable: true, writable: true, enumerable: true,
      });
    } catch {
      // Algunas propiedades son no configurables: se intenta asignar y si no, se ignora
      try { target[key] = fake[key]; } catch { /* nada */ }
    }
  }
}

export function installDOM(html) {
  const document = new Document();
  if (html) parseHTML(html, document);

  const listeners = new Map();
  const matchMediaCache = new Map();

  const window = {
    document,
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    location: {
      href: 'https://example.test/horus/index.html',
      origin: 'https://example.test',
      pathname: '/horus/index.html',
      search: '',
      hash: '',
      protocol: 'https:',
      assign() {}, replace() {}, reload() {},
    },
    history: { replaceState() {}, pushState() {}, back() {} },
    localStorage: null,
    sessionStorage: null,
    matchMedia: (query) => {
      if (!matchMediaCache.has(query)) {
        const list = [];
        const stub = {
          matches: false,
          media: query,
          addEventListener: (type, fn) => { if (type === 'change') list.push(fn); },
          removeEventListener: (type, fn) => {
            const i = list.indexOf(fn);
            if (i >= 0) list.splice(i, 1);
          },
          addListener: (fn) => list.push(fn),
          removeListener: (fn) => {
            const i = list.indexOf(fn);
            if (i >= 0) list.splice(i, 1);
          },
          dispatch: () => list.forEach((fn) => fn({ matches: false, media: query })),
        };
        matchMediaCache.set(query, stub);
      }
      return matchMediaCache.get(query);
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type);
      if (!list) return;
      listeners.set(type, list.filter((h) => h !== handler));
    },
    dispatch(type, event) {
      for (const handler of [...(listeners.get(type) || [])]) handler(event || new DOMEvent(type));
    },
    getComputedStyle: () => ({
      getPropertyValue: () => '',
      position: 'static',
    }),
    scrollTo() {},
    print() {},
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    open: () => null,
    alert() {},
    confirm: () => true,
    prompt: () => null,
    URL: globalThis.URL,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };

  const makeStorage = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      clear: () => map.clear(),
      key: (i) => [...map.keys()][i] ?? null,
      get length() { return map.size; },
      _map: map,
    };
  };
  window.localStorage = makeStorage();
  window.sessionStorage = makeStorage();

  // Notificaciones: se activan por defecto para poder probar los avisos
  const notifications = [];
  class FakeNotification {
    static permission = 'granted';
    static requestPermission = async () => 'granted';
    constructor(title, options) { notifications.push({ title, options }); }
  }
  window.Notification = FakeNotification;

  // Service worker que solo apunta lo que se le pide
  const swMessages = [];
  window.navigator = {
    onLine: true,
    userAgent: 'node-horus-smoke',
    platform: 'node',
    language: 'es-ES',
    serviceWorker: {
      controller: {
        postMessage: (payload) => swMessages.push(payload),
      },
      ready: Promise.resolve({
        showNotification: (title, options) => { notifications.push({ title, options, via: 'registration' }); },
        active: { postMessage: (payload) => swMessages.push(payload) },
      }),
      register: async () => ({ addEventListener() {}, installing: null }),
      addEventListener() {},
    },
    clipboard: {
      writeText: async (text) => { window.__clipboard = text; },
    },
  };

  // Globales
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.localStorage = window.localStorage;
  globalThis.sessionStorage = window.sessionStorage;
  globalThis.matchMedia = window.matchMedia;
  // `navigator` es de solo lectura en Node: se redefinen sus propiedades en
  // lugar de sustituir el objeto.
  redefineNavigator(window.navigator);
  globalThis.Notification = FakeNotification;
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
  globalThis.getComputedStyle = window.getComputedStyle;
  globalThis.DOMEvent = DOMEvent;
  globalThis.HTMLInputElement = DOMNode;
  globalThis.HTMLTextAreaElement = DOMNode;
  globalThis.HTMLSelectElement = DOMNode;
  globalThis.HTMLElement = DOMNode;
  globalThis.Node = DOMNode;
  globalThis.Element = DOMNode;
  if (!globalThis.CustomEvent) globalThis.CustomEvent = DOMEvent;
  if (!globalThis.Blob) globalThis.Blob = class Blob { constructor(parts) { this.parts = parts; } };
  if (typeof globalThis.URL.createObjectURL !== 'function') {
    globalThis.URL.createObjectURL = () => 'blob:stub';
    globalThis.URL.revokeObjectURL = () => {};
  }

  return {
    document,
    window,
    notifications,
    swMessages,
    events: listeners,
    dispatch: window.dispatch,
    DOMEvent,
    DOMNode,
    TextNode,
    reset() {
      notifications.length = 0;
      swMessages.length = 0;
      window.localStorage.clear();
      window.sessionStorage.clear();
      window.__clipboard = null;
    },
  };
}

export { DOMNode, TextNode, DOMEvent, ClassList };

