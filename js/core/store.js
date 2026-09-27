/**
 * HORUS — core/store.js
 * Estado reactivo central. Todo cambio pasa por aquí.
 *
 * Reglas:
 *  1. Nada muta el documento "a mano" desde las vistas: siempre vía acciones.
 *  2. Toda mutación pasa por `commit()`, que normaliza, sube `updatedAt`/`rev`,
 *     empuja el historial y notifica a los suscriptores.
 *  3. Los suscriptores reciben (doc, meta) y leen lo que necesiten.
 *  4. Hay una capa selectora con memoización para no recalcular análisis
 *     costosos en cada repintado.
 */

import {
  emptyDocument, normalizeDocument, createMember, createEntry, createPattern,
  normalizeEntry, normalizeShiftType, normalizePattern, normalizeDayMeta,
  normalizeSettings, shiftTypeById, memberById, entryBlocks, entryType,
  uid, initialsOf, PALETTE, SCHEMA_VERSION,
} from './model.js';
import { todayKey, addDays, monthKeyOf, normalizeBlocks } from './date.js';

const HISTORY_LIMIT = 60;

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

export function createStore(initialDoc = emptyDocument()) {
  let doc = normalizeDocument(initialDoc);
  const listeners = new Set();
  const undoStack = [];
  const redoStack = [];
  let batchDepth = 0;
  let batchLabel = null;
  let batchFailed = false;
  let pendingNotify = false;
  let batchSnapshot = null;
  let lastGroupKey = null;
  let lastGroupAt = 0;
  const meta = { dirty: false, lastAction: null, localRev: 0 };

  /* ---------------- notificación ---------------- */

  function notify() {
    if (batchDepth > 0) { pendingNotify = true; return; }
    const snapshot = doc;
    for (const fn of [...listeners]) {
      try {
        fn(snapshot, meta);
      } catch (err) {
        console.error('[store] suscriptor con error:', err);
      }
    }
  }

  function subscribe(fn, { immediate = false } = {}) {
    listeners.add(fn);
    if (immediate) fn(doc, meta);
    return () => listeners.delete(fn);
  }

  /* ---------------- historial ---------------- */

  function pushHistory(prev, label) {
    undoStack.push({ doc: prev, label: label || 'cambio', at: Date.now() });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }
  function undoLabel() { return undoStack[undoStack.length - 1]?.label || null; }
  function redoLabel() { return redoStack[redoStack.length - 1]?.label || null; }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) return false;
    redoStack.push({ doc, label: entry.label, at: Date.now() });
    doc = normalizeDocument(entry.doc);
    meta.dirty = true;
    meta.lastAction = `deshacer: ${entry.label}`;
    notify();
    return true;
  }

  function redo() {
    const entry = redoStack.pop();
    if (!entry) return false;
    undoStack.push({ doc, label: entry.label, at: Date.now() });
    doc = normalizeDocument(entry.doc);
    meta.dirty = true;
    meta.lastAction = `rehacer: ${entry.label}`;
    notify();
    return true;
  }

  /* ---------------- commit ---------------- */

  /**
   * Aplica una mutación al documento.
   *
   * Nota de rendimiento: `commitBatch()` es el camino rápido para operaciones
   * masivas (miles de asignaciones). Ahí NO se clona el documento por cada
   * acción —el lote ya guardó el estado anterior para deshacer— y solo se
   * normaliza una vez al cerrar. Sin eso, pintar un año de turnos es O(n²).
   *
   * @param {(draft:object)=>void} recipe  recibe el documento a mutar
   * @param {{label?:string, silent?:boolean, group?:string, touch?:boolean}} [opts]
   * @returns {boolean} true si algo cambió
   */
  function apply(recipe, opts = {}) {
    const { label = 'cambio', silent = false, group = null, touch = true } = opts;

    // Agrupación: cambios consecutivos con la misma clave no generan entradas
    // de historial separadas (p. ej. teclear en un campo). Fuera de un lote,
    // CADA acción del usuario es un paso de "deshacer" independiente.
    const now = Date.now();
    const grouped = !!group && group === lastGroupKey && (now - lastGroupAt) < 900;
    const batching = batchDepth > 0;

    if (batching) return commitBatch(recipe, { label, group, touch });

    if (!grouped) pushHistory(doc, label);

    const draft = structuredClone ? structuredClone(doc) : JSON.parse(JSON.stringify(doc));
    try {
      recipe(draft);
    } catch (err) {
      console.error(`[store] la acción "${label}" falló:`, err);
      if (!grouped) undoStack.pop();
      return false;
    }

    if (touch) {
      draft.updatedAt = now;
      draft.rev = (Number(doc.rev) || 1) + 1;
    }

    const next = normalizeDocument(draft);
    if (documentFingerprint(next) === documentFingerprint(doc)) {
      // Nada cambió de verdad: no se ensucia el historial ni la revisión
      if (!grouped) undoStack.pop();
      return false;
    }

    doc = next;
    meta.dirty = true;
    meta.lastAction = label;
    meta.localRev++;
    lastGroupKey = group || null;
    lastGroupAt = now;

    if (!silent) notify();
    return true;
  }

  /** Camino rápido dentro de un lote: muta y marca; se normaliza al cerrar. */
  function commitBatch(recipe, { label, touch = true }) {
    try {
      recipe(doc);
    } catch (err) {
      console.error(`[store] la acción "${label}" falló dentro de un lote:`, err);
      batchFailed = true;
      return false;
    }
    meta.dirty = true;
    meta.lastAction = label;
    meta.localRev++;
    if (touch) doc.updatedAt = Date.now();
    lastGroupAt = Date.now();
    pendingNotify = true;
    return true;
  }

  /**
   * Agrupa varias mutaciones en una sola entrada de historial y una sola
   * notificación. Uso: asignar un turno a un mes entero.
   */
  function batch(label, fn) {
    if (batchDepth === 0) {
      // CLAVE: dentro de un lote se muta `doc` en el sitio, así que el estado
      // anterior para deshacer tiene que ser una copia real. Guardar la
      // referencia dejaría el historial apuntando al documento ya modificado.
      batchSnapshot = structuredClone ? structuredClone(doc) : JSON.parse(JSON.stringify(doc));
      batchLabel = label;
      batchFailed = false;
    }
    batchDepth++;
    try {
      fn();
    } finally {
      batchDepth--;
      if (batchDepth === 0) {
        const before = batchSnapshot;
        batchSnapshot = null;

        if (batchFailed) {
          // Alguna acción del lote falló: se vuelve al estado anterior para no
          // dejar el documento a medias.
          doc = before;
          batchFailed = false;
          pendingNotify = false;
          meta.lastAction = `${label || 'lote'} (cancelado)`;
          notify();
        } else {
          const next = normalizeDocument(doc);
          const changed = documentFingerprint(next) !== documentFingerprint(before);
          if (changed) {
            next.rev = (Number(before.rev) || 1) + 1;
            next.updatedAt = Date.now();
            doc = next;
            pushHistory(before, label || 'cambio agrupado');
            meta.dirty = true;
            meta.lastAction = label || 'cambio agrupado';
          }
          const shouldNotify = pendingNotify;
          pendingNotify = false;
          if (shouldNotify) notify();
        }
      }
    }
  }

  /** Reemplaza el documento entero (carga, sync, importación). */
  function replaceDocument(next, { label = 'reemplazar documento', history = false, silent = false } = {}) {
    const normalized = normalizeDocument(next);
    if (history) pushHistory(doc, label);
    doc = normalized;
    meta.dirty = true;
    meta.lastAction = label;
    meta.localRev++;
    if (!silent) notify();
    return true;
  }

  /** Marca el documento como sincronizado (limpia el flag de cambios). */
  function markSynced() {
    meta.dirty = false;
  }

  /* ------------------------------------------------------------------ *
   * Helpers internos de comparación
   * ------------------------------------------------------------------ */

  /**
   * Compara documentos sin serializar todo (que es caro con miles de
   * entradas). Casa escalares, recuentos y luego entrada por entrada.
   */
  function documentFingerprint(d) {
    const head = [
      d.meId, d.name, d.members.length, d.shiftTypes.length,
      d.entries.length, d.patterns.length, Object.keys(d.dayMeta).length,
      JSON.stringify(d.settings),
    ].join('|');
    const parts = [head];
    for (const m of d.members) parts.push(`m:${m.id}:${m.name}:${m.hex}:${m.active}:${m.weeklyHours}`);
    for (const s of d.shiftTypes) {
      parts.push(`s:${s.id}:${s.code}:${s.label}:${s.hex}:${s.demand}:${s.kind}:${JSON.stringify(s.blocks)}`);
    }
    for (const e of d.entries) {
      parts.push(`e:${e.id}:${e.memberId}:${e.date}:${e.typeId}:${e.dayType}:${e.notes}:${e.demandOverride}:${e.approved}:${JSON.stringify(e.blocks)}`);
    }
    for (const [k, v] of Object.entries(d.dayMeta)) parts.push(`d:${k}:${JSON.stringify(v)}`);
    for (const p of d.patterns) parts.push(`p:${p.id}:${p.name}:${p.startDate}:${p.stepDays}:${JSON.stringify(p.cycle)}`);
    return parts.join('|');
  }

  /* ------------------------------------------------------------------ *
   * Acciones
   * ------------------------------------------------------------------ */

  const actions = {
    /* ---------- miembros ---------- */

    addMember(data = {}) {
      const member = createMember(data.name || 'Nuevo miembro', data);
      apply((d) => { d.members.push(member); }, { label: `añadir ${member.name}` });
      return member;
    },

    addMembers(names = []) {
      const created = [];
      batch('añadir miembros', () => {
        for (const raw of names) {
          const name = String(raw || '').trim();
          if (!name) continue;
          if (doc.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) continue;
          const member = createMember(name);
          created.push(member);
          apply((d) => { d.members.push(member); }, { label: `añadir ${name}`, silent: true });
        }
      });
      return created;
    },

    updateMember(id, patch = {}) {
      const before = memberById(doc, id);
      if (!before) return false;
      const next = { ...before, ...patch };
      if (patch.name) next.initials = initialsOf(patch.name);
      return apply((d) => {
        const i = d.members.findIndex((m) => m.id === id);
        if (i >= 0) d.members[i] = next;
      }, { label: `editar ${before.name}`, group: `member:${id}` });
    },

    /**
     * Elimina un miembro. Sus turnos se pueden reasignar a otro miembro para
     * no perder el cuadrante.
     */
    removeMember(id, { reassignTo = null } = {}) {
      const member = memberById(doc, id);
      if (!member) return false;
      if (doc.members.length <= 1) return false;
      return apply((d) => {
        d.entries = d.entries
          .filter((e) => !(e.memberId === id && !reassignTo))
          .map((e) => (e.memberId === id && reassignTo ? { ...e, memberId: reassignTo } : e));
        d.members = d.members.filter((m) => m.id !== id);
        if (d.meId === id) d.meId = d.members[0]?.id ?? null;
        for (const pattern of d.patterns) {
          pattern.assigneeId = pattern.assigneeId === id ? null : pattern.assigneeId;
        }
      }, { label: `eliminar ${member.name}` });
    },

    setActiveMember(id) {
      const member = memberById(doc, id);
      if (!member) return false;
      return apply((d) => { d.meId = id; }, { label: `soy ${member.name}` });
    },

    reorderMembers(orderedIds = []) {
      return apply((d) => {
        const rank = new Map(orderedIds.map((id, i) => [id, i]));
        d.members.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
      }, { label: 'reordenar miembros' });
    },

    /* ---------- tipos de turno ---------- */

    addShiftType(data = {}) {
      const used = new Set(doc.shiftTypes.map((s) => s.hex));
      const free = PALETTE.find((c) => !used.has(c)) || PALETTE[doc.shiftTypes.length % PALETTE.length];
      const type = normalizeShiftType({
        id: uid('st'),
        code: 'X',
        label: 'Nuevo turno',
        hex: free,
        kind: 'work',
        blocks: [{ start: '09:00', end: '17:00' }],
        order: doc.shiftTypes.length,
        ...data,
      }, doc.shiftTypes.length);
      apply((d) => { d.shiftTypes.push(type); }, { label: `crear turno ${type.label}` });
      return type;
    },

    updateShiftType(id, patch = {}) {
      const before = shiftTypeById(doc, id);
      if (!before) return false;
      if (patch.blocks) patch = { ...patch, blocks: normalizeBlocks(patch.blocks) };
      return apply((d) => {
        const i = d.shiftTypes.findIndex((s) => s.id === id);
        if (i >= 0) d.shiftTypes[i] = { ...d.shiftTypes[i], ...patch };
      }, { label: `editar ${before.label}`, group: `type:${id}` });
    },

    /**
     * Elimina un tipo de turno. Las entradas que lo usaban quedan como turnos
     * sueltos con sus bloques congelados (no se pierde información).
     */
    removeShiftType(id) {
      const type = shiftTypeById(doc, id);
      if (!type) return false;
      return apply((d) => {
        d.entries = d.entries.map((e) => (e.typeId === id
          ? { ...e, typeId: null, blocks: e.blocks?.length ? e.blocks : (type.blocks.length ? type.blocks : null) }
          : e));
        d.patterns = d.patterns.map((p) => ({
          ...p,
          cycle: p.cycle.map((c) => (c.typeId === id ? { ...c, typeId: null } : c)),
        }));
        d.shiftTypes = d.shiftTypes.filter((s) => s.id !== id);
      }, { label: `eliminar turno ${type.label}` });
    },

    reorderShiftTypes(orderedIds = []) {
      return apply((d) => {
        const rank = new Map(orderedIds.map((id, i) => [id, i]));
        d.shiftTypes.forEach((s) => { s.order = rank.get(s.id) ?? s.order; });
        d.shiftTypes.sort((a, b) => a.order - b.order);
      }, { label: 'reordenar turnos' });
    },

    /* ---------- entradas ---------- */

    /**
     * Asigna un turno. Si ya existe una entrada de ese miembro en ese día con
     * el mismo tipo, la reemplaza (no duplica).
     */
    setEntry({ memberId, date, typeId, blocks = null, dayType, notes, demandOverride, approved, keepNotes = false }) {
      if (!memberById(doc, memberId)) return false;
      if (typeId && !shiftTypeById(doc, typeId)) typeId = null;
      const type = typeId ? shiftTypeById(doc, typeId) : null;
      const normalized = blocks ? normalizeBlocks(blocks) : null;
      const existing = doc.entries.find((e) => e.memberId === memberId && e.date === date);

      return apply((d) => {
        const i = d.entries.findIndex((e) => e.memberId === memberId && e.date === date);
        const base = i >= 0 ? d.entries[i] : createEntry({ memberId, date });
        const next = {
          ...base,
          typeId,
          blocks: normalized,
          dayType: dayType ?? base.dayType ?? 'normal',
          demandOverride: demandOverride === undefined ? base.demandOverride : demandOverride,
          approved: approved === undefined ? base.approved : approved,
          notes: notes === undefined ? (keepNotes ? base.notes : base.notes) : notes,
          updatedAt: Date.now(),
        };
        // Si no hay tipo ni bloques propios y no había nada más, borra la entrada
        const hasContent = next.typeId || (next.blocks && next.blocks.length) || next.notes;
        if (!hasContent) {
          if (i >= 0) d.entries.splice(i, 1);
          return;
        }
        if (i >= 0) d.entries[i] = next;
        else d.entries.push(next);
      }, { label: `asignar ${type?.label || 'turno'}`, group: `entry:${memberId}:${date}` });
    },

    /** Asigna el mismo turno a varios miembros en un solo paso. */
    setEntryMany({ memberIds = [], date, typeId, blocks = null, dayType }) {
      let count = 0;
      batch(`asignar a ${memberIds.length} personas`, () => {
        for (const memberId of memberIds) {
          const ok = actions.setEntry({ memberId, date, typeId, blocks, dayType });
          if (ok) count++;
        }
      });
      return count;
    },

    /** Aplica un turno a un rango de fechas (opcionalmente solo ciertos días). */
    setEntryRange({ memberId, from, to, typeId, weekdays = null, blocks = null, skipExisting = false }) {
      const dates = [];
      let cursor = from;
      let guard = 0;
      while (cursor <= to && guard++ < 800) {
        const dow = new Date(`${cursor}T00:00:00`).getDay();
        if (!weekdays || weekdays.includes(dow)) dates.push(cursor);
        cursor = addDays(cursor, 1);
      }
      let count = 0;
      batch(`asignar rango ${from} → ${to}`, () => {
        for (const date of dates) {
          if (skipExisting && doc.entries.some((e) => e.memberId === memberId && e.date === date)) continue;
          if (actions.setEntry({ memberId, date, typeId, blocks })) count++;
        }
      });
      return count;
    },

    /**
     * Copia el cuadrante de un rango a otro (útil para "copiar la semana
     * pasada"). `memberIds` vacío = todos.
     */
    copyRange({ from, to, targetFrom, memberIds = null, mode = 'replace' }) {
      const lengthDays = Math.round((Date.parse(`${to}T00:00:00`) - Date.parse(`${from}T00:00:00`)) / 86400000);
      if (!Number.isFinite(lengthDays) || lengthDays < 0) return 0;
      const source = doc.entries.filter((e) => e.date >= from && e.date <= to && (!memberIds || memberIds.includes(e.memberId)));
      let count = 0;
      batch('copiar rango', () => {
        for (const entry of source) {
          const offset = Math.round((Date.parse(`${entry.date}T00:00:00`) - Date.parse(`${from}T00:00:00`)) / 86400000);
          const targetDate = addDays(targetFrom, offset);
          if (mode === 'fill' && doc.entries.some((e) => e.memberId === entry.memberId && e.date === targetDate)) continue;
          if (mode === 'replace') {
            actions.removeEntries({ memberId: entry.memberId, date: targetDate });
          }
          if (actions.setEntry({
            memberId: entry.memberId,
            date: targetDate,
            typeId: entry.typeId,
            blocks: entry.blocks,
            dayType: entry.dayType,
            notes: entry.notes,
          })) count++;
        }
      });
      return count;
    },

    /** Copia el día de un miembro a otro(s). */
    copyDayToMembers({ date, fromMemberId, toMemberIds = [] }) {
      const source = doc.entries.find((e) => e.memberId === fromMemberId && e.date === date);
      if (!source) return 0;
      let count = 0;
      batch('copiar día a compañeros', () => {
        for (const memberId of toMemberIds) {
          if (memberId === fromMemberId) continue;
          if (actions.setEntry({
            memberId,
            date,
            typeId: source.typeId,
            blocks: source.blocks,
            dayType: source.dayType,
          })) count++;
        }
      });
      return count;
    },

    /** Pasa los turnos de un miembro a otro a partir de una fecha. */
    handover({ fromMemberId, toMemberId, from = null, to = null }) {
      const moved = doc.entries.filter((e) => e.memberId === fromMemberId
        && (!from || e.date >= from) && (!to || e.date <= to));
      if (!moved.length) return 0;
      return apply((d) => {
        for (const e of d.entries) {
          if (e.memberId === fromMemberId && (!from || e.date >= from) && (!to || e.date <= to)) {
            e.memberId = toMemberId;
            e.updatedAt = Date.now();
          }
        }
      }, { label: 'traspasar turnos' }) ? moved.length : 0;
    },

    updateEntry(id, patch = {}) {
      const entry = doc.entries.find((e) => e.id === id);
      if (!entry) return false;
      const next = { ...entry, ...patch, updatedAt: Date.now() };
      if (patch.blocks !== undefined) next.blocks = patch.blocks ? normalizeBlocks(patch.blocks) : null;
      return apply((d) => {
        const i = d.entries.findIndex((e) => e.id === id);
        if (i >= 0) d.entries[i] = next;
      }, { label: 'editar turno', group: `entry-edit:${id}` });
    },

    removeEntries({ memberId, date = null, from = null, to = null, typeId = undefined }) {
      const has = doc.entries.some((e) => e.memberId === memberId
        && (date === null || e.date === date)
        && (!from || e.date >= from)
        && (!to || e.date <= to)
        && (typeId === undefined || e.typeId === typeId));
      if (!has) return false;
      return apply((d) => {
        d.entries = d.entries.filter((e) => !(e.memberId === memberId
          && (date === null || e.date === date)
          && (!from || e.date >= from)
          && (!to || e.date <= to)
          && (typeId === undefined || e.typeId === typeId)));
      }, { label: 'borrar turno(s)' });
    },

    removeEntriesInRange({ memberIds = null, from, to }) {
      return apply((d) => {
        d.entries = d.entries.filter((e) => !(e.date >= from && e.date <= to && (!memberIds || memberIds.includes(e.memberId))));
      }, { label: 'vaciar rango' });
    },

    /** Mueve una entrada a otra fecha (arrastrar y soltar). */
    moveEntry(id, newDate, newMemberId = null) {
      const entry = doc.entries.find((e) => e.id === id);
      if (!entry) return false;
      const targetMember = newMemberId || entry.memberId;
      const clash = doc.entries.find((e) => e.id !== id && e.memberId === targetMember && e.date === newDate);
      return apply((d) => {
        const i = d.entries.findIndex((e) => e.id === id);
        if (i < 0) return;
        if (clash) {
          // Intercambio: el que estaba se va a la fecha original
          const j = d.entries.findIndex((e) => e.id === clash.id);
          if (j >= 0) d.entries[j] = { ...d.entries[j], memberId: entry.memberId, date: entry.date, updatedAt: Date.now() };
        }
        d.entries[i] = { ...d.entries[i], memberId: targetMember, date: newDate, updatedAt: Date.now() };
      }, { label: clash ? 'intercambiar turnos' : 'mover turno' });
    },

    /** Alterna el estado aprobado/pendiente de una entrada. */
    toggleApproved(id) {
      const entry = doc.entries.find((e) => e.id === id);
      if (!entry) return false;
      return apply((d) => {
        const i = d.entries.findIndex((e) => e.id === id);
        if (i >= 0) d.entries[i] = { ...d.entries[i], approved: !d.entries[i].approved, updatedAt: Date.now() };
      }, { label: entry.approved ? 'marcar como pendiente' : 'aprobar turno' });
    },

    /** Duplica la entrada de una fecha al día siguiente. */
    duplicateEntryToNextDay(id) {
      const entry = doc.entries.find((e) => e.id === id);
      if (!entry) return false;
      return actions.setEntry({
        memberId: entry.memberId,
        date: addDays(entry.date, 1),
        typeId: entry.typeId,
        blocks: entry.blocks,
        dayType: entry.dayType,
      });
    },

    /* ---------- patrones de rotación ---------- */

    addPattern(data = {}) {
      const pattern = createPattern({ name: `Rotación ${doc.patterns.length + 1}`, ...data });
      apply((d) => { d.patterns.push(pattern); }, { label: `crear ${pattern.name}` });
      return pattern;
    },

    updatePattern(id, patch = {}) {
      return apply((d) => {
        const i = d.patterns.findIndex((p) => p.id === id);
        if (i >= 0) d.patterns[i] = normalizePattern({ ...d.patterns[i], ...patch }, new Set(d.shiftTypes.map((s) => s.id)), i);
      }, { label: 'editar rotación', group: `pattern:${id}` });
    },

    removePattern(id) {
      return apply((d) => { d.patterns = d.patterns.filter((p) => p.id !== id); }, { label: 'eliminar rotación' });
    },

    /**
     * Aplica un patrón a un miembro durante N días.
     * @param {string} patternId
     * @param {string} memberId
     * @param {string} from
     * @param {string} to
     */
    applyPattern({ patternId, memberId, from, to, skipRest = false }) {
      const pattern = doc.patterns.find((p) => p.id === patternId);
      if (!pattern || !pattern.cycle.length) return 0;
      const step = Math.max(1, pattern.stepDays || 1);
      const fromMs = Date.parse(`${from}T00:00:00`);
      let count = 0;
      let cursor = from;
      let guard = 0;
      batch(`aplicar ${pattern.name}`, () => {
        while (cursor <= to && guard++ < 800) {
          const offset = Math.round((Date.parse(`${cursor}T00:00:00`) - parseStart(pattern.startDate)) / 86400000);
          const idx = ((Math.floor(offset / step) % pattern.cycle.length) + pattern.cycle.length) % pattern.cycle.length;
          const typeId = pattern.cycle[idx]?.typeId ?? null;
          if (!(skipRest && typeId === null)) {
            if (actions.setEntry({ memberId, date: cursor, typeId })) count++;
          }
          cursor = addDays(cursor, 1);
        }
      });
      return count;
    },

    /**
     * Rota los turnos del equipo: cada miembro recibe el cuadrante del
     * compañero que va `direction` posiciones por delante (1 = sentido
     * ascendente en la lista de miembros).
     */
    rotateTeam({ memberIds, from, to, direction = 1 }) {
      const ids = memberIds?.length ? memberIds : doc.members.filter((m) => m.active).map((m) => m.id);
      const n = ids.length;
      if (n < 2) return 0;
      const dir = direction >= 0 ? 1 : -1;
      const snapshot = doc.entries
        .filter((e) => e.date >= from && e.date <= to && ids.includes(e.memberId))
        .map((e) => ({ memberId: e.memberId, date: e.date, typeId: e.typeId, blocks: e.blocks, dayType: e.dayType, notes: e.notes }));
      const index = new Map(ids.map((id, i) => [id, i]));
      const target = (i) => ids[(((i + dir) % n) + n) % n];

      let count = 0;
      batch('rotar equipo', () => {
        // Primero limpia TODO el rango de los implicados: si no, al reasignar
        // se pisarían unas entradas con otras.
        for (const item of snapshot) {
          actions.removeEntries({ memberId: item.memberId, date: item.date });
        }
        for (const item of snapshot) {
          const i = index.get(item.memberId);
          if (i == null) continue;
          if (actions.setEntry({
            memberId: target(i),
            date: item.date,
            typeId: item.typeId,
            blocks: item.blocks,
            dayType: item.dayType,
            notes: item.notes,
          })) count++;
        }
      });
      return count;
    },

    /* ---------- metadatos de día ---------- */

    setDayMeta(date, patch = {}) {
      return apply((d) => {
        const current = d.dayMeta[date] || { dayType: 'normal', label: '', notes: '', demandOverride: null };
        const merged = normalizeDayMeta({ ...current, ...patch });
        if (merged.dayType === 'normal' && !merged.label && !merged.notes && merged.demandOverride == null) {
          delete d.dayMeta[date];
        } else {
          d.dayMeta[date] = merged;
        }
      }, { label: 'editar día', group: `day:${date}` });
    },

    setDayMetaRange({ from, to, dayType, label }) {
      let count = 0;
      batch('marcar días', () => {
        let cursor = from;
        let guard = 0;
        while (cursor <= to && guard++ < 800) {
          if (actions.setDayMeta(cursor, { dayType, label })) count++;
          cursor = addDays(cursor, 1);
        }
      });
      return count;
    },

    toggleHoliday(date) {
      const current = doc.dayMeta?.[date]?.dayType;
      return actions.setDayMeta(date, {
        dayType: current === 'holiday' ? 'normal' : 'holiday',
        label: current === 'holiday' ? '' : 'Festivo',
      });
    },

    /* ---------- ajustes ---------- */

    updateSettings(patch = {}) {
      return apply((d) => {
        d.settings = normalizeSettings(deepMerge(d.settings, patch));
      }, { label: 'cambiar ajustes', group: 'settings' });
    },

    /* ---------- documento ---------- */

    renameDocument(name) {
      return apply((d) => { d.name = String(name || '').slice(0, 60) || 'Mi calendario'; }, { label: 'renombrar calendario' });
    },

    importDocument(nextDoc, { merge = false } = {}) {
      if (!merge) {
        return replaceDocument(nextDoc, { label: 'importar datos', history: true });
      }
      return apply((d) => {
        const incoming = normalizeDocument(nextDoc);
        // Miembros: por nombre; entradas: por miembro+fecha+tipo
        const map = new Map();
        for (const m of incoming.members) {
          const existing = d.members.find((x) => x.name.toLowerCase() === m.name.toLowerCase());
          if (existing) map.set(m.id, existing.id);
          else { d.members.push(m); map.set(m.id, m.id); }
        }
        const types = new Map();
        for (const s of incoming.shiftTypes) {
          const existing = d.shiftTypes.find((x) => x.code.toLowerCase() === s.code.toLowerCase());
          if (existing) types.set(s.id, existing.id);
          else { d.shiftTypes.push(s); types.set(s.id, s.id); }
        }
        const seen = new Set(d.entries.map((e) => `${e.memberId}|${e.date}`));
        for (const e of incoming.entries) {
          const memberId = map.get(e.memberId);
          if (!memberId) continue;
          const k = `${memberId}|${e.date}`;
          if (seen.has(k)) continue;
          seen.add(k);
          d.entries.push({ ...e, id: uid('e'), memberId, typeId: e.typeId ? (types.get(e.typeId) ?? null) : null });
        }
        d.dayMeta = { ...incoming.dayMeta, ...d.dayMeta };
      }, { label: 'fusionar datos' });
    },

    /** Vacía el cuadrante pero conserva miembros y catálogo. */
    clearSchedule() {
      return apply((d) => { d.entries = []; }, { label: 'vaciar cuadrante' });
    },

    /** Reinicio total. */
    reset() {
      return replaceDocument(emptyDocument(), { label: 'reiniciar todo', history: true });
    },

    /* ---------- utilidades expuestas ---------- */

    _apply: apply,
    _batch: batch,
    _actions: null, // se rellena abajo
  };

  actions._actions = actions;

  function parseStart(key) {
    const t = Date.parse(`${key}T00:00:00`);
    return Number.isNaN(t) ? Date.now() : t;
  }

  return {
    get doc() { return doc; },
    get meta() { return meta; },
    get dirty() { return meta.dirty; },
    subscribe,
    notify,
    apply,
    batch,
    replaceDocument,
    markSynced,
    undo,
    redo,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    historySize: () => undoStack.length,
    actions,
  };
}

