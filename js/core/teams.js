/**
 * HORUS — js/core/teams.js
 * La capa de datos de EQUIPOS: crear, entrar con un código, ver a los miembros,
 * cambiar roles y salir. Y, en el mismo sitio, LAS REGLAS DE ROL que decide la
 * interfaz.
 *
 * Por qué este módulo existe aparte de `sync.js`:
 *   `sync.js` sincroniza las SEIS tablas del cuadrante por ámbitos
 *   (`owner_key`). Las dos tablas de equipo no encajan en ese motor a propósito
 *   (lo explica su comentario): `horus_teams` se identifica por su `id` y no
 *   por un `owner_key` + id, y `horus_team_members` se identifica por
 *   `(team_id, user_id)` y no tiene una columna `id` por fila. Aquí viven sus
 *   consultas, que son pocas y muy concretas.
 *
 * Sin DOM: este módulo se puede importar y probar en Node, como el resto del
 * núcleo. Nada de `document` ni de `window`.
 *
 * Lo que NO hace y por qué:
 *   · No decide quién puede escribir DE VERDAD. Eso lo impone el servidor con
 *     RLS (`horus_can_read` / `horus_can_write`, migración 0002). Lo de aquí es
 *     para que la interfaz no ofrezca algo que el servidor va a rechazar.
 *   · No mueve filas de un ámbito a otro (el trigger del servidor lo prohíbe).
 *     Cambiar de ámbito es cosa de `actions.changeScope()` del store.
 *
 * Todos los errores salen en español y NUNCA se lanza una excepción hacia la
 * interfaz: cada función devuelve `{ ok: true, … }` o `{ ok: false, error }`.
 * Un fallo silencioso —o un `TypeError` a medio camino— deja al usuario sin
 * saber qué ha pasado, que es justo lo que aquí se evita.
 */

import { TABLES } from '../config.js';
import { authFetch, isSignedIn, currentSession, AuthError } from './auth.js';
import { normalizeTeamId } from './model.js';
import { storage } from './storage.js';

/* ==================================================================== *
 * Los roles: el ÚNICO sitio donde se decide qué puede tocar cada uno
 * ==================================================================== */

/** Los cuatro roles de `horus_team_members.role` (migración 0002). */
export const ROLES = ['owner', 'admin', 'member', 'viewer'];

/** Etiquetas humanas de cada rol. */
export const ROLE_LABEL = {
  owner: 'Propietario',
  admin: 'Administrador',
  member: 'Miembro',
  viewer: 'Solo lectura',
};

/** Orden para listar (primero los que más pueden). */
export const ROLE_ORDER = { owner: 0, admin: 1, member: 2, viewer: 3 };

/** ¿Es uno de los cuatro roles? */
export function esRolValido(rol) {
  return ROLES.includes(String(rol ?? ''));
}

/** Etiqueta del rol, con un valor por defecto prudente. */
export function etiquetaRol(rol) {
  return ROLE_LABEL[rol] || (esRolValido(rol) ? String(rol) : 'Miembro');
}

/**
 * ¿Este rol puede cambiar el CUADRANTE (turnos, personas, tipos, festivos)?
 *
 * `owner` y `admin` sí, y `member` TAMBIÉN HOY: la migración 0002 deja escribir
 * a `member` de forma interina, porque la tabla de peticiones (cambios de
 * turno, vacaciones, marcas propias) todavía no existe. Es un `TODO(fase-2)`
 * del propio SQL: cuando llegue, el `member` solo debería poder escribir SUS
 * peticiones y SUS marcas, y esta función tendrá que dejar de incluirle.
 *
 * Esta es la única verdad de la interfaz sobre «puedo editar el cuadrante»:
 * las vistas y los diálogos preguntan aquí, no cada uno por su cuenta.
 */
export function puedeEditarCuadrante(rol) {
  return rol === 'owner' || rol === 'admin' || rol === 'member';
}

/**
 * ¿Puede gestionar el equipo (ver miembros y su código, y las tareas de
 * administración)? El servidor deja escribir `horus_teams` y
 * `horus_team_members` SOLO al dueño, así que las acciones que de verdad
 * cambian algo van con `puedeCambiarRoles` / `puedeRotarCodigo`.
 */
