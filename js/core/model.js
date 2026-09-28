/**
 * HORUS — core/model.js
 * Entidades, valores por defecto, normalización y validación.
 *
 * Un documento HORUS (el "estado") tiene esta forma:
 * {
 *   schema: 4,
 *   meId: 'm_xxx',                  // miembro que representa a esta cuenta
 *   teamId: 'uuid' | null,          // ámbito: equipo, o null = cuadrante personal
 *   members:      Member[],
 *   shiftTypes:   ShiftType[],
 *   entries:      ShiftEntry[],     // todas las asignaciones de todos los miembros
 *   patterns:     Pattern[],        // plantillas de rotación reutilizables
 *   dayMeta:      { [dateKey]: DayMeta },
 *   settings:     Settings,
 *   updatedAt:    number,           // ms epoch, para resolución de conflictos
 *   rev:          number,           // contador monótono de revisiones locales
 * }
 *
 * Notas de diseño:
 *  - `entries` es plano (no anidado por miembro) porque hay que consultarlo
 *    por fecha constantemente: "¿quién trabaja el 12 de junio?".
 *  - Nada de `_savedAt` dentro del documento: los metadatos de sincronización
 *    viven en el documento raíz y no se mezclan con los datos.
 */

import { normalizeBlocks, normalizeBlock, todayKey, isValidKey, timeToMin, blockMinutes, formatBlocks } from './date.js';

export const SCHEMA_VERSION = 4;
export const OLD_DB_KEY = 'horario_app_v1';

/* ------------------------------------------------------------------ *
 * Fábricas de IDs
 * ------------------------------------------------------------------ */

