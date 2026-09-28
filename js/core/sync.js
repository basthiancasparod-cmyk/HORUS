/**
 * HORUS — js/core/sync.js
 * Sincronización con Supabase, fila a fila.
 *
 * Por qué no un único blob JSON como la versión anterior:
 *   La versión antigua guardaba TODO el estado en una sola fila con "gana el
 *   último que escribe". Con un calendario compartido eso pierde trabajo: si
 *   tú y un compañero tocáis el cuadrante a la vez, uno de los dos cambios
 *   desaparece sin avisar. Aquí cada entidad es una fila y se resuelve por
 *   entidad con su propia marca de tiempo, así que dos personas editando días
 *   distintos no se pisan nunca.
 *
 * Cómo se detecta qué hay que subir (sin ensuciar el documento):
 *   El motor guarda un "estado de sincronización" aparte con, por tabla, el
 *   conjunto de ids y una huella por fila. Comparar la huella actual con la
 *   guardada dice exactamente qué filas son nuevas, modificadas o borradas.
 *   Nada de esto vive dentro del documento, que se mantiene limpio.
 *
 * Resolución de conflictos: gana la fila con `updatedAt` más reciente. Las
 * filas locales que perdieron se registran en `meta.conflicts` para que la
 * interfaz pueda avisar en lugar de mentir.
 *
 * Ámbitos (`owner_key`): cada fila pertenece a un ÁMBITO, que es el cuadrante
 * personal de una cuenta ('user:<uuid>') o el cuadrante compartido de un
 * equipo ('team:<uuid>'). El ámbito NO se guarda dentro del documento ni del
 * estado: se deduce del documento (`doc.teamId`) y de la sesión con
 * `ownerKeyFor()`, de modo que el mismo documento puede pasar de personal a
 * equipo y volver. `owner_key` va en TODAS las filas que se suben y es el
 * filtro de TODO lo que se baja. `user_id` se sigue mandando además: es «quién
 * escribió la fila», el trigger del servidor lo espera y la app antigua lo usa.
 *
 * OJO con las operaciones de UNA fila: desde la migración 0002 la clave
 * primaria es (owner_key, id), así que un `id` suelto YA NO identifica una
 * fila. Dos ámbitos pueden tener el mismo id (cada dispositivo genera sus
 * propios doc_…/m_…), y un PATCH o un DELETE filtrado solo por `id` tocaría la
 * fila del otro ámbito. Aquí toda operación de una fila filtra por owner_key Y
 * por id.
 */

import { TABLES, CLOUD_SCHEMA } from '../config.js';
import { authFetch, isSignedIn, currentSession, AuthError } from './auth.js';
import { storage } from './storage.js';
import { normalizeDayMeta } from './model.js';

const SYNC_KEY = 'horus.sync.v4';
const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000;
const BATCH_SIZE = 400;
const PULL_LIMIT = 20000;

/* ------------------------------------------------------------------ *
 * Estado de sincronización persistido
 * ------------------------------------------------------------------ */

function emptyState() {
  return {
    schema: CLOUD_SCHEMA,
    docId: null,
    // Ámbito ('user:<uuid>' o 'team:<uuid>') al que pertenece este estado. Si
    // no coincide con el del documento, el estado entero se tira: ver
    // `ensureScope()`.
    ownerKey: null,
    lastPullAt: {},        // tabla → marca de agua (tiempo DEL SERVIDOR) del último pull
    lastPushAt: {},        // tabla → ISO timestamp del último push correcto
    ids: {},               // tabla → array de ids conocidos en el servidor
    hashes: {},            // tabla → { id: huella } de la última versión sincronizada
    tombstones: [],        // [{ table, id, deletedAt }] pendientes de propagar
    conflicts: [],         // [{ table, id, local, remote, at }] detectados y sin resolver
    lastFullSyncAt: null,
  };
}

/**
 * Ámbito de un documento: el equipo si lo tiene, y si no el personal de quien
 * tenga la sesión abierta.
 *
 * Es una función (y no un campo guardado) porque el ámbito cambia con el
 * documento: el mismo dispositivo puede estar en su cuadrante personal y pasar
 * al del equipo sin dejar de ser el mismo documento.
 *
 * @param {{teamId?:string|null}} doc
 * @param {string|null} userId
 * @returns {string|null} 'team:<uuid>', 'user:<uuid>', o null sin sesión ni equipo
 */
export function ownerKeyFor(doc, userId) {
  const teamId = doc?.teamId || null;
  if (teamId) return `team:${teamId}`;
  return userId ? `user:${userId}` : null;
}

