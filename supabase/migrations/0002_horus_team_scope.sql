-- =====================================================================
--  HORUS · cuadrante por EQUIPO (ámbito `owner_key`) + permisos por rol
--  Archivo: supabase/migrations/0002_horus_team_scope.sql
--
--  CÓMO USARLO
--    1) Ejecuta antes 0001_horus_schema.sql (o comprueba que ya está).
--    2) Pega TODO este archivo en el SQL Editor de Supabase y ejecútalo.
--    Es idempotente: se puede ejecutar varias veces sin romper nada, y va
--    entero dentro de una transacción (begin; … commit;), igual que la 0001.
--
--  EL PROBLEMA QUE RESUELVE
--    Hasta la 0001 las ocho tablas se identificaban por (user_id, id): cada
--    cuenta tenía SU cuadrante y no había manera de que dos personas
--    compartieran uno. A partir de aquí cada fila pertenece a un ÁMBITO, que
--    se guarda en la columna `owner_key`:
--        'user:<uuid>'  →  cuadrante personal (lo de siempre)
--        'team:<uuid>'  →  cuadrante compartido del equipo
--    Los roles (owner, admin, member, viewer) siguen viviendo en
--    horus_team_members, y son los que deciden quién puede escribir.
--
--  QUÉ HACE, APARTADO A APARTADO
--    0) Espejo de las ocho tablas de la 0001 (create table if not exists).
--    1) `owner_key`: se añade a las ocho tablas, se rellena desde user_id,
--       queda not null con el formato validado, la clave primaria pasa de
--       (user_id, id) a (owner_key, id) —(owner_key, day_date) en day_meta—
--       y se añade el índice de pull incremental (owner_key, deleted,
--       updated_at).
--    2) Trigger de compatibilidad: rellena owner_key cuando el cliente no la
--       manda (que es como lo hace la app actual), deja el autor (user_id)
--       atado a quien escribe y prohíbe cambiar owner_key con un UPDATE
--       suelto.
--    3) Permisos por ámbito: horus_can_read() y horus_can_write().
--    4) horus_join_team(p_code): entrar en un equipo con un código.
--    5) Políticas RLS nuevas, soltando antes TODAS las de la 0001 que
--       sustituyen (no queda ninguna política vieja viva).
--    6) Permisos de ejecución de las funciones nuevas.
--    7) Lo que esta migración NO toca (app antigua, triggers, Realtime…).
--
--  COMPATIBILIDAD CON LA APP ACTUAL (requisito duro)
--    Esta migración se aplica ANTES de tocar el cliente, así que la app de
--    hoy (js/core/sync.js) tiene que seguir funcionando sin cambios. Eso se
--    consigue con tres cosas:
--      · `user_id` NO se elimina ni se deja de exigir: es «quién escribió la
--        fila», y la app lo sigue mandando y filtrando por él.
--      · El trigger del apartado 2 rellena owner_key = 'user:' || user_id
--        cuando la fila llega sin owner_key (hoy llega siempre así), antes
--        de que Postgres compruebe el not null y las políticas RLS.
--      · Las políticas nuevas dejan al dueño del ámbito personal hacer
--        exactamente lo mismo que hacía con las políticas viejas.
--    Lo que sí cambia para la app actual: las consultas por `user_id` dejan
--    de tener su índice propio (ver 1.6). Siguen funcionando igual, solo que
--    sin índice, y eso se recupera en la fase 2, cuando el cliente pase a
--    filtrar por owner_key.
--
--  SEGURIDAD (resumen)
--    · 'user:<uid>' → solo ese usuario, para leer y para escribir.
--    · 'team:<tid>' → LEEN los miembros del equipo (y su dueño); ESCRIBEN el
--      dueño y los admin… y, POR AHORA, también los member (ver el
--      TODO(fase-2) del apartado 3.2). El viewer nunca escribe.
--    · horus_can_read / horus_can_write son SECURITY DEFINER con search_path
--      fijo, por el mismo motivo que los helpers de la 0001: una política de
--      horus_team_members necesita leer horus_team_members, y sin
--      SECURITY DEFINER esa lectura volvería a evaluar la misma política
--      (recursión infinita, error 42P17).
--    · La app antigua (public.user_data / public.profiles) no se toca.
-- =====================================================================

begin;

-- =====================================================================
-- 0) ESPEJO DE LAS OCHO TABLAS DE LA 0001  (create table if not exists)
-- ---------------------------------------------------------------------
--  ¿Por qué está esto aquí, si las tablas ya las crea la 0001?
--    a) tools/sql-order.mjs analiza CADA migración por separado. Para él, un
--       «alter table public.horus_documents» de este archivo usa una tabla
--       que «todavía no está definida», y la migración no pasaría el
--       comprobador. Con el espejo, este archivo se comprueba solo.
--    b) Si alguien pega este archivo en un proyecto donde no llegó a correr
--       la 0001, las tablas nacen aquí y luego se migran, en vez de fallar
--       con 42P01 «relation … does not exist».
--  En un proyecto que YA tiene la 0001 aplicada este apartado no hace
--  absolutamente nada: `create table if not exists` no toca una tabla que ya
--  existe (ni sus datos, ni sus índices, ni sus políticas).
--  Es un espejo LITERAL de la 0001: si algún día cambias una tabla allí,
--  cambia también su copia de aquí. Las claves primarias de las seis tablas
--  personales las cambia el apartado 1.5; aquí aparecen como las dejó la 0001
--  a propósito (es el punto de partida real de la migración).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0.1) Documentos.
-- ---------------------------------------------------------------------
create table if not exists public.horus_documents (
  user_id           uuid        not null references auth.users(id) on delete cascade,
  id                text        not null,
  name              text,
  me_id             text,
  settings          jsonb       not null default '{}'::jsonb,
  schema            int         not null default 4,
  rev               int         not null default 1,
  payload           jsonb       not null default '{}'::jsonb,
  client_updated_at bigint      not null default 0,
  updated_at        timestamptz not null default now(),
  deleted           boolean     not null default false,
  constraint horus_documents_pkey     primary key (user_id, id),
  constraint horus_documents_schema_chk check (schema >= 1),
  constraint horus_documents_rev_chk    check (rev >= 1)
);

-- ---------------------------------------------------------------------
-- 0.2) Miembros.
-- ---------------------------------------------------------------------
create table if not exists public.horus_members (
  user_id           uuid        not null references auth.users(id) on delete cascade,
  id                text        not null,
  name              text,
  initials          text,
  hex               text,
  role              text,
  active            boolean,
  weekly_hours      numeric,
  payload           jsonb       not null default '{}'::jsonb,
  client_updated_at bigint      not null default 0,
  updated_at        timestamptz not null default now(),
  deleted           boolean     not null default false,
  constraint horus_members_pkey  primary key (user_id, id),
  constraint horus_members_role_chk check (role is null or role in ('owner', 'admin', 'member', 'viewer')),
  constraint horus_members_hex_chk  check (hex  is null or hex ~ '^#[0-9A-Fa-f]{6}$'),
  constraint horus_members_weekly_hours_chk check (weekly_hours is null or (weekly_hours >= 0 and weekly_hours <= 168))
);

