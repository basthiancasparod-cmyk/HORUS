/**
 * HORUS — js/core/auth.js
 * Autenticación contra Supabase (GoTrue) usando fetch, sin dependencias.
 *
 * Decisiones:
 *  - La sesión se guarda en localStorage a través de `storage.js`.
 *  - `authFetch()` se encarga de refrescar el token de forma transparente y
 *    de reintentar una única vez ante un 401. Es la puerta de entrada para
 *    todo lo que necesite hablar con la API con permisos.
 *  - Los mensajes de error se traducen a español: los de GoTrue son crípticos.
 *  - Si no hay configuración de nube, todo esto queda inerte y la app sigue
 *    funcionando en local.
 *  - Y, si falta la URL o la clave, se falla ANTES de salir a la red: una
 *    petición sin `apikey` la corta la puerta de entrada de Supabase con un
 *    mensaje en inglés («No API key found in request») que no dice qué falta
 *    ni dónde se arregla. Ver `exigirConfiguracion()`.
 */

import { cloudConfig, authRedirectUrl } from '../config.js';
import { loadSession, saveSession, sessionExpired } from './storage.js';

/* ------------------------------------------------------------------ *
 * Errores
 * ------------------------------------------------------------------ */

export class AuthError extends Error {
  constructor(message, { code = null, status = 0, offline = false } = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
    this.offline = offline;
  }
}

const MESSAGES = {
  invalid_credentials: 'Email o contraseña incorrectos.',
  email_not_confirmed: 'Todavía no has confirmado tu correo. Revisa la bandeja de entrada (y la carpeta de spam).',
  email_exists: 'Ya existe una cuenta con ese email. Prueba a iniciar sesión.',
  user_already_exists: 'Ya existe una cuenta con ese email. Prueba a iniciar sesión.',
  weak_password: 'La contraseña es demasiado débil. Usa al menos 8 caracteres con letras y números.',
  over_request_rate_limit: 'Demasiados intentos seguidos. Espera un minuto y vuelve a probar.',
  over_email_send_rate_limit: 'Se han enviado demasiados correos. Espera unos minutos.',
  signup_disabled: 'El registro está desactivado en este servidor.',
  email_address_invalid: 'Ese email no parece válido.',
  validation_failed: 'Revisa los datos introducidos.',
  same_password: 'La contraseña nueva debe ser distinta de la actual.',
  session_not_found: 'La sesión ha caducado. Vuelve a iniciar sesión.',
  refresh_token_not_found: 'La sesión ha caducado. Vuelve a iniciar sesión.',
  user_not_found: 'No encontramos esa cuenta.',
  captcha_failed: 'La verificación anti-robots ha fallado. Inténtalo de nuevo.',
};

function translate(payload, status) {
  const code = payload?.error_code || payload?.code || null;
  if (code && MESSAGES[code]) return { message: MESSAGES[code], code };
  const raw = payload?.error_description || payload?.msg || payload?.message || payload?.error;
  if (typeof raw === 'string' && raw.trim()) {
    // Algunos mensajes de GoTrue ya llegan en inglés legible: se pasan tal cual
    // pero se limpian los prefijos técnicos.
    return { message: raw.replace(/^Error:\s*/i, '').trim(), code };
  }
  if (status === 429) return { message: MESSAGES.over_request_rate_limit, code: 'over_request_rate_limit' };
  if (status >= 500) return { message: 'El servidor de cuentas no responde. Inténtalo más tarde.', code: null };
  return { message: `No se pudo completar la operación (código ${status}).`, code };
}

/* ------------------------------------------------------------------ *
 * La configuración, ANTES de la red
 *
 * POR QUÉ ESTO EXISTE. Sin la cabecera `apikey` (o con la clave vacía) la
 * puerta de entrada de Supabase corta la petición ANTES de mirar tabla, fila o
 * política, y contesta en inglés: «No API key found in request». Ese mensaje no
 * dice qué falta ni dónde se arregla, y encima parece un problema de permisos
 * cuando no lo es. Comprobar aquí convierte ese muro en una instrucción.
 * ------------------------------------------------------------------ */

