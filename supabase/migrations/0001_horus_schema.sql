-- =====================================================================
--  HORUS · esquema normalizado + compatibilidad con el modelo antiguo
--  Archivo: supabase/migrations/0001_horus_schema.sql
--
--  CÓMO USARLO
--    Pegar TODO este archivo en el SQL Editor de Supabase y ejecutarlo.
--    Es idempotente: se puede ejecutar varias veces sin romper nada
--    (create table if not exists / drop policy if exists / create or
--    replace function / create index if not exists).
--
--  QUÉ CREA
--    1) horus_documents     un documento (calendario) por usuario
--    2) horus_members       miembros del calendario
--    3) horus_shift_types   catálogo de turnos
--    4) horus_entries       asignaciones miembro + fecha
--    5) horus_patterns      rotaciones reutilizables
--    6) horus_day_meta      metadatos por día (festivo / evento / ...)
--    7) horus_teams         equipos (varios usuarios)
--    8) horus_team_members  pertenencia a equipos
--    +) LEGACY: public.user_data y public.profiles (solo se asegura la
--       forma mínima que espera la app antigua; NO se toca ningún dato).
--
--  MODELO DE SINCRONIZACIÓN
--    - `payload` guarda la entidad tal cual la serializa la app (JSONB).
--    - Las demás columnas son "extraídas": existen para indexar y filtrar.
--    - `client_updated_at` = `updatedAt` (ms epoch) de la entidad; es lo
--      que usa la app para resolver conflictos por last-write-wins.
--    - `updated_at` lo mantiene el trigger del servidor (no la app).
--    - `deleted` es un tombstone: la app lo necesita para propagar
--      borrados a otros dispositivos. OJO: las políticas RLS NO filtran
--      por `deleted` a propósito (si filtraran, la sincronización se
--      quedaría sin saber qué se borró).
--
--  SEGURIDAD (resumen)
--    - RLS activado en las 8 tablas nuevas.
--    - Tablas 1-6: cada usuario solo ve y escribe SUS filas (user_id = auth.uid()).
--    - horus_teams: lo ve el dueño y los miembros del equipo; lo modifica el dueño.
--    - horus_team_members: lo ven los miembros del equipo; lo escriben el dueño
--      (y cada usuario puede borrar su propia fila = salirse del equipo).
--    - Los helpers `horus_is_team_member` / `horus_is_team_owner` son
--      SECURITY DEFINER precisamente para evitar la recursión infinita de RLS
--      cuando una política de horus_team_members necesita leer horus_team_members.
-- =====================================================================

begin;

-- =====================================================================
-- 0) FUNCIONES DE APOYO
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0.1) Trigger genérico: mantener updated_at al día en cada UPDATE.
-- ---------------------------------------------------------------------
create or replace function public.horus_touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.horus_touch_updated_at() is
  'HORUS: trigger BEFORE UPDATE que reescribe updated_at = now().';

-- ---------------------------------------------------------------------
-- 0.2) Helpers de equipo: están en el apartado 2.3, NO aquí.
--      Motivo (error 42P01 «relation public.horus_team_members does not
--      exist»): son funciones `language sql`, y Postgres analiza y planifica
--      su cuerpo al crearlas (check_function_bodies está activo por
--      defecto). Como consultan horus_teams y horus_team_members, tienen que
--      crearse DESPUÉS de esas tablas. Definirlas aquí rompía el script
--      entero en la primera ejecución.
-- ---------------------------------------------------------------------

-- =====================================================================
-- 1) TABLAS DEL USUARIO (una fila por entidad del documento)
--    Clave primaria siempre (user_id, id) — o (user_id, day_date) en day_meta.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1.1) Documentos. El "estado" raíz del calendario de un usuario.
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
-- 1.2) Miembros. `weekly_hours` es NULL cuando no hay contrato definido.
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
-- 1.3) Catálogo de tipos de turno.
--      `placement_order` es el `order` del modelo JS: `order` es palabra
--      reservada en SQL, de ahí el nombre de la columna.
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
-- 1.4) Entradas de turno. Es la tabla grande: casi todo se consulta por
--      (user_id, entry_date) o por (user_id, member_id, entry_date).
--      `type_id` puede ser NULL (turno suelto con bloques propios).
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
-- 1.5) Patrones de rotación.
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
-- 1.6) Metadatos por día. La clave natural es (user_id, day_date),
--      porque `dayMeta` en el documento es un mapa indexado por fecha.
--      day_type aquí es el del modelo normalizeDayMeta:
--      'normal' | 'holiday' | 'event' (sin 'swap', que es de la entrada).
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

