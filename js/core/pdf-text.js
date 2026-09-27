/**
 * HORUS — js/core/pdf-text.js
 * Lector de texto de PDF con posiciones, sin dependencias.
 *
 * Existe porque los cuadrantes que reparte la empresa suelen ser PDF generados
 * con «Imprimir a PDF»: texto real, pero con fuentes CID (Identity-H) y mapas
 * ToUnicode, así que hay que interpretar el flujo de contenido de verdad.
 *
 * Interpreta:
 *  - la pila de estados gráficos (q / Q) y la matriz de transformación (cm),
 *  - las matrices de texto (Tm / Td / TD / T* / TL / Ts),
 *  - los operadores de texto (Tj / TJ / ' / ") y las cadenas hexadecimales,
 *  - los mapas ToUnicode (bfchar y bfrange) para traducir glifos a caracteres.
 *
 * Sin la CTM las coordenadas salen en el espacio del productor y no coinciden
 * con la página: es el error que hacía imposible mapear un cuadrante a fechas.
 *
 * Funciona igual en el navegador y en Node: no toca red ni DOM.
 */

/* ------------------------------------------------------------------ *
 * Utilidades de bytes
 * ------------------------------------------------------------------ */

const LATIN = 'latin1';

/** Convierte un Uint8Array a cadena latin1 sin reventar la pila. */
function bytesToLatin(bytes) {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Carga
 * ------------------------------------------------------------------ */

/**
 * Lee un PDF ya cargado en memoria.
 *
 * Los índices de la cadena latin1 coinciden 1 a 1 con los del array de bytes
 * (latin1 es un byte por carácter), así que se puede localizar todo sobre la
 * cadena y luego extraer solo el trozo de bytes que hace falta. Así no se
 * duplica el PDF entero en memoria ni se crean subcadenas de cada stream.
 *
 * @param {Uint8Array} bytes
 */
export function loadPdfFromBytes(bytes) {
  const latin = bytesToLatin(bytes);

  const objects = new Map();
  const objectOffset = new Map(); // num de objeto → posición en el archivo
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  const starts = [];
  let m;
  while ((m = objRe.exec(latin))) {
    // `m.index` es donde empieza "N 0 obj": el cuerpo arranca al final del match
    starts.push({ num: Number(m[1]), bodyStart: objRe.lastIndex, fileStart: m.index });
  }

  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].bodyStart;
    const to = i + 1 < starts.length ? starts[i + 1].fileStart : latin.length;
    const body = latin.slice(from, to);
    const end = body.lastIndexOf('endobj');
    objects.set(starts[i].num, body.slice(0, end < 0 ? body.length : end));
    objectOffset.set(starts[i].num, from);
  }

  /**
   * Localiza un stream dentro del objeto.
   *
   * El final se determina con `/Length` del diccionario (como manda el estándar)
   * y no buscando el texto «endstream»: los datos comprimidos pueden contener
   * esa secuencia por casualidad, y además incluir el salto de línea previo
   * hacía que DecompressionStream rechazara el stream por «datos de más».
   * `/Length` puede ser indirecto (`/Length 12 0 R`), así que se resuelve.
   */
  function locateStream(objNum) {
    const body = objects.get(objNum);
    if (!body) return null;
    const s = body.indexOf('stream');
    if (s < 0) return null;
    const dict = body.slice(0, s);
    const base = objectOffset.get(objNum) ?? 0;

    let start = base + s + 6;
    if (bytes[start] === 0x0d) start++;
    if (bytes[start] === 0x0a) start++;

    // /Length directo o indirecto
    const lenMatch = /\/Length\s+(\d+)(?:\s+(\d+)\s+R)?/.exec(dict);
    let length = null;
    if (lenMatch) {
      if (lenMatch[2]) {
        const ref = objects.get(Number(lenMatch[1]));
        const resolved = ref && /^\s*(\d+)\s*$/.exec(ref);
        if (resolved) length = Number(resolved[1]);
      } else {
        length = Number(lenMatch[1]);
      }
    }

    // Se acepta /Length solo si el stream cabe en el archivo; si no, se recurre
    // a buscar «endstream» dentro de este objeto.
    let end = length !== null && start + length <= bytes.length ? start + length : null;
    if (end === null) {
      const endIdx = body.indexOf('endstream', s);
      end = endIdx < 0 ? bytes.length : base + endIdx;
      // Se recortan los espacios que el productor deja antes de «endstream»
      while (end > start && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d || bytes[end - 1] === 0x20)) end--;
    }

    return { start, end, dict };
  }

  function pageSize() {
    const mb = /\/MediaBox\s*\[([^\]]+)\]/.exec(latin);
    if (!mb) return { width: 595, height: 842 };
    const p = mb[1].trim().split(/\s+/).map(Number);
    return { width: Math.abs(p[2] - p[0]), height: Math.abs(p[3] - p[1]) };
  }

  return {
    latin,
    bytes,
    objects,
    pageSize,
    /** Stream descomprimido. Devuelve null si no se puede (p. ej. DCTDecode). */
    async streamOf(objNum) {
      const entry = locateStream(objNum);
      if (!entry) return null;
      const raw = bytes.subarray(entry.start, entry.end);
      if (/FlateDecode/.test(entry.dict)) return inflateToLatin(raw);
      if (/Filter/.test(entry.dict)) return null; // otro filtro: no soportado
      return bytesToLatin(raw);
    },
  };
}