/** Dónde se arregla la configuración de la nube, dicho como lo ve el usuario. */
const AJUSTES_NUBE = 'Ajustes → Nube';

/**
 * Mensaje de cada falta, con la instrucción para resolverla. Se escribe entero
 * en cada caso (y no concatenando piezas) porque en español el género y el
 * número cambian según lo que falte.
 */
const SIN_CONFIGURACION = {
  url_y_clave: `Faltan la URL y la clave pública del proyecto de Supabase. Configúralas en ${AJUSTES_NUBE}.`,
  url: `Falta la URL del proyecto de Supabase. Configúrala en ${AJUSTES_NUBE}.`,
  clave: `Falta la clave pública (la «publishable» o la clásica «anon») del proyecto de Supabase. Configúrala en ${AJUSTES_NUBE}.`,
};

/**
 * Qué falta para poder hablar con Supabase: `null` si no falta nada, o
 * `'url_y_clave'`, `'url'` o `'clave'`.
 *
 * OJO: aquí se llega cuando `config.js` ha descartado lo guardado, así que una
 * clave que no llega a `baseHeaders()` es, para la app, una clave que falta. Eso
 * incluye a propósito la clave `sb_secret_…`: se rechaza al guardarla (ver
 * `clasificarClave()` en `config.js`) para que no acabe en el navegador.
 */
export function faltaConfiguracion() {
  const { url, anonKey } = cfg();
  if (!url && !anonKey) return 'url_y_clave';
  if (!url) return 'url';
  if (!anonKey) return 'clave';
  return null;
}

/**
 * Se llama ANTES de cualquier petición. Lanza un `AuthError` en español con lo
 * que falta y dónde se arregla, en vez de dejar salir una petición condenada a
 * un 401 que el usuario no puede interpretar.
 */
function exigirConfiguracion() {
  const falta = faltaConfiguracion();
  if (falta) throw new AuthError(SIN_CONFIGURACION[falta], { code: `sin_${falta}` });
}

