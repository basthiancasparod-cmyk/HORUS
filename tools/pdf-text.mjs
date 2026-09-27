/**
 * HORUS — tools/pdf-text.mjs
 * Volcado de diagnóstico: qué texto ha leído el extractor y DÓNDE está.
 *
 * No reimplementa nada: usa `js/core/pdf-text.js`, el mismo módulo que usa la
 * aplicación. Antes había aquí una copia paralela del intérprete de PDF, y el
 * resultado era que las herramientas y la app podían discrepar. Una sola
 * implementación, una sola verdad.
 *
 * Uso:
 *   node tools/pdf-text.mjs <archivo.pdf>          # resumen
 *   node tools/pdf-text.mjs <archivo.pdf> --rows   # fragmento a fragmento
 *   node tools/pdf-text.mjs <archivo.pdf> --json   # todo, en JSON
 */

import { readFileSync } from 'node:fs';
import { readPdfText, groupRows } from '../js/core/pdf-text.js';

const args = process.argv.slice(2);
const conJson = args.includes('--json');
const conFilas = args.includes('--rows');
const ruta = args.find((a) => !a.startsWith('--'));

if (!ruta) {
  console.error('Uso: node tools/pdf-text.mjs <archivo.pdf> [--json] [--rows]');
  process.exit(1);
}

const { fontMaps, fontMetrics, items, page } = await readPdfText(new Uint8Array(readFileSync(ruta)));

if (conJson) {
  console.log(JSON.stringify(
    { page, fonts: [...fontMaps.keys()], fontMetrics: [...fontMetrics.keys()], items },
    null, 2,
  ));
  process.exit(0);
}

const xs = items.map((i) => i.x);
const ys = items.map((i) => i.y);
console.log(`página: ${page.width.toFixed(1)} × ${page.height.toFixed(1)}`);
console.log(`fuentes: ${[...fontMaps.keys()].join(', ')}`);
console.log(`anchos de glifo (/W): ${fontMetrics.size ? [...fontMetrics.keys()].join(', ') : 'no hay'}`);
console.log(`fragmentos: ${items.length}`);
console.log(`rango x: ${Math.min(...xs).toFixed(1)} … ${Math.max(...xs).toFixed(1)}`);
console.log(`rango y: ${Math.min(...ys).toFixed(1)} … ${Math.max(...ys).toFixed(1)}`);
console.log(`fuera de página: ${items.filter((i) => i.x > page.width || i.y > page.height).length}`);

if (conFilas) {
  console.log('');
  for (const fila of groupRows(items)) {
    const partes = fila.items.map((i) => `${i.x.toFixed(0)}:${i.text}`);
    console.log(`y= ${fila.y.toFixed(0)}  ${partes.join(' ')}`);
  }
}