/* ------------------------------------------------------------------ *
 * Helpers internos
 * ------------------------------------------------------------------ */

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Selectores memoizados
 * ------------------------------------------------------------------ */

/**
 * Caché simple de un valor derivado, invalidada cuando cambia la revisión del
 * documento o los argumentos.
 */
export function memoSelector(fn) {
  let cache = new Map();
  return (doc, ...args) => {
    const key = `${doc.rev}|${JSON.stringify(args)}`;
    if (cache.has(key)) return cache.get(key);
    const value = fn(doc, ...args);
    // Poda: conserva solo las últimas 40 entradas
    if (cache.size > 40) cache = new Map([...cache].slice(-20));
    cache.set(key, value);
    return value;
  };
}

export const selectors = {
  memberById: (doc, id) => doc.members.find((m) => m.id === id) || null,
  shiftTypeById: (doc, id) => doc.shiftTypes.find((s) => s.id === id) || null,
  activeMember: (doc) => doc.members.find((m) => m.id === doc.meId) || doc.members[0] || null,
  activeMembers: (doc) => doc.members.filter((m) => m.active),
  entriesForMemberDay: (doc, memberId, date) => doc.entries.filter((e) => e.memberId === memberId && e.date === date),
  allDatesWithEntries: (doc) => {
    const set = new Set();
    for (const e of doc.entries) set.add(e.date);
    return set;
  },
  sortedShiftTypes: (doc) => [...doc.shiftTypes].sort((a, b) => a.order - b.order),
};