/** El identificador del proyecto (el subdominio), para poder nombrarlo. */
function proyectoDeUrl(url) {
  return String(url || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

/**
 * Descripción de la clave pública SIN enseñarla nunca entera: los ocho
 * primeros caracteres bastan para reconocer cuál se pegó y para notar de un
 * vistazo una clave truncada o pegada a medias.
 *
 * `forma` distingue las DOS que emite Supabase hoy: `jwt` (la clásica «anon»,
 * la única que se puede reconocer por su prefijo `eyJ`) y `publica` (la nueva
 * `sb_publishable_…`). Importa para el diagnóstico: decir de una clave nueva
 * que «no es una clave de Supabase» mandaría al usuario a buscar un problema
 * que no existe. `pareceJwt` se mantiene por compatibilidad con lo que ya lo
 * usaba.
 */
export function describirClave(clave) {
  const texto = String(clave || '');
  if (!texto) return { hay: false, mascara: '', forma: 'ninguna', pareceJwt: false, longitud: 0 };
  const forma = texto.startsWith('sb_publishable_')
    ? 'publica'
    : (texto.startsWith('sb_secret_') ? 'secreta'
      : (texto.startsWith('eyJ') || texto.split('.').length === 3 ? 'jwt' : 'desconocida'));
  return {
    hay: true,
    mascara: `${texto.slice(0, 8)}…`,
    forma,
    pareceJwt: forma === 'jwt',
    longitud: texto.length,
  };
}

/**
 * Lo que se sabe de la nube AHORA, sin tocar la red. Lo usa Ajustes → Nube para
 * poder decir qué se está usando (URL, de dónde sale, qué forma tiene la clave)
 * antes incluso de comprobar nada.
 */
export function estadoDeLaNube() {
  const { url, anonKey, source } = cfg();
  const falta = faltaConfiguracion();
  return {
    url,
    proyecto: proyectoDeUrl(url),
    fuente: source,
    falta,
    mensaje: falta ? SIN_CONFIGURACION[falta] : null,
    clave: describirClave(anonKey),
  };
}

/* ------------------------------------------------------------------ *
 * Cliente HTTP
 * ------------------------------------------------------------------ */

let session = null;

function cfg() {
  const c = cloudConfig();
  return c;
}

export function isCloudConfigured() {
  return cfg().configured;
}

export function currentSession() {
  return session;
}

export function currentUser() {
  return session ? { id: session.userId, email: session.email } : null;
}

export function isSignedIn() {
  return !!session?.accessToken;
}

/**
 * Cabeceras base para cualquier llamada.
 *
 * La clave llega ya limpia y validada por `config.js` (`sanitizeKey()`): aquí
 * NO se recorta ni se normaliza, para que lo que viaja en `apikey` sea
 * exactamente lo que el usuario guardó. Si estuviera vacía, `request()` no
 * llega hasta aquí: falla antes, en español.
 */
function baseHeaders(extra = {}) {
  const { anonKey } = cfg();
  return {
    apikey: anonKey,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/**
 * Petición cruda a Supabase. No refresca token: eso es cosa de `authFetch`.
 *
 * Sin URL o sin clave NO se llama a `fetch`: se falla antes y en español. Una
 * petición sin `apikey` solo puede acabar en un 401 del servidor que el usuario
 * no puede interpretar (y que, además, se confunde con un problema de permisos
 * cuando lo que falta es la configuración).
 *
 * @param {string} path ruta relativa, p. ej. "/auth/v1/token?grant_type=password"
 * @param {{method?:string, body?:any, headers?:object, signal?:AbortSignal}} [opts]
 */
export async function request(path, opts = {}) {
  exigirConfiguracion();
  const { url } = cfg();
  const { method = 'GET', body, headers = {}, signal } = opts;
  let response;
  try {
    response = await fetch(`${url}${path}`, {
      method,
      headers: baseHeaders(headers),
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new AuthError('Sin conexión con el servidor. Se seguirá trabajando en local.', { offline: true, code: 'offline' });
  }
  return response;
}

async function parseJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 300) }; }
}

async function requestJson(path, opts) {
  const response = await request(path, opts);
  const data = await parseJson(response);
  if (!response.ok) {
    const { message, code } = translate(data, response.status);
    throw new AuthError(message, { code, status: response.status });
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * Sesión
 * ------------------------------------------------------------------ */

function buildSession(data) {
  if (!data?.access_token || !data?.user) return null;
  // El token dura 1 h por defecto; se resta un margen para refrescar antes.
  const expiresIn = Number(data.expires_in) || 3600;
  return {
    userId: String(data.user.id || ''),
    email: String(data.user.email || ''),
    accessToken: String(data.access_token),
    refreshToken: String(data.refresh_token || ''),
    expiresAt: Date.now() + Math.max(60, expiresIn - 180) * 1000,
  };
}

function persist(next) {
  session = next;
  saveSession(next);
  emit();
  return next;
}

/* ------------------------------------------------------------------ *
 * Suscriptores (la interfaz reacciona a inicio/cierre de sesión)
 * ------------------------------------------------------------------ */

const listeners = new Set();

export function onAuthChange(fn, { immediate = false } = {}) {
  listeners.add(fn);
  if (immediate) fn(session);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of [...listeners]) {
    try { fn(session); } catch (err) { console.error('[auth] suscriptor con error:', err); }
  }
}

/** Carga la sesión guardada. Devuelve la sesión o null. */
export function restoreSession() {
  session = loadSession();
  return session;
}

/** Une los datos de una respuesta de token a la sesión ya conocida. */
function mergeSession(existing, data) {
  const built = buildSession(data);
  if (!built) return existing;
  return {
    ...built,
    userId: built.userId || existing?.userId || '',
    email: built.email || existing?.email || '',
    refreshToken: built.refreshToken || existing?.refreshToken || '',
  };
}

/* ------------------------------------------------------------------ *
 * Operaciones
 * ------------------------------------------------------------------ */

function validateEmail(email) {
  const value = String(email || '').trim();
  if (!value) throw new AuthError('Escribe tu email.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) throw new AuthError('Ese email no parece válido.');
  return value;
}

function validatePassword(password, { strict = false } = {}) {
  const value = String(password || '');
  if (!value) throw new AuthError('Escribe tu contraseña.');
  if (value.length < 6) throw new AuthError('La contraseña debe tener al menos 6 caracteres.');
  if (strict && value.length < 8) throw new AuthError('Usa al menos 8 caracteres para la contraseña.');
  return value;
}

/**
 * Inicia sesión con email y contraseña.
 * @returns {Promise<{userId:string,email:string}>}
 */
export async function signIn(email, password) {
  const mail = validateEmail(email);
  const pass = validatePassword(password);
  const data = await requestJson('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: mail, password: pass },
  });
  const next = buildSession(data);
  if (!next) throw new AuthError('El servidor no devolvió una sesión válida.');
  persist(next);
  return { userId: next.userId, email: next.email };
}

/**
 * Crea una cuenta.
 * @returns {Promise<{needsConfirmation:boolean, userId:string|null, email:string}>}
 */
export async function signUp(email, password, { redirectTo = authRedirectUrl() } = {}) {
  const mail = validateEmail(email);
  const pass = validatePassword(password, { strict: true });
  const query = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
  const data = await requestJson(`/auth/v1/signup${query}`, {
    method: 'POST',
    body: { email: mail, password: pass },
  });

  // Con confirmación por correo, Supabase devuelve un usuario sin sesión.
  if (data?.access_token && data?.user) {
    const next = buildSession(data);
    if (next) persist(next);
    return { needsConfirmation: false, userId: next?.userId ?? null, email: mail };
  }
  const hasSession = !!data?.session?.access_token;
  if (hasSession) {
    const next = buildSession({ ...data.session, user: data.session.user || data.user });
    if (next) persist(next);
    return { needsConfirmation: false, userId: next?.userId ?? null, email: mail };
  }
  return { needsConfirmation: true, userId: data?.user?.id ?? data?.id ?? null, email: mail };
}

/**
 * Refresca el token. Devuelve true si lo consiguió.
 * Un refresh fallido por red NO cierra la sesión: solo un rechazo del servidor.
 */
export async function refreshSession() {
  if (!session?.refreshToken) return false;
  try {
    const response = await request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: session.refreshToken },
    });
    if (!response.ok) {
      const data = await parseJson(response);
      const { code } = translate(data, response.status);
      // El servidor ha rechazado el refresh token: la sesión ya no sirve.
      if (response.status === 400 || response.status === 401
        || ['refresh_token_not_found', 'session_not_found', 'invalid_grant'].includes(code)) {
        persist(null);
      }
      return false;
    }
    const data = await parseJson(response);
    persist(mergeSession(session, data));
    return true;
  } catch (err) {
    if (err instanceof AuthError && err.offline) return false; // se reintentará
    console.warn('[auth] no se pudo refrescar la sesión:', err?.message || err);
    return false;
  }
}

