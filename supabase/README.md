# Supabase en HORUS

HORUS es **local-first**: funciona entero con `localStorage`. Supabase es
**opcional** y solo sirve para sincronizar el cuadrante entre dispositivos.

## 1. Aplicar la migración

1. Entra en <https://supabase.com/dashboard> y abre tu proyecto.
2. Menú lateral → **SQL Editor** → **New query**.
3. Copia **todo** el contenido de
   [`migrations/0001_horus_schema.sql`](migrations/0001_horus_schema.sql) y pégalo.
4. Pulsa **Run** (o `Ctrl/Cmd + Enter`).
5. Debe terminar con `Success. No rows returned`. Si sale un error, no se ha
   aplicado nada: el script va dentro de una transacción.

El archivo es **idempotente**: se puede pegar y ejecutar varias veces sin
romper nada. Crea las tablas `horus_documents`, `horus_members`,
`horus_shift_types`, `horus_entries`, `horus_patterns`, `horus_day_meta`,
`horus_teams`, `horus_team_members`, activa RLS con políticas por usuario y
deja intactas las tablas antiguas (`user_data`, `profiles`).

## 2. La app funciona sin Supabase

- **Con Supabase**: sincronización en la nube entre dispositivos, equipos e
  invitaciones, y cambios en vivo (Realtime) en un segundo dispositivo.
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
(Row Level Security), activado por la migración:

- cada usuario solo puede leer/escribir sus filas (`user_id = auth.uid()`);
- en equipos manda el dueño (`owner_id`) y los miembros solo ven su equipo.

La clave que **nunca** debe salir del servidor es `service_role`: se salta RLS
por completo. No la pongas en el repo, ni en el cliente, ni en una captura.

## 5. Problemas típicos

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `401 Unauthorized` / `JWT expired` | la sesión caducó | vuelve a iniciar sesión en la app |
| `403` o el `select` devuelve `[]` sin error | RLS ha bloqueado la fila (falta política, o el `user_id` no es el de la sesión) | revisa las políticas de esa tabla y que el `user_id` insertado sea `auth.uid()` |
| `relation "public.horus_entries" does not exist` | la migración no se ha aplicado (o se aplicó en otro proyecto) | ejecuta `0001_horus_schema.sql` en el SQL Editor de ESE proyecto |
| `42P17 infinite recursion detected in policy` | una política lee la misma tabla que protege | usa los helpers `security definer` (`horus_is_team_member`) como hace la migración |
| El segundo dispositivo no se actualiza solo | falta la tabla en la publicación Realtime | vuelve a ejecutar la migración (añade las tablas a `supabase_realtime`) |
| Los datos no suben pero no hay error | sin sesión iniciada o sin URL/anon key configuradas | inicia sesión; revisa la configuración del cliente |