-- =====================================================================
-- 2) TABLAS DE EQUIPO
--    Aquí el "dueño" de la fila es owner_id (horus_teams) o user_id
--    (horus_team_members), no hay columna user_id adicional en teams.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 2.1) Equipos. `invite_code` es el código que comparte el dueño.
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
-- 2.2) Pertenencia a equipos. `role` es el rol DENTRO del equipo.
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

-- ---------------------------------------------------------------------
-- 2.3) Helpers de equipo.
--      SECURITY DEFINER + search_path fijo:
--        - rompen la recursión infinita de RLS (una política de
--          horus_team_members que lea horus_team_members volvería a
--          evaluar la misma política → error 42P17 / recursión).
--        - al ejecutarse como el dueño de la función, no se les aplica la
--          RLS de las tablas que consultan.
--      El parámetro p_user es auth.uid() por defecto.
--
--      VAN AQUÍ, y no al principio del archivo, porque son funciones
--      `language sql`: Postgres planifica su cuerpo al crearlas, así que
--      horus_teams y horus_team_members tienen que existir ya.
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

-- =====================================================================
-- 3) ÍNDICES
-- =====================================================================

-- 3.1) Consultas del calendario.
create index if not exists horus_entries_user_date_idx        on public.horus_entries (user_id, entry_date);
create index if not exists horus_entries_user_member_date_idx on public.horus_entries (user_id, member_id, entry_date);
create index if not exists horus_entries_user_type_date_idx   on public.horus_entries (user_id, type_id, entry_date);
create index if not exists horus_shift_types_user_order_idx   on public.horus_shift_types (user_id, placement_order);

-- 3.2) Índice de pull incremental: "dame lo que ha cambiado desde X".
--      Uno por tabla (en horus_teams el usuario es owner_id).
create index if not exists horus_documents_sync_idx     on public.horus_documents     (user_id,  deleted, updated_at);
create index if not exists horus_members_sync_idx       on public.horus_members       (user_id,  deleted, updated_at);
create index if not exists horus_shift_types_sync_idx   on public.horus_shift_types   (user_id,  deleted, updated_at);
create index if not exists horus_entries_sync_idx       on public.horus_entries       (user_id,  deleted, updated_at);
create index if not exists horus_patterns_sync_idx      on public.horus_patterns      (user_id,  deleted, updated_at);
create index if not exists horus_day_meta_sync_idx      on public.horus_day_meta      (user_id,  deleted, updated_at);
create index if not exists horus_teams_sync_idx         on public.horus_teams         (owner_id, deleted, updated_at);
create index if not exists horus_team_members_sync_idx  on public.horus_team_members  (user_id,  deleted, updated_at);

-- 3.3) "¿A qué equipos pertenezco?" y "¿quién está en este equipo?".
create index if not exists horus_team_members_user_idx  on public.horus_team_members (user_id);
create index if not exists horus_team_members_team_idx  on public.horus_team_members (team_id);

-- =====================================================================
-- 4) TRIGGERS updated_at (las 8 tablas)
-- =====================================================================

drop trigger if exists horus_touch_updated_at on public.horus_documents;
create trigger horus_touch_updated_at before update on public.horus_documents
  for each row execute function public.horus_touch_updated_at();

drop trigger if exists horus_touch_updated_at on public.horus_members;
create trigger horus_touch_updated_at before update on public.horus_members
  for each row execute function public.horus_touch_updated_at();

