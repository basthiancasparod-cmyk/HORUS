/**
 * HORUS — js/config.js
 * Configuración de la aplicación. Único sitio donde viven las credenciales.
 *
 * La clave `anon` de Supabase es PÚBLICA por diseño: va en el cliente y lo que
 * protege los datos son las políticas RLS del servidor. Aun así, se puede
 * sobrescribir desde Ajustes → Nube (se guarda en localStorage), de modo que
 * si publicas el repositorio puedas usar tu propio proyecto sin tocar código.
 *
 * Si no hay URL/clave, la app funciona igual: 100 % local en el dispositivo.
 */

import { storage } from './core/storage.js';

const OVERRIDE_KEY = 'horus.cloud';

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

function sanitizeKey(key) {
  const s = String(key || '').trim();
  // Una clave JWT tiene tres partes separadas por puntos
  return s.split('.').length === 3 && s.length > 40 ? s : '';
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
  if (!anonKey) return { ok: false, error: 'La clave anon no tiene el formato esperado (debe ser un JWT)' };
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