-- ---------------------------------------------------------------------
-- 0.3) Catálogo de tipos de turno.
-- ---------------------------------------------------------------------
create table if not exists public.horus_shift_types (
  user_id           uuid        not null references auth.users(id) on delete cascade,
  id                text        not null,
  code              text,
  label             text,
  kind              text,
  hex               text,
  demand            int,
  archived          boolean,
  placement_order   int,
  payload           jsonb       not null default '{}'::jsonb,
  client_updated_at bigint      not null default 0,
  updated_at        timestamptz not null default now(),
  deleted           boolean     not null default false,
  constraint horus_shift_types_pkey primary key (user_id, id),
  constraint horus_shift_types_kind_chk   check (kind   is null or kind in ('work', 'rest', 'leave', 'sick', 'free')),
  constraint horus_shift_types_hex_chk    check (hex    is null or hex ~ '^#[0-9A-Fa-f]{6}$'),
  constraint horus_shift_types_demand_chk check (demand is null or demand >= 0)
);

-- ---------------------------------------------------------------------
-- 0.4) Entradas de turno.
-- ---------------------------------------------------------------------
create table if not exists public.horus_entries (
  user_id           uuid        not null references auth.users(id) on delete cascade,
  id                text        not null,
  member_id         text,
  entry_date        date,
  type_id           text,
  day_type          text,
  approved          boolean,
  notes             text,
  payload           jsonb       not null default '{}'::jsonb,
  client_updated_at bigint      not null default 0,
  updated_at        timestamptz not null default now(),
  deleted           boolean     not null default false,
  constraint horus_entries_pkey primary key (user_id, id),
  constraint horus_entries_day_type_chk check (day_type is null or day_type in ('normal', 'holiday', 'event', 'swap'))
);

-- ---------------------------------------------------------------------
-- 0.5) Patrones de rotación.
-- ---------------------------------------------------------------------
create table if not exists public.horus_patterns (
  user_id           uuid        not null references auth.users(id) on delete cascade,
  id                text        not null,
  name              text,
  start_date        date,
  step_days         int,
  payload           jsonb       not null default '{}'::jsonb,
  client_updated_at bigint      not null default 0,
  updated_at        timestamptz not null default now(),
  deleted           boolean     not null default false,
  constraint horus_patterns_pkey primary key (user_id, id),
  constraint horus_patterns_step_days_chk check (step_days is null or step_days >= 1)
);

-- ---------------------------------------------------------------------
-- 0.6) Metadatos por día.
-- ---------------------------------------------------------------------
create table if not exists public.horus_day_meta (
  user_id           uuid        not null references auth.users(id) on delete cascade,
  day_date          date        not null,
  day_type          text,
  label             text,
  demand_override   int,
  notes             text,
  payload           jsonb       not null default '{}'::jsonb,
  client_updated_at bigint      not null default 0,
  updated_at        timestamptz not null default now(),
  deleted           boolean     not null default false,
  constraint horus_day_meta_pkey primary key (user_id, day_date),
  constraint horus_day_meta_day_type_chk check (day_type is null or day_type in ('normal', 'holiday', 'event')),
  constraint horus_day_meta_demand_override_chk check (demand_override is null or demand_override >= 0)
);

-- ---------------------------------------------------------------------
-- 0.7) Equipos.
-- ---------------------------------------------------------------------
create table if not exists public.horus_teams (
  id                uuid        primary key default gen_random_uuid(),
  name              text        not null,
  invite_code       text        not null unique,
  owner_id          uuid        not null references auth.users(id) on delete cascade,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted           boolean     not null default false,
  client_updated_at bigint      not null default 0,
  payload           jsonb       not null default '{}'::jsonb
);

-- ---------------------------------------------------------------------
-- 0.8) Pertenencia a equipos.
-- ---------------------------------------------------------------------
create table if not exists public.horus_team_members (
  team_id           uuid        not null references public.horus_teams(id) on delete cascade,
  user_id           uuid        not null references auth.users(id) on delete cascade,
  role              text        not null default 'member',
  joined_at         timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted           boolean     not null default false,
  client_updated_at bigint      not null default 0,
  payload           jsonb       not null default '{}'::jsonb,
  constraint horus_team_members_pkey primary key (team_id, user_id),
  constraint horus_team_members_role_chk check (role in ('owner', 'admin', 'member', 'viewer'))
);

-- =====================================================================
-- 1) EL ÁMBITO: `owner_key` EN LAS OCHO TABLAS
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1.1) Añadir la columna.
--      Primero se añade (nullable) y luego se rellena: en un proyecto que ya
--      ejecutó la 0001 hay filas y no se les puede poner un not null de
--      golpe.
-- ---------------------------------------------------------------------
alter table public.horus_documents    add column if not exists owner_key text;
alter table public.horus_members      add column if not exists owner_key text;
alter table public.horus_shift_types  add column if not exists owner_key text;
alter table public.horus_entries      add column if not exists owner_key text;
alter table public.horus_patterns     add column if not exists owner_key text;
alter table public.horus_day_meta     add column if not exists owner_key text;
alter table public.horus_teams        add column if not exists owner_key text;
alter table public.horus_team_members add column if not exists owner_key text;

-- ---------------------------------------------------------------------
-- 1.2) Rellenar el ámbito de las filas que ya existen.
--      · Tablas 1-6: cada fila era del usuario que la escribió, así que su
--        ámbito es personal: 'user:' || user_id.
--      · horus_teams: el ámbito es el propio equipo: 'team:' || id.
--      · horus_team_members: el ámbito es el equipo al que pertenece la
--        fila: 'team:' || team_id.
--      El WHERE owner_key is null hace que esto se pueda repetir mil veces
--      sin tocar nada ya migrado (y sin reescribir filas).
-- ---------------------------------------------------------------------
update public.horus_documents set owner_key = 'user:' || user_id::text where owner_key is null;
update public.horus_members   set owner_key = 'user:' || user_id::text where owner_key is null;
update public.horus_shift_types set owner_key = 'user:' || user_id::text where owner_key is null;
update public.horus_entries   set owner_key = 'user:' || user_id::text where owner_key is null;
update public.horus_patterns  set owner_key = 'user:' || user_id::text where owner_key is null;
update public.horus_day_meta  set owner_key = 'user:' || user_id::text where owner_key is null;
update public.horus_teams         set owner_key = 'team:' || id::text      where owner_key is null;
update public.horus_team_members  set owner_key = 'team:' || team_id::text where owner_key is null;

-- ---------------------------------------------------------------------
-- 1.3) Ahora sí: obligatoria en las ocho.
-- ---------------------------------------------------------------------
alter table public.horus_documents    alter column owner_key set not null;
alter table public.horus_members      alter column owner_key set not null;
alter table public.horus_shift_types  alter column owner_key set not null;
alter table public.horus_entries      alter column owner_key set not null;
alter table public.horus_patterns     alter column owner_key set not null;
alter table public.horus_day_meta     alter column owner_key set not null;
alter table public.horus_teams        alter column owner_key set not null;
alter table public.horus_team_members alter column owner_key set not null;