/**
 * Descomprime con la API del navegador o con zlib de Node.
 * Se resuelve en tiempo de ejecución para que el mismo archivo valga en ambos.
 */
async function inflateToLatin(raw) {
  // Navegador
  if (typeof DecompressionStream === 'function') {
    try {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'));
      const buffer = await new Response(stream).arrayBuffer();
      return bytesToLatin(new Uint8Array(buffer));
    } catch {
      // Algunos productores no ponen la cabecera zlib: se reintenta en crudo
      try {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const buffer = await new Response(stream).arrayBuffer();
        return bytesToLatin(new Uint8Array(buffer));
      } catch {
        return null;
      }
    }
  }
  // Node
  try {
    const { inflateSync } = await import('node:zlib');
    return inflateSync(Buffer.from(raw)).toString(LATIN);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Matrices 2D
 * ------------------------------------------------------------------ */

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function multiply(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function applyMatrix(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function matrixScale(m) {
  return Math.hypot(m[0], m[1]);
}

/* ------------------------------------------------------------------ *
 * ToUnicode
 * ------------------------------------------------------------------ */

function hexToText(hex) {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  }
  return out;
}

export function parseToUnicode(cmapText) {
  const map = new Map();
  if (!cmapText) return map;

  for (const m of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1], 16), hexToText(pair[2]));
    }
  }
  for (const m of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const block = m[1];
    for (const r of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(r[1], 16);
      const hi = parseInt(r[2], 16);
      const base = parseInt(r[3], 16);
      for (let c = lo; c <= hi && c - lo < 65536; c++) {
        map.set(c, hexToText((base + (c - lo)).toString(16).padStart(r[3].length, '0')));
      }
    }
    for (const r of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(r[1], 16);
      const texts = [...r[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hexToText(x[1]));
      texts.forEach((text, i) => map.set(lo + i, text));
    }
  }
  return map;
}

/** nombre de fuente (/F1) → Map(código → texto) */
export async function buildFontMaps(pdf) {
  const nameOfObject = new Map();
  for (const [num, body] of pdf.objects) {
    for (const m of body.matchAll(/\/(F\d+)\s+(\d+)\s+\d+\s+R/g)) nameOfObject.set(Number(m[2]), m[1]);
  }

  const byName = new Map();
  for (const [num, body] of pdf.objects) {
    if (!/\/Type\s*\/Font/.test(body)) continue;
    const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(body);
    if (!tu) continue;
    const name = nameOfObject.get(num);
    if (!name) continue;
    byName.set(name, parseToUnicode(await pdf.streamOf(Number(tu[1]))));
  }
  return byName;
}

