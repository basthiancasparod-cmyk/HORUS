/**
 * HORUS — tools/check.mjs
 * Comprobador estático del proyecto. Sin dependencias.
 *
 * Qué revisa:
 *   1. Sintaxis y ENLACADO de todos los módulos ES: importa cada uno en Node
 *      (con un DOM mínimo) y verifica que exista cada nombre importado. Un
 *      `export { algoNoImportado }` o un import mal escrito falla aquí.
 *   2. Que todos los `getElementById`/`querySelector('#id')` del código existan
 *      en index.html, y que no queden ids declarados sin usar (informativo).
 *   3. Que las clases CSS personalizadas usadas en el JS estén definidas en
 *      alguna hoja de `css/`, y que los archivos listados en el precache del
 *      service worker existan de verdad.
 *   4. Que las rutas de import relativas apunten a archivos existentes.
 *
 * Uso: node tools/check.mjs [--quiet]
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const QUIET = process.argv.includes('--quiet');

const problems = [];
const notes = [];

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

function fail(area, message) {
  problems.push({ area, message });
}

function note(area, message) {
  notes.push({ area, message });
}

function read(path) {
  return readFileSync(path, 'utf8');
}

/* ================================================================== *
 * 1. Recopilar archivos
 * ================================================================== */

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      walk(full, filter, out);
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

const jsFiles = walk(join(ROOT, 'js'), (f) => f.endsWith('.js'));
const cssFiles = walk(join(ROOT, 'css'), (f) => f.endsWith('.css'));
const toolFiles = walk(join(ROOT, 'tools'), (f) => f.endsWith('.mjs'));

const htmlPath = join(ROOT, 'index.html');
const html = existsSync(htmlPath) ? read(htmlPath) : '';
if (!html) fail('index.html', 'no existe');

const allCss = cssFiles.map((f) => read(f)).join('\n');
const allJs = jsFiles.map((f) => ({ path: f, text: read(f) }));

/* ================================================================== *
 * 2. Comprobar nombres importados contra los exportados (sin ejecutar)
 *
 * Se hace de forma estática y por separado de la importación real, porque
 * algunos módulos no se pueden cargar en Node (usan `document` al evaluarse) y
 * porque un error de nombre se explica mucho mejor con nombres y líneas.
 * ================================================================== */

/** Extrae los nombres que un módulo exporta. */
function exportedNames(text) {
  const names = new Set();

  // export const/let/var/function/class NAME   y   export async function NAME
  for (const m of text.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }

  // export const { a, b } = ...   y   export function f({ a }) {}  → no aplica
  // export { a, b as c, default as d }
  for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(part);
      if (asMatch) { names.add(asMatch[1]); continue; }
      const identifier = /^([A-Za-z_$][\w$]*)/.exec(part);
      if (identifier) names.add(identifier[1]);
    }
  }

  // export * from './x' → no se puede resolver sin recursión; se marca
  const hasStarExport = /\bexport\s*\*\s*from/.test(text);
  return { names, hasStarExport };
}

const exportCache = new Map();
function exportsOf(file) {
  const key = resolve(file);
  if (exportCache.has(key)) return exportCache.get(key);
  const result = exportedNames(read(key));
  exportCache.set(key, result);
  return result;
}

const IMPORT_NAMES_RE = /\bimport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

