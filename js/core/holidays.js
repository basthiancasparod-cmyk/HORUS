/**
 * HORUS — core/holidays.js
 * Catálogo de festivos (días no laborables) españoles y cálculo de la Pascua.
 *
 * Módulo PURO: sin DOM, sin red, sin almacenamiento y sin estado propio.
 * Las mismas entradas devuelven siempre las mismas salidas. Funciona igual en
 * el navegador y en Node 18+ (`"type": "module"` en package.json).
 *
 * Convenios (los mismos que core/date.js):
 *  - Una fecha se representa SIEMPRE como string "YYYY-MM-DD".
 *  - Un `region` es una clave de 2 letras en MAYÚSCULAS (ver REGIONS).
 *    `'ES'` y `'XX'` significan "solo festivos nacionales".
 *  - Ninguna función lanza: ante datos inservibles devuelven [] / null / false.
 *
 * Qué es EXACTO y qué es APROXIMADO (ver DATA_NOTES):
 *  - Exacto: los 9 festivos nacionales fijos, la Pascua (Meeus/Jones/Butcher)
 *    y, por tanto, Viernes Santo, Jueves Santo y Lunes de Pascua.
 *  - Best-effort: los festivos propios de cada comunidad autónoma. Cambian de
 *    un año a otro (traslados, canjes, renuncias) y cada entrada lleva un campo
 *    `confidence` para que la app pueda avisar de lo que conviene revisar.
 */

import { dateKey, addDays, fromKey, isValidKey, DAY_MS } from './date.js';

/* ------------------------------------------------------------------ *
 * Regiones
 * ------------------------------------------------------------------ */

/** Forma cada entrada de REGIONS. Congelada: es una tabla, no un dato vivo. */
const region = (code, name) => Object.freeze({ code, name });

/**
 * Regiones soportadas, con `ES` (solo nacionales) en primer lugar y después
 * las 19 comunidades/ciudades autónomas en orden alfabético de código.
 * Pensado para poblar un `<select>`.
 *
 * `'XX'` es un alias histórico de `'ES'` (solo nacionales): se acepta en todas
 * las funciones, pero NO aparece aquí para no duplicar la opción en la lista.
 */
export const REGIONS = Object.freeze([
  region('ES', 'España (solo festivos nacionales)'),
  region('AN', 'Andalucía'),
  region('AR', 'Aragón'),
  region('AS', 'Asturias'),
  region('CB', 'Cantabria'),
  region('CE', 'Ceuta'),
  region('CL', 'Castilla y León'),
  region('CM', 'Castilla-La Mancha'),
  region('CN', 'Canarias'),
  region('CT', 'Cataluña'),
  region('EX', 'Extremadura'),
  region('GA', 'Galicia'),
  region('IB', 'Islas Baleares'),
  region('MC', 'Murcia'),
  region('MD', 'Madrid'),
  region('ML', 'Melilla'),
  region('NC', 'Navarra'),
  region('PV', 'País Vasco'),
  region('RI', 'La Rioja'),
  region('VC', 'Comunidad Valenciana'),
]);

/** Códigos que significan "solo festivos nacionales, sin comunidad". */
export const NATIONAL_ONLY_CODES = Object.freeze(['ES', 'XX']);

const REGION_CODES = new Set(REGIONS.map((r) => r.code));
const REGION_NAMES = new Map(REGIONS.map((r) => [r.code, r.name]));

/** ¿Es un código de región conocido (sin contar los alias nacionales)? */
export function isKnownRegionCode(code) {
  return REGION_CODES.has(String(code ?? '').trim().toUpperCase());
}

/**
 * Normaliza un código de región: recorta, pasa a mayúsculas y valida.
 * `'md'` → `'MD'`. Desconocido o vacío → `'ES'` (solo nacionales). Nunca lanza.
 * @param {string} [code]
 * @returns {string} código válido de REGIONS
 */
export function normalizeRegionCode(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c || c === 'XX') return 'ES';
  return REGION_CODES.has(c) ? c : 'ES';
}

/** Nombre mostrable de una región; `''` si no se reconoce. */
export function regionName(code) {
  return REGION_NAMES.get(normalizeRegionCode(code)) || '';
}

/* ------------------------------------------------------------------ *
 * Festivos nacionales fijos
 * ------------------------------------------------------------------ */

/** Forma cada entrada de NATIONAL_HOLIDAYS (mes 1-12, mes natural). */
const national = (month, day, name, mondayIfSunday = true) => Object.freeze({ month, day, name, mondayIfSunday });

/**
 * Festivos NACIONALES fijos (mes natural 1-12).
 *
 * Viernes Santo NO está aquí: depende de la Pascua y lo calcula
 * `movableHolidays(year)`.
 *
 * `mondayIfSunday`: según el art. 37.2 del Estatuto de los Trabajadores, cuando
 * uno de estos festivos cae en domingo el descanso se traslada al lunes
 * inmediatamente posterior. El traslado real de cada año lo fija el calendario
 * laboral publicado (Real Decreto) y algunas comunidades lo matizan, así que
 * `holidaysFor` NO lo aplica por defecto: pide `{ shiftSundayToMonday: true }`.
 *
 * @type {ReadonlyArray<{month:number, day:number, name:string, mondayIfSunday:boolean}>}
 */