-- ---------------------------------------------------------------------
-- 1.4) Formato validado: 'user:<uuid>' o 'team:<uuid>'.
--      `drop constraint if exists` + `add constraint` es idempotente (en una
--      segunda pasada se suelta y se vuelve a crear la misma). OJO: cada
--      ejecución vuelve a validar la tabla entera; en un cuadrante enorme,
--      eso es un rato de lectura, no un problema de corrección.
-- ---------------------------------------------------------------------
alter table public.horus_documents drop constraint if exists horus_documents_owner_key_chk;
alter table public.horus_documents add constraint horus_documents_owner_key_chk
  check (owner_key ~ '^(user|team):[0-9a-f-]{36}$');

alter table public.horus_members drop constraint if exists horus_members_owner_key_chk;
alter table public.horus_members add constraint horus_members_owner_key_chk
  check (owner_key ~ '^(user|team):[0-9a-f-]{36}$');

alter table public.horus_shift_types drop constraint if exists horus_shift_types_owner_key_chk;
alter table public.horus_shift_types add constraint horus_shift_types_owner_key_chk
  check (owner_key ~ '^(user|team):[0-9a-f-]{36}$');

alter table public.horus_entries drop constraint if exists horus_entries_owner_key_chk;
alter table public.horus_entries add constraint horus_entries_owner_key_chk
  check (owner_key ~ '^(user|team):[0-9a-f-]{36}$');

alter table public.horus_patterns drop constraint if exists horus_patterns_owner_key_chk;
alter table public.horus_patterns add constraint horus_patterns_owner_key_chk
  check (owner_key ~ '^(user|team):[0-9a-f-]{36}$');

alter table public.horus_day_meta drop constraint if exists horus_day_meta_owner_key_chk;
alter table public.horus_day_meta add constraint horus_day_meta_owner_key_chk
  check (owner_key ~ '^(user|team):[0-9a-f-]{36}$');

alter table public.horus_teams drop constraint if exists horus_teams_owner_key_chk;
alter table public.horus_teams add constraint horus_teams_owner_key_chk
  check (owner_key ~ '^(user|team):[0-9a-f-]{36}$');

alter table public.horus_team_members drop constraint if exists horus_team_members_owner_key_chk;
alter table public.horus_team_members add constraint horus_team_members_owner_key_chk
  check (owner_key ~ '^(user|team):[0-9a-f-]{36}$');

-- ---------------------------------------------------------------------
-- 1.5) Clave primaria: de (user_id, id) a (owner_key, id).
--      La 0001 identificaba la fila por su dueño; ahora la identifica su
--      ámbito (y en day_meta, la fecha, como siempre).
--      `drop constraint if exists` + `add constraint` es idempotente: en la
--      segunda ejecución se suelta la clave nueva y se vuelve a crear igual.
--      No hay ninguna clave ajena apuntando a estas seis tablas (las
--      relaciones del modelo son por texto: member_id, type_id…), así que
--      soltar la clave primaria no arrastra nada.
-- ---------------------------------------------------------------------
alter table public.horus_documents drop constraint if exists horus_documents_pkey;
alter table public.horus_documents add constraint horus_documents_pkey
  primary key (owner_key, id);

alter table public.horus_members drop constraint if exists horus_members_pkey;
alter table public.horus_members add constraint horus_members_pkey
  primary key (owner_key, id);

alter table public.horus_shift_types drop constraint if exists horus_shift_types_pkey;
alter table public.horus_shift_types add constraint horus_shift_types_pkey
  primary key (owner_key, id);

alter table public.horus_entries drop constraint if exists horus_entries_pkey;
alter table public.horus_entries add constraint horus_entries_pkey
  primary key (owner_key, id);

alter table public.horus_patterns drop constraint if exists horus_patterns_pkey;
alter table public.horus_patterns add constraint horus_patterns_pkey
  primary key (owner_key, id);

alter table public.horus_day_meta drop constraint if exists horus_day_meta_pkey;
alter table public.horus_day_meta add constraint horus_day_meta_pkey
  primary key (owner_key, day_date);

-- ---------------------------------------------------------------------
-- 1.5.1) Las DOS TABLAS DE EQUIPO no cambian de clave primaria. A propósito:
--      · horus_teams ya se identifica por `id` (uuid único global) y su
--        ámbito es exactamente 'team:' || id, así que (owner_key, id) sería
--        redundante; además, soltar esa clave rompería la clave ajena de
--        horus_team_members → horus_teams(id), que necesita un único sobre
--        `id` (Postgres no deja soltar una clave referenciada).
--      · horus_team_members ya se identifica por (team_id, user_id), que es
--        justo «quién está en qué equipo»; su owner_key es 'team:' ||
--        team_id, es decir, el mismo ámbito. Cambiarla por (owner_key,
--        user_id) no aportaría nada y rompería los upsert por (team_id,
--        user_id) que hace horus_join_team().
--      Las dos llevan igualmente su owner_key, porque son las que deciden
--      el ámbito de las demás tablas.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1.6) Índices.
--      El pull incremental del cliente pregunta «dame lo que ha cambiado
--      desde X», y a partir de ahora lo pregunta POR ÁMBITO: un índice
--      (owner_key, deleted, updated_at) por tabla.
--      Para el pull de un equipo esto es lo que hace que un miembro vea el
--      cuadrante compartido entero (todas las filas del ámbito) sin recorrer
--      la tabla.
-- ---------------------------------------------------------------------
create index if not exists horus_documents_scope_sync_idx
  on public.horus_documents    (owner_key, deleted, updated_at);
create index if not exists horus_members_scope_sync_idx
  on public.horus_members      (owner_key, deleted, updated_at);
create index if not exists horus_shift_types_scope_sync_idx
  on public.horus_shift_types  (owner_key, deleted, updated_at);
create index if not exists horus_entries_scope_sync_idx
  on public.horus_entries      (owner_key, deleted, updated_at);
create index if not exists horus_patterns_scope_sync_idx
  on public.horus_patterns     (owner_key, deleted, updated_at);
create index if not exists horus_day_meta_scope_sync_idx
  on public.horus_day_meta     (owner_key, deleted, updated_at);
create index if not exists horus_teams_scope_sync_idx
  on public.horus_teams        (owner_key, deleted, updated_at);
create index if not exists horus_team_members_scope_sync_idx
  on public.horus_team_members (owner_key, deleted, updated_at);

--      Índices que la 0001 creó para el pull POR USUARIO y que este cambio
--      deja sin sentido en las seis tablas personales: el dueño de la fila
--      ya no es lo que la identifica. Se sueltan.
--      (Lo que esto cuesta: hasta la fase 2, cuando el cliente pase a
--      filtrar por owner_key, las consultas de la app actual por user_id
--      —el pull y los PATCH de borrado— siguen funcionando, pero sin índice
--      propio. No es un problema de corrección, solo de velocidad, y en un
--      cuadrante de equipo son tablas pequeñas.)
drop index if exists public.horus_documents_sync_idx;
drop index if exists public.horus_members_sync_idx;
drop index if exists public.horus_shift_types_sync_idx;
drop index if exists public.horus_entries_sync_idx;
drop index if exists public.horus_patterns_sync_idx;
drop index if exists public.horus_day_meta_sync_idx;

