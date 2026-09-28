# Supabase en HORUS

HORUS es **local-first**: funciona entero con `localStorage`. Supabase es
**opcional** y solo sirve para sincronizar el cuadrante entre dispositivos.

## 1. Aplicar las migraciones

Se aplican **en orden** y cada archivo en su propia consulta. Los dos son
**idempotentes**: se pueden pegar y ejecutar varias veces sin romper nada.

1. Entra en <https://supabase.com/dashboard> y abre tu proyecto.
2. Menú lateral → **SQL Editor** → **New query**.
3. Copia **todo** el contenido de
   [`migrations/0001_horus_schema.sql`](migrations/0001_horus_schema.sql) y pégalo.
4. Pulsa **Run** (o `Ctrl/Cmd + Enter`). Debe terminar con
   `Success. No rows returned`.
5. Repite los pasos 3 y 4 con
   [`migrations/0002_horus_team_scope.sql`](migrations/0002_horus_team_scope.sql).
   **Siempre después de la 0001**: es la que añade el ámbito `owner_key`, las
   políticas por rol y el alta por código de invitación.

Si un paso sale con error, no se ha aplicado nada de ESE archivo: cada script
va entero dentro de una transacción (`begin;` … `commit;`).

La 0001 crea las tablas `horus_documents`, `horus_members`,
`horus_shift_types`, `horus_entries`, `horus_patterns`, `horus_day_meta`,
`horus_teams`, `horus_team_members`, activa RLS con políticas por usuario y
deja intactas las tablas antiguas (`user_data`, `profiles`).