export function puedeGestionarEquipo(rol) {
  return rol === 'owner' || rol === 'admin';
}

/** ¿Puede cambiar el rol de otros? El servidor solo se lo permite al dueño. */
export function puedeCambiarRoles(rol) {
  return rol === 'owner';
}

/** ¿Puede rotar el código de invitación? También solo el dueño. */
export function puedeRotarCodigo(rol) {
  return rol === 'owner';
}

/**
 * ¿Este rol escribe? El `viewer` nunca, y cualquier rol que no se reconozca
 * tampoco (ante la duda, no se ofrece la escritura).
 *
 * OJO con `null`: significa «no se sabe» (modo personal, o equipo del que
 * todavía no se ha comprobado el rol), y ahí devuelve `false` a propósito. Ver
 * la nota de `soloLectura()`.
 */
export function esSoloLectura(rol) {
  if (rol == null) return false;
  return !puedeEditarCuadrante(rol);
}

/** Texto para explicar por qué no se puede escribir. */
export function motivoSoloLectura() {
  return 'Tu rol en este equipo es «Solo lectura»: puedes consultar el cuadrante, '
    + 'pero no modificarlo. Los cambios los rechazaría el servidor de todos modos.';
}

/* ------------------------------------------------------------------ *
 * El rol del usuario en el equipo del documento
 *
 * El ámbito del documento (`doc.teamId`) dice EN QUÉ equipo está el cuadrante,
 * pero no QUÉ puede hacer quien lo mira: eso vive en `horus_team_members` y
 * hay que preguntarlo al servidor. Para que la interfaz pueda decidirlo de
 * forma SÍNCRONA (pintar es síncrono) el rol se guarda en el dispositivo.
 *
 * Por qué se guarda en `localStorage` y no solo en memoria: para que un
 * recargar la página sin conexión no pierda el «solo lectura» y la app vuelva
 * a ofrecer botones que van a fallar. El servidor sigue siendo quien manda: si
 * el rol ha cambiado, la siguiente comprobación lo corrige.
 * ------------------------------------------------------------------ */

/** Clave del almacenamiento donde viven los roles conocidos. */
export const KEY_ROLES = 'horus.teams.roles';