drop trigger if exists horus_touch_updated_at on public.horus_shift_types;
create trigger horus_touch_updated_at before update on public.horus_shift_types
  for each row execute function public.horus_touch_updated_at();

drop trigger if exists horus_touch_updated_at on public.horus_entries;
create trigger horus_touch_updated_at before update on public.horus_entries
  for each row execute function public.horus_touch_updated_at();

drop trigger if exists horus_touch_updated_at on public.horus_patterns;
create trigger horus_touch_updated_at before update on public.horus_patterns
  for each row execute function public.horus_touch_updated_at();

drop trigger if exists horus_touch_updated_at on public.horus_day_meta;
create trigger horus_touch_updated_at before update on public.horus_day_meta
  for each row execute function public.horus_touch_updated_at();

drop trigger if exists horus_touch_updated_at on public.horus_teams;
create trigger horus_touch_updated_at before update on public.horus_teams
  for each row execute function public.horus_touch_updated_at();

drop trigger if exists horus_touch_updated_at on public.horus_team_members;
create trigger horus_touch_updated_at before update on public.horus_team_members
  for each row execute function public.horus_touch_updated_at();

-- =====================================================================
-- 5) RLS: activar en todas las tablas
--    (enable row level security no falla si ya estaba activado)
-- =====================================================================

alter table public.horus_documents    enable row level security;
alter table public.horus_members      enable row level security;
alter table public.horus_shift_types  enable row level security;
alter table public.horus_entries      enable row level security;
alter table public.horus_patterns     enable row level security;
alter table public.horus_day_meta     enable row level security;
alter table public.horus_teams        enable row level security;
alter table public.horus_team_members enable row level security;

-- =====================================================================
-- 6) POLÍTICAS RLS
--    Patrón: drop policy if exists + create policy (idempotente).
--    Ninguna política filtra por `deleted`: los tombstones deben viajar.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 6.1) Tablas 1-6: solo el dueño de la fila (user_id = auth.uid()).
-- ---------------------------------------------------------------------

-- horus_documents
drop policy if exists horus_documents_select_own on public.horus_documents;
create policy horus_documents_select_own on public.horus_documents
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists horus_documents_insert_own on public.horus_documents;
create policy horus_documents_insert_own on public.horus_documents
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists horus_documents_update_own on public.horus_documents;
create policy horus_documents_update_own on public.horus_documents
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists horus_documents_delete_own on public.horus_documents;
create policy horus_documents_delete_own on public.horus_documents
  for delete to authenticated
  using (user_id = auth.uid());

-- horus_members
drop policy if exists horus_members_select_own on public.horus_members;
create policy horus_members_select_own on public.horus_members
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists horus_members_insert_own on public.horus_members;
create policy horus_members_insert_own on public.horus_members
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists horus_members_update_own on public.horus_members;
create policy horus_members_update_own on public.horus_members
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists horus_members_delete_own on public.horus_members;
create policy horus_members_delete_own on public.horus_members
  for delete to authenticated
  using (user_id = auth.uid());

-- horus_shift_types
drop policy if exists horus_shift_types_select_own on public.horus_shift_types;
create policy horus_shift_types_select_own on public.horus_shift_types
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists horus_shift_types_insert_own on public.horus_shift_types;
create policy horus_shift_types_insert_own on public.horus_shift_types
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists horus_shift_types_update_own on public.horus_shift_types;
create policy horus_shift_types_update_own on public.horus_shift_types
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists horus_shift_types_delete_own on public.horus_shift_types;
create policy horus_shift_types_delete_own on public.horus_shift_types
  for delete to authenticated
  using (user_id = auth.uid());

-- horus_entries
drop policy if exists horus_entries_select_own on public.horus_entries;
create policy horus_entries_select_own on public.horus_entries
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists horus_entries_insert_own on public.horus_entries;
create policy horus_entries_insert_own on public.horus_entries
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists horus_entries_update_own on public.horus_entries;
create policy horus_entries_update_own on public.horus_entries
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists horus_entries_delete_own on public.horus_entries;
create policy horus_entries_delete_own on public.horus_entries
  for delete to authenticated
  using (user_id = auth.uid());