--      Los de las dos tablas de equipo SÍ se conservan: indexan columnas que
--      siguen teniendo sentido y que el nuevo índice de ámbito no cubre —
--      `owner_id` responde a «equipos que he creado» y `user_id` a «equipos
--      en los que estoy», y son también el filtro de sus políticas.
--      (horus_teams_sync_idx y horus_team_members_sync_idx, de la 0001.)
--
--      Índices de consulta de la 0001 que se conservan tal cual:
--        horus_entries_user_date_idx, horus_entries_user_member_date_idx,
--        horus_entries_user_type_date_idx, horus_shift_types_user_order_idx
--        y horus_team_members_user_idx / horus_team_members_team_idx.
--      Siguen sirviendo a las consultas por usuario/fecha y a la app actual.
--      Cuando el cliente trabaje por ámbito, en la fase 2 habrá que añadir
--      sus equivalentes con owner_key (y entonces sí se podrán retirar).
--
--      Nota (no lo toco aquí a propósito): horus_team_members_user_idx es
--      redundante de por sí, porque (user_id) es el prefijo de
--      horus_team_members_sync_idx (user_id, deleted, updated_at), y
--      horus_team_members_team_idx lo es del único (team_id, user_id) de su
--      clave primaria. Es redundancia que ya venía de la 0001 y que la 0001
--      volvería a crear con sus `create index if not exists`; limpiarla es
--      una tarea aparte, no de esta migración.
--
--      Para el código de invitación no hace falta índice nuevo:
--      horus_teams.invite_code ya es `unique`, y horus_join_team() busca por
--      ahí.
-- ---------------------------------------------------------------------

-- =====================================================================
-- 2) COMPATIBILIDAD: QUIÉN RELLENA `owner_key`, QUIÉN FIGURA COMO AUTOR
--    Y QUIÉN NO PUEDE CAMBIAR EL ÁMBITO
-- =====================================================================

-- ---------------------------------------------------------------------
-- 2.1) Función de trigger.
--
--      POR QUÉ HACE FALTA (es el requisito duro de esta migración):
--        La app actual (js/core/sync.js) inserta filas SIN owner_key: manda
--        user_id, id, payload, client_updated_at… y nada más. Como owner_key
--        es not null, esos INSERT fallarían. Este trigger la rellena a partir
--        del user_id de la propia fila ANTES de que Postgres compruebe el
--        not null y las políticas RLS (los BEFORE de fila se ejecutan antes
--        que las restricciones y que el WITH CHECK de RLS), así que la app
--        de hoy sigue subiendo sus filas exactamente igual que antes.
--
--      POR QUÉ UN TRIGGER Y NO UN `default auth.uid()`:
--        porque el ámbito tiene que salir del user_id QUE TRAE LA FILA (que
--        la app ya manda y que para las filas personales es auth.uid()), no
--        de la sesión. Así una fila personal nunca puede acabar en un ámbito
--        que no le corresponde, y en las tablas de equipo el ámbito sale de
--        la propia clave (id del equipo, team_id), no del usuario.
--
--      Y ADEMÁS, para que las políticas nuevas no sean MÁS AMPLIAS que las
--      de la 0001 en ningún caso, mantiene las dos garantías que daba la
--      clave primaria vieja (user_id, id) con su WITH CHECK:
--        · al INSERT, user_id = auth.uid() en las seis tablas del cuadrante
--          (nadie escribe una fila atribuyéndosela a otra persona);
--        · al UPDATE, user_id no cambia (nadie reatribuye una fila).
--      Con auth.uid() nulo (SQL Editor, service_role, una migración de datos)
--      no se toca nada, para poder hacer mantenimiento a mano.
--
--      Y EN UPDATE: prohíbe cambiar owner_key. Mudar filas de un ámbito a
--      otro —llevarse a lo personal una fila del equipo, por ejemplo— tiene
--      que ser una operación explícita y revisada (una función RPC), nunca
--      un UPDATE suelto del cliente. Si no, un member podría «robar» filas
--      del equipo: el WITH CHECK mira el ámbito NUEVO (el suyo personal, que
--      sí puede escribir) y la USING mira el VIEJO (el del equipo, que
--      también puede escribir), así que las dos políticas pasarían.
--      Se permite, eso sí, el relleno inicial (fila con owner_key null, es
--      decir, la primera pasada de esta migración) y los contextos de
--      mantenimiento (SQL Editor / service_role), que son los que podrían
--      necesitar una migración de datos de verdad.
-- ---------------------------------------------------------------------
create or replace function public.horus_owner_key_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Las seis tablas del cuadrante tienen user_id; las dos de equipo no
  -- (horus_teams usa owner_id y horus_team_members se identifica por
  -- (team_id, user_id), pero su «quién escribe» no manda sobre el ámbito).
  v_personal boolean;
begin
  v_personal := tg_table_name not in ('horus_teams', 'horus_team_members');

  if tg_op = 'INSERT' then

    -- 1) En las seis tablas del cuadrante, `user_id` es SIEMPRE quien escribe.
    --    Las políticas de la 0001 lo garantizaban (la clave primaria era
    --    (user_id, id) y el WITH CHECK pedía user_id = auth.uid()). Ahora el
    --    ámbito manda para RLS, así que esa garantía se mantiene aquí: nadie
    --    puede escribir una fila atribuyéndosela a otra persona. Con
    --    `auth.uid()` nulo (SQL Editor, service_role, una migración de datos)
    --    no se toca, para poder hacer mantenimiento a mano.
    if v_personal and auth.uid() is not null then
      new.user_id := auth.uid();
    end if;

    -- 2) El ámbito, si el cliente no lo ha mandado (hoy no lo manda nunca).
    if new.owner_key is null then
      if tg_table_name = 'horus_teams' then
        -- El default de `id` (gen_random_uuid) ya está aplicado cuando corre
        -- un BEFORE (los defaults se calculan al formar la fila, antes de los
        -- triggers). La comprobación de null es por si algún día cambia ese
        -- orden: sin ella, owner_key saldría null y el error sería confuso.
        if new.id is null then
          new.id := pg_catalog.gen_random_uuid();
        end if;
        new.owner_key := 'team:' || new.id::text;
      elsif tg_table_name = 'horus_team_members' then
        new.owner_key := 'team:' || new.team_id::text;
      else
        new.owner_key := 'user:' || new.user_id::text;
      end if;
    end if;
    return new;
  end if;

  -- 3) UPDATE: `user_id` es «quién escribió la fila» y no se reescribe. En la
  --    0001 tampoco se podía (el WITH CHECK pedía user_id = auth.uid() y el
  --    USING ya lo exigía en la fila vieja), así que aquí se mantiene igual:
  --    nadie reatribuye una fila a otra persona. Con auth.uid() nulo
  --    (mantenimiento) sí se deja pasar.
  if v_personal and auth.uid() is not null
     and new.user_id is distinct from old.user_id then
    new.user_id := old.user_id;
  end if;

  -- 4) UPDATE: el ámbito de una fila no se cambia a mano.
  if new.owner_key is distinct from old.owner_key then
    if old.owner_key is not null
       and current_user not in ('postgres', 'supabase_admin', 'service_role') then
      raise exception
        'HORUS: el ámbito de una fila (owner_key) no se puede cambiar por un UPDATE (de % a %). Mover filas entre ámbitos requiere una función RPC explícita.',
        old.owner_key, new.owner_key
        using errcode = '42501';   -- insufficient_privilege
    end if;
  end if;
  return new;
