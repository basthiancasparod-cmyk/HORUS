/**
 * HORUS — tools/sql-order.mjs
 * Comprueba el ORDEN de las definiciones de la migración de Supabase.
 *
 * Por qué existe: Postgres valida el cuerpo de una función SQL al crearla
 * (`check_function_bodies`, activo por defecto). Si una función consulta una
 * tabla que todavía no existe, el script entero se cae con
 * «42P01: relation ... does not exist» y el usuario se queda sin esquema.
 * Lo mismo vale para índices, triggers, políticas y claves ajenas.
 *
 * Este comprobador lee el SQL, separa las sentencias y verifica que ningún
 * objeto se use antes de estar definido. No necesita Postgres.
 *
 * Uso: node tools/sql-order.mjs [archivo.sql ...]
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/* ------------------------------------------------------------------ *
 * 1. Separar el SQL en sentencias (respetando $$ y las comillas)
 * ------------------------------------------------------------------ */

/** Quita los comentarios, conservando los saltos de línea para contar. */
function stripComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i] === '\n' ? '\n' : ' '; i++; }
      i += 2;
      continue;
    }
    if (c === "'") {
      out += c; i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") { out += sql[i + 1]; i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    const dol = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dol) {
      const cierre = dol[0];
      out += cierre;
      const fin = sql.indexOf(cierre, i + cierre.length);
      const cuerpo = fin < 0 ? sql.slice(i + cierre.length) : sql.slice(i + cierre.length, fin);
      out += cuerpo;
      out += cierre;
      i = fin < 0 ? sql.length : fin + cierre.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Trocea en sentencias por `;` de primer nivel. */
function splitStatements(sql) {
  const out = [];
  let actual = '';
  let i = 0;
  let linea = 1;
  let lineaInicio = 1;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '\n') linea++;
    const dol = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dol) {
      const cierre = dol[0];
      const fin = sql.indexOf(cierre, i + cierre.length);
      const trozo = fin < 0 ? sql.slice(i) : sql.slice(i, fin + cierre.length);
      actual += trozo;
      linea += (trozo.match(/\n/g) || []).length;
      i = fin < 0 ? sql.length : fin + cierre.length;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j++; break; }
        j++;
      }
      actual += sql.slice(i, j);
      linea += ((sql.slice(i, j).match(/\n/g) || []).length);
      i = j;
      continue;
    }
    if (c === ';') {
      out.push({ sql: actual, line: lineaInicio });
      actual = '';
      i++;
      lineaInicio = linea;
      continue;
    }
    if (!actual.trim() && !/\s/.test(c)) lineaInicio = linea;
    actual += c;
    i++;
  }
  if (actual.trim()) out.push({ sql: actual, line: lineaInicio });
  return out.filter((s) => s.sql.trim());
}

/* ------------------------------------------------------------------ *
 * 2. Qué define y qué necesita cada sentencia
 * ------------------------------------------------------------------ */

/** Objetos que no define la migración: los pone Supabase o Postgres. */
const EXTERNOS = new Set([
  'auth.users', 'auth.uid', 'auth.jwt', 'auth.role',
  'extensions.uuid-ossp', 'pg_catalog.pg_stat_statements',
]);

/**
 * `public.horus_x` → `public.horus_x`; `horus_x` → `public.horus_x`.
 * Todo se compara con esquema explícito para que las claves cuadren.
 */
