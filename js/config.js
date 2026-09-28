/**
 * HORUS — js/config.js
 * Configuración de la aplicación. Único sitio donde viven las credenciales.
 *
 * La clave pública de Supabase va en el cliente por diseño y lo que protege los
 * datos son las políticas RLS del servidor. Aun así, se puede sobrescribir desde
 * Ajustes → Nube (se guarda en localStorage), de modo que si publicas el
 * repositorio puedas usar tu propio proyecto sin tocar código.
 *
 * Supabase emite HOY dos formas de clave pública y las dos valen aquí:
 *   · la nueva «publishable», que empieza por `sb_publishable_`;
 *   · la clásica «anon», que es un JWT (tres partes separadas por puntos).
 * Y una que NO puede usarse nunca en el navegador: `sb_secret_…` (heredera de
 * `service_role`), que se salta RLS entera. El porqué, en `clasificarClave()`.
 *
 * Si no hay URL/clave, la app funciona igual: 100 % local en el dispositivo.
 */

import { storage } from './core/storage.js';

const OVERRIDE_KEY = 'horus.cloud';

/** Prefijos con los que Supabase nombra sus claves en el panel nuevo. */
const PREFIJO_PUBLICABLE = 'sb_publishable_';
const PREFIJO_SECRETA = 'sb_secret_';

/**
 * Suelo de longitud para una clave «publishable». No pretende medir la clave
 * real (las de verdad pasan de 40 caracteres): solo delata un pegado a medias,
 * y se queda muy por debajo de la longitud real para no descartar una clave
 * válida por «corta» ni por no llevar puntos.
 */
const MINIMO_PUBLICABLE = PREFIJO_PUBLICABLE.length + 8;

/**
 * Suelo de longitud para la clave clásica. La sola cabecera de un JWT
 * (`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`) ya tiene 36 caracteres, así que 40
 * no rechaza ninguna clave real: solo un pegado truncado.
 */
const MINIMO_JWT = 40;

/**
 * Mensajes de rechazo, escritos enteros y en español. El de formato dice QUÉ se
 * espera (las dos formas aceptadas) porque el anterior («no tiene el formato
 * esperado (debe ser un JWT)») mandaba a buscar un JWT justo cuando Supabase ya
 * recomienda dejar de usarlos.
 */
const MENSAJES_CLAVE = {
  vacia: 'Escribe la clave pública del proyecto: la «publishable» (empieza por «sb_publishable_») '
    + 'o la clásica «anon» (un JWT que empieza por «eyJ»).',
  formato: 'Esa no es la clave pública del proyecto. Copia la clave «publishable» '
    + '(empieza por «sb_publishable_») o la clásica «anon» (un JWT que empieza por «eyJ» '
    + 'y tiene tres partes separadas por puntos). Se pegan enteras y sin comillas.',
  secreta_nueva: 'Esa es la clave SECRETA del proyecto (empieza por «sb_secret_»). Se salta TODAS '
    + 'las reglas de seguridad (RLS), así que no puede usarse en el navegador: cualquiera que '
    + 'abriera la página la vería y tendría acceso completo a la base de datos. Esa clave es solo '
    + 'para el servidor; aquí va la clave pública («sb_publishable_…» o la «anon»).',
  secreta_jwt: 'Esa es la clave de SERVICIO del proyecto (su JWT lleva «service_role»). Se salta '
    + 'TODAS las reglas de seguridad (RLS), así que no puede usarse en el navegador: cualquiera que '
    + 'abriera la página la vería y tendría acceso completo a la base de datos. Esa clave es solo '
    + 'para el servidor; aquí va la clave pública («sb_publishable_…» o la «anon»).',
};

/**
 * Credenciales por defecto (proyecto original de HORUS).
 * Pueden sustituirse desde la interfaz.
 */
export const DEFAULT_CLOUD = {
  url: 'https://rvqraldjcjixcrjnceda.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2cXJhbGRqY2ppeGNyam5jZWRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0NzgwMDQsImV4cCI6MjA5ODA1NDAwNH0.JLXMvYk2-v7zXyH5LrYp5anLc3FpZmkQB0daAcefUng',
};