for (const { path, text } of [...allJs, ...toolFiles.map((f) => ({ path: f, text: read(f) }))]) {
  IMPORT_NAMES_RE.lastIndex = 0;
  let match;
  while ((match = IMPORT_NAMES_RE.exec(text))) {
    const [, rawNames, spec] = match;
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(path), spec);
    if (!existsSync(target)) continue; // ya se avisa en la sección de imports

    const line = text.slice(0, match.index).split('\n').length;
    const { names, hasStarExport } = exportsOf(target);
    if (hasStarExport) continue; // no se puede comprobar con exactitud

    for (const raw of rawNames.split(',')) {
      const part = raw.trim();
      if (!part || part.startsWith('type ')) continue;
      // `a as b` importa `a`
      const imported = (/^([A-Za-z_$][\w$]*)/.exec(part) || [])[1];
      if (!imported || imported === 'default') continue;
      if (!names.has(imported)) {
        fail('exports', `${rel(path)}:${line} importa «${imported}» de «${spec}» y ese módulo no lo exporta`);
      }
    }
  }

  // Nombres reexportados que no existen localmente
  for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}\s*(?:;|$)/g)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim();
      if (!part || part.includes(' from ')) continue;
      const source = (/^([A-Za-z_$][\w$]*)/.exec(part) || [])[1];
      if (!source) continue;
      const asName = /\bas\s+/.test(part);
      if (asName) continue; // un alias puede reexportar algo importado
      const declared = new RegExp(`\\b(?:const|let|var|function|class)\\s+${source}\\b`).test(text)
        || new RegExp(`\\bimport\\s*\\{[^}]*\\b${source}\\b[^}]*\\}`).test(text)
        || new RegExp(`\\bimport\\s+${source}\\b`).test(text);
      if (!declared) {
        fail('exports', `${rel(path)} reexporta «${source}» pero no está definido ni importado`);
      }
    }
  }
}

/* ================================================================== *
 * 3. Importar cada módulo para comprobar sintaxis y enlazado
 * ================================================================== */

/**
 * DOM mínimo suficiente para que los módulos que tocan `document` en tiempo de
 * carga no revienten. No simula comportamiento: solo evita el ReferenceError.
 */
function installMinimalDom() {
  const makeEl = () => ({
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    hidden: false,
    children: [],
    firstElementChild: null,
    lastElementChild: null,
    value: '',
    textContent: '',
    innerHTML: '',
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren() {},
    insertBefore(c) { this.children.push(c); return c; },
    removeChild() {},
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    closest: () => null,
    focus() {},
    click() {},
    reset() {},
    submit() {},
    scrollTo() {},
    matches: () => false,
    contains: () => false,
    cloneNode() { return makeEl(); },
    replaceWith() {},
    animate: () => ({ finished: Promise.resolve(), cancel() {} }),
    isConnected: true,
    lastElementChild2: null,
  });

  const documentStub = {
    documentElement: makeEl(),
    body: makeEl(),
    head: makeEl(),
    hidden: false,
    visibilityState: 'visible',
    activeElement: null,
    createElement: () => makeEl(),
    createElementNS: () => makeEl(),
    createTextNode: (t) => ({ textContent: t, nodeType: 3 }),
    createDocumentFragment: () => makeEl(),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    execCommand: () => true,
    fonts: { ready: Promise.resolve() },
  };

  const matchMediaStub = () => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });

  const localStorageStub = (() => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      clear: () => map.clear(),
      key: (i) => [...map.keys()][i] ?? null,
      get length() { return map.size; },
    };
  })();

  const locationStub = {
    href: 'https://example.test/horus/',
    origin: 'https://example.test',
    pathname: '/horus/',
    search: '',
    hash: '',
    protocol: 'https:',
    assign() {},
    replace() {},
    reload() {},
  };

  globalThis.document = documentStub;
  globalThis.window = globalThis.window || {};
  Object.assign(globalThis.window, {
    document: documentStub,
    location: locationStub,
    history: { replaceState() {}, pushState() {} },
    matchMedia: matchMediaStub,
    localStorage: localStorageStub,
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 800,
    scrollTo() {},
    print() {},
    Notification: undefined,
    serviceWorker: undefined,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  });
  globalThis.localStorage = localStorageStub;
  globalThis.location = locationStub;
  globalThis.history = globalThis.window.history;
  globalThis.matchMedia = matchMediaStub;
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;
  globalThis.getComputedStyle = globalThis.window.getComputedStyle;
  globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  if (!globalThis.navigator) globalThis.navigator = {};
  try {
    Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true, writable: true });
    Object.defineProperty(globalThis.navigator, 'userAgent', { value: 'node-check', configurable: true, writable: true });
    Object.defineProperty(globalThis.navigator, 'platform', { value: 'node', configurable: true, writable: true });
  } catch { /* ya existe y no se puede redefinir */ }
  if (typeof globalThis.URL.createObjectURL !== 'function') {
    globalThis.URL.createObjectURL = () => 'blob:stub';
    globalThis.URL.revokeObjectURL = () => {};
  }
  if (typeof globalThis.Blob === 'undefined') {
    globalThis.Blob = class Blob { constructor(parts) { this.parts = parts; } };
  }
}