let _seq = 0;
/** ID estable y ordenable: prefijo + tiempo base36 + contador. */
export function uid(prefix = 'id') {
  _seq = (_seq + 1) % 46656;
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${t}${_seq.toString(36).padStart(3, '0')}${r}`;
}

/** Clave aleatoria de invitación (equipo). */
export function inviteCode(len = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos
  let out = '';
  const bytes = new Uint8Array(len);
  (globalThis.crypto || {}).getRandomValues?.(bytes);
  for (let i = 0; i < len; i++) {
    const v = bytes[i] ?? Math.floor(Math.random() * 256);
    out += alphabet[v % alphabet.length];
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Paleta y tipos de turno por defecto
 * ------------------------------------------------------------------ */

export const PALETTE = [
  '#F2A33C', '#5B8DEF', '#2DD4BF', '#C77DFF', '#EF5B5B',
  '#7C9885', '#F06292', '#4DB6AC', '#FFB74D', '#9575CD',
  '#4FC3F7', '#AED581', '#FF8A65', '#7986CB', '#DCE775',
];

/** Códigos reservados con semántica especial (no son turnos trabajados). */
export const NON_WORKING_CODES = ['V', 'B', 'L', 'F', 'G'];

export function defaultShiftTypes() {
  const mk = (code, label, hex, blocks, kind = 'work', extra = {}) => ({
    id: `st_${code.toLowerCase()}`,
    code,
    label,
    short: label.slice(0, 4),
    hex,
    kind,               // 'work' | 'rest' | 'leave' | 'sick' | 'free'
    blocks: normalizeBlocks(blocks),
    paid: kind === 'work' || kind === 'leave',
    countsHours: kind === 'work',
    demand: 1,          // personas necesarias por defecto al usar este turno
    order: 0,
    archived: false,
    ...extra,
  });
  return [
    mk('M', 'Mañana', '#F2A33C', [{ start: '08:30', end: '17:00' }], 'work'),
    mk('T', 'Tarde', '#5B8DEF', [{ start: '16:15', end: '00:45' }], 'work'),
    mk('INT', 'Intermedio', '#2DD4BF', [{ start: '13:30', end: '22:00' }], 'work'),
    mk('N', 'Noche', '#7986CB', [{ start: '22:00', end: '06:00' }], 'work'),
    mk('P', 'Partido', '#C77DFF', [{ start: '08:30', end: '13:00' }, { start: '17:00', end: '21:00' }], 'work'),
    // Reunión: el cuadrante de la empresa la marca con `RE` (y a veces `R`). Sin
    // este turno en el catálogo, esos días se descartaban al importar. Se deja
    // SIN horario a propósito: el cuadrante no dice a qué hora es, y inventarlo
    // sería peor que dejarlo en blanco para que se ajuste en Ajustes.
    mk('RE', 'Reunión', '#A78BFA', [], 'work'),
    mk('V', 'Vacaciones', '#7C9885', [], 'leave'),
    mk('B', 'Baja', '#EF5B5B', [], 'sick'),
    mk('L', 'Libre', '#8A93A8', [], 'free'),
    mk('F', 'Festivo', '#FFB74D', [], 'rest'),
  ].map((s, i) => ({ ...s, order: i }));
}

/* ------------------------------------------------------------------ *
 * Miembros
 * ------------------------------------------------------------------ */

export function createMember(name, patch = {}) {
  const now = Date.now();
  return {
    id: uid('m'),
    name: String(name || 'Sin nombre').trim().slice(0, 40) || 'Sin nombre',
    initials: '',
    hex: PALETTE[Math.floor(Math.random() * PALETTE.length)],
    role: 'member',        // 'owner' | 'admin' | 'member' | 'viewer'
    teamId: null,
    weeklyHours: null,     // contrato: horas semanales objetivo
    active: true,
    colorSeed: Math.floor(Math.random() * 360),
    createdAt: now,
    // `updatedAt` es la marca que resuelve conflictos al sincronizar. Todas las
    // entidades la llevan: sin ella el motor no puede saber cuál es más nueva.
    updatedAt: now,
    ...patch,
  };
}

/** Iniciales a partir del nombre: "Ana María Ruiz" → "AM". */
export function initialsOf(name) {
  const cleaned = String(name ?? '').trim();
  if (!cleaned) return '?';
  const parts = cleaned
    .split(/\s+/)
    .filter((p) => p.length > 1 && !/^(de|del|la|las|los|y|e)$/i.test(p));
  if (!parts.length) return cleaned.slice(0, 1).toUpperCase() || '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/* ------------------------------------------------------------------ *
 * Entradas de turno
 * ------------------------------------------------------------------ */

/**
 * @param {object} patch
 * @param {string} patch.memberId
 * @param {string} patch.date     "YYYY-MM-DD" en que EMPIEZA el turno
 * @param {string} patch.typeId   id de ShiftType, o null = turno suelto
 * @param {object[]} [patch.blocks] bloques propios (si no, se usan los del tipo)
 */
export function createEntry(patch = {}) {
  const blocks = patch.blocks === undefined ? null : normalizeBlocks(patch.blocks);
  const now = Date.now();
  return {
    id: patch.id || uid('e'),
    memberId: patch.memberId || null,
    date: patch.date || todayKey(),
    typeId: patch.typeId ?? null,
    blocks,                      // null = heredar del catálogo
    dayType: patch.dayType || 'normal', // 'normal' | 'holiday' | 'event' | 'swap'
    notes: String(patch.notes || '').slice(0, 2000),
    demandOverride: patch.demandOverride ?? null,
    approved: patch.approved !== false,
    createdAt: patch.createdAt ?? now,
    updatedAt: patch.updatedAt ?? now,
    updatedBy: patch.updatedBy || null,
  };
}

/** Firma de un bloque de turno, para agrupar entradas idénticas. */
export function blocksSignature(blocks) {
  return normalizeBlocks(blocks).map((b) => `${b.start}-${b.end}`).join('|');
}

/* ------------------------------------------------------------------ *
 * Patrones de rotación
 * ------------------------------------------------------------------ */

/**
 * Un patrón es una secuencia de posiciones que se repite.
 * cycle: [{ typeId:string|null, offsetDays:number }] — normalmente 1 paso = 1 día
 * o `stepDays` días por paso (p. ej. 2 días por turno).
 */
export function createPattern(patch = {}) {
  return {
    id: patch.id || uid('pt'),
    name: String(patch.name || 'Rotación').slice(0, 60),
    cycle: Array.isArray(patch.cycle) ? patch.cycle : [],
    stepDays: patch.stepDays || 1,
    startDate: patch.startDate || todayKey(),
    description: patch.description || '',
    createdAt: Date.now(),
  };
}

/**
 * Expande un patrón: qué tipo de turno toca en la fecha `date`.
 * @returns {string|null} typeId o null
 */
export function patternTypeForDate(pattern, date) {
  if (!pattern || !pattern.cycle?.length) return null;
  const step = Math.max(1, pattern.stepDays || 1);
  const from = Date.parse(`${pattern.startDate}T00:00:00`);
  const to = Date.parse(`${date}T00:00:00`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const days = Math.round((to - from) / 86400000);
  const stepIndex = Math.floor(days / step);
  const n = pattern.cycle.length;
  const idx = ((stepIndex % n) + n) % n;
  return pattern.cycle[idx]?.typeId ?? null;
}

/* ------------------------------------------------------------------ *
 * Ajustes
 * ------------------------------------------------------------------ */

export function defaultSettings() {
  return {
    theme: 'dark',                    // 'dark' | 'light' | 'auto'
    weekStartsOn: 1,                  // 1 = lunes
    defaultView: 'month',             // 'month' | 'team' | 'list'
    showWeekNumbers: true,
    compactMode: false,
    notifications: {
      enabled: false,
      minutesBefore: 30,
      dailyBriefing: false,
      briefingHour: '20:00',
      coverageAlerts: false,
    },
    hours: { weeklyTarget: 40, monthlyTarget: null, overtimeAfter: 40 },
    coverage: { enabled: true, defaultDemand: 1, warnUnder: 1 },
    locale: 'es-ES',
    firstRun: true,
  };
}

/* ------------------------------------------------------------------ *
 * Documento por defecto y fusión
 * ------------------------------------------------------------------ */

export function emptyDocument() {
  const me = createMember('Yo', { id: uid('m'), role: 'owner', hex: PALETTE[0] });
  return {
    schema: SCHEMA_VERSION,
    id: uid('doc'),
    name: 'Mi calendario',
    // El ÁMBITO del documento: con equipo, todas sus filas viven en el
    // cuadrante compartido; con null, en el personal de la cuenta. El user_id
    // NO se guarda aquí a propósito: el ámbito personal se deduce de la sesión
    // (ver `ownerKeyFor` en sync.js), así que el mismo documento sirve para
    // cualquier cuenta y los documentos viejos (sin `teamId`) siguen siendo
    // personales sin migrar nada.
    teamId: null,
    meId: me.id,
    members: [me],
    shiftTypes: defaultShiftTypes(),
    entries: [],
    patterns: [],
    dayMeta: {},
    settings: defaultSettings(),
    updatedAt: Date.now(),
    rev: 1,
  };
}

/**
 * Crea el documento inicial de una persona con datos de onboarding.
 */
export function bootstrapDocument({ name, coworkers = [], notifications, minutesBefore, weeklyHours } = {}) {
  const doc = emptyDocument();
  const me = createMember(name || 'Yo', { role: 'owner', hex: PALETTE[0], weeklyHours: weeklyHours ?? null });
  doc.meId = me.id;
  doc.members = [me];
  (coworkers || []).forEach((n) => {
    const clean = String(n || '').trim();
    if (clean && !doc.members.some((m) => m.name.toLowerCase() === clean.toLowerCase())) {
      doc.members.push(createMember(clean));
    }
  });
  if (notifications !== undefined) doc.settings.notifications.enabled = !!notifications;
  if (minutesBefore !== undefined) doc.settings.notifications.minutesBefore = Number(minutesBefore) || 30;
  doc.settings.firstRun = false;
  return doc;
}

/* ------------------------------------------------------------------ *
 * Normalización defensiva (todo dato que entra pasa por aquí)
 * ------------------------------------------------------------------ */

const clampNum = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const isHex = (c) => /^#[0-9A-Fa-f]{6}$/.test(String(c || ''));
const safeHex = (c, fallback = '#8A93A8') => (isHex(c) ? String(c).toUpperCase() : fallback);
const str = (v, max = 200) => String(v ?? '').slice(0, max);

// El servidor exige que el ámbito cumpla '^(user|team):[0-9a-f-]{36}$', así que
// un id de equipo que no sea un uuid no puede ser ámbito de nada.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Id de equipo normalizado, o null si no lo es (ámbito personal).
 *
 * Por qué se valida aquí y no se deja pasar tal cual: el `owner_key` que sale
 * de aquí acaba en la URL del pull y en el cuerpo del push, y el servidor lo
 * rechaza con un error lejano (400 / violación de check) que no dice nada útil.
 * Ante un id con mala pinta se cae a PERSONAL, que es el ámbito en el que el
 * documento ya estaba: nunca se inventa una pertenencia a un equipo.
 */
export function normalizeTeamId(value) {
  const s = str(value, 40).trim().toLowerCase();
  return UUID_RE.test(s) ? s : null;
}

export function normalizeShiftType(raw, index = 0) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const code = str(s.code, 8).trim() || `T${index + 1}`;
  const kinds = ['work', 'rest', 'leave', 'sick', 'free'];
  const kind = kinds.includes(s.kind) ? s.kind : 'work';
  const now = Date.now();
  return {
    id: str(s.id, 60) || `st_${code.toLowerCase()}_${index}`,
    code,
    label: str(s.label, 40).trim() || code,
    short: str(s.short, 6).trim() || code.slice(0, 4),
    hex: safeHex(s.hex, PALETTE[index % PALETTE.length]),
    kind,
    blocks: normalizeBlocks(s.blocks),
    paid: s.paid === undefined ? (kind === 'work' || kind === 'leave') : !!s.paid,
    countsHours: s.countsHours === undefined ? kind === 'work' : !!s.countsHours,
    demand: clampNum(s.demand, 0, 99, 1),
    order: Number.isFinite(+s.order) ? +s.order : index,
    archived: !!s.archived,
    createdAt: Number.isFinite(+s.createdAt) ? +s.createdAt : now,
    updatedAt: Number.isFinite(+s.updatedAt) ? +s.updatedAt : (Number.isFinite(+s.createdAt) ? +s.createdAt : now),
  };
}

export function normalizeMember(raw, index = 0) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const name = str(m.name, 40).trim() || `Miembro ${index + 1}`;
  const roles = ['owner', 'admin', 'member', 'viewer'];
  const now = Date.now();
  const createdAt = Number.isFinite(+m.createdAt) ? +m.createdAt : now;
  return {
    id: str(m.id, 60) || `m_${index}`,
    name,
    initials: str(m.initials, 3).toUpperCase() || initialsOf(name),
    hex: safeHex(m.hex, PALETTE[index % PALETTE.length]),
    role: roles.includes(m.role) ? m.role : 'member',
    teamId: m.teamId ? str(m.teamId, 60) : null,
    weeklyHours: m.weeklyHours == null ? null : clampNum(m.weeklyHours, 0, 168, null),
    active: m.active !== false,
    colorSeed: Number.isFinite(+m.colorSeed) ? +m.colorSeed : Math.floor(Math.random() * 360),
    createdAt,
    updatedAt: Number.isFinite(+m.updatedAt) ? +m.updatedAt : createdAt,
  };
}

export function normalizeEntry(raw, memberIds, typeIds) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const date = isValidKey(e.date) ? e.date : todayKey();
  const memberId = memberIds.has(e.memberId) ? e.memberId : null;
  const typeId = e.typeId == null ? null : (typeIds.has(e.typeId) ? e.typeId : null);
  const dayTypes = ['normal', 'holiday', 'event', 'swap'];
  return {
    id: str(e.id, 60) || uid('e'),
    memberId,
    date,
    typeId,
    blocks: e.blocks ? normalizeBlocks(e.blocks) : null,
    dayType: dayTypes.includes(e.dayType) ? e.dayType : 'normal',
    notes: str(e.notes, 2000),
    demandOverride: e.demandOverride == null ? null : clampNum(e.demandOverride, 0, 99, null),
    approved: e.approved !== false,
    createdAt: Number.isFinite(+e.createdAt) ? +e.createdAt : Date.now(),
    updatedAt: Number.isFinite(+e.updatedAt) ? +e.updatedAt : Date.now(),
    updatedBy: e.updatedBy ? str(e.updatedBy, 60) : null,
  };
}

export function normalizePattern(raw, typeIds, index = 0) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const cycle = Array.isArray(p.cycle)
    ? p.cycle.slice(0, 64).map((c) => ({
      typeId: c && typeIds.has(c.typeId) ? c.typeId : null,
      label: c?.label ? str(c.label, 20) : undefined,
    }))
    : [];
  const now = Date.now();
  return {
    id: str(p.id, 60) || `pt_${index}`,
    name: str(p.name, 60).trim() || `Rotación ${index + 1}`,
    cycle,
    stepDays: clampNum(p.stepDays, 1, 30, 1),
    startDate: isValidKey(p.startDate) ? p.startDate : todayKey(),
    description: str(p.description, 200),
    createdAt: Number.isFinite(+p.createdAt) ? +p.createdAt : now,
    updatedAt: Number.isFinite(+p.updatedAt) ? +p.updatedAt : (Number.isFinite(+p.createdAt) ? +p.createdAt : now),
  };
}

export function normalizeDayMeta(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const dayTypes = ['normal', 'holiday', 'event'];
  return {
    dayType: dayTypes.includes(d.dayType) ? d.dayType : 'normal',
    label: str(d.label, 60),
    demandOverride: d.demandOverride == null ? null : clampNum(d.demandOverride, 0, 99, null),
    notes: str(d.notes, 500),
    // Marca de tiempo de la última edición del día (para resolver conflictos)
    updatedAt: Number.isFinite(+d.updatedAt) ? +d.updatedAt : 0,
    // Los festivos cargados automáticamente se marcan para poder quitarlos sin
    // tocar los que el usuario haya puesto a mano. Sin este campo, la marca se
    // perdía al normalizar y el botón de «quitar los importados» no encontraba
    // nada, además de no poder avisar de ello.
    imported: d.imported === true,
  };
}

export function normalizeSettings(raw) {
  const base = defaultSettings();
  const s = raw && typeof raw === 'object' ? raw : {};
  const n = s.notifications && typeof s.notifications === 'object' ? s.notifications : {};
  const h = s.hours && typeof s.hours === 'object' ? s.hours : {};
  const c = s.coverage && typeof s.coverage === 'object' ? s.coverage : {};
  const themes = ['dark', 'light', 'auto'];
  const views = ['month', 'team', 'list'];
  return {
    ...base,
    theme: themes.includes(s.theme) ? s.theme : base.theme,
    weekStartsOn: [0, 1, 6].includes(+s.weekStartsOn) ? +s.weekStartsOn : 1,
    defaultView: views.includes(s.defaultView) ? s.defaultView : base.defaultView,
    showWeekNumbers: s.showWeekNumbers !== false,
    compactMode: !!s.compactMode,
    locale: str(s.locale, 10) || base.locale,
    firstRun: s.firstRun === undefined ? base.firstRun : !!s.firstRun,
    notifications: {
      enabled: !!n.enabled,
      minutesBefore: clampNum(n.minutesBefore, 0, 720, 30),
      dailyBriefing: !!n.dailyBriefing,
      briefingHour: /^\d{2}:\d{2}$/.test(n.briefingHour) ? n.briefingHour : '20:00',
      coverageAlerts: !!n.coverageAlerts,
    },
    hours: {
      weeklyTarget: clampNum(h.weeklyTarget, 0, 168, 40),
      monthlyTarget: h.monthlyTarget == null ? null : clampNum(h.monthlyTarget, 0, 744, null),
      overtimeAfter: clampNum(h.overtimeAfter, 0, 168, 40),
    },
    coverage: {
      enabled: c.enabled !== false,
      defaultDemand: clampNum(c.defaultDemand, 0, 99, 1),
      warnUnder: clampNum(c.warnUnder, 0, 99, 1),
    },
  };
}

/**
 * Normaliza un documento completo. Nunca lanza: ante basura devuelve un
 * documento vacío válido.
 */
export function normalizeDocument(raw) {
  if (!raw || typeof raw !== 'object') return emptyDocument();

  const shiftTypes = (Array.isArray(raw.shiftTypes) ? raw.shiftTypes : [])
    .slice(0, 60)
    .map((s, i) => normalizeShiftType(s, i));
  if (!shiftTypes.length) shiftTypes.push(...defaultShiftTypes());

  const members = (Array.isArray(raw.members) ? raw.members : [])
    .slice(0, 200)
    .map((m, i) => normalizeMember(m, i));

  const typeIds = new Set(shiftTypes.map((s) => s.id));
  const memberIds = new Set(members.map((m) => m.id));

  const seen = new Set();
  const entries = [];
  for (const raw2 of (Array.isArray(raw.entries) ? raw.entries : []).slice(0, 20000)) {
    const e = normalizeEntry(raw2, memberIds, typeIds);
    if (!e.memberId) continue;                       // huérfana: se descarta
    const dedupe = `${e.memberId}|${e.date}|${e.typeId}|${e.id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    entries.push(e);
  }

  const dayMeta = {};
  if (raw.dayMeta && typeof raw.dayMeta === 'object') {
    for (const [k, v] of Object.entries(raw.dayMeta).slice(0, 2000)) {
      if (!isValidKey(k)) continue;
      const meta = normalizeDayMeta(v);
      if (meta.dayType !== 'normal' || meta.label || meta.notes || meta.demandOverride != null) {
        dayMeta[k] = meta;
      }
    }
  }

  const patterns = (Array.isArray(raw.patterns) ? raw.patterns : [])
    .slice(0, 40)
    .map((p, i) => normalizePattern(p, typeIds, i));

  const meId = memberIds.has(raw.meId) ? raw.meId : (members[0]?.id ?? null);

  const doc = {
    schema: SCHEMA_VERSION,
    id: str(raw.id, 60) || uid('doc'),
    name: str(raw.name, 60).trim() || 'Mi calendario',
    // Un documento sin `teamId` (todos los que hay hoy) es personal: no hace
    // falta migración ni versión de esquema nueva.
    teamId: normalizeTeamId(raw.teamId),
    meId,
    members,
    shiftTypes,
    entries,
    patterns,
    dayMeta,
    settings: normalizeSettings(raw.settings),
    updatedAt: Number.isFinite(+raw.updatedAt) ? +raw.updatedAt : Date.now(),
    rev: Number.isFinite(+raw.rev) ? +raw.rev : 1,
  };
  // La información de migración es solo informativa: se conserva tal cual.
  if (raw.migration && typeof raw.migration === 'object') doc.migration = raw.migration;
  return doc;
}