export const NATIONAL_HOLIDAYS = Object.freeze([
  national(1, 1, 'Año Nuevo'),
  national(1, 6, 'Epifanía del Señor'),
  national(5, 1, 'Fiesta del Trabajo'),
  national(8, 15, 'Asunción de la Virgen'),
  national(10, 12, 'Fiesta Nacional de España'),
  national(11, 1, 'Todos los Santos'),
  national(12, 6, 'Día de la Constitución Española'),
  national(12, 8, 'Inmaculada Concepción'),
  national(12, 25, 'Natividad del Señor'),
]);

/* ------------------------------------------------------------------ *
 * Festivos propios de cada comunidad (best-effort, con `confidence`)
 * ------------------------------------------------------------------ */

const CONFIDENCES = new Set(['high', 'medium', 'low']);

/** Forma cada festivo autonómico fijo. */
const regional = (month, day, name, confidence, mondayIfSunday = false) =>
  Object.freeze({ month, day, name, confidence, mondayIfSunday });

/**
 * Festivos autonómicos FIJOS por región (los que no dependen de la Pascua).
 *
 * `confidence`:
 *  - `'high'`   festivo autonómico estable (Día de la Comunidad, etc.).
 *  - `'medium'` habitual, pero alguna comunidad lo ha canjeado o trasladado
 *               en años concretos: conviene revisarlo.
 *  - `'low'`    aparece en el calendario de algunos años; verificar SIEMPRE.
 *
 * NO se incluyen los festivos locales/municipales (cada municipio tiene 2
 * propios), ni las fiestas islámicas de Ceuta y Melilla (calendario lunar).
 */
const REGIONAL_FIXED = Object.freeze({
  AN: Object.freeze([regional(2, 28, 'Día de Andalucía', 'high')]),
  AR: Object.freeze([regional(4, 23, 'Día de Aragón (San Jorge)', 'high')]),
  AS: Object.freeze([regional(9, 8, 'Día de Asturias', 'high')]),
  CB: Object.freeze([
    regional(7, 28, 'Día de las Instituciones de Cantabria', 'high'),
    regional(9, 15, 'La Bien Aparecida', 'high'),
  ]),
  CE: Object.freeze([regional(9, 2, 'Día de Ceuta', 'high')]),
  CL: Object.freeze([regional(4, 23, 'Día de Castilla y León (Villalar)', 'high')]),
  CM: Object.freeze([regional(5, 31, 'Día de Castilla-La Mancha', 'high')]),
  CN: Object.freeze([regional(5, 30, 'Día de Canarias', 'high')]),
  CT: Object.freeze([
    regional(6, 24, 'Sant Joan', 'high'),
    regional(9, 11, 'Diada Nacional de Catalunya', 'high'),
    regional(12, 26, 'Sant Esteve', 'high'),
  ]),
  EX: Object.freeze([regional(9, 8, 'Día de Extremadura', 'high')]),
  GA: Object.freeze([
    regional(5, 17, 'Día das Letras Galegas', 'high'),
    regional(7, 25, 'Santiago Apóstol', 'high'),
  ]),
  IB: Object.freeze([
    regional(3, 1, 'Día de les Illes Balears', 'high'),
    // Sant Esteve en Baleares: aparece en el calendario balear en bastantes
    // años, pero no en todos. Se marca 'low' a propósito.
    regional(12, 26, 'Sant Esteve', 'low'),
  ]),
  MC: Object.freeze([
    regional(3, 19, 'San José', 'medium'),
    regional(6, 9, 'Día de la Región de Murcia', 'high'),
  ]),
  MD: Object.freeze([regional(5, 2, 'Fiesta de la Comunidad de Madrid', 'high')]),
  ML: Object.freeze([regional(9, 17, 'Día de Melilla', 'high')]),
  NC: Object.freeze([regional(12, 3, 'San Francisco Javier (Día de Navarra)', 'high')]),
  PV: Object.freeze([regional(7, 25, 'Santiago Apóstol', 'medium')]),
  RI: Object.freeze([regional(6, 9, 'Día de La Rioja', 'high')]),
  VC: Object.freeze([
    regional(3, 19, 'San José', 'high'),
    regional(6, 24, 'San Juan', 'medium'),
    regional(10, 9, 'Día de la Comunitat Valenciana', 'high'),
  ]),
});

/** Jueves Santo: es festivo en todas las comunidades MENOS Cataluña y C. Valenciana. */
const GOOD_FRIDAY_REGIONS = Object.freeze(
  REGIONS.map((r) => r.code).filter((c) => c !== 'ES' && c !== 'CT' && c !== 'VC'),
);

/** Lunes de Pascua: comunidades que lo observan. */
const EASTER_MONDAY_REGIONS = Object.freeze(['CT', 'IB', 'NC', 'PV', 'VC', 'RI']);

/**
 * Festivos móviles derivados de la Pascua (desplazamiento en días desde el
 * Domingo de Resurrección). `regions` vacío = nacional.
 */