end;
$$;

comment on function public.horus_owner_key_guard() is
  'HORUS: rellena owner_key cuando el cliente no la manda (app actual), ata el autor (user_id) a quien escribe y lo deja inmutable, e impide cambiar owner_key en UPDATE.';

-- ---------------------------------------------------------------------
-- 2.2) Un trigger por tabla, para INSERT y para UPDATE (tg_op distingue).
--      `drop trigger if exists` + `create trigger` es idempotente.
--      Convive sin problema con horus_touch_updated_at de la 0001.
-- ---------------------------------------------------------------------
drop trigger if exists horus_owner_key_guard on public.horus_documents;
create trigger horus_owner_key_guard before insert or update on public.horus_documents
  for each row execute function public.horus_owner_key_guard();

drop trigger if exists horus_owner_key_guard on public.horus_members;
create trigger horus_owner_key_guard before insert or update on public.horus_members
  for each row execute function public.horus_owner_key_guard();

drop trigger if exists horus_owner_key_guard on public.horus_shift_types;
create trigger horus_owner_key_guard before insert or update on public.horus_shift_types
  for each row execute function public.horus_owner_key_guard();

drop trigger if exists horus_owner_key_guard on public.horus_entries;
create trigger horus_owner_key_guard before insert or update on public.horus_entries
  for each row execute function public.horus_owner_key_guard();

drop trigger if exists horus_owner_key_guard on public.horus_patterns;
create trigger horus_owner_key_guard before insert or update on public.horus_patterns
  for each row execute function public.horus_owner_key_guard();

drop trigger if exists horus_owner_key_guard on public.horus_day_meta;
create trigger horus_owner_key_guard before insert or update on public.horus_day_meta
  for each row execute function public.horus_owner_key_guard();

drop trigger if exists horus_owner_key_guard on public.horus_teams;
create trigger horus_owner_key_guard before insert or update on public.horus_teams
  for each row execute function public.horus_owner_key_guard();

drop trigger if exists horus_owner_key_guard on public.horus_team_members;
create trigger horus_owner_key_guard before insert or update on public.horus_team_members
  for each row execute function public.horus_owner_key_guard();

-- =====================================================================
-- 3) PERMISOS POR ÁMBITO  ·  horus_can_read / horus_can_write
-- =====================================================================

-- ---------------------------------------------------------------------
-- 3.0) Espejo de los dos helpers de equipo de la 0001 (su apartado 2.3).
--      Se declaran otra vez con `create or replace` y el MISMO cuerpo: así
--      este archivo se comprueba y se ejecuta solo, y en un proyecto con la
--      0001 aplicada la redeclaración es inocua (misma firma, mismo cuerpo).
--      Los privilegios que la 0001 les dio se conservan al reemplazarlas.
-- ---------------------------------------------------------------------
create or replace function public.horus_is_team_member(p_team_id uuid, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.horus_team_members tm
    where tm.team_id = p_team_id
      and tm.user_id = p_user
      and tm.deleted = false
  );
$$;

comment on function public.horus_is_team_member(uuid, uuid) is
  'HORUS: ¿p_user pertenece al equipo p_team_id? SECURITY DEFINER para evitar recursión en RLS.';

create or replace function public.horus_is_team_owner(p_team_id uuid, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.horus_teams t
    where t.id = p_team_id
      and t.owner_id = p_user
  );
$$;

comment on function public.horus_is_team_owner(uuid, uuid) is
  'HORUS: ¿p_user es el dueño del equipo p_team_id? SECURITY DEFINER para evitar recursión en RLS.';

-- ---------------------------------------------------------------------
-- 3.1) horus_can_read(p_owner_key, p_user)
--      'user:<uid>' → solo ese usuario.
--      'team:<tid>' → los miembros del equipo (deleted = false) y su dueño.
--      Cualquier otra cosa (null incluido) → false.
--
--      El uuid se extrae solo cuando el texto cumple el patrón estricto: el
--      CASE de SQL no evalúa las ramas que no le tocan, así que un owner_key
--      con basura devuelve false en lugar de reventar con 22P02 al castear.
-- ---------------------------------------------------------------------
create or replace function public.horus_can_read(p_owner_key text, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_user is null then false
    when p_owner_key = 'user:' || p_user::text then true
    when p_owner_key ~ '^team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.horus_is_team_member(substring(p_owner_key from 6)::uuid, p_user)
        or public.horus_is_team_owner(substring(p_owner_key from 6)::uuid, p_user)
    else false
  end;
$$;

comment on function public.horus_can_read(text, uuid) is
  'HORUS: ¿p_user puede LEER el ámbito p_owner_key? SECURITY DEFINER para evitar recursión en RLS.';

-- ---------------------------------------------------------------------
-- 3.2) horus_can_write(p_owner_key, p_user)
--      'user:<uid>' → solo ese usuario (escribir es igual que leer).
--      'team:<tid>' → owner y admin del equipo, que son quienes editan el
--                     cuadrante completo. El viewer nunca escribe.
--      Cualquier otra cosa (null incluido) → false.
-- ---------------------------------------------------------------------
create or replace function public.horus_can_write(p_owner_key text, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_user is null then false
    when p_owner_key = 'user:' || p_user::text then true
    when p_owner_key ~ '^team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (
        exists (
          select 1
          from public.horus_team_members tm
          where tm.team_id = substring(p_owner_key from 6)::uuid
            and tm.user_id = p_user
            and tm.deleted = false
            -- TODO(fase-2): `member` entra aquí porque la tabla de peticiones
            -- (cambios de turno, vacaciones, marcas propias…) todavía no
            -- existe. Cuando exista, hay que afinarlo: el member solo debería
            -- poder escribir SUS peticiones y SUS marcas, no el cuadrante
            -- entero del equipo. El viewer ya queda fuera.
            and tm.role in ('owner', 'admin', 'member')
        )
        -- El dueño del equipo manda aunque su fila de horus_team_members
        -- todavía no exista (es lo mismo que hacía la 0001 con owner_id).
        or public.horus_is_team_owner(substring(p_owner_key from 6)::uuid, p_user)
      )
    else false
  end;
$$;