installMinimalDom();

const importOrder = [
  ...jsFiles.filter((f) => /[\\/]core[\\/]/.test(f)),
  ...jsFiles.filter((f) => /[\\/]ui[\\/]/.test(f)),
  ...jsFiles.filter((f) => !/[\\/]core[\\/]/.test(f) && !/[\\/]ui[\\/]/.test(f)),
];

const loaded = new Set();
const loadFailures = [];

for (const file of importOrder) {
  const name = rel(file);
  try {
    await import(pathToFileURL(file).href);
    loaded.add(name);
  } catch (err) {
    loadFailures.push({ file: name, error: err });
    fail('enlazado', `${name} no se puede importar: ${err.message.split('\n')[0]}`);
  }
}

if (!QUIET) {
  console.log(`\n\x1b[1mMódulos ES comprobados\x1b[0m (${loaded.size}/${importOrder.length})`);
  for (const item of loadFailures) {
    console.log(`  \x1b[31m✗\x1b[0m ${item.file}`);
    console.log(`      ${item.error.message.split('\n')[0]}`);
  }
}

/* ================================================================== *
 * 3. Rutas de import relativas
 * ================================================================== */

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Sustituye los comentarios por espacios conservando el número de líneas. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, prefix) => prefix + ' '.repeat(m.length - prefix.length));
}

const sourceFiles = [...allJs, ...toolFiles.map((f) => ({ path: f, text: read(f) }))];

for (const { path, text } of sourceFiles) {
  const code = stripComments(text);
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(code))) {
      const spec = match[1];
      if (!spec.startsWith('.')) continue;
      const target = resolve(dirname(path), spec);
      if (!existsSync(target)) {
        fail('imports', `${rel(path)} importa «${spec}» y ese archivo no existe`);
      }
    }
  }
}

/* ================================================================== *
 * 4. Ids del HTML
 * ================================================================== */

const htmlIds = new Set();
{
  const re = /\bid\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(html))) htmlIds.add(match[1]);
}

const usedIds = new Map(); // id -> [archivos]
function recordId(id, file) {
  if (!usedIds.has(id)) usedIds.set(id, new Set());
  usedIds.get(id).add(rel(file));
}