function nombre(s) {
  const limpio = String(s || '').replace(/"/g, '').toLowerCase().trim();
  return limpio.includes('.') ? limpio : `public.${limpio}`;
}
const claveFuncion = (s) => `func:${nombre(s)}`;

/**
 * Relaciones (`public.x`) citadas. Se descartan las que van seguidas de `(`
 * porque entonces son LLAMADAS a una función, no tablas: `public.horus_es_miembro(...)`.
 * Las claves ajenas (`references public.x(id)`) las recoge cada rama por su cuenta.
 * (Se filtra en JS y no con una mirada hacia delante en la expresión regular:
 * con `(?!\s*\()` el cuantificador retrocede un carácter y corta el nombre.)
 */
function relacionesCitadas(texto) {
  const out = [];
  for (const m of texto.matchAll(/\bpublic\.([a-z_][a-z0-9_]*)/gi)) {
    const despues = texto.slice(m.index + m[0].length);
    if (/^\s*\(/.test(despues)) continue; // es una llamada, no una tabla
    out.push(`public.${m[1].toLowerCase()}`);
  }
  return out;
}

/**
 * Funciones citadas: sólo cuentan si van seguidas de `(` (una llamada) o si
 * aparecen tras `on function`, que es como las referencian permisos y
 * comentarios. Así `public.horus_documents` no se confunde con una función.
 */
function funcionesCitadas(texto) {
  const out = [];
  for (const m of texto.matchAll(/\bpublic\.(horus_[a-z0-9_]+)\s*\(/gi)) out.push(`func:public.${m[1].toLowerCase()}`);
  for (const m of texto.matchAll(/\bon\s+function\s+public\.(horus_[a-z0-9_]+)/gi)) out.push(`func:public.${m[1].toLowerCase()}`);
  return out;
}

function analizar(st) {
  const s = st.sql.replace(/\s+/g, ' ').trim();
  const baja = s.toLowerCase();
  const define = [];
  const necesita = [];

  const push = (lista, v) => { if (v && !EXTERNOS.has(v)) lista.push(v); };

  let m;

  // --- create table -------------------------------------------------
  if ((m = /^create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(public\.[a-z0-9_]+|"[^"]+")/i.exec(baja))) {
    define.push(nombre(m[1]));
    // Claves ajenas: `references public.otra(id)`
    for (const r of s.matchAll(/references\s+(public\.[a-z0-9_]+)/gi)) push(necesita, nombre(r[1]));
    return { define, necesita, tipo: 'tabla' };
  }

  // --- create function ----------------------------------------------
  if ((m = /^create\s+(?:or\s+replace\s+)?function\s+(public\.[a-z0-9_]+)/i.exec(baja))) {
    const propia = claveFuncion(m[1]);
    define.push(propia);
    // El cuerpo consulta tablas y llama a otras funciones: eso tiene que existir.
    for (const r of relacionesCitadas(s)) push(necesita, r);
    for (const f of funcionesCitadas(s)) push(necesita, f);
    return { define, necesita: necesita.filter((n) => n !== propia), tipo: 'función' };
  }

  // --- create view ---------------------------------------------------
  if ((m = /^create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(public\.[a-z0-9_]+)/i.exec(baja))) {
    define.push(nombre(m[1]));
    for (const r of relacionesCitadas(s)) push(necesita, r);
    for (const f of funcionesCitadas(s)) push(necesita, f);
    return { define, necesita, tipo: 'vista' };
  }

  // --- create index --------------------------------------------------
  if ((m = /^create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?[a-z0-9_"]+\s+on\s+(public\.[a-z0-9_]+)/i.exec(baja))) {
    push(necesita, nombre(m[1]));
    return { define, necesita, tipo: 'índice' };
  }

  // --- create trigger ------------------------------------------------
  if ((m = /^create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+[a-z0-9_"]+\s+.*?\son\s+(public\.[a-z0-9_]+)/i.exec(baja))) {
    push(necesita, nombre(m[1]));
    for (const f of funcionesCitadas(s)) push(necesita, f);
    return { define, necesita, tipo: 'trigger' };
  }

  // --- create policy ------------------------------------------------
  if ((m = /^create\s+policy\s+[a-z0-9_"]+\s+on\s+(public\.[a-z0-9_]+)/i.exec(baja))) {
    push(necesita, nombre(m[1]));
    for (const r of relacionesCitadas(s)) push(necesita, r);
    for (const f of funcionesCitadas(s)) push(necesita, f);
    return { define, necesita, tipo: 'política' };
  }

  // --- alter table ---------------------------------------------------
  if ((m = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(public\.[a-z0-9_]+)/i.exec(baja))) {
    push(necesita, nombre(m[1]));
    for (const r of s.matchAll(/references\s+(public\.[a-z0-9_]+)/gi)) push(necesita, nombre(r[1]));
    return { define, necesita, tipo: 'alter table' };
  }

  // --- drop policy / drop trigger (necesitan la tabla) ---------------
  if ((m = /^drop\s+(?:policy|trigger)\s+(?:if\s+exists\s+)?[a-z0-9_"]+\s+on\s+(public\.[a-z0-9_]+)/i.exec(baja))) {
    push(necesita, nombre(m[1]));
    return { define, necesita, tipo: 'drop' };
  }

  // --- grant / revoke ------------------------------------------------
  if (/^(grant|revoke)\b/i.test(baja)) {
    for (const r of s.matchAll(/\bon\s+(?:table\s+)?(public\.[a-z0-9_]+)/gi)) push(necesita, nombre(r[1]));
    for (const f of s.matchAll(/\bon\s+function\s+(public\.[a-z0-9_]+)/gi)) push(necesita, `func:${nombre(f[1])}`);
    return { define, necesita, tipo: 'permisos' };
  }

  // --- comment on ----------------------------------------------------
  if ((m = /^comment\s+on\s+(table|function|view|column)\s+(public\.[a-z0-9_]+)/i.exec(baja))) {
    push(necesita, m[1].toLowerCase() === 'function' ? `func:${nombre(m[2])}` : nombre(m[2]));
    return { define, necesita, tipo: 'comentario' };
  }

  return { define, necesita, tipo: 'otra' };
}

/* ------------------------------------------------------------------ *
 * 3. Comprobación
 * ------------------------------------------------------------------ */

function comprobar(ruta) {
  const crudo = readFileSync(ruta, 'utf8');
  const sentencias = splitStatements(stripComments(crudo));
  const definidos = new Set();
  const problemas = [];

  for (const st of sentencias) {
    const { define, necesita, tipo } = analizar(st);
    for (const n of new Set(necesita)) {
      if (EXTERNOS.has(n)) continue;
      if (!definidos.has(n)) {
        problemas.push({
          line: st.line,
          tipo,
          falta: n,
          fragmento: st.sql.replace(/\s+/g, ' ').trim().slice(0, 90),
        });
      }
    }
    for (const n of define) definidos.add(n);
  }

  return { ruta, sentencias: sentencias.length, objetos: definidos.size, problemas };
}

/* ------------------------------------------------------------------ *
 * 4. Main
 * ------------------------------------------------------------------ */

const objetivos = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).map((f) => join('supabase/migrations', f));

let fallos = 0;
for (const ruta of objetivos) {
  const r = comprobar(ruta);
  const etiqueta = `${ruta}  (${r.sentencias} sentencias, ${r.objetos} objetos)`;
  if (!r.problemas.length) {
    console.log(`\x1b[32m✓\x1b[0m ${etiqueta}`);
    continue;
  }
  fallos += r.problemas.length;
  console.log(`\x1b[31m✗\x1b[0m ${etiqueta}`);
  for (const p of r.problemas) {
    console.log(`    línea ${p.line}: ${p.tipo} usa «${p.falta}», que todavía no está definido`);
    console.log(`      ${p.fragmento}…`);
  }
}

console.log('');
if (fallos) {
  console.log(`\x1b[31m${fallos} uso(s) antes de definir\x1b[0m — Postgres fallaría con 42P01/42P01-like.`);
  process.exit(1);
}
console.log('\x1b[32mOrden de las migraciones correcto.\x1b[0m');
