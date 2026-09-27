/**
 * HORUS — tools/make-icons.mjs
 * Genera los iconos PNG de la aplicación sin dependencias externas.
 *
 * Se dibuja el ojo de Horus a mano sobre un búfer RGBA y se codifica el PNG con
 * zlib, que viene con Node. Así los iconos son reproducibles y el repositorio no
 * arrastra binarios generados por una herramienta gráfica.
 *
 * Uso: node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'icons');

/* ------------------------------------------------------------------ *
 * Codificador PNG mínimo (RGBA de 8 bits, sin filtros)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'latin1');
  const body = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** @param {Uint8Array} rgba ancho*alto*4 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bits por canal
  ihdr[9] = 6;   // color: RGBA
  ihdr[10] = 0;  // compresión: deflate
  ihdr[11] = 0;  // filtro: adaptativo
  ihdr[12] = 0;  // entrelazado: no

  // Cada línea lleva un byte de filtro delante (0 = sin filtro)
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Dibujo
 * ------------------------------------------------------------------ */

const hexToRgb = (hex) => {
  const c = hex.replace('#', '');
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
};

/** Mezcla un color sobre el búfer con cobertura alfa suave. */
function blend(rgba, width, x, y, rgb, alpha) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= width) return;
  const i = (y * width + x) * 4;
  if (i < 0 || i + 3 >= rgba.length) return;
  const a = Math.min(1, alpha);
  const dstA = rgba[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  for (let k = 0; k < 3; k++) {
    rgba[i + k] = Math.round((rgb[k] * a + rgba[i + k] * dstA * (1 - a)) / outA);
  }
  rgba[i + 3] = Math.round(outA * 255);
}

/**
 * Antialias por supermuestreo: se evalúa la escena en una rejilla más fina y
 * se promedia. Es más simple y más correcto que inventar coberturas a mano.
 */
function renderScene(size, scene, { samples = 3 } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  const step = 1 / samples;
  const total = samples * samples;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          const from = scene(px / size, py / size);
          if (!from) continue;
          r += from[0] * from[3];
          g += from[1] * from[3];
          b += from[2] * from[3];
          a += from[3];
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
        rgba[i + 3] = Math.round((a / total) * 255);
      }
    }
  }
  return rgba;
}

/**
 * Escena del icono: fondo redondeado con degradado, el ojo de Horus y una
 * ceja. Todo en coordenadas normalizadas (0..1).
 *
 * @param {{maskable?:boolean, rounded?:boolean, scale?:number}} opts
 */
function makeScene({ maskable = false, rounded = true, scale = 1 } = {}) {
  const BG_TOP = hexToRgb('#141925');
  const BG_BOTTOM = hexToRgb('#0b0d12');
  const GOLD = hexToRgb('#f2a33c');
  const GOLD_SOFT = hexToRgb('#f7b355');
  const VIOLET = hexToRgb('#c77dff');

  // Los iconos "maskable" deben sobrevivir a un recorte circular: el dibujo va
  // más pequeño y el fondo llena todo el lienzo.
  const inset = maskable ? 0.14 : 0.06;
  const fgScale = (maskable ? 0.62 : 0.78) * scale;

  return (u, v) => {
    // --- Fondo ---
    let inside = true;
    if (rounded && !maskable) {
      const radius = 0.22;
      const dx = Math.max(0, Math.abs(u - 0.5) - (0.5 - radius));
      const dy = Math.max(0, Math.abs(v - 0.5) - (0.5 - radius));
      inside = Math.hypot(dx, dy) <= radius;
    } else if (maskable) {
      // Los maskable llevan el fondo completo y el sistema recorta
      inside = true;
    }
    if (!inside) return null;

    const t = v;
    const base = [
      Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
      Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
      Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
    ];
    let color = base;
    let alpha = 1;

    // Halo dorado suave para dar profundidad
    const halo = Math.hypot(u - 0.5, v - 0.42);
    if (halo < 0.42) {
      const k = (1 - halo / 0.42) ** 2 * 0.16;
      color = [
        Math.round(color[0] + (GOLD[0] - color[0]) * k),
        Math.round(color[1] + (GOLD[1] - color[1]) * k),
        Math.round(color[2] + (GOLD[2] - color[2]) * k),
      ];
    }

    // --- Geometría del ojo (normalizada y centrada) ---
    const cx = u - 0.5;
    const cy = v - 0.5;
    const s = fgScale;

    // El ojo: dos arcos que se cruzan formando una lente.
    const ax = cx / (0.40 * s);
    const ay = cy / (0.40 * s);
    // Fronteras superior e inferior de la lente
    const top = -0.52 + 1.5 * ax * ax;
    const bottom = 0.52 - 1.5 * ax * ax;
    const lens = Math.abs(ax) <= 0.72 && ay >= top && ay <= bottom;

    // Ceja: arco por encima del ojo
    const browY = -0.50 - 0.30 * (1 - (cx / (0.46 * s)) ** 2);
    const brow = Math.abs(cx) <= 0.46 * s
      && cy / s >= browY - 0.085
      && cy / s <= browY + 0.085;

    // Lágrima de Horus: línea descendente bajo el ojo
    const tear = cx > 0.10 * s && cx < 0.34 * s
      && cy / s > 0.44
      && cy / s < 0.44 + 0.34 * ((cx - 0.10 * s) / (0.24 * s));

    // Cola del ojo: línea que sale hacia fuera por el lado izquierdo
    const tail = cx < -0.44 * s && cx > -0.76 * s
      && Math.abs(cy / s + 0.06 * ((cx + 0.44 * s) / (0.32 * s))) < 0.055;

    // Espiral: el ojo con el párpado grueso
    const outerRing = lens;
    const innerLens = Math.abs(ax) <= 0.58 && ay >= (-0.34 + 1.9 * ax * ax) && ay <= (0.34 - 1.9 * ax * ax);

    // Pupila
    const pupilR = 0.145 * s;
    const ringR = 0.215 * s;
    const dist = Math.hypot(cx, cy);
    const pupil = dist < pupilR;
    const iris = dist < ringR;

    if (tail || brow || tear) {
      color = GOLD;
    } else if (outerRing && !innerLens) {
      // Trazo del párpado
      color = GOLD;
    } else if (pupil) {
      color = GOLD_SOFT;
    } else if (iris) {
      color = VIOLET;
    } else if (innerLens) {
      // Interior del ojo: un poco más claro que el fondo
      color = [
        Math.round(base[0] + 18),
        Math.round(base[1] + 20),
        Math.round(base[2] + 26),
      ];
    }

    // Se devuelve el color con alfa para el supermuestreo
    return [color[0], color[1], color[2], alpha];
  };
}

/* ------------------------------------------------------------------ *
 * Generación
 * ------------------------------------------------------------------ */

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'icon-96.png', size: 96, maskable: false },
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-192.png', size: 192, maskable: true },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'favicon-32.png', size: 32, maskable: false },
];

for (const target of targets) {
  const samples = target.size <= 96 ? 4 : 2;
  const rgba = renderScene(target.size, makeScene({ maskable: target.maskable }), { samples });
  const png = encodePng(target.size, target.size, rgba);
  writeFileSync(join(OUT_DIR, target.file), png);
  console.log(`✓ icons/${target.file} (${target.size}×${target.size}, ${(png.length / 1024).toFixed(1)} KB)`);
}

console.log(`\nIconos generados en ${OUT_DIR}`);
