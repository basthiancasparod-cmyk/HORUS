/**
 * HORUS — core/storage.js
 * Persistencia local (localStorage) con respaldo en memoria, copias de
 * seguridad rotativas y migración del formato antiguo.
 *
 * Claves usadas:
 *   horus.doc.v4      → documento actual
 *   horus.bak.0..2    → copias rotativas de las últimas escrituras
 *   horus.session     → sesión de Supabase (tokens)
 *   horus.ui          → preferencias de interfaz (no sincronizadas)
 *   horus.legacy.bak  → copia del blob antiguo, por si hay que volver atrás
 */

import { normalizeDocument, migrateFromLegacy, emptyDocument, OLD_DB_KEY } from './model.js';

export const KEY_DOC = 'horus.doc.v4';
export const KEY_SESSION = 'horus.session';
export const KEY_UI = 'horus.ui';
export const KEY_LEGACY_BACKUP = 'horus.legacy.bak';
export const KEY_MIGRATED = 'horus.migrated.v4';
const KEY_BAK = (i) => `horus.bak.${i}`;
const BAK_SLOTS = 3;
const LEGACY_UI_KEYS = ['horus_theme', 'horus_onboarding_done', 'horus_auth'];

/* ------------------------------------------------------------------ *
 * Adaptador tolerante a fallos
 * ------------------------------------------------------------------ */

function probeLocalStorage() {
  try {
    const probe = '__horus_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

function memoryAdapter() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    __memory: true,
  };
}

const backing = probeLocalStorage() || memoryAdapter();

export const storage = {
  available: !backing.__memory,
  backend: backing.__memory ? 'memory' : 'localStorage',

  get(key) {
    try { return backing.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { backing.setItem(key, value); return true; } catch (err) {
      // Cuota llena: se intenta liberar espacio borrando copias de seguridad
      if (isQuotaError(err)) {
        for (let i = 0; i < BAK_SLOTS; i++) {
          try { backing.removeItem(KEY_BAK(i)); } catch { /* nada */ }
        }
        try { backing.setItem(key, value); return true; } catch { /* sigue fallando */ }
      }
      console.warn('[storage] no se pudo escribir', key, err);
      return false;
    }
  },
  remove(key) {
    try { backing.removeItem(key); } catch { /* nada */ }
  },
  keys() {
    const out = [];
    try {
      for (let i = 0; i < backing.length; i++) {
        const k = backing.key(i);
        if (k) out.push(k);
      }
    } catch { /* nada */ }
    return out;
  },
};

function isQuotaError(err) {
  return err && (err.name === 'QuotaExceededError'
    || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || err.code === 22 || err.code === 1014);
}

/* ------------------------------------------------------------------ *
 * Documento
 * ------------------------------------------------------------------ */

function parseJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Lee el documento guardado (sin migrar). Devuelve null si no hay nada válido. */
export function readRawDocument() {
  const raw = parseJSON(storage.get(KEY_DOC));
  if (!raw || typeof raw !== 'object') return null;
  return raw;
}

/**
 * Carga el documento aplicando migraciones si hace falta.
 * @returns {{doc:object, source:'v4'|'legacy'|'fresh', migrated:boolean, legacySummary:object|null}}
 */
export function loadDocument() {
  const raw = readRawDocument();
  if (raw && raw.schema >= 4) {
    return { doc: normalizeDocument(raw), source: 'v4', migrated: false, legacySummary: null };
  }
  // Documento de una versión intermedia (no existe todavía, pero por robustez)
  if (raw && Array.isArray(raw.entries)) {
    return { doc: normalizeDocument(raw), source: 'v4', migrated: true, legacySummary: null };
  }

  const legacy = readLegacy();
  if (legacy) {
    const doc = migrateFromLegacy(legacy);
    // Guarda el blob antiguo antes de tocar nada, y marca la migración
    storage.set(KEY_LEGACY_BACKUP, JSON.stringify(legacy));
    storage.set(KEY_MIGRATED, String(Date.now()));
    writeDocument(doc);
    return {
      doc,
      source: 'legacy',
      migrated: true,
      legacySummary: doc.migration || null,
    };
  }

  return { doc: emptyDocument(), source: 'fresh', migrated: false, legacySummary: null };
}

export function readLegacy() {
  const raw = parseJSON(storage.get(OLD_DB_KEY));
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.days && !raw.profiles && !raw.shiftTypes) return null;
  return raw;
}

export function hasLegacy() {
  return readLegacy() !== null;
}

/** Copia guardada del blob antiguo (para poder recuperarla). */
export function readLegacyBackup() {
  return parseJSON(storage.get(KEY_LEGACY_BACKUP));
}

/**
 * Escribe el documento, rotando antes las copias de seguridad.
 * @param {object} doc
 * @param {{backup?:boolean}} [opts]
 */