export function loadSyncState() {
  try {
    const raw = storage.get(SYNC_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const base = emptyState();
    const merged = { ...base, ...parsed };
    merged.ownerKey = typeof parsed.ownerKey === 'string' ? parsed.ownerKey : null;
    merged.lastPullAt = { ...(parsed.lastPullAt || {}) };
    merged.lastPushAt = { ...(parsed.lastPushAt || {}) };
    merged.ids = { ...(parsed.ids || {}) };
    merged.hashes = { ...(parsed.hashes || {}) };
    merged.tombstones = Array.isArray(parsed.tombstones) ? parsed.tombstones : [];
    merged.conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];
    return merged;
  } catch {
    return emptyState();
  }
}

function saveSyncState(state) {
  try {
    storage.set(SYNC_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function resetSyncState() {
  storage.remove(SYNC_KEY);
}

/** Elimina lápidas antiguas para que el estado no crezca sin fin. */
function pruneTombstones(state, now = Date.now()) {
  state.tombstones = state.tombstones.filter((t) => (now - (t.deletedAt || 0)) < TOMBSTONE_TTL_MS);
}

/* ------------------------------------------------------------------ *
 * Huellas
 * ------------------------------------------------------------------ */

/** Huella estable de un objeto: claves ordenadas, sin campos volátiles. */
export function fingerprint(value) {
  const seen = new WeakSet();
  const build = (v) => {
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'number') return Number.isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return v ? '1' : '0';
    if (t === 'string') return JSON.stringify(v);
    if (t === 'undefined') return 'u';
    if (Array.isArray(v)) return `[${v.map(build).join(',')}]`;
    if (t === 'object') {
      if (seen.has(v)) return 'circ';
      seen.add(v);
      const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
      return `{${keys.map((k) => `${k}:${build(v[k])}`).join(',')}}`;
    }
    return 'x';
  };
  const text = build(value);
  // Hash FNV-1a de 32 bits en base36: barato, suficiente para detectar cambios
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(36)}-${text.length.toString(36)}`;
}

/**
 * Huella de una entidad local.
 *
 * Es IMPRESCINDIBLE que el push y el pull usen exactamente esta misma función
 * y que la entidad llegue ya normalizada por `normalizeDocument()`. Si una de
 * las dos partes huellara una forma distinta de la misma fila, el motor creería
 * que todo sigue sin subir y reenviaría el documento entero cada vez.
 */
function entityFingerprint(key, entity, id) {
  switch (key) {
    case 'members':
      return fingerprint({ id, name: entity.name, initials: entity.initials, hex: entity.hex, role: entity.role, active: entity.active, weekly_hours: entity.weeklyHours });
    case 'shiftTypes':
      return fingerprint({ id, code: entity.code, label: entity.label, kind: entity.kind, hex: entity.hex, demand: entity.demand, archived: entity.archived, placement_order: entity.order });
    case 'entries':
      return fingerprint({ id, member_id: entity.memberId, entry_date: entity.date, type_id: entity.typeId, day_type: entity.dayType, approved: entity.approved, notes: entity.notes || '' });
    case 'patterns':
      return fingerprint({ id, name: entity.name, start_date: entity.startDate, step_days: entity.stepDays });
    case 'dayMeta':
      return fingerprint({ day_date: id, day_type: entity.dayType, label: entity.label || '', demand_override: entity.demandOverride, notes: entity.notes || '' });
    default:
      return fingerprint(entity);
  }
}

/* ------------------------------------------------------------------ *
 * Serialización: entidad local ↔ fila de Supabase
 * ------------------------------------------------------------------ */

/**
 * Definición de cada tabla: cómo extraer filas del documento y cómo
 * reconstruir el documento desde las filas.
 *
 * Solo están las tablas del cuadrante. `horus_teams` y `horus_team_members`
 * son un caso aparte y este motor no las toca: su ámbito ya ES el equipo
 * ('team:' || id / 'team:' || team_id, lo rellena el trigger del servidor) y
 * sus consultas van por `owner_id` (equipos que he creado) y `user_id`
 * (equipos en los que estoy), no por el `owner_key` por fila de aquí. Además
 * `horus_team_members` se identifica por (team_id, user_id) y no tiene un `id`
 * por fila, así que meterla en este mapa —que asume una clave por fila— la
 * rompería. Cuando la fase de equipos necesite leerlas, querrá su propia
 * consulta, no un descriptor más.
 */
function buildDescriptors(doc) {
  return {
    members: {
      table: TABLES.members,
      pk: 'id',
      rows: () => doc.members.map((m) => ({
        id: m.id,
        name: m.name,
        initials: m.initials,
        hex: m.hex,
        role: m.role,
        active: m.active,
        weekly_hours: m.weeklyHours,
        payload: m,
        client_updated_at: Number(m.updatedAt) || Number(m.createdAt) || doc.updatedAt,
      })),
      // Los miembros se fusionan por id, conservando el más reciente
      apply: (list, merged) => { merged.members = list; },
      order: 1,
    },
    shiftTypes: {
      table: TABLES.shiftTypes,
      pk: 'id',
      rows: () => doc.shiftTypes.map((s) => ({
        id: s.id,
        code: s.code,
        label: s.label,
        kind: s.kind,
        hex: s.hex,
        demand: s.demand,
        archived: s.archived,
        placement_order: s.order,
        payload: s,
        client_updated_at: Number(s.updatedAt) || doc.updatedAt,
      })),
      apply: (list, merged) => { merged.shiftTypes = list; },
      order: 0,
    },
    entries: {
      table: TABLES.entries,
      pk: 'id',
      rows: () => doc.entries.map((e) => ({
        id: e.id,
        member_id: e.memberId,
        entry_date: e.date,
        type_id: e.typeId,
        day_type: e.dayType,
        approved: e.approved,
        notes: e.notes || '',
        payload: e,
        client_updated_at: Number(e.updatedAt) || Number(e.createdAt) || doc.updatedAt,
      })),
      apply: (list, merged) => { merged.entries = list; },
      order: 2,
    },
    patterns: {
      table: TABLES.patterns,
      pk: 'id',
      rows: () => doc.patterns.map((p) => ({
        id: p.id,
        name: p.name,
        start_date: p.startDate,
        step_days: p.stepDays,
        payload: p,
        client_updated_at: Number(p.updatedAt) || Number(p.createdAt) || doc.updatedAt,
      })),
      apply: (list, merged) => { merged.patterns = list; },
      order: 3,
    },
    dayMeta: {
      table: TABLES.dayMeta,
      pk: 'day_date',
      rows: () => Object.entries(doc.dayMeta || {}).map(([date, meta]) => ({
        day_date: date,
        day_type: meta.dayType,
        label: meta.label || '',
        demand_override: meta.demandOverride,
        notes: meta.notes || '',
        payload: meta,
        client_updated_at: Number(meta.updatedAt) || doc.updatedAt,
      })),
      apply: (list, merged) => {
        const out = {};
        for (const row of list) {
          const date = row.day_date || row.id;
          if (!date) continue;
          out[date] = normalizeDayMeta(row.payload || row);
        }
        merged.dayMeta = out;
      },
      order: 4,
    },
  };
}

/** Extrae el valor de marca de tiempo de una fila remota. */
function remoteStamp(row) {
  const n = Number(row?.client_updated_at);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(row?.updated_at || '');
  return Number.isFinite(t) ? t : 0;
}

/** Convierte una fila remota en la entidad local. */
function rowToEntity(tableKey, row) {
  if (row?.payload && typeof row.payload === 'object') return { ...row.payload };
  // Respaldo: reconstruir desde las columnas por si el payload no llegó
  switch (tableKey) {
    case 'members':
      return {
        id: row.id, name: row.name, initials: row.initials, hex: row.hex,
        role: row.role, teamId: null, weeklyHours: row.weekly_hours,
        active: row.active !== false, colorSeed: 0, createdAt: 0,
      };
    case 'shiftTypes':
      return {
        id: row.id, code: row.code, label: row.label, short: row.code, hex: row.hex,
        kind: row.kind, blocks: [], paid: true, countsHours: row.kind === 'work',
        demand: row.demand, order: row.placement_order, archived: !!row.archived,
      };
    case 'entries':
      return {
        id: row.id, memberId: row.member_id, date: row.entry_date, typeId: row.type_id,
        blocks: null, dayType: row.day_type, notes: row.notes || '',
        demandOverride: null, approved: row.approved !== false, createdAt: 0, updatedAt: remoteStamp(row),
      };
    case 'patterns':
      return {
        id: row.id, name: row.name, cycle: [], stepDays: row.step_days,
        startDate: row.start_date, description: '', createdAt: 0,
      };
    case 'dayMeta':
      return normalizeDayMeta(row);
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Motor
 * ------------------------------------------------------------------ */

const STATUS = {
  idle: 'idle',
  syncing: 'syncing',
  offline: 'offline',
  error: 'error',
  conflict: 'conflict',
};

/**
 * Crea el motor de sincronización.
 *
 * @param {{
 *   getDoc: () => object,
 *   replaceDoc: (doc:object, meta:object) => void,
 *   getAuthUserId: () => string|null,
 * }} deps
 */
export function createSyncEngine(deps) {
  const { getDoc, replaceDoc } = deps;
  let state = loadSyncState();
  let status = STATUS.idle;
  let lastError = null;
  let lastResult = null;
  let running = false;
  const listeners = new Set();

  function emit() {
    const info = {
      status,
      running,
      lastError,
      lastResult,
      lastFullSyncAt: state.lastFullSyncAt,
      hasPendingPush: pendingCount() > 0,
      configured: isSignedIn(),
    };
    for (const fn of [...listeners]) {
      try { fn(info); } catch (err) { console.error('[sync] suscriptor con error:', err); }
    }
  }

  function setStatus(next, error = null) {
    status = next;
    lastError = error;
    emit();
  }

  /** Suscribirse a cambios de estado. */
  function subscribe(fn, { immediate = false } = {}) {
    listeners.add(fn);
    if (immediate) fn({ status, running, lastError, lastResult, configured: isSignedIn(), hasPendingPush: pendingCount() > 0 });
    return () => listeners.delete(fn);
  }

  /* ---------------- ámbito ---------------- */

  /**
   * Comprueba que el estado de sincronización es del ámbito del documento y,
   * si no lo es, lo empieza de cero.
   *
   * POR QUÉ HAY QUE REINICIARLO (el fallo silencioso que esto evita):
   * al pasar de personal a equipo (o al revés) las marcas de agua, las huellas,
   * los ids y las lápidas son del ámbito ANTERIOR. La marca de agua es lo peor:
   * el pull pregunta «dame lo cambiado desde X» y X es del otro cuadrante, así
   * que todo lo que ya existía en el ámbito nuevo —que es más antiguo— queda
   * fuera de la consulta y el usuario ve el cuadrante vacío sin ningún error,
   * como si estuviera todo al día. Y las lápidas viejas borrarían filas del
   * ámbito nuevo que este dispositivo ni siquiera conoce todavía.
   * Al no quedar huellas, el siguiente push sube el documento entero al ámbito
   * nuevo, que es justo lo que se quiere al mudarse.
   *
   * Se conservan los conflictos a propósito: son avisos para el usuario («esta
   * edición tuya la pisó el servidor»), no marcas de agua; perderlos en
   * silencio es lo contrario de lo que se pretende.
   *
   * @returns {string|null} el ámbito vigente, o null si no hay sesión ni equipo
   */
  function ensureScope() {
    const scope = ownerKeyFor(getDoc(), currentSession()?.userId);
    if (!scope) return null;
    if (state.ownerKey !== scope) {
      state = { ...emptyState(), ownerKey: scope, conflicts: state.conflicts || [] };
      saveSyncState(state);
    }
    return scope;
  }

  /* ---------------- cálculo de diferencias ---------------- */

  /**
   * Compara el documento con el último estado sincronizado.
   * @returns {{toUpsert:object[], toDelete:object[], byTable:object, total:number}}
   */
  function diff() {
    // El ámbito se revisa aquí porque `pendingCount()` pasa por aquí: tras un
    // cambio de ámbito (personal ↔ equipo) lo pendiente es todo el documento,
    // y eso solo es cierto si el estado del ámbito viejo ya se ha tirado.
    ensureScope();
    const doc = getDoc();
    const descriptors = buildDescriptors(doc);
    const toUpsert = [];
    const toDelete = [];

    for (const [key, desc] of Object.entries(descriptors)) {
      const rows = desc.rows();
      const knownHashes = state.hashes[key] || {};
      const knownIds = new Set(state.ids[key] || []);
      const currentIds = new Set();

      for (const row of rows) {
        const id = String(row[desc.pk]);
        currentIds.add(id);
        const h = entityFingerprint(key, row.payload ?? row, id);
        if (knownHashes[id] !== h) toUpsert.push({ key, table: desc.table, pk: desc.pk, id, row });
      }

      // Filas que estaban en el servidor y ya no están en el documento
      for (const id of knownIds) {
        if (!currentIds.has(id) && !state.tombstones.some((t) => t.table === desc.table && t.id === id)) {
          toDelete.push({ key, table: desc.table, pk: desc.pk, id });
        }
      }
    }

    // Lápidas pendientes de propagar
    for (const t of state.tombstones) {
      toDelete.push({ key: null, table: t.table, pk: null, id: t.id, fromTombstone: true });
    }

    // Respeta el orden de dependencias: primero tipos y miembros, luego entradas
    const orderOf = (key) => descriptors[key]?.order ?? 9;
    toUpsert.sort((a, b) => orderOf(a.key) - orderOf(b.key));
    toDelete.sort((a, b) => orderOf(b.key) - orderOf(a.key)); // borra las hojas primero

    return { toUpsert, toDelete, total: toUpsert.length + toDelete.length, descriptors };
  }

  function pendingCount() {
    try {
      return diff().total;
    } catch {
      return 0;
    }
  }

  /** Anota un conflicto para poder avisar al usuario (máximo 50, los últimos). */
  function recordConflict(conflict) {
    state.conflicts = (state.conflicts || []).filter((c) => !(c.table === conflict.table && c.id === conflict.id));
    state.conflicts.push({ ...conflict, at: Date.now() });
    if (state.conflicts.length > 50) state.conflicts = state.conflicts.slice(-50);
  }

  /** Conflictos detectados y todavía sin revisar. */
  function conflicts() {
    return [...(state.conflicts || [])];
  }

  /** Da por revisados los conflictos (tras enseñarlos al usuario). */
  function acknowledgeConflicts(ids = null) {
    if (!ids) state.conflicts = [];
    else state.conflicts = (state.conflicts || []).filter((c) => !ids.includes(c.id));
    saveSyncState(state);
    emit();
    return conflicts();
  }

  /* ---------------- HTTP ---------------- */

  async function api(path, opts = {}) {
    if (!isSignedIn()) throw new AuthError('No hay sesión iniciada.', { code: 'no_session' });
    return authFetch(path, opts);
  }

  async function readError(response) {
    try {
      const text = await response.text();
      if (!text) return `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        return parsed.message || parsed.hint || parsed.error_description || text.slice(0, 300);
      } catch {
        return text.slice(0, 300);
      }
    } catch {
      return `HTTP ${response.status}`;
    }
  }

  /**
   * Inserta o actualiza un lote de filas en una tabla.
   *
   * Toda fila lleva su `owner_key` (el ámbito) además de `user_id`: la clave
   * primaria del servidor es (owner_key, id), y sin el ámbito el trigger lo
   * rellenaría con 'user:' || user_id, o sea, que una fila de equipo acabaría
   * en el cuadrante personal de quien la escribe.
   */
  async function upsertRows(table, rows, ownerKey) {
    const userId = currentSession()?.userId;
    if (!userId || !ownerKey) throw new AuthError('No hay sesión iniciada.');
    const body = rows.map((r) => ({
      ...r,
      owner_key: ownerKey,
      user_id: userId,
      deleted: false,
      updated_at: new Date().toISOString(),
    }));
    const response = await api(`/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal',
        'Content-Type': 'application/json',
      },
      body,
    });
    if (!response.ok) throw new Error(`No se pudo guardar en ${table}: ${await readError(response)}`);
  }

  /**
   * Marca filas como borradas (borrado lógico, para poder propagarlo).
   *
   * Filtra por `owner_key` Y por id, nunca solo por id: con la clave primaria
   * (owner_key, id), el mismo id existe en varios ámbitos y un PATCH suelto
   * marcaría como borrada la fila de otro cuadrante.
   *
   * Y NO filtra por `user_id`: en un equipo la fila puede haberla escrito otro
   * miembro, así que un `user_id=eq.yo` no encontraría nada y el borrado se
   * quedaría sin propagar (el turno volvería a aparecer en el siguiente pull).
   */
  async function tombstoneRows(table, ids, ownerKey) {
    if (!ids.length) return;
    const userId = currentSession()?.userId;
    if (!userId || !ownerKey) throw new AuthError('No hay sesión iniciada.');
    const list = ids.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',');
    const pkColumn = table === TABLES.dayMeta ? 'day_date' : 'id';
    const response = await api(
      `/rest/v1/${table}?${pkColumn}=in.(${list})&owner_key=eq.${encodeURIComponent(ownerKey)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal', 'Content-Type': 'application/json' },
        body: { deleted: true, updated_at: new Date().toISOString() },
      },
    );
    if (!response.ok) throw new Error(`No se pudo borrar en ${table}: ${await readError(response)}`);
  }

  /* ---------------- push ---------------- */

  /**
   * Sube los cambios locales.
   * @returns {Promise<{pushed:number, deleted:number}>}
   */
  async function push({ full = false } = {}) {
    const doc = getDoc();
    const scope = ensureScope();
    const descriptors = buildDescriptors(doc);
    const { toUpsert, toDelete } = diff();
    const upserts = full
      ? Object.entries(descriptors).flatMap(([key, desc]) => desc.rows().map((row) => ({ key, table: desc.table, pk: desc.pk, id: String(row[desc.pk]), row })))
      : toUpsert;

    let pushed = 0;
    let deleted = 0;

    // Agrupa por tabla para hacer menos peticiones
    const byTable = new Map();
    for (const item of upserts) {
      if (!byTable.has(item.table)) byTable.set(item.table, []);
      byTable.get(item.table).push(item);
    }

    for (const [table, items] of byTable) {
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const chunk = items.slice(i, i + BATCH_SIZE);
        await upsertRows(table, chunk.map((c) => c.row), scope);
        // Solo se apunta la huella cuando el servidor ha aceptado el lote
        for (const c of chunk) {
          const key = c.key;
          if (!state.hashes[key]) state.hashes[key] = {};
          state.hashes[key][c.id] = entityFingerprint(key, c.row.payload ?? c.row, c.id);
          if (!state.ids[key]) state.ids[key] = [];
          if (!state.ids[key].includes(c.id)) state.ids[key].push(c.id);
          pushed++;
        }
        saveSyncState(state);
      }
      state.lastPushAt[table] = new Date().toISOString();
    }

    // Borrados agrupados por tabla
    const delByTable = new Map();
    for (const item of toDelete) {
      if (!delByTable.has(item.table)) delByTable.set(item.table, []);
      delByTable.get(item.table).push(item.id);
    }
    for (const [table, ids] of delByTable) {
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        await tombstoneRows(table, ids.slice(i, i + BATCH_SIZE), scope);
      }
      const key = Object.keys(descriptors).find((k) => descriptors[k].table === table);
      if (key) {
        const removed = new Set(ids);
        state.ids[key] = (state.ids[key] || []).filter((id) => !removed.has(id));
        for (const id of removed) delete state.hashes[key]?.[id];
      }
      state.tombstones = state.tombstones.filter((t) => t.table !== table || !ids.includes(t.id));
      deleted += ids.length;
      saveSyncState(state);
    }

    saveSyncState(state);
    return { pushed, deleted };
  }

  /* ---------------- pull ---------------- */

  /**
   * Baja los cambios remotos y los fusiona por entidad.
   * @returns {Promise<{applied:number, conflicts:object[]}>}
   */
  async function pull({ full = false } = {}) {
    const doc = getDoc();
    const scope = ensureScope();
    if (!scope) throw new AuthError('No hay sesión iniciada.');
    const descriptors = buildDescriptors(doc);
    const localHashes = Object.fromEntries(
      Object.entries(descriptors).map(([key, desc]) => {
        const map = {};
        for (const row of desc.rows()) map[String(row[desc.pk])] = fingerprint({ ...row, payload: undefined });
        return [key, map];
      }),
    );

    const merged = {
      members: [...doc.members],
      shiftTypes: [...doc.shiftTypes],
      entries: [...doc.entries],
      patterns: [...doc.patterns],
      dayMeta: { ...doc.dayMeta },
    };

    let applied = 0;
    const conflicts = [];

    for (const [key, desc] of Object.entries(descriptors)) {
      /* La marca de agua es `updated_at`, que la pone EL SERVIDOR al escribir.
         Antes se usaba `client_updated_at`, que es el reloj del propio
         dispositivo, y encima se saltaba a `Date.now()` cuando no venía nada.
         Consecuencia: si el móvil va unos minutos por detrás de la PC, los
         cambios del móvil nacen con una marca anterior a la que ya se trajo la
         PC y la consulta los ignora PARA SIEMPRE. El síntoma era «todo estaba al
         día» con cambios que nunca llegaban.
         Se pide con `gte` y no con `gt` para no perder las filas que comparten
         el instante de corte; comparar la huella de cada fila hace que volver a
         aplicar una fila ya vista no cueste nada.
         Una marca antigua (numérica) se descarta: obliga a un pull completo una
         vez y a partir de ahí todo va con la hora del servidor.
         El filtro es por ÁMBITO (owner_key), no por user_id: el cuadrante del
         equipo es de todos sus miembros y aquí hay que bajar también lo que
         escribieron los demás. `owner_key` es, además, el prefijo del índice
         (owner_key, deleted, updated_at) que creó la migración 0002. */
      const marca = state.lastPullAt[desc.table];
      const since = full || typeof marca !== 'string' ? null : marca;
      let query = `/rest/v1/${desc.table}?owner_key=eq.${encodeURIComponent(scope)}&select=*&limit=${PULL_LIMIT}`;
      if (since) query += `&updated_at=gte.${encodeURIComponent(since)}`;
      query += '&order=updated_at.asc';

      const response = await api(query);
      if (!response.ok) throw new Error(`No se pudo leer ${desc.table}: ${await readError(response)}`);
      const rows = await response.json();
      if (!Array.isArray(rows)) continue;

      const index = new Map();
      const current = merged[key];
      if (key === 'dayMeta') {
        for (const [date, meta] of Object.entries(merged.dayMeta)) index.set(date, meta);
      } else {
        for (const item of current) index.set(item.id, item);
      }

      const tombstones = new Set(state.tombstones.filter((t) => t.table === desc.table).map((t) => t.id));
      const knownHashes = state.hashes[key] || {};
      const knownIds = new Set(state.ids[key] || []);
      const nextIds = new Set(knownIds);
      const nextHashes = { ...knownHashes };
      let newestStamp = 0;
      // Instante del SERVIDOR más reciente de esta tanda: es el que se guarda
      // como marca de agua. Nunca la hora local.
      let newestServer = null;
      let newestServerMs = 0;

      for (const row of rows) {
        const id = String(row[desc.pk] ?? row.id ?? row.day_date);
        if (!id) continue;
        const rowStamp = Number(row.client_updated_at) || 0;
        if (rowStamp > newestStamp) newestStamp = rowStamp;

        if (row.updated_at) {
          const ms = Date.parse(row.updated_at);
          if (Number.isFinite(ms) && ms >= newestServerMs) {
            newestServerMs = ms;
            newestServer = String(row.updated_at);
          }
        }

        // Una lápida local pendiente manda: si yo borré esto, la fila que aún
        // vive en el servidor no debe resucitarla en mi dispositivo.
        if (tombstones.has(id)) {
          index.delete(id);
          nextIds.delete(id);
          delete nextHashes[id];
          continue;
        }

        const deleted = row.deleted === true;

        if (deleted) {
          if (index.has(id)) {
            index.delete(id);
            applied++;
          }
          nextIds.delete(id);
          delete nextHashes[id];
          continue;
        }

        const entity = rowToEntity(key, row);
        if (!entity) continue;
        const stamp = remoteStamp(row);
        const local = index.get(id);
        const localStamp = local ? (Number(local.updatedAt) || Number(local.createdAt) || 0) : 0;

        // ¿Tengo cambios locales sin subir en esta misma fila?
        const syncedFingerprint = knownHashes[id];
        const locallyModified = !local
          ? false
          : (!syncedFingerprint || entityFingerprint(key, local, id) !== syncedFingerprint);

        if (!local) {
          // Fila que aún no tengo: se añade sin más, no hay nada que pisar.
          index.set(id, entity);
          applied++;
        } else if (stamp > localStamp) {
          // Un conflicto de verdad exige que AMBAS partes hayan cambiado la
          // misma fila respecto a la última versión sincronizada. Si mi copia
          // sigue igual que cuando la subí, el servidor simplemente va por
          // delante y no hay nada que avisar.
          if (localStamp > 0 && locallyModified) {
            conflicts.push({
              table: desc.table,
              key,
              id,
              local: localStamp,
              remote: stamp,
              resolution: 'remote',
            });
            // Se guarda una copia de lo que había aquí para poder enseñárselo
            // al usuario: perder una edición en silencio es lo peor que puede
            // hacer un calendario compartido.
            recordConflict({
              table: desc.table,
              key,
              id,
              entryId: key === 'entries' ? id : null,
              remote: stamp,
              local: localStamp,
              lost: local,
            });
          }
          // Gana la fila más reciente, entera. No se mezclan campos de las dos
          // versiones: un híbrido con la marca del servidor y el contenido local
          // sería una mentira que además corrompería la siguiente subida.
          index.set(id, key === 'dayMeta' ? normalizeDayMeta(entity) : entity);
          applied++;
        } else if (!locallyModified && stamp < localStamp) {
          // Mi copia es más nueva y ya está subida: el servidor va por detrás
          // (nada que hacer localmente; el siguiente push la actualizará)
        }

        nextIds.add(id);
        nextHashes[id] = stamp > localStamp
          ? entityFingerprint(key, index.get(id), id)
          : (knownHashes[id] ?? entityFingerprint(key, index.get(id), id));
      }

      // Refleja el resultado en el documento fusionado
      if (key === 'dayMeta') {
        merged.dayMeta = Object.fromEntries(index);
      } else {
        merged[key] = [...index.values()];
      }

      state.ids[key] = [...nextIds];
      state.hashes[key] = nextHashes;
      // La marca de agua usa el instante DEL SERVIDOR, no el del cliente. Si se
      // usara la hora local y el reloj del dispositivo fuera adelantado, los
      // cambios remotos con marca intermedia se perderían para siempre.
      // Solo se AVANZA la marca de agua si el servidor ha devuelto algo, y se
      // avanza al instante del servidor. Saltarla a la hora local cuando la
      // respuesta venía vacía era lo que dejaba a un dispositivo sordo para
      // siempre: su reloj se adelantaba a los cambios del otro.
      if (newestServer) state.lastPullAt[desc.table] = newestServer;
      saveSyncState(state);
    }

    if (applied > 0 || conflicts.length) {
      replaceDoc(
        { ...doc, ...merged },
        { label: 'sincronizar desde la nube', history: false, silent: true },
      );
    }
    return { applied, conflicts };
  }

  /* ---------------- ciclo completo ---------------- */

  /**
   * Sincroniza: primero sube, luego baja (así el servidor nunca pisa lo propio
   * antes de haberlo recibido).
   * @param {{full?:boolean, silent?:boolean}} [opts]
   */
  async function sync({ full = false, silent = false } = {}) {
    // Si ya hay una sincronización en marcha se devuelve la última conocida. OJO:
    // en la primerísima sincronización `lastResult` todavía es null, y devolver
    // null hacía que quien llama (app.js) reventara al leer `result.pushed`.
    if (running) return lastResult ?? { skipped: true, reason: 'already-running' };
    if (!isSignedIn()) {
      setStatus(STATUS.offline, null);
      return { skipped: true, reason: 'no-session' };
    }
    if (!navigator.onLine) {
      setStatus(STATUS.offline, null);
      return { skipped: true, reason: 'offline' };
    }

    running = true;
    setStatus(STATUS.syncing);
    try {
      const pushed = await push({ full });
      const pulled = await pull({ full });
      lastResult = {
        at: Date.now(),
        pushed: pushed.pushed,
        deleted: pushed.deleted,
        applied: pulled.applied,
        conflicts: pulled.conflicts,
      };
      state.lastFullSyncAt = new Date().toISOString();
      // El documento y el estado ya coinciden
      saveSyncState(state);
      setStatus(pulled.conflicts.length ? STATUS.conflict : STATUS.idle);
      return lastResult;
    } catch (err) {
      if (err instanceof AuthError && err.offline) {
        setStatus(STATUS.offline, err);
        return { skipped: true, reason: 'offline' };
      }
      console.error('[sync] error:', err);
      setStatus(STATUS.error, err);
      throw err;
    } finally {
      running = false;
      emit();
    }
  }

  /**
   * Borra definitivamente los datos del ámbito en la nube (no toca el
   * documento local).
   *
   * OJO: el borrado es por ÁMBITO, así que en modo equipo se lleva por delante
   * el cuadrante DEL EQUIPO, no solo lo que subió este dispositivo (es la
   * misma semántica que tenía con user_id en el ámbito personal). La interfaz
   * debería pedir una confirmación aparte para ese caso.
   */
  async function wipeCloud() {
    const scope = ensureScope();
    if (!scope) throw new AuthError('No hay sesión iniciada.');
    const descriptors = buildDescriptors(getDoc());
    for (const desc of Object.values(descriptors)) {
      const response = await api(`/rest/v1/${desc.table}?owner_key=eq.${encodeURIComponent(scope)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        throw new Error(`No se pudo vaciar ${desc.table}: ${await readError(response)}`);
      }
    }
    resetSyncState();
    state = loadSyncState();
    emit();
    return true;
  }

  /** Cuántas filas hay en la nube ahora mismo (comprobación rápida). */
  async function cloudStats() {
    const scope = ensureScope();
    if (!scope) return null;
    const descriptors = buildDescriptors(getDoc());
    const out = {};
    for (const [key, desc] of Object.entries(descriptors)) {
      const response = await api(`/rest/v1/${desc.table}?owner_key=eq.${encodeURIComponent(scope)}&deleted=eq.false&select=id`, {
        headers: { Prefer: 'count=exact', Range: '0-0' },
      });
      const range = response.headers.get('content-range') || '';
      const count = Number(range.split('/')[1]);
      out[key] = Number.isFinite(count) ? count : null;
    }
    return out;
  }

  return {
    subscribe,
    sync,
    push,
    pull,
    diff,
    pendingCount,
    conflicts,
    acknowledgeConflicts,
    wipeCloud,
    cloudStats,
    reset: () => { resetSyncState(); state = loadSyncState(); emit(); },
    get state() { return state; },
    /**
     * Ámbito vigente ('user:…' o 'team:…'), recalculado del documento. Preguntarlo
     * es también un buen momento para enterarse de que ha cambiado: llama a
     * `ensureScope()`, así que deja el estado interno en el ámbito correcto.
     */
    get ownerKey() { return ensureScope(); },
    get status() { return status; },
    get lastError() { return lastError; },
    get lastResult() { return lastResult; },
    get running() { return running; },
    STATUS,
  };
}

/* ------------------------------------------------------------------ *
 * Migración desde el esquema antiguo (blob en user_data)
 * ------------------------------------------------------------------ */

/**
 * Lee el blob de la versión anterior (`user_data.data`) y lo convierte en
 * documento. Se usa una sola vez, para no perder el cuadrante de quien venía
 * de la app antigua.
 *
 * @returns {Promise<object|null>} documento migrado o null si no había nada
 */
export async function fetchLegacyBlob() {
  if (!isSignedIn()) return null;
  try {
    const userId = currentSession()?.userId;
    const response = await authFetch(
      `/rest/v1/${TABLES.legacyUserData}?select=data,updated_at&user_id=eq.${userId}&limit=1`,
    );
    if (!response.ok) return null;
    const rows = await response.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return { data: rows[0].data, updatedAt: rows[0].updated_at };
  } catch {
    return null;
  }
}

/** ¿Hay algo guardado en el formato antiguo? */
export async function hasLegacyBlob() {
  const blob = await fetchLegacyBlob();
  return !!blob?.data;
}

/**
 * Convierte el blob antiguo en filas del esquema nuevo y las sube.
 * @param {(legacy:object)=>object} migrate función que convierte blob → documento
 */
export async function importLegacyBlob(migrate) {
  const blob = await fetchLegacyBlob();
  if (!blob?.data) return { imported: false, reason: 'nothing' };
  const doc = migrate(blob.data);
  if (!doc) return { imported: false, reason: 'invalid' };
  return { imported: true, doc, updatedAt: blob.updatedAt };
}