-- horus_patterns
drop policy if exists horus_patterns_select_own on public.horus_patterns;
create policy horus_patterns_select_own on public.horus_patterns
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists horus_patterns_insert_own on public.horus_patterns;
create policy horus_patterns_insert_own on public.horus_patterns
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists horus_patterns_update_own on public.horus_patterns;
create policy horus_patterns_update_own on public.horus_patterns
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists horus_patterns_delete_own on public.horus_patterns;
create policy horus_patterns_delete_own on public.horus_patterns
  for delete to authenticated
  using (user_id = auth.uid());

-- horus_day_meta (la clave natural es (user_id, day_date))
drop policy if exists horus_day_meta_select_own on public.horus_day_meta;
create policy horus_day_meta_select_own on public.horus_day_meta
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists horus_day_meta_insert_own on public.horus_day_meta;
create policy horus_day_meta_insert_own on public.horus_day_meta
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists horus_day_meta_update_own on public.horus_day_meta;
create policy horus_day_meta_update_own on public.horus_day_meta
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists horus_day_meta_delete_own on public.horus_day_meta;
create policy horus_day_meta_delete_own on public.horus_day_meta
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 6.2) horus_teams
--      SELECT: el dueño y cualquier miembro del equipo.
--      INSERT: solo creando un equipo propio.
--      UPDATE / DELETE: solo el dueño.
--      Se usan los helpers SECURITY DEFINER para no re-evaluar la RLS de
--      horus_team_members desde dentro de una política.
-- ---------------------------------------------------------------------
drop policy if exists horus_teams_select_member on public.horus_teams;
create policy horus_teams_select_member on public.horus_teams
  for select to authenticated
  using (owner_id = auth.uid() or public.horus_is_team_member(id));

drop policy if exists horus_teams_insert_owner on public.horus_teams;
create policy horus_teams_insert_owner on public.horus_teams
  for insert to authenticated
  with check (owner_id = auth.uid());

drop policy if exists horus_teams_update_owner on public.horus_teams;
create policy horus_teams_update_owner on public.horus_teams
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists horus_teams_delete_owner on public.horus_teams;
create policy horus_teams_delete_owner on public.horus_teams
  for delete to authenticated
  using (owner_id = auth.uid());

-- ---------------------------------------------------------------------
-- 6.3) horus_team_members
--      SELECT: los miembros del equipo (+ el dueño, para que pueda leer
--              el roster aunque su propia fila aún no exista).
--      INSERT: solo el dueño del equipo.
--      UPDATE: solo el dueño (cambiar roles, reactivar, etc.).
--      DELETE: el dueño, o el propio usuario (salirse del equipo).
--      `horus_is_team_member(team_id)` es SECURITY DEFINER: lee la tabla
--      sin disparar esta misma política → sin recursión infinita.
-- ---------------------------------------------------------------------
drop policy if exists horus_team_members_select_member on public.horus_team_members;
create policy horus_team_members_select_member on public.horus_team_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.horus_is_team_member(team_id)
    or public.horus_is_team_owner(team_id)
  );

--      (La entrada a un equipo la hace el dueño. Un alta por código de
--      invitación necesitaría una función RPC security definer aparte,
--      que NO se define aquí: no queremos que cualquiera pueda insertarse
--      a sí mismo en un equipo con solo conocer su uuid.)
drop policy if exists horus_team_members_insert_owner on public.horus_team_members;
create policy horus_team_members_insert_owner on public.horus_team_members
  for insert to authenticated
  with check (public.horus_is_team_owner(team_id));

drop policy if exists horus_team_members_update_owner on public.horus_team_members;
create policy horus_team_members_update_owner on public.horus_team_members
  for update to authenticated
  using (public.horus_is_team_owner(team_id))
  with check (public.horus_is_team_owner(team_id));

drop policy if exists horus_team_members_delete_owner_or_self on public.horus_team_members;
create policy horus_team_members_delete_owner_or_self on public.horus_team_members
  for delete to authenticated
  using (public.horus_is_team_owner(team_id) or user_id = auth.uid());

