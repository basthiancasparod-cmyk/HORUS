/**
 * HORUS — tools/pdf-grid.mjs
 * Diagnóstico de la importación: enseña, tal cual, lo que el parser ha entendido
 * de un cuadrante en PDF. Sirve para afinar el lector contra un archivo real y
 * para comprobar a mano que las fechas y los códigos caen donde toca.
 *
 * Usa el MISMO parser que la aplicación (`js/core/schedule-import.js`), no una
 * reimplementación: si aquí se ve bien, en la app también.
 *
 * Uso:
 *   node tools/pdf-grid.mjs <archivo.pdf>              # resumen + rejilla
 *   node tools/pdf-grid.mjs <archivo.pdf> --json       # el ParseResult entero
 *   node tools/pdf-grid.mjs <archivo.pdf> --persona X  # solo las filas que casen
 */

import { readFileSync } from 'node:fs';
import { parseSchedulePdf } from '../js/core/schedule-import.js';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
const flag = (name) => args.includes(`--${name}`);
const valor = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

if (!path) {
  console.error('Uso: node tools/pdf-grid.mjs <archivo.pdf> [--json] [--persona NOMBRE]');
  process.exit(1);
}

const bytes = new Uint8Array(readFileSync(path));
const parse = await parseSchedulePdf(bytes);

if (flag('json')) {
  console.log(JSON.stringify(parse, null, 2));
  process.exit(parse.ok ? 0 : 1);
}

if (!parse.ok) {
  console.log(`\n✗ No se ha podido interpretar el cuadrante.\n  ${parse.reason}\n`);
  process.exit(1);
}

const filtro = valor('persona');
const personas = filtro
  ? parse.people.filter((p) => p.label.toUpperCase().includes(filtro.toUpperCase()))
  : parse.people;

console.log(`\nCuadrante: ${parse.monthKey}  (confianza del mes: ${parse.monthConfidence})`);
console.log(`Página: ${Math.round(parse.page.width)} × ${Math.round(parse.page.height)}` +
  `  ·  ${parse.meta.columns} columnas  ·  días ${parse.meta.firstDay}..${parse.meta.lastDay}` +
  `  ·  anchos de fuente: ${parse.meta.fontMetrics ? 'sí' : 'no'}`);
console.log(`Cabecera: ${parse.meta.header ?? '—'}`);
console.log(`Personas: ${parse.stats.people}  ·  turnos: ${parse.stats.entries}` +
  ` (${parse.stats.high} seguros, ${parse.stats.low} dudosos)  ·  fuera del mes: ${parse.stats.outsideMonth}`);

const desconocidos = Object.entries(parse.unknownCodes || {});
if (desconocidos.length) {
  console.log(`Códigos por decidir: ${desconocidos.map(([c, n]) => `${c}×${n}`).join(', ')}`);
}
if (parse.issues?.length) {
  console.log('\nAvisos:');
  for (const i of parse.issues) console.log(`  · [${i.kind}] ${i.message}`);
}

/* --- La rejilla, día a día ------------------------------------------ */

const [y, m] = parse.monthKey.split('-').map(Number);
const totalDias = new Date(y, m, 0).getDate();
const LETRAS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

console.log('\nRejilla (· = sin turno, ¿? = dudoso):');
const cabecera = ['Persona'.padEnd(14)];
for (let d = 1; d <= totalDias; d++) cabecera.push(String(d).padStart(2));
cabecera.push(' total');
console.log(cabecera.join(' '));
console.log(' '.repeat(15) + Array.from({ length: totalDias }, (_, i) => {
  const dow = new Date(y, m - 1, i + 1).getDay();
  return ` ${LETRAS[dow]}`;
}).join(''));

for (const p of personas) {
  const porDia = new Map(p.entries.map((e) => [e.day, e]));
  const fila = [p.label.slice(0, 14).padEnd(14)];
  let alto = 0;
  for (let d = 1; d <= totalDias; d++) {
    const e = porDia.get(d);
    if (!e) { fila.push(' ·'); continue; }
    const txt = e.confidence === 'low' ? `¿${e.code}` : e.code;
    if (e.confidence === 'high') alto++;
    fila.push(txt.padStart(2).slice(-2));
  }
  fila.push(String(p.entries.length).padStart(5));
  console.log(fila.join(' '));
  if (p.entries.some((e) => e.confidence === 'low')) {
    for (const e of p.entries.filter((x) => x.confidence === 'low')) {
      console.log(`    ↳ día ${e.day} «${e.code}»: ${e.reason ?? 'sin motivo'}`);
    }
  }
}

/* --- Recuento por código -------------------------------------------- */

const porCodigo = new Map();
for (const p of parse.people) {
  for (const e of p.entries) porCodigo.set(e.code, (porCodigo.get(e.code) || 0) + 1);
}
console.log('\nCódigos: ' + [...porCodigo.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([c, n]) => `${c}×${n}`)
  .join('  ') + '\n');