/** Nombres de las tablas en Supabase. Un solo sitio para cambiarlos. */
export const TABLES = {
  documents: 'horus_documents',
  members: 'horus_members',
  shiftTypes: 'horus_shift_types',
  entries: 'horus_entries',
  patterns: 'horus_patterns',
  dayMeta: 'horus_day_meta',
  teams: 'horus_teams',
  teamMembers: 'horus_team_members',
  // Tablas de la versión anterior: solo se usan para la migración
  legacyUserData: 'user_data',
  legacyProfiles: 'profiles',
};

/** Versión del documento en la nube. */
export const CLOUD_SCHEMA = 4;

/** Nombre de la app y metadatos de exportación. */
export const APP = {
  name: 'HORUS',
  version: '4.0.0',
  tagline: 'Cuadrante de turnos del equipo',
  exportPrefix: 'horus',
};

let cached = null;
let defaultOverride = null;

function sanitizeUrl(url) {
  const s = String(url || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+$/i.test(s) ? s : '';
}

/**
 * Deja la clave como debe guardarse: sin espacios ni saltos de línea y sin las
 * comillas que a veces arrastra el botón de copiar (o un pegote a mano).
 *
 * POR QUÉ SE LIMPIA AQUÍ Y NO AL USARLA: este es el único sitio por el que pasa
 * la clave antes de guardarse y antes de leerse, así que limpiarla una vez evita
 * tener dos normalizaciones distintas que se contradigan (la de Ajustes y la de
 * `baseHeaders()`). Una comilla pegada a la clave viaja al servidor dentro de la
 * cabecera `apikey` y hace que la rechace, y el mensaje que devuelve no dice
 * nada de comillas.
 */
function limpiarClave(valor) {
  return String(valor ?? '')
    .trim()
    .replace(/^["'`“”‘’]+/, '')
    .replace(/["'`“”‘’]+$/, '')
    .trim();
}

/**
 * ¿El JWT lleva el rol `service_role`? Mira el contenido, y ante CUALQUIER duda
 * deja pasar la clave (el objetivo es cazar la clave de servicio, no adivinar
 * claves): si no se puede decodificar, ya la rechazará el servidor si no vale.
 */
function esClaveDeServicio(jwt) {
  try {
    const base64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const relleno = '='.repeat((4 - (base64.length % 4)) % 4);
    const texto = typeof atob === 'function' ? atob(base64 + relleno) : '';
    return JSON.parse(texto)?.role === 'service_role';
  } catch {
    return false;
  }
}

/**
 * Qué forma tiene lo que se ha pegado: `publica`, `secreta_nueva`, `secreta_jwt`,
 * `vacia` o `desconocida`.
 *
 * POR QUÉ NO BASTA CON MIRAR SI ES UN JWT — el fallo que llegó desde la
 * aplicación real: Supabase ya emite claves públicas nuevas que NO son JWT
 * (`sb_publishable_…`) y recomienda migrar a ellas. Al exigir «tres partes
 * separadas por puntos y más de 40 caracteres», `sanitizeKey` descartaba en
 * silencio una clave perfectamente válida; la app se quedaba SIN clave y todas
 * las peticiones salían sin la cabecera `apikey`, que Supabase corta con «No API
 * key found in request» (en inglés y sin decir qué falta).
 *
 * Y la clave `sb_secret_` (o la antigua `service_role`) se detecta a propósito:
 * no es que no valga, es que no puede estar aquí. Si se colara, RLS dejaría de
 * proteger nada y cualquiera podría leer y escribir la base de datos entera
 * desde la consola del navegador.
 */
function clasificarClave(valor) {
  const s = limpiarClave(valor);
  if (!s) return 'vacia';

  // La secreta se mira PRIMERO: no es lo mismo «no vale» que «no puede estar
  // aquí», y confundirlas llevaría a alguien a pegar la clave de servicio
  // «porque es la que le funciona en el servidor».
  if (s.startsWith(PREFIJO_SECRETA)) return 'secreta_nueva';

  // Forma nueva: `sb_publishable_…`
  if (s.startsWith(PREFIJO_PUBLICABLE)) {
    return s.length >= MINIMO_PUBLICABLE ? 'publica' : 'desconocida';
  }

  // Forma clásica: JWT. Se acepta por su FORMA (tres partes no vacías) y no por
  // su contenido: una clave de un proyecto de pruebas o recién rotada puede no
  // empezar por «eyJ» y sigue siendo válida.
  const partes = s.split('.');
  if (partes.length === 3 && partes.every((parte) => parte.length > 0) && s.length >= MINIMO_JWT) {
    return esClaveDeServicio(s) ? 'secreta_jwt' : 'publica';
  }

  return 'desconocida';
}

/**
 * La clave tal y como se guarda: limpia y `''` si no es una clave pública.
 *
 * `''` significa «sin clave», que es lo que hace que la app lo diga en español
 * ANTES de salir a la red (ver `exigirConfiguracion()` en `core/auth.js`) en vez
 * de dejar que Supabase conteste en inglés.
 */
function sanitizeKey(key) {
  return clasificarClave(key) === 'publica' ? limpiarClave(key) : '';
}

/** Por qué no se acepta una clave, ya escrito para enseñárselo al usuario. */
function motivoClave(key) {
  const forma = clasificarClave(key);
  if (forma === 'publica') return '';
  return MENSAJES_CLAVE[forma] || MENSAJES_CLAVE.formato;
}

/** Credenciales por defecto efectivas (pueden haberse sustituido en memoria). */
function effectiveDefault() {
  return defaultOverride ?? DEFAULT_CLOUD;
}

/**
 * Sustituye las credenciales por defecto en memoria.
 *
 * Sirve para dos cosas: que otro despliegue apunte a su propio proyecto sin
 * tocar el código, y que las pruebas puedan comprobar el comportamiento «sin
 * nube» (pasando `null`), que es como funciona la app recién descargada.
 *
 * @param {{url:string, anonKey:string}|null} config
 */
export function setDefaultCloud(config) {
  defaultOverride = config ? { url: String(config.url || ''), anonKey: String(config.anonKey || '') } : { url: '', anonKey: '' };
  cached = null;
}

function readOverride() {
  try {
    const raw = storage.get(OVERRIDE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return { url: sanitizeUrl(parsed.url), anonKey: sanitizeKey(parsed.anonKey) };
  } catch {
    return null;
  }
}

/**
 * Configuración efectiva de la nube.
 * @returns {{url:string, anonKey:string, configured:boolean, source:'default'|'override'|'none'}}
 */
export function cloudConfig() {
  if (cached) return cached;
  const override = readOverride();
  if (override?.url && override?.anonKey) {
    cached = { ...override, configured: true, source: 'override' };
    return cached;
  }
  const url = sanitizeUrl(effectiveDefault().url);
  const anonKey = sanitizeKey(effectiveDefault().anonKey);
  cached = { url, anonKey, configured: !!(url && anonKey), source: url && anonKey ? 'default' : 'none' };
  return cached;
}

/**
 * Guarda credenciales propias. Pasa `null` para volver a las de por defecto.
 * @param {{url:string, anonKey:string}|null} config
 * @returns {{ok:boolean, error?:string}}
 */
export function setCloudConfig(config) {
  if (!config) {
    storage.remove(OVERRIDE_KEY);
    cached = null;
    return { ok: true };
  }
  const url = sanitizeUrl(config.url);
  const anonKey = sanitizeKey(config.anonKey);
  if (!url) return { ok: false, error: 'La URL debe ser tipo https://tuproyecto.supabase.co' };
  // El motivo se escribe según lo que se haya pegado: una clave secreta no se
  // rechaza «por el formato», se rechaza porque no puede estar en el navegador.
  if (!anonKey) return { ok: false, error: motivoClave(config.anonKey) };
  storage.set(OVERRIDE_KEY, JSON.stringify({ url, anonKey }));
  cached = null;
  return { ok: true };
}

export function hasOwnCloudConfig() {
  const override = readOverride();
  return !!(override?.url && override?.anonKey);
}

/**
 * Olvida la configuración cacheada para que la próxima consulta la vuelva a
 * leer del almacenamiento. Lo usan las pruebas y el cambio de credenciales.
 */
export function resetCloudConfigCache() {
  cached = null;
}

/** URL absoluta a la que Supabase redirige tras confirmar el correo. */
export function authRedirectUrl() {
  try {
    return new URL('.', window.location.href).href;
  } catch {
    return undefined;
  }
}