const EASTER_OFFSETS = Object.freeze([
  { offset: -3, name: 'Jueves Santo', scope: 'regional', regions: GOOD_FRIDAY_REGIONS, confidence: 'high' },
  { offset: -2, name: 'Viernes Santo', scope: 'national', regions: null, confidence: 'high' },
  { offset: 1, name: 'Lunes de Pascua', scope: 'regional', regions: EASTER_MONDAY_REGIONS, confidence: 'high' },
  // San Vicente Ferrer: lunes siguiente al segundo domingo de Pascua (Pascua + 8).
  { offset: 8, name: 'San Vicente Ferrer', scope: 'regional', regions: Object.freeze(['VC']), confidence: 'medium' },
]);

/* ------------------------------------------------------------------ *
 * Notas sobre los datos (para mostrar en la interfaz)
 * ------------------------------------------------------------------ */

/**
 * Avisos en español sobre la fiabilidad del catálogo. La app puede mostrarlos
 * junto al selector de región.
 * @type {ReadonlyArray<string>}
 */
export const DATA_NOTES = Object.freeze([
  'Datos EXACTOS: los 9 festivos nacionales fijos (1/1, 6/1, 1/5, 15/8, 12/10, 1/11, 6/12, 8/12 y 25/12) y todos los festivos calculados a partir de la Pascua (Viernes Santo, Jueves Santo y Lunes de Pascua), porque la Pascua se obtiene con el algoritmo gregoriano de Meeus/Jones/Butcher.',
  'Datos ORIENTATIVOS (revisar): los festivos propios de cada comunidad autónoma. Cambian cada año por traslados, canjes y renuncias, y el calendario laboral oficial se publica anualmente en el BOE y en los boletines autonómicos. Cada festivo autonómico lleva un campo "confidence" ("high", "medium" o "low"); revisa sobre todo los "medium" y los "low".',
  'El traslado al lunes cuando un festivo nacional cae en domingo (art. 37.2 del Estatuto de los Trabajadores) no se aplica por defecto: pide holidaysFor(año, region, { shiftSundayToMonday: true }) para incluirlo. El traslado real de cada año lo fija el calendario oficial y algunas comunidades lo matizan.',
  'NO incluidos: los festivos locales o municipales (cada municipio tiene 2 al año), ni las fiestas islámicas de Ceuta y Melilla (Eid al-Adha / Fiesta del Sacrificio), que dependen del calendario lunar y no se pueden calcular con una regla fija.',
  'Los festivos de Cataluña y la Comunidad Valenciana se listan sin Jueves Santo, que es la excepción habitual: el Jueves Santo es festivo en el resto de comunidades.',
  'Esta lista es solo un PUNTO DE PARTIDA: la aplicación permite añadir y quitar festivos manualmente, así que corrige lo que haga falta en tu calendario.',
]);

/* ------------------------------------------------------------------ *
 * Utilidades internas
 * ------------------------------------------------------------------ */

/**
 * Año utilizable: acepta número o cadena numérica. Devuelve null si no es un
 * entero finito dentro de un rango razonable (nunca lanza).
 * @param {number|string} year
 * @returns {number|null}
 */
function normalizeYear(year) {
  const n = Number(year);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 1 || n > 9999) return null;
  return n;
}

/** Año de una clave "YYYY-MM-DD", o null si la clave no es válida. */
function yearOfKey(key) {
  if (!isValidKey(key)) return null;
  return Number(String(key).slice(0, 4));
}

/** Copia mutable y normalizada de una entrada de festivo. */
function entry(date, name, scope, regionCode, extra) {
  return { date, name, scope, region: regionCode ?? null, ...(extra || {}) };
}

/** Orden estable: fecha, luego nacional antes que autonómico, luego nombre. */
function compareHolidays(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.scope !== b.scope) return a.scope === 'national' ? -1 : 1;
  return a.name.localeCompare(b.name, 'es');
}