-- =====================================================================
-- 7) PERMISOS (GRANTs)
--    RLS filtra FILAS, pero el rol necesita además privilegios de tabla.
--    `anon` no recibe nada: la sincronización exige sesión iniciada.
-- =====================================================================

grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on table public.horus_documents    to authenticated;
grant select, insert, update, delete on table public.horus_members      to authenticated;
grant select, insert, update, delete on table public.horus_shift_types  to authenticated;
grant select, insert, update, delete on table public.horus_entries      to authenticated;
grant select, insert, update, delete on table public.horus_patterns     to authenticated;
grant select, insert, update, delete on table public.horus_day_meta     to authenticated;
grant select, insert, update, delete on table public.horus_teams        to authenticated;
grant select, insert, update, delete on table public.horus_team_members to authenticated;

revoke all on table public.horus_documents    from anon;
revoke all on table public.horus_members      from anon;
revoke all on table public.horus_shift_types  from anon;
revoke all on table public.horus_entries      from anon;
revoke all on table public.horus_patterns     from anon;
revoke all on table public.horus_day_meta     from anon;
revoke all on table public.horus_teams        from anon;
revoke all on table public.horus_team_members from anon;

-- Los helpers de equipo solo los puede invocar un usuario autenticado:
-- si no, cualquiera podría sondear la pertenencia a un equipo con el
-- parámetro p_user.
revoke all on function public.horus_is_team_member(uuid, uuid) from public;
revoke all on function public.horus_is_team_member(uuid, uuid) from anon;
grant execute on function public.horus_is_team_member(uuid, uuid) to authenticated;

revoke all on function public.horus_is_team_owner(uuid, uuid) from public;
revoke all on function public.horus_is_team_owner(uuid, uuid) from anon;
grant execute on function public.horus_is_team_owner(uuid, uuid) to authenticated;

-- NOTA: a `public.horus_touch_updated_at()` se le deja el EXECUTE por
-- defecto a propósito. Es una función de trigger: invocarla a mano da
-- error ("trigger functions can only be called as triggers"), así que no
-- aporta seguridad revocarla, y revocarla sí podría interferir con la
-- ejecución de los triggers de UPDATE.

-- =====================================================================
-- 8) REALTIME
--    Añadir horus_entries y horus_members a la publicación para que un
--    segundo dispositivo reciba los cambios en vivo.
--    Se comprueba pg_publication / pg_publication_tables para que no
--    falle si la publicación no existe o si la tabla ya está dentro
--    (ALTER PUBLICATION ... ADD TABLE da error si ya es miembro, y
--    también si la publicación es FOR ALL TABLES).
-- =====================================================================
do $$
declare
  v_pub text := 'supabase_realtime';
begin
  if exists (
    select 1
    from pg_publication p
    where p.pubname = v_pub
      and p.puballtables = false
  ) then
    if not exists (
      select 1
      from pg_publication_tables t
      where t.pubname = v_pub
        and t.schemaname = 'public'
        and t.tablename = 'horus_entries'
    ) then
      execute format('alter publication %I add table public.horus_entries', v_pub);
    end if;

    if not exists (
      select 1
      from pg_publication_tables t
      where t.pubname = v_pub
        and t.schemaname = 'public'
        and t.tablename = 'horus_members'
    ) then
      execute format('alter publication %I add table public.horus_members', v_pub);
    end if;
  else
    raise notice 'HORUS: la publicacion % no existe (o es FOR ALL TABLES); se omite Realtime.', v_pub;
  end if;
end;
$$;

commit;