/* ------------------------------------------------------------------ *
 * Anchos de glifo: sin esto las posiciones salen mal
 * ------------------------------------------------------------------ */

/**
 * Lee el array /W de un objeto fuente y devuelve Map(código → ancho en em).
 *
 * POR QUÉ HACE FALTA: al avanzar el cursor de texto no se puede suponer que
 * cada glifo mide 0,5 em. En este cuadrante la `M` mide 0,854 em y la `I`
 * 0,251, así que el error se acumula a lo largo de la tirada y las columnas
 * de la derecha acaban desplazadas casi una casilla entera. Con los anchos
 * reales las posiciones son las de la página.
 *
 * El array /W puede ser directo (`[ c [w …] … ]`) o indirecto (`n 0 R`).
 */
export function parseWidthArray(pdf, fontBody) {
  const m = /\/W\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(fontBody);
  if (!m) return null;
  let texto = m[1];
  const indirecto = /^\s*(\d+)\s+\d+\s+R\s*$/.exec(texto);
  if (indirecto) texto = pdf.objects.get(Number(indirecto[1])) || '';
  const anchos = new Map();
  const nums = [...texto.matchAll(/-?\d+/g)].map((x) => Number(x[0]));
  for (let i = 0; i + 2 < nums.length; i += 3) {
    const desde = nums[i];
    const hasta = nums[i + 1];
    const ancho = nums[i + 2];
    if (!(hasta >= desde) || hasta - desde > 60000) break;
    for (let c = desde; c <= hasta; c++) anchos.set(c, ancho / 1000);
  }
  return anchos;
}

/**
 * Anchos por fuente, indexados también por carácter (que es lo cómodo aquí).
 *
 * @returns {Promise<Map<string, {porCodigo:Map<number,number>, porCaracter:Map<string,number>}>>}
 */
export async function buildFontMetrics(pdf, fontMaps) {
  const maps = fontMaps ?? await buildFontMaps(pdf);
  const nameOfObject = new Map();
  for (const [num, body] of pdf.objects) {
    for (const m of body.matchAll(/\/(F\d+)\s+(\d+)\s+\d+\s+R/g)) nameOfObject.set(Number(m[2]), m[1]);
  }

  const salida = new Map();
  for (const [num, body] of pdf.objects) {
    if (!/\/Type\s*\/Font/.test(body)) continue;
    const nombre = nameOfObject.get(num);
    if (!nombre) continue;
    const porCodigo = parseWidthArray(pdf, body);
    if (!porCodigo || !porCodigo.size) continue;
    const porCaracter = new Map();
    const cmap = maps.get(nombre);
    if (cmap) for (const [cid, ch] of cmap) {
      const em = porCodigo.get(cid);
      if (em !== undefined) porCaracter.set(ch, em);
    }
    salida.set(nombre, { porCodigo, porCaracter });
  }
  return salida;
}

/** Ancho en em de un carácter, con 0,5 como último recurso. */
function anchoEm(metrics, font, ch) {
  const f = metrics?.get(font);
  if (!f) return 0.5;
  const directo = f.porCaracter.get(ch);
  if (directo !== undefined) return directo;
  const arriba = f.porCaracter.get(String(ch).toUpperCase());
  return arriba !== undefined ? arriba : 0.5;
}

/* ------------------------------------------------------------------ *
 * Interpretación del contenido
 * ------------------------------------------------------------------ */

function hexToCodes(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  const codes = [];
  for (let i = 0; i + 4 <= clean.length; i += 4) codes.push(parseInt(clean.slice(i, i + 4), 16));
  return codes;
}

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

function literalToString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = raw[++i];
    if (next === undefined) break;
    if (ESCAPES[next] !== undefined) { out += ESCAPES[next]; continue; }
    if (next >= '0' && next <= '7') {
      let oct = next;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
      continue;
    }
    out += next;
  }
  return out;
}