/** Quita duplicados por fecha+nombre+ámbito conservando el primero. */
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const h of list) {
    const k = `${h.date}|${h.name}|${h.scope}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Pascua
 * ------------------------------------------------------------------ */

/**
 * Domingo de Resurrección (Pascua) por el algoritmo gregoriano anónimo de
 * Meeus/Jones/Butcher.
 * @param {number|string} year año (válido a partir de 1583, calendario gregoriano)
 * @returns {string|null} "YYYY-MM-DD", o null si el año no es utilizable
 */
export function easterSunday(year) {
  const y = normalizeYear(year);
  if (y === null || y < 1583) return null;

  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);   // 3 = marzo, 4 = abril
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return dateKey(y, month - 1, day);
}

/**
 * Festivos móviles de un año (los que dependen de la Pascua).
 *
 * Devuelve Viernes Santo (`scope:'national'`) y los autonómicos derivados:
 * Jueves Santo, Lunes de Pascua y San Vicente Ferrer, cada uno con su lista de
 * `regions` y su `confidence`.
 *
 * @param {number|string} year
 * @returns {{date:string, name:string, scope:'national'|'regional', regions:(string[]|null), confidence:string}[]}
 *          array vacío si el año no es utilizable
 */
export function movableHolidays(year) {
  const y = normalizeYear(year);
  if (y === null) return [];
  const easter = easterSunday(y);
  if (!easter) return [];

  return EASTER_OFFSETS.map((h) => ({
    date: addDays(easter, h.offset),
    name: h.name,
    scope: h.scope,
    regions: h.regions ? [...h.regions] : null,
    confidence: h.confidence,
  })).sort(compareHolidays);
}

/* ------------------------------------------------------------------ *
 * Consulta de festivos
 * ------------------------------------------------------------------ */

/** Festivos nacionales fijos de un año, como entradas normalizadas. */
function fixedNationalEntries(y) {
  return NATIONAL_HOLIDAYS.map((h) =>
    entry(dateKey(y, h.month - 1, h.day), h.name, 'national', null, { mondayIfSunday: h.mondayIfSunday }));
}

/** Festivos fijos propios de una región (vacío para 'ES'/'XX'). */
function fixedRegionalEntries(y, code) {
  const list = REGIONAL_FIXED[code] || [];
  return list.map((h) =>
    entry(dateKey(y, h.month - 1, h.day), h.name, 'regional', code,
      { confidence: h.confidence, mondayIfSunday: h.mondayIfSunday }));
}

/** Festivos móviles que afectan a una región concreta. */
function movableEntries(y, code) {
  const out = [];
  for (const h of movableHolidays(y)) {
    if (h.scope === 'national') {
      out.push(entry(h.date, h.name, 'national', null, { confidence: h.confidence }));
    } else if (h.regions && h.regions.includes(code)) {
      out.push(entry(h.date, h.name, 'regional', code, { confidence: h.confidence }));
    }
  }
  return out;
}

/**
 * Añade el traslado al lunes de los festivos que caen en domingo y están
 * marcados con `mondayIfSunday`. La entrada original se conserva; la nueva
 * lleva `moved: true` y `movedFrom`.
 */
function addMondayShifts(list) {
  const out = [...list];
  for (const h of list) {
    if (!h.mondayIfSunday) continue;
    const dt = fromKey(h.date);
    if (!dt || dt.getDay() !== 0) continue;                 // 0 = domingo
    out.push(entry(addDays(h.date, 1), `${h.name} (traslado del domingo)`, h.scope, h.region,
      { confidence: h.confidence, moved: true, movedFrom: h.date }));
  }
  return out;
}

/**
 * Todos los festivos de un año para una región.
 *
 * Incluye los nacionales fijos, los móviles (Pascua) y los propios de la
 * comunidad, sin duplicados y ordenados por fecha. Para `'ES'` y `'XX'`
 * devuelve solo los nacionales. Una región desconocida se trata como `'ES'`.
 *
 * @param {number|string} year año (número o cadena numérica)
 * @param {string} [region='ES'] código de REGIONS, sin distinguir mayúsculas
 * @param {{shiftSundayToMonday?:boolean}} [options]
 * @returns {{date:string, name:string, scope:'national'|'regional', region:string|null,
 *            confidence?:string, mondayIfSunday?:boolean, moved?:boolean, movedFrom?:string}[]}
 *          array vacío si el año no es utilizable
 */
export function holidaysFor(year, region = 'ES', options = {}) {
  const y = normalizeYear(year);
  if (y === null) return [];
  const code = normalizeRegionCode(region);
  const opts = options && typeof options === 'object' ? options : {};

  let list = [...fixedNationalEntries(y), ...movableEntries(y, code)];
  if (code !== 'ES') list.push(...fixedRegionalEntries(y, code));
  if (opts.shiftSundayToMonday) list = addMondayShifts(list);

  return dedupe(list).sort(compareHolidays);
}

/**
 * ¿Es festivo esa fecha en esa región?
 * @param {string} dateKey fecha "YYYY-MM-DD"
 * @param {string} [region='ES']
 * @returns {{isHoliday:boolean, holiday:object|null}} el primer festivo del día
 */
export function isHoliday(dateKey, region = 'ES') {
  const empty = { isHoliday: false, holiday: null };
  if (!isValidKey(dateKey)) return empty;
  const key = String(dateKey);
  const holiday = holidaysFor(key.slice(0, 4), region).find((h) => h.date === key) || null;
  return holiday ? { isHoliday: true, holiday } : empty;
}

/** Nº máximo de días que recorre `holidaysForRange` (evita bucles enormes). */
export const MAX_RANGE_DAYS = 1200;

/**
 * Festivos dentro de un rango de fechas (ambos inclusive).
 *
 * Defensivo: si alguna clave es inválida devuelve []; si el rango viene
 * invertido se ordenan los extremos; si supera `MAX_RANGE_DAYS` se recorta al
 * final (nunca recorre más de 1200 días).
 *
 * @param {string} fromKey "YYYY-MM-DD"
 * @param {string} toKey "YYYY-MM-DD"
 * @param {string} [region='ES']
 * @returns {object[]} festivos ordenados por fecha (misma forma que holidaysFor)
 */
export function holidaysForRange(fromKey, toKey, region = 'ES') {
  const range = normalizeRange(fromKey, toKey);
  if (!range) return [];
  const [start, end] = range;
  const out = [];
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) {
    for (const h of holidaysFor(y, region)) {
      if (h.date >= start && h.date <= end) out.push(h);
    }
  }
  return out.sort(compareHolidays);
}

/**
 * Igual que `holidaysForRange`, pero como `Map` de `dateKey` → array de
 * festivos de ese día (normalmente 1; puede haber 2 si coinciden un nacional y
 * uno autonómico). Las fechas sin festivo no aparecen en el Map.
 *
 * @param {string} fromKey
 * @param {string} toKey
 * @param {string} [region='ES']
 * @returns {Map<string, object[]>}
 */
export function holidaysMapForRange(fromKey, toKey, region = 'ES') {
  const map = new Map();
  for (const h of holidaysForRange(fromKey, toKey, region)) {
    const bucket = map.get(h.date);
    if (bucket) bucket.push(h);
    else map.set(h.date, [h]);
  }
  return map;
}

/** Normaliza un rango: ordena extremos y recorta a MAX_RANGE_DAYS. */
function normalizeRange(fromKey, toKey) {
  if (!isValidKey(fromKey) || !isValidKey(toKey)) return null;
  let start = String(fromKey);
  let end = String(toKey);
  if (start > end) { const t = start; start = end; end = t; }
  const days = Math.round((fromKeyDate(end) - fromKeyDate(start)) / DAY_MS);
  if (days + 1 > MAX_RANGE_DAYS) end = addDays(start, MAX_RANGE_DAYS - 1);
  return [start, end];
}

/** Date local de una clave ya validada (evita repetir comprobaciones). */
function fromKeyDate(key) {
  const dt = fromKey(key);
  return dt ? dt.getTime() : 0;
}

/* ------------------------------------------------------------------ *
 * Códigos postales → región
 * ------------------------------------------------------------------ */

/**
 * Provincias (prefijo de 2 dígitos del código postal) con su comunidad.
 * Tabla oficial de provincias (01-52). Álava = 01, Albacete = 02, Alicante = 03,
 * Almería = 04, Burgos = 09, Tarragona = 43.
 * @type {ReadonlyArray<{code:string, name:string, region:string}>}
 */
const RAW_PROVINCES = [
  ['01', 'Álava', 'PV'],
  ['02', 'Albacete', 'CM'],
  ['03', 'Alicante', 'VC'],
  ['04', 'Almería', 'AN'],
  ['05', 'Ávila', 'CL'],
  ['06', 'Badajoz', 'EX'],
  ['07', 'Illes Balears', 'IB'],
  ['08', 'Barcelona', 'CT'],
  ['09', 'Burgos', 'CL'],
  ['10', 'Cáceres', 'EX'],
  ['11', 'Cádiz', 'AN'],
  ['12', 'Castellón', 'VC'],
  ['13', 'Ciudad Real', 'CM'],
  ['14', 'Córdoba', 'AN'],
  ['15', 'A Coruña', 'GA'],
  ['16', 'Cuenca', 'CM'],
  ['17', 'Girona', 'CT'],
  ['18', 'Granada', 'AN'],
  ['19', 'Guadalajara', 'CM'],
  ['20', 'Gipuzkoa', 'PV'],
  ['21', 'Huelva', 'AN'],
  ['22', 'Huesca', 'AR'],
  ['23', 'Jaén', 'AN'],
  ['24', 'León', 'CL'],
  ['25', 'Lleida', 'CT'],
  ['26', 'La Rioja', 'RI'],
  ['27', 'Lugo', 'GA'],
  ['28', 'Madrid', 'MD'],
  ['29', 'Málaga', 'AN'],
  ['30', 'Murcia', 'MC'],
  ['31', 'Navarra', 'NC'],
  ['32', 'Ourense', 'GA'],
  ['33', 'Asturias', 'AS'],
  ['34', 'Palencia', 'CL'],
  ['35', 'Las Palmas', 'CN'],
  ['36', 'Pontevedra', 'GA'],
  ['37', 'Salamanca', 'CL'],
  ['38', 'Santa Cruz de Tenerife', 'CN'],
  ['39', 'Cantabria', 'CB'],
  ['40', 'Segovia', 'CL'],
  ['41', 'Sevilla', 'AN'],
  ['42', 'Soria', 'CL'],
  ['43', 'Tarragona', 'CT'],
  ['44', 'Teruel', 'AR'],
  ['45', 'Toledo', 'CM'],
  ['46', 'Valencia', 'VC'],
  ['47', 'Valladolid', 'CL'],
  ['48', 'Bizkaia', 'PV'],
  ['49', 'Zamora', 'CL'],
  ['50', 'Zaragoza', 'AR'],
  ['51', 'Ceuta', 'CE'],
  ['52', 'Melilla', 'ML'],
];

/** Tabla consultable de provincias: `{ code, name, region }`. */
export const PROVINCES = Object.freeze(RAW_PROVINCES.map(([code, name, reg]) => Object.freeze({ code, name, region: reg })));

/** Índice prefijo → región. Constante derivada, nunca se modifica. */
const PROVINCE_REGION = Object.freeze(
  RAW_PROVINCES.reduce((acc, [code, , reg]) => { acc[code] = reg; return acc; }, {}),
);

/**
 * Región (código de 2 letras) a partir de un código postal español de 5 dígitos.
 * La comunidad se deduce del prefijo provincial de 2 dígitos.
 *
 * No distingue municipios ni provincias: `"28013"` → `"MD"`, `"08001"` → `"CT"`.
 * Devuelve `null` si no son 5 dígitos, si el prefijo no es una provincia válida
 * (01-52) o si el código municipal es `000`.
 *
 * @param {string|number} cp
 * @returns {string|null} código de REGIONS, o null
 */
export function regionFromPostalCode(cp) {
  const s = String(cp ?? '').trim();
  if (!/^\d{5}$/.test(s)) return null;
  const prefix = s.slice(0, 2);
  const reg = PROVINCE_REGION[prefix];
  if (!reg) return null;
  if (s.slice(2) === '000') return null;          // municipio inexistente
  return reg;
}

/* ------------------------------------------------------------------ *
 * Autocomprobación (invocable desde Node)
 * ------------------------------------------------------------------ */

/**
 * Comprueba el módulo contra valores conocidos.
 *
 * Uso desde Node:
 *   node -e "import('./js/core/holidays.js').then(m => console.log(m.selfTest()))"
 *
 * @returns {{passed:number, failed:number, failures:string[]}}
 */
export function selfTest() {
  const failures = [];
  let passed = 0;

  /** Comprueba una condición. */
  const check = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };
  /** Ejecuta sin lanzar; si lanza, lo anota como fallo. */
  const attempt = (label, fn) => {
    try {
      return fn();
    } catch (err) {
      failures.push(`${label}: lanzó ${err && err.message ? err.message : String(err)}`);
      return undefined;
    }
  };
  const eq = (label, actual, expected) => check(`${label} (se esperaba ${JSON.stringify(expected)}, se obtuvo ${JSON.stringify(actual)})`, actual === expected);

  try {
    /* --- Pascua: los 5 años pedidos --- */
    const EASTERS = { 2024: '2024-03-31', 2025: '2025-04-20', 2026: '2026-04-05', 2027: '2027-03-28', 2030: '2030-04-21' };
    for (const [y, expected] of Object.entries(EASTERS)) {
      eq(`easterSunday(${y})`, attempt(`easterSunday(${y})`, () => easterSunday(y)), expected);
    }
    eq('easterSunday("2025") acepta cadena', easterSunday('2025'), '2025-04-20');
    eq('easterSunday(1500) fuera del gregoriano', easterSunday(1500), null);
    eq('easterSunday("hola")', easterSunday('hola'), null);

    /* --- Festivos nacionales básicos --- */
    eq('1 de enero es festivo (ES)', isHoliday('2025-01-01', 'ES').isHoliday, true);
    eq('25 de diciembre es festivo (ES)', isHoliday('2025-12-25', 'ES').isHoliday, true);
    eq('nombre del 1 de enero', isHoliday('2025-01-01', 'ES').holiday?.name, 'Año Nuevo');
    eq('nombre del 25 de diciembre', isHoliday('2025-12-25', 'ES').holiday?.name, 'Natividad del Señor');
    eq('9 festivos nacionales fijos', NATIONAL_HOLIDAYS.length, 9);
    eq('2025 en ES: 9 fijos + Viernes Santo', holidaysFor(2025, 'ES').length, 10);
    eq('Viernes Santo 2025', isHoliday('2025-04-18', 'ES').holiday?.name, 'Viernes Santo');
    eq('Viernes Santo 2024', isHoliday('2024-03-29', 'ES').holiday?.name, 'Viernes Santo');
    eq('Viernes Santo es nacional', isHoliday('2025-04-18', 'ES').holiday?.scope, 'national');

    /* --- Móviles autonómicos --- */
    eq('Lunes de Pascua 2025 no es nacional', isHoliday('2025-04-21', 'ES').isHoliday, false);
    eq('Lunes de Pascua 2025 en CT', isHoliday('2025-04-21', 'CT').isHoliday, true);
    eq('Jueves Santo 2025 en AN', isHoliday('2025-04-17', 'AN').isHoliday, true);
    eq('Jueves Santo 2025 no en CT', isHoliday('2025-04-17', 'CT').isHoliday, false);
    eq('Jueves Santo 2025 no en VC', isHoliday('2025-04-17', 'VC').isHoliday, false);
    eq('San Vicente Ferrer 2024 en VC (Pascua + 8)', isHoliday('2024-04-08', 'VC').isHoliday, true);

    /* --- Festivos autonómicos fijos de muestra --- */
    eq('28 de febrero en AN', isHoliday('2025-02-28', 'AN').isHoliday, true);
    eq('28 de febrero no en MD', isHoliday('2025-02-28', 'MD').isHoliday, false);
    eq('2 de mayo en MD', isHoliday('2025-05-02', 'MD').holiday?.name, 'Fiesta de la Comunidad de Madrid');
    eq('Diada 2026 en CT', isHoliday('2026-09-11', 'CT').isHoliday, true);
    eq('Sant Esteve 2026 en CT', isHoliday('2026-12-26', 'CT').isHoliday, true);
    eq('Sant Esteve 2026 en MD', isHoliday('2026-12-26', 'MD').isHoliday, false);

    /* --- Códigos postales --- */
    eq("regionFromPostalCode('28013')", regionFromPostalCode('28013'), 'MD');
    eq("regionFromPostalCode('08001')", regionFromPostalCode('08001'), 'CT');
    eq("regionFromPostalCode('48001')", regionFromPostalCode('48001'), 'PV');
    eq("regionFromPostalCode('41001')", regionFromPostalCode('41001'), 'AN');
    eq("regionFromPostalCode('02001') Albacete", regionFromPostalCode('02001'), 'CM');
    eq("regionFromPostalCode('04001') Almería", regionFromPostalCode('04001'), 'AN');
    eq("regionFromPostalCode('09001') Burgos", regionFromPostalCode('09001'), 'CL');
    eq("regionFromPostalCode('43001') Tarragona", regionFromPostalCode('43001'), 'CT');
    eq("regionFromPostalCode('51001') Ceuta", regionFromPostalCode('51001'), 'CE');
    eq("regionFromPostalCode('52001') Melilla", regionFromPostalCode('52001'), 'ML');
    eq("regionFromPostalCode('35001') Las Palmas", regionFromPostalCode('35001'), 'CN');
    eq("regionFromPostalCode('38001') S/C de Tenerife", regionFromPostalCode('38001'), 'CN');
    eq("regionFromPostalCode('07001') Baleares", regionFromPostalCode('07001'), 'IB');
    eq("regionFromPostalCode('26001') La Rioja", regionFromPostalCode('26001'), 'RI');
    eq("regionFromPostalCode('33001') Asturias", regionFromPostalCode('33001'), 'AS');
    eq("regionFromPostalCode('39001') Cantabria", regionFromPostalCode('39001'), 'CB');
    eq("regionFromPostalCode('31001') Navarra", regionFromPostalCode('31001'), 'NC');
    eq("regionFromPostalCode('00000')", regionFromPostalCode('00000'), null);
    eq("regionFromPostalCode('53001') inexistente", regionFromPostalCode('53001'), null);
    eq("regionFromPostalCode('2801')", regionFromPostalCode('2801'), null);
    eq("regionFromPostalCode('abcde')", regionFromPostalCode('abcde'), null);
    eq("regionFromPostalCode('')", regionFromPostalCode(''), null);
    eq("regionFromPostalCode(null)", regionFromPostalCode(null), null);
    eq('tabla de provincias completa (01-52)', PROVINCES.length, 52);
    check('prefijos 01-52 sin huecos', PROVINCES.every((p, i) => p.code === String(i + 1).padStart(2, '0')));
    check('todas las provincias apuntan a una región válida', PROVINCES.every((p) => isKnownRegionCode(p.region)));
    check('todas las regiones con provincia aparecen en REGIONS', new Set(PROVINCES.map((p) => p.region)).size === REGIONS.length - 1);

    /* --- Robustez: años inválidos y regiones desconocidas --- */
    for (const bad of ['abc', '', null, undefined, NaN, Infinity, -Infinity, {}, [], 0]) {
      const list = attempt(`holidaysFor(${JSON.stringify(bad)}) no debe lanzar`, () => holidaysFor(bad, 'MD'));
      check(`año inválido ${JSON.stringify(bad)} → []`, Array.isArray(list) && list.length === 0);
    }
    check('holidaysFor("abc") no lanza (llamada directa)', attempt('holidaysFor("abc")', () => holidaysFor('abc', 'ES'))?.length === 0);
    eq('año como cadena numérica', holidaysFor('2025', 'MD').length, holidaysFor(2025, 'MD').length);
    const unknown = attempt('región desconocida', () => holidaysFor(2025, 'ZZ'));
    check('región desconocida no lanza', Array.isArray(unknown));
    eq('región desconocida = solo nacionales', unknown?.length, holidaysFor(2025, 'ES').length);
    eq('región vacía = solo nacionales', holidaysFor(2025, undefined).length, holidaysFor(2025, 'ES').length);
    eq('región minúsculas', JSON.stringify(holidaysFor(2025, 'md')), JSON.stringify(holidaysFor(2025, 'MD')));
    eq('región con espacios', JSON.stringify(holidaysFor(2025, ' ct ')), JSON.stringify(holidaysFor(2025, 'CT')));
    eq("alias 'XX' = 'ES'", JSON.stringify(holidaysFor(2025, 'XX')), JSON.stringify(holidaysFor(2025, 'ES')));
    eq('normalizeRegionCode(md)', normalizeRegionCode('md'), 'MD');
    eq('normalizeRegionCode(zz)', normalizeRegionCode('zz'), 'ES');
    eq('normalizeRegionCode(XX)', normalizeRegionCode('XX'), 'ES');
    eq('isHoliday con fecha inválida', isHoliday('2025-02-31', 'ES').isHoliday, false);
    eq('isHoliday con basura', isHoliday('no-es-fecha', 'MD').isHoliday, false);
    eq('isHoliday devuelve holiday null si no lo es', isHoliday('2025-03-05', 'MD').holiday, null);
    eq('isHoliday con región desconocida no lanza', isHoliday('2025-01-01', '??').isHoliday, true);

    /* --- Orden, unicidad y forma de las entradas --- */
    const md2025 = holidaysFor(2025, 'MD');
    check('fechas ordenadas', md2025.every((h, i) => i === 0 || md2025[i - 1].date <= h.date));
    check('sin duplicados fecha+nombre', new Set(md2025.map((h) => `${h.date}|${h.name}`)).size === md2025.length);
    check('todas las entradas tienen date/name/scope/region', md2025.every((h) => typeof h.date === 'string' && h.name && (h.scope === 'national' || h.scope === 'regional') && (h.region === null || typeof h.region === 'string')));
    check('nacionales con region null', md2025.filter((h) => h.scope === 'national').every((h) => h.region === null));
    check('autonómicos con region = MD', md2025.filter((h) => h.scope === 'regional').every((h) => h.region === 'MD'));
    check('todos los festivos caen en el año pedido', md2025.every((h) => h.date.slice(0, 4) === '2025'));
    check('NATIONAL_HOLIDAYS con mondayIfSunday booleano', NATIONAL_HOLIDAYS.every((h) => typeof h.mondayIfSunday === 'boolean'));
    check('festivos autonómicos con confidence válida', REGIONS.filter((r) => r.code !== 'ES').every((r) => holidaysFor(2025, r.code).filter((h) => h.scope === 'regional').every((h) => CONFIDENCES.has(h.confidence))));
    eq('REGIONS empieza por ES', REGIONS[0].code, 'ES');
    check('códigos de región únicos', new Set(REGIONS.map((r) => r.code)).size === REGIONS.length);
    eq('REGIONS tiene 20 entradas (ES + 19)', REGIONS.length, 20);
    check('todas las comunidades tienen algún festivo propio', REGIONS.filter((r) => r.code !== 'ES').every((r) => holidaysFor(2025, r.code).some((h) => h.scope === 'regional')));
    check('DATA_NOTES no está vacío y es de cadenas', Array.isArray(DATA_NOTES) && DATA_NOTES.length > 0 && DATA_NOTES.every((n) => typeof n === 'string' && n.length > 20));

    /* --- Traslado al lunes (opcional) --- */
    // 1 de enero de 2023 fue domingo: con la opción debe aparecer el lunes 2.
    eq('sin traslado: 2023-01-02 no es festivo', isHoliday('2023-01-02', 'ES').isHoliday, false);
    const shifted = holidaysFor(2023, 'ES', { shiftSundayToMonday: true });
    check('con traslado: aparece el lunes 2023-01-02', shifted.some((h) => h.date === '2023-01-02' && h.moved === true));
    check('el traslado conserva el festivo original', shifted.some((h) => h.date === '2023-01-01'));
    check('el traslado va después de ordenar', shifted.every((h, i) => i === 0 || shifted[i - 1].date <= h.date));
    check('holidaysFor ignora opciones basura', Array.isArray(holidaysFor(2025, 'MD', null)));

    /* --- Rangos --- */
    const range = attempt('holidaysForRange', () => holidaysForRange('2025-04-01', '2025-04-30', 'ES'));
    check('rango de abril de 2025 devuelve el Viernes Santo', range?.some((h) => h.date === '2025-04-18'));
    check('el rango no incluye nada fuera de límites', range?.every((h) => h.date >= '2025-04-01' && h.date <= '2025-04-30'));
    eq('rango invertido = rango normal', JSON.stringify(holidaysForRange('2025-04-30', '2025-04-01', 'ES')), JSON.stringify(holidaysForRange('2025-04-01', '2025-04-30', 'ES')));
    eq('rango con claves inválidas', holidaysForRange('basura', '2025-12-31').length, 0);
    eq('rango de un solo día festivo', holidaysForRange('2025-12-25', '2025-12-25', 'ES').length, 1);
    const longRange = attempt('rango larguísimo', () => holidaysForRange('2025-01-01', '2099-01-01', 'ES'));
    check('rango larguísimo se recorta a 1200 días', Array.isArray(longRange) && longRange.every((h) => h.date <= addDays('2025-01-01', MAX_RANGE_DAYS - 1)));
    const map = attempt('holidaysMapForRange', () => holidaysMapForRange('2025-01-01', '2025-12-31', 'MD'));
    check('holidaysMapForRange devuelve un Map', map instanceof Map);
    eq('el Map cubre todas las fechas del array', map?.size, new Set(holidaysForRange('2025-01-01', '2025-12-31', 'MD').map((h) => h.date)).size);

    /* --- Pureza: nada compartido entre llamadas --- */
    const a1 = holidaysFor(2025, 'MD')[0];
    const a2 = holidaysFor(2025, 'MD')[0];
    check('cada llamada devuelve objetos nuevos', a1 !== a2);
    a1.name = 'MUTADO';
    eq('mutar el resultado no afecta a la siguiente llamada', holidaysFor(2025, 'MD')[0].name, 'Año Nuevo');
    eq('NATIONAL_HOLIDAYS intacto tras mutar', NATIONAL_HOLIDAYS[0].name, 'Año Nuevo');
    check('tablas congeladas', Object.isFrozen(REGIONS) && Object.isFrozen(NATIONAL_HOLIDAYS) && Object.isFrozen(PROVINCES) && Object.isFrozen(DATA_NOTES));
  } catch (err) {
    failures.push(`fallo inesperado en selfTest: ${err && err.message ? err.message : String(err)}`);
  }

  return { passed, failed: failures.length, failures };
}