comment on function public.horus_can_write(text, uuid) is
  'HORUS: ¿p_user puede ESCRIBIR en el ámbito p_owner_key? SECURITY DEFINER para evitar recursión en RLS.';

-- =====================================================================
-- 4) ENTRAR EN UN EQUIPO CON UN CÓDIGO  ·  horus_join_team
-- =====================================================================
--  Hasta ahora no había forma de que un usuario entrara en un equipo sin que
--  el dueño le insertara la fila a mano (la política de INSERT de
--  horus_team_members exige ser el dueño, a propósito). Esta función hace esa
--  entrada de forma controlada:
--    · valida el código contra horus_teams.invite_code (equipo no borrado);
--    · inserta —o revive, si se había salido— la fila con rol 'member';
--    · si ya es miembro, no toca NADA y devuelve el equipo igualmente;
--    · es IMPOSIBLE ponerse owner o admin por aquí: el rol no es parámetro y
--      el INSERT lo fija a 'member';
--    · limita el equipo a 100 miembros, con un mensaje claro en español;
--    · si el código no vale, no cuenta NADA del equipo (ni existe / ni está
--      borrado): así no sirve para adivinar códigos ni equipos.
--    · el user_id NO es parámetro: es siempre auth.uid(), o sea, uno mismo.
--  Como es SECURITY DEFINER se salta la RLS de horus_team_members, así que
--  `grant execute` solo se le da a `authenticated` (apartado 6).
-- =====================================================================

create or replace function public.horus_join_team(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_team    uuid;
  v_activo  boolean;
  v_cuantos int;
  -- Tope de miembros por equipo. Es un límite «de negocio», así que vive aquí
  -- (y no en una restricción de tabla) para poder dar un mensaje entendible.
  v_tope    constant int := 100;
begin
  if v_user is null then
    raise exception 'HORUS: hace falta una sesión iniciada para entrar en un equipo.'
      using errcode = '28000';   -- invalid_authorization_specification
  end if;

  if p_code is null or btrim(p_code) = '' then
    raise exception 'HORUS: falta el código de invitación.'
      using errcode = '22023';   -- invalid_parameter_value
  end if;

  select t.id
    into v_team
    from public.horus_teams t
   where t.invite_code = btrim(p_code)
     and t.deleted = false;

  if v_team is null then
    -- Un único mensaje para «no existe» y para «está borrado»: el error no
    -- sirve para averiguar qué equipos o qué códigos hay.
    raise exception 'HORUS: el código de invitación no es válido.'
      using errcode = '22023';   -- invalid_parameter_value
  end if;

  -- Bloquea la fila del equipo mientras dura el alta: dos personas entrando a
  -- la vez en el mismo equipo no pueden colarse por encima del tope.
  perform 1 from public.horus_teams t where t.id = v_team for update;

  -- ¿Ya es miembro activo? Entonces no se toca nada (ni el rol).
  select exists (
    select 1
      from public.horus_team_members tm
     where tm.team_id = v_team
       and tm.user_id = v_user
       and tm.deleted = false
  ) into v_activo;

  if v_activo then
    return v_team;
  end if;

  select count(*)
    into v_cuantos
    from public.horus_team_members tm
   where tm.team_id = v_team
     and tm.deleted = false;

  if v_cuantos >= v_tope then
    raise exception 'HORUS: el equipo ya tiene el máximo de % miembros.', v_tope
      using errcode = '23514';   -- check_violation
  end if;

  -- Revive la fila si se había salido (deleted = true). Se vuelve como
  -- 'member' y punto: revivir NO sirve para recuperar un rol alto (a un admin
  -- al que se echó no le devuelve el admin por volver a entrar) ni para
  -- ascender a nadie (un viewer que se sale y vuelve entra como member, igual
  -- que cualquiera que tenga el código: por eso el código se rota). Los roles
  -- altos los pone el dueño del equipo desde horus_team_members.
  -- OJO: al dueño del equipo no se le quita nada aunque su fila vuelva como
  -- member, porque horus_teams.owner_id sigue siendo suyo.
  update public.horus_team_members tm
     set deleted = false,
         joined_at = now(),
         role = 'member'
   where tm.team_id = v_team
     and tm.user_id = v_user
     and tm.deleted = true;

  if not found then
    -- El alias `tm` no se usa para nada: está para que tools/sql-order.mjs no
    -- confunda la lista de columnas con una llamada a una función llamada
    -- «horus_team_members». No lo quites sin volver a pasar el comprobador.
    insert into public.horus_team_members as tm (team_id, user_id, role, owner_key, deleted)
    values (v_team, v_user, 'member', 'team:' || v_team::text, false);
  end if;

  return v_team;
end;
$$;

comment on function public.horus_join_team(text) is
  'HORUS: entra en el equipo del código de invitación y devuelve su id. Alta o revivido como member; nunca owner/admin. SECURITY DEFINER.';

-- =====================================================================
-- 5) POLÍTICAS RLS  ·  el juego nuevo
-- ---------------------------------------------------------------------
--  Quién puede qué:
--      leer      → horus_can_read(owner_key)
--      escribir  → horus_can_write(owner_key)   (insert / update / delete)
--  Resumen de las dos funciones:
--      'user:<uid>'  leer: solo <uid>            escribir: solo <uid>
--      'team:<tid>'  leer: miembros del equipo  escribir: owner y admin
--                                               (+ member, TODO(fase-2))
--      viewer: no escribe nunca.
--  Ninguna política filtra por `deleted`: los tombstones tienen que viajar
--  (es lo que permite que un borrado llegue a los demás dispositivos). La
--  única excepción es la PERTENENCIA al equipo, que exige deleted = false:
--  quien se ha salido del equipo deja de leerlo.
--  Aquí se sueltan (drop policy if exists) TODAS las políticas de la 0001 que
--  esta migración sustituye: al terminar el apartado no queda viva ninguna
--  política antigua en estas ocho tablas. Las de la app antigua
--  (user_data / profiles, con prefijo horus_legacy_) son otra cosa y NO se
--  tocan: ver el apartado 7.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 5.0) RLS activado en las ocho (idempotente; en la 0001 ya lo está).
--      Se repite para que este archivo no deje nunca una tabla sin RLS si
--      alguien lo pega en un proyecto donde no corrió la 0001.
-- ---------------------------------------------------------------------
alter table public.horus_documents    enable row level security;
alter table public.horus_members      enable row level security;
alter table public.horus_shift_types  enable row level security;
alter table public.horus_entries      enable row level security;
alter table public.horus_patterns     enable row level security;
alter table public.horus_day_meta     enable row level security;
alter table public.horus_teams        enable row level security;
alter table public.horus_team_members enable row level security;

-- ---------------------------------------------------------------------
-- 5.1) Las seis tablas del cuadrante: mismo juego de cuatro políticas en
--      todas, cambiando solo el nombre de la tabla.
--      Antes: user_id = auth.uid(). Ahora: el ámbito, que para las filas
--      personales da exactamente el mismo resultado (owner_key =
--      'user:' || auth.uid()), y para las filas de equipo lo decide el rol.
-- ---------------------------------------------------------------------