/**
 * Fragmentos de texto con su posición REAL en la página.
 *
 * @param {object} pdf
 * @param {Map<string, Map<number,string>>} fontMaps
 * @param {Map} [fontMetrics] anchos reales; si no se pasan, se calculan
 * @returns {Promise<{x:number,y:number,size:number,font:string,text:string,width:number}[]>}
 */
export async function extractTextItems(pdf, fontMaps, fontMetrics) {
  const maps = fontMaps ?? await buildFontMaps(pdf);
  const metrics = fontMetrics ?? await buildFontMetrics(pdf, maps);
  const { width: pageW, height: pageH } = pdf.pageSize();
  const items = [];

  // Se localizan los objetos de contenido (los que tienen operadores de texto)
  const contentObjects = [];
  for (const [num, body] of pdf.objects) {
    if (!body.includes('stream')) continue;
    contentObjects.push(num);
  }

  for (const num of contentObjects) {
    const content = await pdf.streamOf(num);
    if (!content || !/\bTf\b/.test(content)) continue;

    let ctm = IDENTITY;
    const gsStack = [];
    let font = '';
    let size = 0;
    let tm = IDENTITY;
    let tlm = IDENTITY;
    let leading = 0;
    let rise = 0;

    const inside = (p) => p.x >= -2 && p.x <= pageW + 2 && p.y >= -2 && p.y <= pageH + 2;

    /**
     * `ancho` va en espacio de TEXTO (em × tamaño sin escalar) y se aplica
     * antes de la CTM, así que la escala de la página la aplica `trm` sola.
     * El ancho real del fragmento, en unidades de página, sale de multiplicar
     * por la escala de `trm`.
     */
    const push = (text, offsetX = 0, anchoTexto = null) => {
      if (!text) return;
      const trm = multiply(multiply(tm, ctm), [1, 0, 0, 1, offsetX, 0]);
      const pos = applyMatrix(trm, 0, rise);
      if (!inside(pos)) return;
      const escala = matrixScale(trm);
      const ancho = anchoTexto === null
        ? text.length * size * 0.5 * escala
        : anchoTexto * escala;
      items.push({ x: pos.x, y: pos.y, size: size * escala, font, text, width: ancho });
    };

    const decode = (codes) => {
      const map = maps.get(font.replace('/', ''));
      return codes.map((c) => map?.get(c) ?? '').join('');
    };

    /** Ancho real (en espacio de texto) de una lista de códigos CID. */
    const anchoDeCodigos = (codes) => {
      const f = metrics.get(font);
      let total = 0;
      for (const c of codes) {
        const em = f?.porCodigo.get(c);
        total += (em === undefined ? 0.5 : em) * size;
      }
      return total;
    };

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line === 'q') { gsStack.push(ctm.slice()); continue; }
      if (line === 'Q') { if (gsStack.length) ctm = gsStack.pop(); continue; }

      const cm = /^([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+cm$/.exec(line);
      if (cm) { ctm = multiply(ctm, cm.slice(1, 7).map(Number)); continue; }

      if (line === 'BT') { tm = IDENTITY; tlm = IDENTITY; continue; }

      const tf = /^\/(\S+)\s+([\d.]+)\s+Tf$/.exec(line);
      if (tf) { font = tf[1]; size = Number(tf[2]); continue; }

      const tl = /^([-\d.]+)\s+TL$/.exec(line);
      if (tl) { leading = Number(tl[1]); continue; }

      const ts = /^([-\d.]+)\s+Ts$/.exec(line);
      if (ts) { rise = Number(ts[1]); continue; }

      const tmOp = /^([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm$/.exec(line);
      if (tmOp) { tlm = tmOp.slice(1, 7).map(Number); tm = tlm.slice(); continue; }

      const td = /^([-\d.]+)\s+([-\d.]+)\s+(Td|TD)$/.exec(line);
      if (td) {
        if (td[3] === 'TD') leading = -Number(td[2]);
        tlm = multiply(tlm, [1, 0, 0, 1, Number(td[1]), Number(td[2])]);
        tm = tlm.slice();
        continue;
      }

      if (line === 'T*') {
        tlm = multiply(tlm, [1, 0, 0, 1, 0, -leading]);
        tm = tlm.slice();
        continue;
      }

      const tjArr = /^\[((?:[^\[\]]|\[[^\]]*\])*)\]\s*TJ$/.exec(line);
      if (tjArr) {
        let advance = 0;
        for (const piece of tjArr[1].matchAll(/<([0-9A-Fa-f]*)>|\(((?:[^()\\]|\\.)*)\)|(-?\d+(?:\.\d+)?)/g)) {
          if (piece[1] !== undefined) {
            const codes = hexToCodes(piece[1]);
            const texto = decode(codes);
            const ancho = anchoDeCodigos(codes);
            push(texto, advance, ancho);
            advance += ancho;
          } else if (piece[2] !== undefined) {
            const texto = literalToString(piece[2]);
            let ancho = 0;
            for (const ch of texto) ancho += anchoEm(metrics, font, ch) * size;
            push(texto, advance, ancho);
            advance += ancho;
          } else if (piece[3] !== undefined) {
            advance -= (Number(piece[3]) / 1000) * size;
          }
        }
        continue;
      }

      const tjHex = /^<([0-9A-Fa-f]+)>\s*Tj$/.exec(line);
      if (tjHex) {
        const codes = hexToCodes(tjHex[1]);
        push(decode(codes), 0, anchoDeCodigos(codes));
        continue;
      }

      const tjLit = /^\(((?:[^()\\]|\\.)*)\)\s*Tj$/.exec(line);
      if (tjLit) {
        const texto = literalToString(tjLit[1]);
        let ancho = 0;
        for (const ch of texto) ancho += anchoEm(metrics, font, ch) * size;
        push(texto, 0, ancho);
        continue;
      }

      const quote = /^\(((?:[^()\\]|\\.)*)\)\s*'$/.exec(line);
      if (quote) {
        tlm = multiply(tlm, [1, 0, 0, 1, 0, -leading]);
        tm = tlm.slice();
        const texto = literalToString(quote[1]);
        let ancho = 0;
        for (const ch of texto) ancho += anchoEm(metrics, font, ch) * size;
        push(texto, 0, ancho);
      }
    }
  }

  return items.sort((a, b) => (Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x));
}

/** Agrupa los fragmentos que comparten línea. */
export function groupRows(items, tolerance = 2.5) {
  const rows = [];
  for (const item of items) {
    let row = rows.find((r) => Math.abs(r.y - item.y) <= tolerance);
    if (!row) {
      row = { y: item.y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  return rows.sort((a, b) => b.y - a.y);
}

/**
 * Une fragmentos contiguos de una fila en unidades con sentido.
 * Los códigos de dos letras («VC», «RE») llegan partidos, así que hay que
 * pegarlos sin juntar columnas distintas: el corte lo marca la separación real.
 */
export function clusterRow(row, gap = 8) {
  const out = [];
  for (const item of row.items) {
    const last = out[out.length - 1];
    // El ancho real del fragmento viene de los anchos de la fuente; sólo si no
    // está se estima a 0,55 em por carácter.
    const width = item.width ?? item.text.length * item.size * 0.55;
    if (last && item.x - last.x2 <= gap && Math.abs(item.size - last.size) < 0.6) {
      last.text += item.text;
      last.x2 = item.x + width;
    } else {
      out.push({ x: item.x, x2: item.x + width, text: item.text, size: item.size });
    }
  }
  return out.filter((c) => c.text.trim() !== '');
}

/**
 * Atajo: de bytes de PDF a fragmentos de texto con posición.
 * @param {Uint8Array} bytes
 */
export async function readPdfText(bytes) {
  const pdf = loadPdfFromBytes(bytes);
  const fontMaps = await buildFontMaps(pdf);
  const fontMetrics = await buildFontMetrics(pdf, fontMaps);
  const items = await extractTextItems(pdf, fontMaps, fontMetrics);
  return { pdf, fontMaps, fontMetrics, items, page: pdf.pageSize() };
}