/* ------------------------------------------------------------------ *
 * Migración desde el formato antiguo (blob v1-v3)
 * ------------------------------------------------------------------ */

/**
 * Convierte el estado antiguo (state.days + state.shiftTypes como objeto +
 * profiles como lista de nombres) al documento nuevo.
 *
 * El estado antiguo NO tenía turnos por persona: había un único calendario y
 * "profiles" era solo una etiqueta. Se migra como: cada perfil antiguo se
 * vuelve un miembro, y todas las entradas existentes se asignan al miembro
 * activo (que es de quien realmente eran los datos).
 */
export function migrateFromLegacy(legacy) {
  const doc = emptyDocument();
  if (!legacy || typeof legacy !== 'object') return doc;

  // 1) Tipos de turno: el objeto { code: {label, hex, blocks} } pasa a array.
  const legacyTypes = legacy.shiftTypes && typeof legacy.shiftTypes === 'object' ? legacy.shiftTypes : {};
  const converted = [];
  let order = 0;
  for (const [key, t] of Object.entries(legacyTypes)) {
    if (!t || typeof t !== 'object') continue;
    const code = String(t.code || key);
    const kind = ['V', 'B'].includes(code) ? (code === 'V' ? 'leave' : 'sick')
      : (code === 'L' ? 'free' : (code === 'F' ? 'rest' : 'work'));
    converted.push(normalizeShiftType({
      id: `st_${code.toLowerCase()}`,
      code,
      label: t.label || code,
      hex: t.hex,
      kind,
      blocks: Array.isArray(t.blocks) ? t.blocks : [],
      demand: code === 'P' || code === 'RE' ? 0 : 1,
      order: order++,
    }, order));
  }
  // Rellena con los tipos por defecto que falten (por si el blob venía incompleto)
  const existingCodes = new Set(converted.map((s) => s.code));
  for (const d of defaultShiftTypes()) {
    if (!existingCodes.has(d.code)) converted.push(d);
  }
  doc.shiftTypes = order === 0 ? defaultShiftTypes() : converted;

  // 2) Miembros desde `profiles` (lista de nombres) o desde activeProfile.
  const names = Array.isArray(legacy.profiles) ? legacy.profiles.filter((p) => typeof p === 'string' && p.trim()) : [];
  const activeName = typeof legacy.activeProfile === 'string' ? legacy.activeProfile.trim() : '';
  if (activeName && !names.includes(activeName)) names.unshift(activeName);
  const uniqueNames = [...new Set(names)].slice(0, 100);

  if (uniqueNames.length) {
    doc.members = uniqueNames.map((n, i) => normalizeMember({ name: n, role: i === 0 ? 'owner' : 'member' }, i));
    // El miembro activo es el dueño de los datos antiguos
    const activeIndex = Math.max(0, uniqueNames.indexOf(activeName || uniqueNames[0]));
    doc.meId = doc.members[activeIndex].id;
  } else {
    const me = normalizeMember({ name: 'Yo', role: 'owner' }, 0);
    doc.members = [me];
    doc.meId = me.id;
  }

  // 3) Entradas desde `days`.
  //    El antiguo `sc` era un CÓDIGO ('M','T'...), aquí se resuelve a typeId.
  const byCode = new Map(doc.shiftTypes.map((s) => [s.code, s]));
  const byId = new Map(doc.shiftTypes.map((s) => [s.id, s]));
  const days = legacy.days && typeof legacy.days === 'object' ? legacy.days : {};
  const entries = [];
  let dayMetaCount = 0;
  let invalidBlocks = 0;
  let preservedOwnBlocks = 0;
  let skippedDays = 0;

  for (const [date, day] of Object.entries(days)) {
    if (!isValidKey(date) || !day || typeof day !== 'object') { skippedDays++; continue; }

    const codeKey = day.sc == null ? null : String(day.sc);
    const type = codeKey ? (byCode.get(codeKey) || byId.get(codeKey) || null) : null;
    const dt = day.dt || 'normal';

    // Bloques propios: el formato antiguo los separaba en `bo` (día puntual)
    // y `dtb` (excepción), con reglas distintas según el tipo.
    // normalizeBlocks descarta los bloques con horas inválidas o completas.
    let ownBlocks = null;
    if (Array.isArray(day.bo) && day.bo.length) ownBlocks = normalizeBlocks(day.bo);
    else if (Array.isArray(day.dtb) && day.dtb.length) ownBlocks = normalizeBlocks(day.dtb);
    if (ownBlocks && !ownBlocks.length) ownBlocks = null;
    const hadInvalidBlocks = (Array.isArray(day.bo) && day.bo.length && !day.bo.some((b) => normalizeBlock(b)))
      || (Array.isArray(day.dtb) && day.dtb.length && !day.dtb.some((b) => normalizeBlock(b)));

    // Un tipo del catálogo con bloques: si los bloques propios coinciden con el
    // catálogo no hace falta duplicarlos (blocks: null = heredar).
    if (ownBlocks && type) {
      const same = ownBlocks.length === type.blocks.length
        && ownBlocks.every((b, i) => b.start === type.blocks[i]?.start && b.end === type.blocks[i]?.end);
      if (same) ownBlocks = null;
    }

    // Un día marcado como feriado/evento siempre queda registrado, aunque no
    // tenga turno asignado: es información del calendario por sí misma.
    const isException = dt === 'feriado' || dt === 'evento';
    if (type || ownBlocks || day.notes || isException) {
      entries.push(normalizeEntry({
        memberId: doc.meId,
        date,
        typeId: type ? type.id : null,
        blocks: ownBlocks,
        dayType: dt === 'feriado' ? 'holiday' : (dt === 'evento' ? 'event' : 'normal'),
        notes: day.notes || '',
        createdAt: legacy._savedAt || Date.now(),
      }, new Set(doc.members.map((m) => m.id)), new Set(doc.shiftTypes.map((s) => s.id))));
    }
    if (hadInvalidBlocks) invalidBlocks++; else if (ownBlocks) preservedOwnBlocks++;

    if (dt === 'feriado' || dt === 'evento') {
      doc.dayMeta[date] = normalizeDayMeta({
        dayType: dt === 'feriado' ? 'holiday' : 'event',
        label: dt === 'feriado' ? 'Feriado' : 'Evento',
      });
      dayMetaCount++;
    }
  }
  doc.entries = entries;

  // 4) Ajustes
  const s = legacy.settings && typeof legacy.settings === 'object' ? legacy.settings : {};
  doc.settings.notifications.enabled = !!s.notificationsEnabled;
  doc.settings.notifications.minutesBefore = Number(s.alarmMinutesBefore) || 30;
  doc.settings.firstRun = !legacy.onboardingDone;

  doc.updatedAt = Number(legacy._savedAt) || Date.now();
  doc.migration = {
    from: 'legacy-v1',
    at: Date.now(),
    entries: entries.length,
    members: doc.members.length,
    dayMeta: dayMetaCount,
    preservedOwnBlocks,
    invalidBlocks,
    skippedDays,
  };
  // Las advertencias sobreviven a normalizeDocument (que no toca `migration`).
  const warnings = [];
  if (invalidBlocks) warnings.push(`${invalidBlocks} día(s) tenían horarios con horas inválidas: se usó el horario del catálogo.`);
  if (skippedDays) warnings.push(`${skippedDays} día(s) con fecha ilegible se descartaron.`);
  if (warnings.length) doc.migration.warnings = warnings;

  return normalizeDocument(doc);
}