for (const { path, text } of allJs) {
  // byId('x'), getElementById('x'), querySelector('#x') y sus variantes
  // construidas con plantilla: byId(`fila-${id}`) → se ignora la parte variable.
  const patterns = [
    /\bbyId\(\s*['"]([^'"]+)['"]/g,
    /getElementById\(\s*['"]([^'"]+)['"]/g,
    /querySelector(?:All)?\(\s*['"]#([A-Za-z][\w-]*)['"]/g,
    /byId\(\s*`([^`$]+)\$\{/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      const id = match[1];
      // Los ids puramente dinámicos (concatenados) no llegan aquí
      if (id.includes('$') || id.includes('{')) continue;
      // Un prefijo que termina en guion viene de una plantilla: view-${v}
      if (/[-_]$/.test(id)) continue;
      recordId(id, path);
      // Los ids creados en tiempo de ejecución (dentro de un diálogo) no están
      // en el HTML: se marcan como dinámicos si aparecen en un `el(...)` con
      // ese mismo id.
      const dynamic = new RegExp(`id\\s*:\\s*['"\`]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
      if (dynamic.test(text)) {
        note('ids', `${rel(path)} usa el id dinámico «${id}» (se crea en tiempo de ejecución)`);
        continue;
      }
      if (html && !htmlIds.has(id) && !id.endsWith('-inline')) {
        fail('ids', `${rel(path)} usa el id «${id}» y no existe en index.html`);
      }
    }
  }
}

// Ids del HTML que no usa nadie (informativo, no es un error)
if (html) {
  const unused = [...htmlIds].filter((id) => !usedIds.has(id) && !id.startsWith('tab-') && !id.startsWith('pane-'));
  if (unused.length) {
    note('ids', `${unused.length} id(s) de index.html sin uso en el JS: ${unused.slice(0, 12).join(', ')}${unused.length > 12 ? '…' : ''}`);
  }
}

/* ================================================================== *
 * 5. Clases CSS
 * ================================================================== */

// Clases definidas en las hojas
const definedClasses = new Set();
{
  const re = /\.(-?[_a-zA-Z][\w-]*)/g;
  let match;
  while ((match = re.exec(allCss))) definedClasses.add(match[1]);
}

// Clases que aplica el JS vía class/className/classList/template
const classAttrs = [
  // class: 'a b c'  /  className: '…'  (incluye plantillas sin interpolación pura)
  /\bclass(?:Name)?\s*[:=]\s*['"]([^'"]+)['"]/g,
  /\bclass(?:Name)?\s*[:=]\s*`([^`$]*)`/g,
  /\bclassList\.(?:add|remove|toggle|contains)\(\s*['"]([^'"]+)['"]/g,
  // class="a b" dentro de una plantilla
  /\bclass=\\?["'`]([^"'`]+)/g,
];

const ignoredPrefixes = ['is-', 'has-', 'js-', 'ql-'];
/**
 * Las clases con prefijo variable (`toast-${type}`) no se pueden comprobar con
 * exactitud: solo se mira el prefijo, así que se listan aquí como conocidas.
 */
const dynamicClassPrefixes = ['toast-'];
const appliedClasses = new Map(); // clase -> archivo

for (const { path, text } of allJs) {
  // Los ejemplos de la documentación no son código real
  const code = rel(path).endsWith('core/utils.js')
    ? text.replace(/\/\*\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    : text;

  for (const re of classAttrs) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(code))) {
      const tokens = match[1].split(/\s+/).filter(Boolean);
      for (const raw of tokens) {
        const cls = raw.replace(/\$\{[^}]*\}/g, '').trim();
        if (!cls || cls.includes('$')) continue;
        if (!/^-?[_a-zA-Z][\w-]*$/.test(cls)) continue;
        if (ignoredPrefixes.some((p) => cls.startsWith(p))) continue;
        if (dynamicClassPrefixes.some((p) => cls.startsWith(p))) continue;
        if (!appliedClasses.has(cls)) appliedClasses.set(cls, new Set());
        appliedClasses.get(cls).add(rel(path));
      }
    }
  }
}

const unknownClasses = [];
for (const [cls, files] of appliedClasses) {
  if (!definedClasses.has(cls)) unknownClasses.push({ cls, files: [...files] });
}
unknownClasses.sort((a, b) => a.cls.localeCompare(b.cls));
for (const item of unknownClasses) {
  note('css', `clase «${item.cls}» usada en ${item.files.join(', ')} y no definida en css/`);
}

/* ================================================================== *
 * 6. Recursos del service worker
 * ================================================================== */

const swPath = join(ROOT, 'sw.js');
if (existsSync(swPath)) {
  const sw = read(swPath);
  const block = /const PRECACHE = \[([\s\S]*?)\];/.exec(sw);
  if (!block) {
    fail('sw', 'no se encontró la lista PRECACHE');
  } else {
    const assets = [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const asset of assets) {
      if (asset === './') continue;
      const target = join(ROOT, asset.replace(/^\.\//, ''));
      if (!existsSync(target)) fail('sw', `el precache lista «${asset}» y no existe`);
    }
    if (!QUIET) console.log(`\n\x1b[1mPrecache del service worker\x1b[0m (${assets.length} recursos)`);

    // Todos los .js de js/ deberían estar precacheados o no existirían offline
    const missed = jsFiles
      .map((f) => `./${rel(f)}`)
      .filter((p) => !assets.includes(p));
    if (missed.length) {
      note('sw', `${missed.length} módulo(s) fuera del precache: ${missed.join(', ')}`);
    }
  }
} else {
  fail('sw', 'no existe sw.js');
}

/* ================================================================== *
 * 7. Manifiesto
 * ================================================================== */

const manifestPath = join(ROOT, 'manifest.json');
if (existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(read(manifestPath));
    for (const required of ['name', 'short_name', 'start_url', 'display', 'icons']) {
      if (!manifest[required]) fail('manifest', `falta el campo «${required}»`);
    }
    for (const icon of manifest.icons || []) {
      if (!existsSync(join(ROOT, icon.src))) fail('manifest', `el icono «${icon.src}» no existe`);
    }
    if (!(manifest.icons || []).some((i) => String(i.purpose || '').includes('maskable'))) {
      fail('manifest', 'no hay ningún icono con purpose "maskable" (Android lo necesita)');
    }
  } catch (err) {
    fail('manifest', `no es JSON válido: ${err.message}`);
  }
} else {
  fail('manifest', 'no existe manifest.json');
}

/* ================================================================== *
 * 8. Comprobaciones de coherencia del HTML
 * ================================================================== */

if (html) {
  // Cada data-view del HTML debe ser una vista conocida
  const contextText = read(join(ROOT, 'js', 'ui', 'context.js'));
  const viewsMatch = /export const VIEWS = \[([^\]]+)\]/.exec(contextText);
  const views = viewsMatch ? [...viewsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  for (const match of html.matchAll(/data-view="([^"]+)"/g)) {
    if (!views.includes(match[1])) fail('html', `data-view="${match[1]}" no está en context.VIEWS`);
  }
  // Y cada vista de VIEWS debe existir en el HTML
  for (const view of views) {
    if (!html.includes(`id="view-${view}"`)) fail('html', `falta la sección id="view-${view}"`);
  }
  // Y cada vista debe tener su archivo
  for (const view of views) {
    const file = join(ROOT, 'js', 'ui', 'views', `${view}.js`);
    if (!existsSync(file)) fail('vistas', `no existe js/ui/views/${view}.js`);
  }
  // Todos los <script src> y <link href> locales deben existir
  for (const match of html.matchAll(/(?:src|href)="(?!https?:|data:|#|mailto:)([^"]+)"/g)) {
    const target = join(ROOT, match[1]);
    if (!existsSync(target)) fail('html', `el recurso «${match[1]}» no existe`);
  }
}

/* ================================================================== *
 * Informe
 * ================================================================== */

if (!QUIET) {
  if (notes.length) {
    console.log(`\n\x1b[1m\x1b[33mAvisos\x1b[0m (${notes.length})`);
    for (const item of notes) console.log(`  · [${item.area}] ${item.message}`);
  }
}

console.log(`\n${'─'.repeat(62)}`);
if (problems.length === 0) {
  console.log('\x1b[1m\x1b[32m✓ Comprobación estática superada sin errores\x1b[0m');
  if (notes.length) console.log(`  ${notes.length} aviso(s) informativo(s)`);
} else {
  console.log(`\x1b[1m\x1b[31m✗ ${problems.length} problema(s) encontrado(s)\x1b[0m`);
  for (const item of problems) console.log(`  · [${item.area}] ${item.message}`);
}
console.log(`${'─'.repeat(62)}\n`);

process.exit(problems.length === 0 ? 0 : 1);