-- =====================================================================
--  9) COMPATIBILIDAD CON LA APP ANTIGUA  ·  public.user_data / profiles
-- ---------------------------------------------------------------------
--  La versión antigua de HORUS guardaba TODO el estado en un único JSON:
--    public.user_data(user_id uuid, data jsonb, updated_at timestamptz)
--    public.profiles(id uuid, onboarding_complete bool)
--  Esas tablas YA EXISTEN en el proyecto en producción y puede haber
--  alguien con la app antigua abierta en el navegador. Esta sección:
--    - solo se ASEGURA de que existan con la forma mínima esperada,
--    - NO borra, NO migra y NO modifica ningún dato existente,
--    - es idempotente (se puede volver a ejecutar sin efectos).
--  Ojo: `create table if not exists` no toca una tabla ya existente, y
--  `alter table ... add column if not exists` solo añade lo que falte.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 9.1) public.user_data  (blob JSON del estado antiguo)
-- ---------------------------------------------------------------------
create table if not exists public.user_data (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Si la tabla ya existía, añadir solo lo que falte (sin tocar datos).
alter table public.user_data add column if not exists user_id    uuid;
alter table public.user_data add column if not exists data       jsonb not null default '{}'::jsonb;
alter table public.user_data add column if not exists updated_at timestamptz not null default now();

comment on table public.user_data is
  'HORUS (legacy): estado completo de la app antigua en un único JSONB. Solo compatibilidad.';

-- ---------------------------------------------------------------------
-- 9.2) public.profiles  (marca de onboarding de la app antigua)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id                  uuid        primary key references auth.users(id) on delete cascade,
  onboarding_complete boolean     not null default false
);

alter table public.profiles add column if not exists id                  uuid;
alter table public.profiles add column if not exists onboarding_complete boolean not null default false;

comment on table public.profiles is
  'HORUS (legacy): perfil mínimo de la app antigua (onboarding_complete). Solo compatibilidad.';

-- ---------------------------------------------------------------------
-- 9.3) Permisos para el cliente antiguo (usa la anon key + JWT del
--      usuario, por lo que el rol efectivo es `authenticated`).
--      No se revoca nada a `anon` aquí para no cambiar el comportamiento
--      de una tabla que ya está en producción.
-- ---------------------------------------------------------------------
grant select, insert, update, delete on table public.user_data to authenticated;
grant select, insert, update, delete on table public.profiles  to authenticated;

-- ---------------------------------------------------------------------
-- 9.4) Políticas RLS owner-only para las tablas antiguas.
--      Son idempotentes y SOLO se aplican si RLS está activado en la
--      tabla (si no lo está, quedan inertes y todo sigue funcionando
--      exactamente igual que antes).
--      Para consultar el estado actual:
--        select relname, relrowsecurity
--        from pg_class where relname in ('user_data','profiles');
--      Si quieres activar RLS (la app antigua solo lee/escribe filas con
--      user_id = auth.uid(), así que seguiría funcionando), descomenta:
--        alter table public.user_data enable row level security;
--        alter table public.profiles  enable row level security;
-- ---------------------------------------------------------------------
--      Las políticas llevan prefijo `horus_legacy_` a propósito: así este
--      script nunca borra una política que ya existiera en la tabla en
--      producción (solo gestiona las suyas).
drop policy if exists horus_legacy_user_data_select_own on public.user_data;
create policy horus_legacy_user_data_select_own on public.user_data
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists horus_legacy_user_data_insert_own on public.user_data;
create policy horus_legacy_user_data_insert_own on public.user_data
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists horus_legacy_user_data_update_own on public.user_data;
create policy horus_legacy_user_data_update_own on public.user_data
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists horus_legacy_user_data_delete_own on public.user_data;
create policy horus_legacy_user_data_delete_own on public.user_data
  for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists horus_legacy_profiles_select_own on public.profiles;
create policy horus_legacy_profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists horus_legacy_profiles_insert_own on public.profiles;
create policy horus_legacy_profiles_insert_own on public.profiles
  for insert to authenticated
  with check (id = auth.uid());

drop policy if exists horus_legacy_profiles_update_own on public.profiles;
create policy horus_legacy_profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists horus_legacy_profiles_delete_own on public.profiles;
create policy horus_legacy_profiles_delete_own on public.profiles
  for delete to authenticated
  using (id = auth.uid());

-- =====================================================================
--  FIN · HORUS 0001_horus_schema.sql
-- =====================================================================