/* ------------------------------------------------------------------ *
 * Índices y consultas del documento (puras)
 * ------------------------------------------------------------------ */

export function indexById(list) {
  return new Map((list || []).map((x) => [x.id, x]));
}

export function shiftTypeById(doc, id) {
  return (doc.shiftTypes || []).find((s) => s.id === id) || null;
}

export function shiftTypeByCode(doc, code) {
  return (doc.shiftTypes || []).find((s) => s.code === code) || null;
}

export function memberById(doc, id) {
  return (doc.members || []).find((m) => m.id === id) || null;
}

/** Bloques efectivos de una entrada (propios o heredados del catálogo). */
export function entryBlocks(doc, entry) {
  if (!entry) return [];
  if (Array.isArray(entry.blocks) && entry.blocks.length) return entry.blocks;
  // Si apunta a un tipo que ya no existe, la entrada queda sin horario.
  if (entry.typeId && !shiftTypeById(doc, entry.typeId)) return [];
  const type = shiftTypeById(doc, entry.typeId);
  return type ? type.blocks : [];
}

/** Tipo efectivo de una entrada (puede ser null para turnos sueltos). */
export function entryType(doc, entry) {
  return entry?.typeId ? shiftTypeById(doc, entry.typeId) : null;
}

/** Etiqueta mostrable de una entrada. */
export function entryLabel(doc, entry) {
  const type = entryType(doc, entry);
  if (type) return type.label;
  const blocks = entryBlocks(doc, entry);
  return blocks.length ? formatBlocks(blocks) : 'Turno';
}