La 0002 convierte el cuadrante de «uno por usuario» a «uno por equipo»: añade
`owner_key` a las ocho tablas, cambia la clave primaria a `(owner_key, id)`,
sustituye todas las políticas por las de ámbito + rol y añade
`horus_join_team(código)`. Se cuenta en el [apartado 6](#6-equipos-ámbitos-owner_key-y-roles).

> **Si te salió `42P01: relation "public.horus_team_members" does not exist`**
> (en la línea 88), tenías una copia antigua del archivo: los helpers de equipo
> se creaban antes que las tablas que consultan. Como son funciones
> `language sql`, Postgres planifica su cuerpo al crearlas y el script entero
> se caía. Ya está corregido: vuelve a copiar el archivo entero y ejecútalo. No
> hay nada que limpiar, porque el error abortó la transacción completa.

### Comprobar el esquema sin Supabase

```bash
npm run check:sql     # orden de las definiciones (detecta el 42P01 de arriba)
```

`tools/sql-order.mjs` lee la migración y avisa si algún objeto se usa antes de
estar definido. No sustituye a probarlo en Supabase, pero caza el fallo más
fácil de cometer a mano.

El comprobador analiza **cada migración por separado**, así que la 0002 lleva
al principio un espejo (`create table if not exists`) de las ocho tablas de la
0001: de ese modo se comprueba sola y además se puede pegar en un proyecto
donde no corrió la 0001 sin que salte un `42P01`. En un proyecto que ya tiene
la 0001 aplicada, ese espejo no hace absolutamente nada.

## 2. La app funciona sin Supabase

- **Con Supabase**: sincronización en la nube entre dispositivos y cambios en
  vivo (Realtime) en un segundo dispositivo. Los equipos y las invitaciones ya
  están en el servidor (apartado 6), pero el cliente todavía no los usa: eso
  llega en la fase 2.
- **Sin Supabase** (o sin sesión iniciada): todo sigue funcionando, pero los
  datos viven solo en ese navegador. Se pierde al borrar los datos del sitio.
  No hay equipos, ni invitaciones, ni sincronización entre dispositivos.

Nada de esto bloquea la app: si la red falla, HORUS sigue guardando en local y
reintenta después.

## 3. Dónde están la URL y la anon key

Dashboard del proyecto → **Project Settings** (engranaje) → **API**:

- **Project URL** → `https://<ref>.supabase.co`
- **Project API keys** → `anon` `public`

Se pegan en la configuración del cliente de HORUS (login/sync).

## 4. La anon key es pública (a propósito)

La `anon` key viaja en el navegador: cualquiera puede leerla. **No es un
secreto** y no hay que "protegerla". Lo que protege los datos es **RLS**
(Row Level Security), que activan las dos migraciones:

- cada fila pertenece a un **ámbito** (`owner_key`): en `user:<uuid>` solo
  manda su dueño (leer y escribir); en `team:<uuid>` leen los miembros del
  equipo y escriben el dueño y los `admin` (hoy también los `member`; el
  detalle está en el apartado 6);
- `user_id` se conserva en todas las filas: es «quién escribió la fila»;
- los roles viven en `horus_team_members` y `viewer` nunca escribe.

La clave que **nunca** debe salir del servidor es `service_role`: se salta RLS
por completo. No la pongas en el repo, ni en el cliente, ni en una captura.

## 5. Problemas típicos

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `401 Unauthorized` / `JWT expired` | la sesión caducó | vuelve a iniciar sesión en la app |
| `403` o el `select` devuelve `[]` sin error | RLS ha bloqueado la fila (falta política, o el ámbito `owner_key` no es el tuyo) | revisa `horus_can_read` / `horus_can_write` y que la fila esté en `user:<tu-uuid>` o en un equipo en el que estés |
| `relation "public.horus_entries" does not exist` | la migración no se ha aplicado (o se aplicó en otro proyecto) | ejecuta `0001_horus_schema.sql` en el SQL Editor de ESE proyecto |
| `relation "public.horus_team_members" does not exist` en la línea 88 | copia antigua de la migración (los helpers iban antes que las tablas) | copia otra vez el archivo entero; la transacción abortada no dejó nada a medias |
| `42P17 infinite recursion detected in policy` | una política lee la misma tabla que protege | usa los helpers `security definer` (`horus_is_team_member`) como hace la migración |
| El segundo dispositivo no se actualiza solo | falta la tabla en la publicación Realtime | vuelve a ejecutar la migración (añade las tablas a `supabase_realtime`) |
| Los datos no suben pero no hay error | sin sesión iniciada o sin URL/anon key configuradas | inicia sesión; revisa la configuración del cliente |
| `42P10` / «there is no unique or exclusion constraint matching the ON CONFLICT specification» | PostgREST todavía tiene en caché la clave primaria vieja `(user_id, id)` | ejecuta `notify pgrst, 'reload schema';` (la 0002 ya lo hace al terminar) y reintenta |
| `HORUS: el ámbito de una fila (owner_key) no se puede cambiar` | se intentó mover una fila de un ámbito a otro con un `UPDATE` suelto | no se hace así a propósito: hace falta una función RPC que lo haga de forma explícita (fase 2) |
| `HORUS: el código de invitación no es válido` | el código no existe, está mal copiado o el equipo está borrado (`deleted = true`) | copia otra vez el código (`select invite_code from public.horus_teams`); el mensaje es el mismo a propósito, para no poder adivinar códigos |
| `HORUS: el equipo ya tiene el máximo de 100 miembros` | tope de miembros por equipo | echa a alguien inactivo o sube `v_tope` en `horus_join_team` |
| `HORUS: hace falta una sesión iniciada…` al llamar a `horus_join_team` | se llamó sin sesión (o con la `anon` key) | inicia sesión: la función solo se le concede a `authenticated` |

## 6. Equipos, ámbitos (`owner_key`) y roles

Desde la migración **0002**, cada fila de las ocho tablas pertenece a un
**ámbito**, que se guarda en la columna `owner_key`:

| `owner_key` | Qué es | Quién lee | Quién escribe |
| --- | --- | --- | --- |
| `user:<uuid>` | cuadrante personal | solo ese usuario | solo ese usuario |
| `team:<uuid>` | cuadrante compartido del equipo | los miembros (`deleted = false`) y el dueño del equipo | `owner` y `admin`; **hoy también `member`** (ver el aviso de la fase 2) |

Reglas, en corto:

- `user_id` **se conserva** en todas las filas: es «quién escribió la fila».
  La app actual sigue subiendo y bajando por `user_id` sin cambiar ni una
  línea, y un trigger rellena `owner_key` cuando la fila llega sin ella
  (`'user:' || user_id`, `'team:' || id` en los equipos, `'team:' || team_id`
  en las pertenencias).
- El ámbito de una fila (`owner_key`) **no se cambia con un `UPDATE`**: un
  trigger lo impide (`HORUS: el ámbito de una fila (owner_key) no se puede
  cambiar…`). Mover filas de un ámbito a otro tiene que ser una función RPC
  explícita. El autor (`user_id`) tampoco se reescribe: se fija al insertar y
  no cambia después (en la 0001 pasaba lo mismo).
- Los roles son los de `horus_team_members`: `owner`, `admin`, `member`,
  `viewer`. El `viewer` **nunca** escribe.
- Ninguna política filtra por `deleted`: los borrados tienen que poder viajar
  a los demás dispositivos (son lápidas). La única excepción es la
  **pertenencia** al equipo: quien se ha salido (`deleted = true`) deja de
  leer ese equipo.

### Entrar en un equipo con un código

```sql
select public.horus_join_team('MI-CODIGO');   -- devuelve el uuid del equipo
```

- Solo para usuarios con sesión (`authenticated`).
- Si ya eras miembro no cambia nada (ni tu rol) y devuelve el equipo igual.
- Si te habías salido, te revive como `member`. Un rol alto no se recupera
  solo al volver a entrar: lo pone el dueño del equipo (al dueño del equipo no
  se le quita nada, porque `horus_teams.owner_id` sigue siendo suyo).
- **No se puede uno poner `owner` ni `admin`** por esta vía: el rol no es un
  parámetro y la fila nueva entra siempre como `member`.
- Tope de **100 miembros** por equipo.
- Si el código no vale, el mensaje es siempre el mismo (*el código de
  invitación no es válido*), tanto si el equipo no existe como si está
  borrado: así el error no sirve para adivinar códigos ni equipos.

### Crear un equipo (todavía por SQL)

El cliente aún **no** escribe en `horus_teams` ni en `horus_team_members` (eso
es la fase 2), así que hoy un equipo se crea desde el SQL Editor. Ojo: en el
SQL Editor `auth.uid()` es `null`, así que hay que poner el uuid a mano
(*Authentication → Users*, o `select id, email from auth.users`):

```sql
-- con tu uuid de usuario:
insert into public.horus_teams (name, invite_code, owner_id)
values ('Cuadrante de mañanas', 'MI-CODIGO', '<tu-uuid>')
returning id;

-- y con el id que devuelve la consulta anterior:
insert into public.horus_team_members (team_id, user_id, role)
values ('<uuid-del-equipo>', '<tu-uuid>', 'owner');
```

`owner_key` no hace falta escribirla nunca: la rellena el trigger.

### Comprobar qué políticas han quedado

```sql
select tablename, policyname, cmd
  from pg_policies
 where schemaname = 'public' and tablename like 'horus_%'
 order by tablename, cmd, policyname;
```

Tienen que salir **32** políticas nuevas:

- en las seis tablas del cuadrante (`horus_documents`, `horus_members`,
  `horus_shift_types`, `horus_entries`, `horus_patterns`, `horus_day_meta`),
  las cuatro de cada una: `_select_scope`, `_insert_scope`, `_update_scope` y
  `_delete_scope`;
- en `horus_teams`: `horus_teams_select_scope`, `horus_teams_insert_owner`,
  `horus_teams_update_owner` y `horus_teams_delete_owner`;
- en `horus_team_members`: `horus_team_members_select_scope`,
  `horus_team_members_insert_owner`, `horus_team_members_update_owner` y
  `horus_team_members_delete_owner_or_self`.

Si aparece alguna `*_select_own`, `*_insert_own`, `*_update_own`,
`*_delete_own` o `horus_teams_select_member`, es que quedó viva una política
vieja (más permisiva): vuelve a ejecutar la 0002. Las `horus_legacy_*` de
`user_data` y `profiles` son de la app antigua y **no** se tocan.

### Lo que esta migración deja a propósito para la fase 2

- `member` puede escribir **todo** el ámbito del equipo porque la tabla de
  peticiones (cambios de turno, vacaciones, marcas propias) todavía no existe.
  Cuando exista hay que afinarlo: el `member` solo debería escribir SUS
  peticiones y SUS marcas. Está marcado como `TODO(fase-2)` en
  `horus_can_write()`.
- El cliente todavía filtra por `user_id` y no conoce los equipos: no hay
  interfaz para crear un equipo, invitar ni entrar con un código.
- Los `admin` pueden editar todo el cuadrante, pero **no** el equipo en sí
  (nombre, código de invitación, altas y cambios de rol): eso sigue siendo del
  `owner`, como en la 0001.
- Se han retirado los índices de pull por `user_id` de las seis tablas
  personales (los sustituye el de `owner_key`). Hasta que el cliente cambie,
  sus consultas siguen funcionando exactamente igual, pero sin índice propio.