/** Cierra la sesión local y, si se puede, avisa al servidor. */
export async function signOut({ everywhere = false } = {}) {
  const token = session?.accessToken;
  persist(null);
  if (!token) return;
  try {
    await request('/auth/v1/logout?scope=' + (everywhere ? 'global' : 'local'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Da igual: la sesión local ya está cerrada y el token caducará solo.
  }
}

/** Envía el correo de recuperación. */
export async function sendPasswordReset(email, { redirectTo = authRedirectUrl() } = {}) {
  const mail = validateEmail(email);
  const query = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
  await requestJson(`/auth/v1/recover${query}`, { method: 'POST', body: { email: mail } });
  return true;
}

/**
 * Cambia la contraseña del usuario con sesión activa.
 * Requiere haber refrescado el token antes, que es lo que hace `authFetch`.
 */
export async function updatePassword(newPassword) {
  const pass = validatePassword(newPassword, { strict: true });
  if (!session) throw new AuthError('Necesitas iniciar sesión para cambiar la contraseña.');
  const response = await authFetch('/auth/v1/user', {
    method: 'PUT',
    body: { password: pass },
  });
  if (!response.ok) {
    const data = await parseJson(response);
    const { message, code } = translate(data, response.status);
    throw new AuthError(message, { code, status: response.status });
  }
  return true;
}

/** Datos del usuario actual según el servidor. */
export async function fetchUser() {
  const response = await authFetch('/auth/v1/user');
  if (!response.ok) return null;
  const data = await parseJson(response);
  return data ? { id: data.id, email: data.email, createdAt: data.created_at } : null;
}

/**
 * Petición autenticada con refresco automático.
 * Reintenta UNA vez tras refrescar si el servidor responde 401.
 *
 * @param {string} path
 * @param {{method?:string, body?:any, headers?:object, signal?:AbortSignal}} [opts]
 * @returns {Promise<Response>}
 */
export async function authFetch(path, opts = {}) {
  if (!session) throw new AuthError('No hay sesión iniciada.', { code: 'no_session' });

  // Refresco preventivo si el token está a punto de caducar
  if (sessionExpired(session, 120000)) {
    await refreshSession();
  }

  const doFetch = () => request(path, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${session?.accessToken || ''}` },
  });

  let response = await doFetch();
  if (response.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) response = await doFetch();
    else if (!session) throw new AuthError('La sesión ha caducado. Vuelve a iniciar sesión.', { code: 'session_expired', status: 401 });
  }
  return response;
}

/** Igual que authFetch pero parseando JSON y lanzando AuthError si falla. */
export async function authJson(path, opts = {}) {
  const response = await authFetch(path, opts);
  const data = await parseJson(response);
  if (!response.ok) {
    const { message, code } = translate(data, response.status);
    throw new AuthError(message, { code, status: response.status });
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * Enlaces mágicos y recuperación desde la URL
 * ------------------------------------------------------------------ */

/**
 * Extrae de `window.location.hash` los tokens que Supabase devuelve en los
 * flujos de confirmación de correo, invitación y recuperación, y los usa para
 * establecer la sesión. Devuelve el tipo de enlace detectado.
 *
 * @returns {{type:'recovery'|'signup'|'invite'|'magiclink'|'error'|null, error?:string}}
 */
export async function consumeAuthRedirect() {
  const hash = String(window.location.hash || '');
  if (!hash || hash.length < 2) return { type: null };
  const params = new URLSearchParams(hash.slice(1));
  const errorCode = params.get('error_code') || params.get('error');
  if (errorCode) {
    return { type: 'error', error: params.get('error_description') || MESSAGES[errorCode] || 'El enlace no es válido o ha caducado.' };
  }

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const type = params.get('type') || 'magiclink';

  if (!accessToken) return { type: null };

  // Se establece la sesión canónicamente pidiendo el token con el refresh_token.
  if (refreshToken) {
    session = {
      userId: '', email: '', accessToken, refreshToken,
      expiresAt: Date.now() + 3600 * 1000,
    };
    saveSession(session);
    const ok = await refreshSession();
    if (ok) {
      // Completa email/id consultando el usuario ya autenticado
      try {
        const user = await fetchUser();
        if (user) persist({ ...session, userId: user.id, email: user.email });
      } catch { /* la sesión ya está establecida */ }
    }
  }

  // Limpia el hash para que el token no quede en la barra de direcciones
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch { /* algunos navegadores antiguos lo rechazan */ }

  return { type: ['recovery', 'signup', 'invite', 'magiclink'].includes(type) ? type : 'magiclink' };
}

/** Códigos de error de reenvío de confirmación. */
export async function resendConfirmation(email) {
  const mail = validateEmail(email);
  await requestJson('/auth/v1/resend', {
    method: 'POST',
    body: { type: 'signup', email: mail },
  });
  return true;
}