/** ¿La entrada cuenta como trabajo efectivo (suma horas)? */
export function entryIsWork(doc, entry) {
  const type = entryType(doc, entry);
  if (type) return type.countsHours;
  return (entry.blocks?.length ?? 0) > 0;
}

/** ¿La entrada está en un día no laborable (festivo/evento)? */
export function entryIsException(doc, entry) {
  return (entry?.dayType && entry.dayType !== 'normal')
    || doc.dayMeta?.[entry?.date]?.dayType === 'holiday';
}

/** Minutos de una entrada (0 si es no laborable). */
export function entryMinutes(doc, entry) {
  if (!entryIsWork(doc, entry)) return 0;
  return normalizeBlocks(entryBlocks(doc, entry)).reduce((a, b) => a + blockMinutes(b), 0);
}

/**
 * Entradas de una fecha concreta, ordenadas por miembro y hora de inicio.
 * @param {object} doc
 * @param {string} date
 * @param {{memberId?:string, typeId?:string|null, includeInactive?:boolean}} [filter]
 */
export function entriesForDate(doc, date, filter = {}) {
  const out = [];
  for (const e of doc.entries) {
    if (e.date !== date) continue;
    if (filter.memberId && e.memberId !== filter.memberId) continue;
    if (filter.typeId !== undefined && filter.typeId !== null && e.typeId !== filter.typeId) continue;
    out.push(e);
  }
  return out.sort((a, b) => {
    const sa = timeToMin(entryBlocks(doc, a)[0]?.start || '99:99');
    const sb = timeToMin(entryBlocks(doc, b)[0]?.start || '99:99');
    if (sa !== sb) return sa - sb;
    return String(memberById(doc, a.memberId)?.name || '').localeCompare(String(memberById(doc, b.memberId)?.name || ''));
  });
}