function leerRoles() {
  try {
    const raw = storage.get(KEY_ROLES);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function escribirRoles(mapa) {
  try { storage.set(KEY_ROLES, JSON.stringify(mapa)); } catch { /* sin sitio: se sigue sin caché */ }
  return mapa;
}

/** Lo que se sabe del equipo `teamId`: `{ rol, miembro, comprobadoEn }` o null. */
export function cacheEquipo(teamId) {
  const id = String(teamId || '');
  if (!id) return null;
  const entry = leerRoles()[id];
  return entry && typeof entry === 'object' ? entry : null;
}

/**
 * Rol conocido del usuario en ese equipo, o `null` si no se ha comprobado
 * todavía (o si no es miembro).
 */
export function rolConocido(teamId) {
  const entry = cacheEquipo(teamId);
  return esRolValido(entry?.rol) ? entry.rol : null;
}

/** Se ha comprobado que NO pertenece al equipo (o ya no). */
export function esAjenoConocido(teamId) {
  const entry = cacheEquipo(teamId);
  return !!entry && entry.miembro === false;
}

/** Guarda lo que se sabe del rol (lo usan las consultas y las pruebas). */
export function guardarRolConocido(teamId, rol, { miembro = true } = {}) {
  const id = normalizeTeamId(teamId) || String(teamId || '');
  if (!id) return null;
  const mapa = leerRoles();
  mapa[id] = {
    rol: esRolValido(rol) ? rol : null,
    miembro: !!miembro,
    comprobadoEn: Date.now(),
  };
  escribirRoles(mapa);
  return mapa[id];
}

/** Olvida el equipo (al salir de él, o si ya no existe). */
export function olvidarRolConocido(teamId) {
  const id = String(teamId || '');
  if (!id) return;
  const mapa = leerRoles();
  if (id in mapa) {
    delete mapa[id];
    escribirRoles(mapa);
  }
}

/**
 * ¿El documento está en SOLO LECTURA por el rol del usuario?
 *
 * En modo personal (o sin equipo) nunca lo está. En un equipo:
 *   · rol conocido y sin permiso de escritura (`viewer`, o uno desconocido) → sí;
 *   · rol conocido con permiso (`owner`, `admin`, `member`) → no;
 *   · rol DESCONOCIDO → NO se bloquea. Es una decisión consciente: la app es
 *     local-first y un dueño o un admin sin conexión (o con el rol aún sin
 *     comprobar en este dispositivo) tiene que poder seguir trabajando; el
 *     servidor sigue siendo el que impone la seguridad. Lo que sí se hace es
 *     avisar en Ajustes → Equipo de que no se ha podido comprobar el rol.
 */
export function soloLectura(doc) {
  const teamId = doc?.teamId || null;
  if (!teamId) return false;
  if (esAjenoConocido(teamId)) return true;
  return esSoloLectura(rolConocido(teamId));
}

/* ==================================================================== *
 * Cliente HTTP
 * ==================================================================== */

const SIN_SESION = 'Necesitas iniciar sesión para usar los equipos.';

/** ¿Hay sesión con usuario? Devuelve el uuid o null. */
function usuarioActual() {
  const sesion = currentSession();
  if (!isSignedIn() || !sesion?.userId) return null;
  return sesion.userId;
}

/**
 * La ÚNICA puerta de salida de este módulo hacia Supabase.
 *
 * POR QUÉ EXISTE — el fallo que evita, reportado desde la aplicación real:
 * las cabeceras que Supabase exige (`apikey` SIEMPRE, y `Authorization: Bearer
 * <token>` cuando hay sesión) no las pone este módulo. Las construye `auth.js`
 * en `baseHeaders()` y las añade `authFetch()` a cada petición, exactamente
 * igual que para `sync.js`. Y sin `apikey` no hay petición: el servidor la
 * corta antes de mirar nada con «No API key found in request», así que
 * `auth.uid()` nunca se rellena y RLS contesta un «new row violates row-level
 * security policy» que no tiene nada que ver con la causa real. Por eso TODO lo
 * que sale de aquí pasa por esta única función: quien añada una consulta nueva
 * la escribe detrás de esta puerta y hereda las cabeceras sin poder olvidarse
 * de ninguna, en vez de repetirlas a mano en cada sitio (una copia repetida es
 * una copia que se queda atrás).
 */
async function api(ruta, opciones = {}) {
  return authFetch(`/rest/v1/${ruta}`, opciones);
}

/** Mensaje de error de una respuesta de Supabase/PostgREST. */
async function leerError(response) {
  try {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text);
      const mensaje = parsed?.message || parsed?.hint || parsed?.details || parsed?.error_description;
      if (typeof mensaje === 'string' && mensaje.trim()) return limpiarMensaje(mensaje);
      return text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

/** Quita el prefijo «HORUS: » con el que hablan las funciones de la migración. */
function limpiarMensaje(mensaje) {
  return String(mensaje).replace(/^HORUS:\s*/i, '').trim();
}

/** Traduce un fallo de red o de sesión a un `{ ok:false }` en español. */
function falloDeRed(err) {
  if (err instanceof AuthError) {
    if (err.offline) {
      return { ok: false, error: 'Sin conexión con el servidor. Inténtalo cuando vuelvas a estar en línea.', code: 'offline' };
    }
    return { ok: false, error: err.message || SIN_SESION, code: err.code || 'auth' };
  }
  return { ok: false, error: `No se pudo hablar con el servidor: ${err?.message || 'error desconocido'}`, code: 'red' };
}

/** GET de una tabla: `{ ok, filas }` o `{ ok:false, error }`. */
async function pedir(path) {
  let response;
  try {
    response = await api(path);
  } catch (err) {
    return falloDeRed(err);
  }
  if (!response.ok) return { ok: false, error: await leerError(response), status: response.status };
  const filas = await response.json().catch(() => null);
  if (!Array.isArray(filas)) {
    return { ok: false, error: 'El servidor devolvió una respuesta que no se entiende.' };
  }
  return { ok: true, filas };
}

/** Primera fila de una consulta (o null). */
async function pedirUna(path) {
  const res = await pedir(path);
  if (!res.ok) return res;
  return { ok: true, fila: res.filas[0] || null };
}

/** POST de una fila con `return=representation`: `{ ok, fila }`. */
async function insertar(tabla, fila) {
  let response;
  try {
    response = await api(tabla, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: [fila],
    });
  } catch (err) {
    return falloDeRed(err);
  }
  if (!response.ok) {
    return { ok: false, error: await leerError(response), status: response.status };
  }
  const data = await response.json().catch(() => null);
  const creada = Array.isArray(data) ? data[0] : data;
  return { ok: true, fila: creada || null };
}

/** PATCH de las filas que cumplan el filtro: `{ ok }`. */
async function actualizar(tabla, filtro, cambios) {
  let response;
  try {
    response = await api(`${tabla}?${filtro}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: cambios,
    });
  } catch (err) {
    return falloDeRed(err);
  }
  if (!response.ok) return { ok: false, error: await leerError(response), status: response.status };
  return { ok: true };
}

/** DELETE de las filas que cumplan el filtro: `{ ok }`. */
async function borrar(tabla, filtro) {
  let response;
  try {
    response = await api(`${tabla}?${filtro}`, { method: 'DELETE' });
  } catch (err) {
    return falloDeRed(err);
  }
  if (!response.ok) return { ok: false, error: await leerError(response), status: response.status };
  return { ok: true };
}

/** Filtro `eq` con el valor escapado. */
function eq(valor) {
  return encodeURIComponent(String(valor));
}

/* ------------------------------------------------------------------ *
 * Código de invitación
 * ------------------------------------------------------------------ */

/**
 * Alfabeto sin caracteres que se confunden al dictarlos por teléfono o
 * copiarlos a mano: fuera la O y el 0, la I, la L y el 1.
 */
const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Bytes aleatorios (Web Crypto si está; si no, `Math.random` basta aquí). */
function bytesAleatorios(n) {
  const out = new Uint8Array(n);
  const cripto = globalThis.crypto;
  if (cripto && typeof cripto.getRandomValues === 'function') {
    cripto.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** Código de invitación nuevo. No es un secreto criptográfico: es un carné. */
export function generarCodigoInvitacion(largo = 8) {
  const bytes = bytesAleatorios(largo);
  let out = '';
  for (let i = 0; i < largo; i++) out += ALFABETO_CODIGO[bytes[i] % ALFABETO_CODIGO.length];
  return out;
}

/** La fila de `horus_teams` en la forma que usa la interfaz. */
function equipoDesdeFila(fila) {
  if (!fila) return null;
  return {
    id: fila.id,
    nombre: fila.name || 'Equipo sin nombre',
    codigo: fila.invite_code || '',
    ownerId: fila.owner_id || null,
  };
}

/* ==================================================================== *
 * Crear un equipo
 * ==================================================================== */

/**
 * Crea un equipo y deja al creador como `owner`.
 *
 * El id y el ámbito los pone el servidor: `id` con su `default
 * gen_random_uuid()` y `owner_key` con el trigger `horus_owner_key_guard`, que
 * lo rellena a `'team:' || id`. El cliente no inventa identificadores.
 *
 * El código de invitación SÍ lo genera el cliente (la tabla no tiene default) y
 * es `unique`: si el servidor lo rechaza por repetido se prueba otra vez con
 * otro código.
 *
 * @param {string} name nombre visible del equipo
 * @returns {Promise<{ok:boolean, equipo?:object, error?:string}>}
 */
export async function createTeam(name) {
  const nombre = String(name ?? '').trim().slice(0, 60);
  if (!nombre) return { ok: false, error: 'Ponle un nombre al equipo.' };
  const userId = usuarioActual();
  if (!userId) return { ok: false, error: SIN_SESION, code: 'no_session' };

  let ultimoError = null;
  for (let intento = 0; intento < 3; intento++) {
    const creado = await insertar(TABLES.teams, {
      name: nombre,
      invite_code: generarCodigoInvitacion(),
      owner_id: userId,
    });

    if (!creado.ok) {
      // Choque de código de invitación (la tabla lo tiene `unique`): otro intento.
      if (creado.status === 409 || /duplicate key|already exists|unique/i.test(creado.error)) {
        ultimoError = creado.error;
        continue;
      }
      return { ok: false, error: `No se pudo crear el equipo: ${creado.error}`, status: creado.status };
    }

    const equipo = equipoDesdeFila(creado.fila);
    if (!equipo?.id) {
      ultimoError = 'El servidor no devolvió el equipo creado.';
      continue;
    }

    // La pertenencia como `owner`. Si esto falla, el equipo se quedaría sin
    // nadie dentro (ni siquiera su dueño podría verlo en «mis equipos»), así
    // que se deshace el alta en vez de dejar basura.
    const alta = await insertar(TABLES.teamMembers, {
      team_id: equipo.id,
      user_id: userId,
      role: 'owner',
      owner_key: `team:${equipo.id}`,
    });
    if (!alta.ok) {
      await borrarEquipo(equipo.id);
      return {
        ok: false,
        error: 'Se creó el equipo pero no se pudo dar de alta tu pertenencia, así que no se ha guardado nada. '
          + `Detalle: ${alta.error}`,
      };
    }

    guardarRolConocido(equipo.id, 'owner', { miembro: true });
    return { ok: true, equipo, rol: 'owner' };
  }

  return { ok: false, error: `No se pudo crear el equipo: ${ultimoError || 'no se pudo generar un código de invitación libre.'}` };
}

/** Borrado del equipo recién creado cuando el alta de la pertenencia falla. */
async function borrarEquipo(teamId) {
  const id = normalizeTeamId(teamId);
  if (!id) return;
  try { await borrar(TABLES.teams, `id=eq.${eq(id)}`); } catch { /* se intenta y ya está */ }
}

/* ==================================================================== *
 * Entrar con un código
 * ==================================================================== */

/**
 * Entra en el equipo del código de invitación y devuelve su id.
 *
 * Lo hace la función `horus_join_team(p_code)` del servidor (SECURITY DEFINER):
 * valida el código, da de alta —o revive— la pertenencia como `member` y
 * devuelve el uuid del equipo. Por esa vía es IMPOSIBLE ponerse `owner` o
 * `admin`; los roles altos los da el dueño del equipo.
 *
 * @param {string} code código de invitación
 * @returns {Promise<{ok:boolean, equipo?:object, rol?:string, error?:string}>}
 */
export async function joinTeam(code) {
  const texto = String(code ?? '').trim();
  if (!texto) return { ok: false, error: 'Escribe el código de invitación.' };
  if (!usuarioActual()) return { ok: false, error: SIN_SESION, code: 'no_session' };

  let response;
  try {
    response = await api('rpc/horus_join_team', {
      method: 'POST',
      body: { p_code: texto },
    });
  } catch (err) {
    return falloDeRed(err);
  }

  if (!response.ok) {
    const detalle = await leerError(response);
    if (response.status === 404 || /could not find the function|PGRST202|does not exist/i.test(detalle)) {
      return {
        ok: false,
        error: 'Este servidor todavía no sabe entrar en equipos por código: falta aplicar la migración 0002 en Supabase.',
        code: 'sin_funcion',
      };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: SIN_SESION, code: 'no_session' };
    }
    // El mensaje de la función ya viene en español y sin decir si el equipo
    // existe o está borrado (a propósito, para no poder adivinar códigos).
    return { ok: false, error: detalle || 'No se pudo entrar en el equipo.', status: response.status };
  }

  const data = await response.json().catch(() => null);
  const bruto = Array.isArray(data) ? data[0] : data;
  const teamId = typeof bruto === 'string' ? bruto : (bruto?.horus_join_team || bruto?.id || null);
  if (!normalizeTeamId(teamId)) {
    return { ok: false, error: 'El servidor no devolvió un equipo válido. Inténtalo otra vez.' };
  }

  // El rol REAL: quien ya era admin u owner lo conserva (la función no lo toca),
  // y quien entra nuevo queda como `member`.
  const situacion = await miSituacionEnEquipo(teamId);
  const equipo = situacion.ok
    ? situacion.equipo
    : { id: teamId, nombre: 'el equipo', codigo: '', ownerId: null };
  const rol = situacion.ok ? situacion.rol : 'member';
  guardarRolConocido(teamId, rol, { miembro: true });
  return { ok: true, equipo, rol };
}

/* ==================================================================== *
 * Consultas
 * ==================================================================== */

/**
 * Situación del usuario en un equipo: sus datos, su rol y si es el dueño.
 *
 * Se pregunta primero por la PERTENENCIA (cada uno puede leer su propia fila
 * aunque ya esté de baja) y después por el equipo. Importa el orden: si la
 * lectura del equipo vuelve vacía, no se puede saber si es que no existe o si
 * es que no se tiene permiso, y el mensaje tiene que cubrir las dos cosas sin
 * mentir.
 *
 * @returns {Promise<{ok:boolean, equipo?:object, rol?:string|null,
 *                    esMiembro?:boolean, soyDueno?:boolean, error?:string}>}
 */
export async function miSituacionEnEquipo(teamId) {
  const id = normalizeTeamId(teamId);
  if (!id) return { ok: false, error: 'Ese equipo no tiene un identificador válido.' };
  const userId = usuarioActual();
  if (!userId) return { ok: false, error: SIN_SESION, code: 'no_session' };

  const pertenencia = await pedirUna(
    `${TABLES.teamMembers}?team_id=eq.${eq(id)}&user_id=eq.${eq(userId)}&select=role,deleted`,
  );
  if (!pertenencia.ok) return pertenencia;

  const equipoRes = await pedirUna(
    `${TABLES.teams}?id=eq.${eq(id)}&select=id,name,invite_code,owner_id,deleted`,
  );
  if (!equipoRes.ok) return equipoRes;

  const filaEquipo = equipoRes.fila;
  const soyDueno = !!filaEquipo && filaEquipo.owner_id === userId && filaEquipo.deleted !== true;
  const esMiembro = !!pertenencia.fila && pertenencia.fila.deleted !== true;

  if (!filaEquipo || filaEquipo.deleted === true) {
    if (esMiembro) return { ok: false, error: 'Ese equipo ya no existe.' };
    return { ok: false, error: 'No perteneces a ese equipo (o ya no existe). Pide un código de invitación nuevo.' };
  }

  let rol = null;
  if (soyDueno) rol = 'owner';
  else if (esMiembro) rol = esRolValido(pertenencia.fila.role) ? pertenencia.fila.role : null;

  guardarRolConocido(id, rol, { miembro: soyDueno || esMiembro });
  return { ok: true, equipo: equipoDesdeFila(filaEquipo), rol, esMiembro: soyDueno || esMiembro, soyDueno, userId };
}

/**
 * Vuelve a comprobar el rol del usuario en el equipo y lo guarda.
 * Es lo que llama la aplicación al arrancar y tras sincronizar.
 */
export async function refrescarRol(teamId) {
  const situacion = await miSituacionEnEquipo(teamId);
  if (!situacion.ok) return situacion;
  return { ok: true, rol: situacion.rol, equipo: situacion.equipo, esMiembro: situacion.esMiembro, soyDueno: situacion.soyDueno };
}

/**
 * Los equipos a los que pertenece el usuario, con su rol en cada uno.
 *
 * Son dos consultas: las pertenencias (con su rol) y los equipos. Se incluyen
 * también los equipos de los que el usuario es DUEÑO aunque no tenga fila de
 * pertenencia: la migración 0002 lo contempla («el dueño manda aunque su fila
 * todavía no exista») y hay equipos creados a mano desde el SQL Editor que solo
 * tienen la fila de `horus_teams`.
 *
 * @returns {Promise<{ok:boolean, equipos?:Array<{id:string,nombre:string,codigo:string,ownerId:string,rol:string|null}>, error?:string}>}
 */
export async function myTeams() {
  const userId = usuarioActual();
  if (!userId) return { ok: false, error: SIN_SESION, code: 'no_session' };

  const pertenencias = await pedir(
    `${TABLES.teamMembers}?user_id=eq.${eq(userId)}&deleted=eq.false&select=team_id,role`,
  );
  if (!pertenencias.ok) return pertenencias;

  const propios = await pedir(
    `${TABLES.teams}?owner_id=eq.${eq(userId)}&deleted=eq.false&select=id,name,invite_code,owner_id`,
  );
  if (!propios.ok) return propios;

  const rolPorEquipo = new Map();
  for (const fila of pertenencias.filas) {
    if (fila?.team_id) rolPorEquipo.set(String(fila.team_id), esRolValido(fila.role) ? fila.role : null);
  }

  const equipos = new Map();
  for (const fila of propios.filas) {
    const equipo = equipoDesdeFila(fila);
    if (equipo?.id) equipos.set(equipo.id, { ...equipo, rol: 'owner' });
  }

  // Los equipos de los que solo se tiene la pertenencia (no se es dueño) hay
  // que leerlos aparte, porque el filtro de arriba iba por `owner_id`.
  const faltan = [...rolPorEquipo.keys()].filter((id) => !equipos.has(id));
  if (faltan.length) {
    const res = await pedir(
      `${TABLES.teams}?id=in.(${faltan.map((id) => eq(id)).join(',')})&deleted=eq.false&select=id,name,invite_code,owner_id`,
    );
    if (!res.ok) return res;
    for (const fila of res.filas) {
      const equipo = equipoDesdeFila(fila);
      if (equipo?.id) equipos.set(equipo.id, { ...equipo, rol: rolPorEquipo.get(equipo.id) ?? null });
    }
  }

  const lista = [...equipos.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  for (const equipo of lista) guardarRolConocido(equipo.id, equipo.rol, { miembro: true });
  return { ok: true, equipos: lista };
}

/**
 * Los miembros de un equipo, con su rol.
 *
 * Solo llegan los `user_id`: el servidor no expone los correos de los demás
 * (no hay ninguna vista ni función que los dé, y añadirla es otra tarea). La
 * interfaz lo dice tal cual en lugar de inventarse nombres.
 *
 * @returns {Promise<{ok:boolean, miembros?:Array<{userId:string, rol:string, joinedAt:string|null, esYo:boolean}>, yo?:string, error?:string}>}
 */
export async function teamMembers(teamId) {
  const id = normalizeTeamId(teamId);
  if (!id) return { ok: false, error: 'Ese equipo no tiene un identificador válido.' };
  const userId = usuarioActual();
  if (!userId) return { ok: false, error: SIN_SESION, code: 'no_session' };

  const res = await pedir(
    `${TABLES.teamMembers}?team_id=eq.${eq(id)}&deleted=eq.false&select=user_id,role,joined_at`,
  );
  if (!res.ok) return res;

  const miembros = res.filas
    .filter((fila) => fila?.user_id)
    .map((fila) => ({
      userId: String(fila.user_id),
      rol: esRolValido(fila.role) ? fila.role : 'member',
      joinedAt: fila.joined_at || null,
      esYo: String(fila.user_id) === userId,
    }))
    .sort((a, b) => (ROLE_ORDER[a.rol] ?? 9) - (ROLE_ORDER[b.rol] ?? 9));

  return { ok: true, miembros, yo: userId };
}

/* ==================================================================== *
 * Gestión (lo que el servidor solo deja al dueño)
 * ==================================================================== */

/**
 * Cambia el rol de un miembro.
 *
 * El servidor solo se lo permite al DUEÑO (`horus_team_members_update_owner`),
 * así que aquí solo se refleja: si el rol conocido no es `owner` se avisa sin
 * gastar una petición, y si aun así el servidor la rechaza, su mensaje manda.
 *
 * El rol del dueño del equipo no se toca: `horus_teams.owner_id` no cambia con
 * esta tabla, así que dejarlo sería una mentira (seguiría mandando). La
 * interfaz no ofrece el control para esa fila.
 */
export async function setMemberRole(teamId, userId, role) {
  const id = normalizeTeamId(teamId);
  if (!id) return { ok: false, error: 'Ese equipo no tiene un identificador válido.' };
  if (!esRolValido(role)) {
    return { ok: false, error: `Ese rol no existe. Los roles son: ${ROLES.map(etiquetaRol).join(', ')}.` };
  }
  const objetivo = String(userId || '');
  if (!objetivo) return { ok: false, error: 'Falta la persona a la que cambiar el rol.' };
  if (!usuarioActual()) return { ok: false, error: SIN_SESION, code: 'no_session' };

  const mio = rolConocido(id);
  if (mio && !puedeCambiarRoles(mio)) {
    return { ok: false, error: 'Solo el propietario del equipo puede cambiar los roles.' };
  }

  const res = await actualizar(
    TABLES.teamMembers,
    `team_id=eq.${eq(id)}&user_id=eq.${eq(objetivo)}`,
    { role, updated_at: new Date().toISOString() },
  );
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Solo el propietario del equipo puede cambiar los roles.' };
    }
    return { ok: false, error: `No se pudo cambiar el rol: ${res.error}`, status: res.status };
  }
  return { ok: true, rol: role };
}

/**
 * Rota el código de invitación (solo el dueño). El código viejo deja de valer.
 * @returns {Promise<{ok:boolean, codigo?:string, error?:string}>}
 */
export async function rotateInviteCode(teamId) {
  const id = normalizeTeamId(teamId);
  if (!id) return { ok: false, error: 'Ese equipo no tiene un identificador válido.' };
  if (!usuarioActual()) return { ok: false, error: SIN_SESION, code: 'no_session' };
  const mio = rolConocido(id);
  if (mio && !puedeRotarCodigo(mio)) {
    return { ok: false, error: 'Solo el propietario del equipo puede cambiar el código de invitación.' };
  }

  let ultimoError = '';
  for (let intento = 0; intento < 3; intento++) {
    const codigo = generarCodigoInvitacion();
    const res = await actualizar(TABLES.teams, `id=eq.${eq(id)}`, {
      invite_code: codigo,
      updated_at: new Date().toISOString(),
    });
    if (res.ok) return { ok: true, codigo };
    ultimoError = res.error;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Solo el propietario del equipo puede cambiar el código de invitación.' };
    }
    if (!(res.status === 409 || /duplicate key|already exists|unique/i.test(res.error))) break;
  }
  return { ok: false, error: `No se pudo cambiar el código: ${ultimoError}` };
}

/**
 * Sale del equipo.
 *
 * Dos caminos, y no es un capricho: las políticas de la 0002 dejan ACTUALIZAR
 * `horus_team_members` solo al dueño, pero BORRAR la fila propia a cualquiera.
 * Así que el dueño deja una lápida (`deleted = true`, que es lo que hace que la
 * baja les llegue a los demás dispositivos) y los demás borran su fila.
 *
 * Si el usuario es dueño del equipo, sigue siéndolo: `horus_teams.owner_id` no
 * cambia, así que puede volver a entrar con el código (o desde «mis equipos»).
 */
export async function leaveTeam(teamId) {
  const id = normalizeTeamId(teamId);
  if (!id) return { ok: false, error: 'Ese equipo no tiene un identificador válido.' };
  const userId = usuarioActual();
  if (!userId) return { ok: false, error: SIN_SESION, code: 'no_session' };

  const filtro = `team_id=eq.${eq(id)}&user_id=eq.${eq(userId)}`;
  const soyDueno = rolConocido(id) === 'owner';

  if (soyDueno) {
    const baja = await actualizar(TABLES.teamMembers, filtro, {
      deleted: true,
      updated_at: new Date().toISOString(),
    });
    if (baja.ok) {
      olvidarRolConocido(id);
      return { ok: true };
    }
    // Si la lápida no se pudo dejar (por ejemplo, ya no es el dueño), se
    // intenta el borrado de la fila propia, que es lo que sí permite la política.
  }

  const salida = await borrar(TABLES.teamMembers, filtro);
  if (!salida.ok) {
    return { ok: false, error: `No se pudo salir del equipo: ${salida.error}`, status: salida.status };
  }
  olvidarRolConocido(id);
  return { ok: true };
}