-- horus_documents
drop policy if exists horus_documents_select_own on public.horus_documents;

-- ---------------------------------------------------------------------
-- Antes de crear nada: se sueltan TODAS las políticas de las tablas del
-- proyecto. Es lo que hace la migración IDEMPOTENTE de verdad.
--
-- Por qué así y no con un «drop policy if exists» por cada política: al
-- reaplicar el archivo, las políticas que crea ESTA migración ya existen y
-- «create policy» falla con «policy ... already exists», y como todo va
-- dentro de una transacción, aborta el archivo entero. Soltando por
-- recorrido no hay que acordarse de añadir un drop cada vez que se añada
-- una política nueva.
-- Las tablas antiguas (user_data, profiles) NO se tocan: no llevan el
-- prefijo horus_.
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public' and tablename like 'horus\_%'
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy horus_documents_select_scope on public.horus_documents
  for select to authenticated
  using (public.horus_can_read(owner_key));

drop policy if exists horus_documents_insert_own on public.horus_documents;
create policy horus_documents_insert_scope on public.horus_documents
  for insert to authenticated
  with check (public.horus_can_write(owner_key));

drop policy if exists horus_documents_update_own on public.horus_documents;
create policy horus_documents_update_scope on public.horus_documents
  for update to authenticated
  using (public.horus_can_write(owner_key))
  with check (public.horus_can_write(owner_key));

drop policy if exists horus_documents_delete_own on public.horus_documents;
create policy horus_documents_delete_scope on public.horus_documents
  for delete to authenticated
  using (public.horus_can_write(owner_key));

-- horus_members
drop policy if exists horus_members_select_own on public.horus_members;
create policy horus_members_select_scope on public.horus_members
  for select to authenticated
  using (public.horus_can_read(owner_key));

drop policy if exists horus_members_insert_own on public.horus_members;
create policy horus_members_insert_scope on public.horus_members
  for insert to authenticated
  with check (public.horus_can_write(owner_key));

drop policy if exists horus_members_update_own on public.horus_members;
create policy horus_members_update_scope on public.horus_members
  for update to authenticated
  using (public.horus_can_write(owner_key))
  with check (public.horus_can_write(owner_key));

drop policy if exists horus_members_delete_own on public.horus_members;
create policy horus_members_delete_scope on public.horus_members
  for delete to authenticated
  using (public.horus_can_write(owner_key));

-- horus_shift_types
drop policy if exists horus_shift_types_select_own on public.horus_shift_types;
create policy horus_shift_types_select_scope on public.horus_shift_types
  for select to authenticated
  using (public.horus_can_read(owner_key));

drop policy if exists horus_shift_types_insert_own on public.horus_shift_types;
create policy horus_shift_types_insert_scope on public.horus_shift_types
  for insert to authenticated
  with check (public.horus_can_write(owner_key));

drop policy if exists horus_shift_types_update_own on public.horus_shift_types;
create policy horus_shift_types_update_scope on public.horus_shift_types
  for update to authenticated
  using (public.horus_can_write(owner_key))
  with check (public.horus_can_write(owner_key));

drop policy if exists horus_shift_types_delete_own on public.horus_shift_types;
create policy horus_shift_types_delete_scope on public.horus_shift_types
  for delete to authenticated
  using (public.horus_can_write(owner_key));

-- horus_entries
drop policy if exists horus_entries_select_own on public.horus_entries;
create policy horus_entries_select_scope on public.horus_entries
  for select to authenticated
  using (public.horus_can_read(owner_key));

drop policy if exists horus_entries_insert_own on public.horus_entries;
create policy horus_entries_insert_scope on public.horus_entries
  for insert to authenticated
  with check (public.horus_can_write(owner_key));

drop policy if exists horus_entries_update_own on public.horus_entries;
create policy horus_entries_update_scope on public.horus_entries
  for update to authenticated
  using (public.horus_can_write(owner_key))
  with check (public.horus_can_write(owner_key));

drop policy if exists horus_entries_delete_own on public.horus_entries;
create policy horus_entries_delete_scope on public.horus_entries
  for delete to authenticated
  using (public.horus_can_write(owner_key));

-- horus_patterns
drop policy if exists horus_patterns_select_own on public.horus_patterns;
create policy horus_patterns_select_scope on public.horus_patterns
  for select to authenticated
  using (public.horus_can_read(owner_key));

drop policy if exists horus_patterns_insert_own on public.horus_patterns;
create policy horus_patterns_insert_scope on public.horus_patterns
  for insert to authenticated
  with check (public.horus_can_write(owner_key));

drop policy if exists horus_patterns_update_own on public.horus_patterns;
create policy horus_patterns_update_scope on public.horus_patterns
  for update to authenticated
  using (public.horus_can_write(owner_key))
  with check (public.horus_can_write(owner_key));

drop policy if exists horus_patterns_delete_own on public.horus_patterns;
create policy horus_patterns_delete_scope on public.horus_patterns
  for delete to authenticated
  using (public.horus_can_write(owner_key));

-- horus_day_meta (su clave natural es (owner_key, day_date))
drop policy if exists horus_day_meta_select_own on public.horus_day_meta;
create policy horus_day_meta_select_scope on public.horus_day_meta
  for select to authenticated
  using (public.horus_can_read(owner_key));

drop policy if exists horus_day_meta_insert_own on public.horus_day_meta;
create policy horus_day_meta_insert_scope on public.horus_day_meta
  for insert to authenticated
  with check (public.horus_can_write(owner_key));

drop policy if exists horus_day_meta_update_own on public.horus_day_meta;
create policy horus_day_meta_update_scope on public.horus_day_meta
  for update to authenticated
  using (public.horus_can_write(owner_key))
  with check (public.horus_can_write(owner_key));

drop policy if exists horus_day_meta_delete_own on public.horus_day_meta;
create policy horus_day_meta_delete_scope on public.horus_day_meta
  for delete to authenticated
  using (public.horus_can_write(owner_key));

-- ---------------------------------------------------------------------
-- 5.2) horus_teams
--      SELECT: quien puede leer el ámbito del equipo (miembros y dueño).
--      INSERT: crear un equipo propio. Aquí NO se puede usar
--              horus_can_write: al crear el equipo todavía no existe la
--              pertenencia, así que la comprobación es «el dueño soy yo»,
--              como en la 0001, más la coherencia del ámbito.
--      UPDATE / DELETE: el dueño del equipo (como en la 0001).
--      Nota: los admin pueden editar todo el cuadrante, pero el alta del
--      equipo, su nombre y su código de invitación siguen siendo cosa del
--      dueño. Si más adelante los admin tienen que poder rotar el código,
--      se les añade aquí (hace falta un helper «owner o admin»).
-- ---------------------------------------------------------------------
drop policy if exists horus_teams_select_member on public.horus_teams;
create policy horus_teams_select_scope on public.horus_teams
  for select to authenticated
  using (public.horus_can_read(owner_key));