/** Entradas de un miembro en un rango de fechas (ambos inclusive). */
export function entriesInRange(doc, memberId, fromKey, toKey) {
  return doc.entries.filter((e) => e.memberId === memberId && e.date >= fromKey && e.date <= toKey);
}

/** ¿La entrada empieza en `date` y sigue después de medianoche? */
export function entryIsOvernight(doc, entry) {
  return normalizeBlocks(entryBlocks(doc, entry)).some((b) => timeToMin(b.end) <= timeToMin(b.start));
}

/**
 * Entradas candidatas a estar ACTIVAS en un instante dado: las de hoy y las de
 * ayer (por si cruzan medianoche). El filtro fino lo hace `shiftRuntime`.
 */
export function entriesActiveAt(doc, when = new Date()) {
  const today = todayKey(when);
  const yesterday = (() => {
    const d = new Date(when);
    d.setDate(d.getDate() - 1);
    return todayKey(d);
  })();
  const out = [];
  for (const date of [yesterday, today]) {
    for (const e of doc.entries) {
      if (e.date !== date) continue;
      out.push(e);
    }
  }
  return out;
}

/** Duplicados exactos (mismo miembro, fecha y tipo) — para avisar, no para romper. */
export function findDuplicates(doc) {
  const seen = new Map();
  const dups = [];
  for (const e of doc.entries) {
    const k = `${e.memberId}|${e.date}`;
    if (seen.has(k)) dups.push([seen.get(k), e]);
    else seen.set(k, e);
  }
  return dups;
}