export function writeDocument(doc, { backup = true } = {}) {
  const text = JSON.stringify(doc);
  if (backup) {
    const previous = storage.get(KEY_DOC);
    if (previous && previous.length > 200) {
      for (let i = BAK_SLOTS - 1; i > 0; i--) {
        const prev = storage.get(KEY_BAK(i - 1));
        if (prev) storage.set(KEY_BAK(i), prev);
      }
      storage.set(KEY_BAK(0), previous);
    }
  }
  return storage.set(KEY_DOC, text);
}

/** Copias de seguridad disponibles, de la más reciente a la más antigua. */
export function listBackups() {
  const out = [];
  for (let i = 0; i < BAK_SLOTS; i++) {
    const raw = parseJSON(storage.get(KEY_BAK(i)));
    if (raw) {
      out.push({
        slot: i,
        savedAt: Number(raw.updatedAt) || null,
        entries: Array.isArray(raw.entries) ? raw.entries.length : 0,
        members: Array.isArray(raw.members) ? raw.members.length : 0,
        size: (storage.get(KEY_BAK(i)) || '').length,
      });
    }
  }
  return out;
}

export function readBackup(slot) {
  const raw = parseJSON(storage.get(KEY_BAK(slot)));
  return raw ? normalizeDocument(raw) : null;
}

/** Elimina el blob antiguo y las claves sueltas de la versión anterior. */
export function purgeLegacy({ keepBackup = true } = {}) {
  // Asegura que la copia del blob antiguo exista antes de borrarlo, porque
  // `loadDocument()` puede haber migrado en memoria sin llegar a escribirla.
  if (keepBackup && !storage.get(KEY_LEGACY_BACKUP)) {
    const legacy = storage.get(OLD_DB_KEY);
    if (legacy) storage.set(KEY_LEGACY_BACKUP, legacy);
  }
  if (!keepBackup) storage.remove(KEY_LEGACY_BACKUP);
  storage.remove(OLD_DB_KEY);
  for (const k of LEGACY_UI_KEYS) {
    if (k !== 'horus_auth') storage.remove(k);
  }
}

/* ------------------------------------------------------------------ *
 * Espacio ocupado
 * ------------------------------------------------------------------ */

export function storageStats() {
  const keys = storage.keys();
  let total = 0;
  const detail = [];
  for (const k of keys) {
    const v = storage.get(k) || '';
    total += k.length + v.length;
    if (k.startsWith('horus.') || k === OLD_DB_KEY) {
      detail.push({ key: k, bytes: k.length + v.length });
    }
  }
  return {
    backend: storage.backend,
    keys: keys.length,
    bytes: total,
    // localStorage guarda UTF-16: ~2 bytes por carácter
    approxBytes: total * 2,
    detail: detail.sort((a, b) => b.bytes - a.bytes),
  };
}

/** Borra TODO lo de HORUS en este dispositivo. */
export function clearAll({ includeBackups = true } = {}) {
  const keys = storage.keys();
  for (const k of keys) {
    if (!k.startsWith('horus.') && k !== OLD_DB_KEY) continue;
    if (!includeBackups && (k.startsWith('horus.bak.') || k === KEY_LEGACY_BACKUP)) continue;
    if (k === KEY_UI) continue; // las preferencias visuales se conservan
    storage.remove(k);
  }
}

/* ------------------------------------------------------------------ *
 * Sesión de Supabase
 * ------------------------------------------------------------------ */

export function loadSession() {
  const s = parseJSON(storage.get(KEY_SESSION));
  if (!s || typeof s !== 'object' || !s.accessToken) return null;
  return {
    userId: String(s.userId || ''),
    email: String(s.email || ''),
    accessToken: String(s.accessToken),
    refreshToken: String(s.refreshToken || ''),
    expiresAt: Number(s.expiresAt) || 0,
  };
}

export function saveSession(session) {
  if (!session) {
    storage.remove(KEY_SESSION);
    return;
  }
  storage.set(KEY_SESSION, JSON.stringify(session));
}

export function sessionExpired(session, skewMs = 60000) {
  if (!session) return true;
  if (!session.expiresAt) return false; // sin expiración conocida: se intenta igual
  return Date.now() > (session.expiresAt - skewMs);
}

/* ------------------------------------------------------------------ *
 * Preferencias de interfaz (locales, no sincronizadas)
 * ------------------------------------------------------------------ */

const UI_DEFAULTS = {
  lastView: 'today',
  calendarMode: 'month',      // 'month' | 'list' | 'team'
  filterMemberIds: [],
  filterTypeIds: [],
  showOnlyMine: false,
  lastMonth: null,
  collapsedPanels: [],
  dismissedHints: [],
  sidebarOpen: false,
};

export function loadUI() {
  const raw = parseJSON(storage.get(KEY_UI));
  return { ...UI_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
}

export function saveUI(patch) {
  const current = loadUI();
  const next = { ...current, ...patch };
  storage.set(KEY_UI, JSON.stringify(next));
  return next;
}

/** Guarda la sesión y el documento a la vez (al cerrar sesión, por ejemplo). */
export function snapshotAll() {
  return {
    doc: readRawDocument(),
    session: loadSession(),
    ui: loadUI(),
    stats: storageStats(),
  };
}