drop policy if exists horus_teams_insert_owner on public.horus_teams;
create policy horus_teams_insert_owner on public.horus_teams
  for insert to authenticated
  with check (owner_id = auth.uid() and owner_key = 'team:' || id::text);

drop policy if exists horus_teams_update_owner on public.horus_teams;
create policy horus_teams_update_owner on public.horus_teams
  for update to authenticated
  using (public.horus_is_team_owner(id))
  with check (public.horus_is_team_owner(id) and owner_key = 'team:' || id::text);

drop policy if exists horus_teams_delete_owner on public.horus_teams;
create policy horus_teams_delete_owner on public.horus_teams
  for delete to authenticated
  using (public.horus_is_team_owner(id));

-- ---------------------------------------------------------------------
-- 5.3) horus_team_members
--      SELECT: los miembros del equipo, y cada uno su propia fila. Esa
--              última parte importa: una fila con deleted = true (me salí)
--              deja de ser legible por pertenencia, y sin el
--              `user_id = auth.uid()` la lápida no viajaría a mi dispositivo.
--      INSERT / UPDATE: solo el dueño del equipo (cambiar roles, reactivar,
--              echar a alguien). OJO: no se usa horus_can_write aquí a
--              propósito — hoy incluye a `member`, y un member que pudiera
--              escribir esta tabla se ascendería solo. El alta por código la
--              hace horus_join_team(), que es SECURITY DEFINER y no pasa por
--              estas políticas.
--      DELETE: el dueño, o uno mismo (salirse del equipo), como en la 0001.
-- ---------------------------------------------------------------------
drop policy if exists horus_team_members_select_member on public.horus_team_members;
create policy horus_team_members_select_scope on public.horus_team_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.horus_can_read(owner_key)
  );

drop policy if exists horus_team_members_insert_owner on public.horus_team_members;
create policy horus_team_members_insert_owner on public.horus_team_members
  for insert to authenticated
  with check (
    public.horus_is_team_owner(team_id)
    and owner_key = 'team:' || team_id::text
  );

drop policy if exists horus_team_members_update_owner on public.horus_team_members;
create policy horus_team_members_update_owner on public.horus_team_members
  for update to authenticated
  using (public.horus_is_team_owner(team_id))
  with check (
    public.horus_is_team_owner(team_id)
    and owner_key = 'team:' || team_id::text
  );

drop policy if exists horus_team_members_delete_owner_or_self on public.horus_team_members;
create policy horus_team_members_delete_owner_or_self on public.horus_team_members
  for delete to authenticated
  using (public.horus_is_team_owner(team_id) or user_id = auth.uid());

-- =====================================================================
-- 6) PERMISOS (GRANTs)
-- ---------------------------------------------------------------------
--  Los GRANT de TABLA no cambian: la 0001 ya concede select, insert, update
--  y delete a `authenticated` en las ocho tablas y se lo revoca a `anon`.
--  RLS filtra filas y el GRANT da el privilegio de tabla; siguen haciendo
--  falta los dos.
--  Aquí solo hay que dar EJECUCIÓN a las funciones nuevas. Como en la 0001,
--  se le quita el EXECUTE por defecto a PUBLIC y a anon: si no, cualquiera
--  podría sondear ámbitos usando el parámetro p_user.
-- =====================================================================

revoke all on function public.horus_can_read(text, uuid) from public;
revoke all on function public.horus_can_read(text, uuid) from anon;
grant execute on function public.horus_can_read(text, uuid) to authenticated;

revoke all on function public.horus_can_write(text, uuid) from public;
revoke all on function public.horus_can_write(text, uuid) from anon;
grant execute on function public.horus_can_write(text, uuid) to authenticated;

-- El alta por código solo para usuarios con sesión: es SECURITY DEFINER y
-- escribe en horus_team_members saltándose la RLS, así que no puede quedar
-- al alcance de `anon`.
revoke all on function public.horus_join_team(text) from public;
revoke all on function public.horus_join_team(text) from anon;
grant execute on function public.horus_join_team(text) to authenticated;

-- NOTA (igual que en la 0001): a public.horus_owner_key_guard() se le deja el
-- EXECUTE por defecto a propósito. Es una función de trigger: llamarla a mano
-- da error («trigger functions can only be called as triggers»), así que no
-- aporta seguridad revocarla, y revocarla sí podría interferir con los
-- triggers de INSERT/UPDATE.

-- ---------------------------------------------------------------------
-- 6.1) Aviso a PostgREST: la clave primaria de seis tablas ha cambiado.
--      PostgREST guarda el esquema en caché (incluida la clave primaria) y
--      construye con ella el ON CONFLICT de los upsert del cliente
--      (`Prefer: resolution=merge-duplicates`). Si la caché se queda con la
--      clave vieja (user_id, id), el upsert falla con 42P10 («there is no
--      unique or exclusion constraint matching the ON CONFLICT
--      specification»). El NOTIFY se entrega al hacer COMMIT y fuerza la
--      recarga del esquema.
-- ---------------------------------------------------------------------
notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- 7) LO QUE ESTA MIGRACIÓN **NO** TOCA  (a propósito)
-- ---------------------------------------------------------------------
--  · public.user_data y public.profiles, con sus políticas horus_legacy_*:
--    son de la app ANTIGUA (apartado 9 de la 0001) y se quedan exactamente
--    como están. No forman parte del modelo por ámbito: la app antigua
--    guarda un único JSON por usuario y filtra por user_id = auth.uid(), así
--    que sigue funcionando igual. NO se borra, NO se migra y NO se modifica
--    ningún dato de esas dos tablas.
--  · Los triggers horus_touch_updated_at de la 0001 (uno por tabla) siguen
--    siendo los que mantienen updated_at; aquí solo se AÑADE el trigger del
--    apartado 2 a las mismas tablas, sin tocar los otros.
--  · La publicación Realtime (supabase_realtime con horus_entries y
--    horus_members) se queda como la dejó la 0001. Un cambio de columnas no
--    exige tocar la publicación.
--  · Los GRANT de tabla, igual que en la 0001 (ver el apartado 6).
--
--  PARA COMPROBAR A MANO QUE NO QUEDA NINGUNA POLÍTICA VIEJA VIVA:
--    select tablename, policyname, cmd, qual
--      from pg_policies
--     where schemaname = 'public'
--       and tablename like 'horus_%'
--     order by tablename, cmd, policyname;
--  Lo que tiene que salir, exactamente:
--    · seis tablas del cuadrante: <tabla>_select_scope, _insert_scope,
--      _update_scope y _delete_scope (24 políticas);
--    · horus_teams: _select_scope, _insert_owner, _update_owner,
--      _delete_owner;
--    · horus_team_members: _select_scope, _insert_owner, _update_owner,
--      _delete_owner_or_self;
--    · las horus_legacy_* de user_data y profiles, intactas.
--  Y ninguna <tabla>_*_own ni horus_teams_select_member, que eran las viejas.
-- =====================================================================

-- =====================================================================
--  FIN · HORUS 0002_horus_team_scope.sql
-- =====================================================================
