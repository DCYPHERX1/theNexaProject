create extension if not exists pgcrypto;

do $$ begin
  create type public.user_role as enum ('student', 'staff', 'hod', 'admin', 'super_admin');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.upload_status as enum ('draft', 'submitted', 'pending_review', 'approved', 'rejected');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.material_type as enum ('pdf', 'slide', 'past_question');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.academic_level as enum ('100L', '200L', '300L', '400L', '500L');
exception when duplicate_object then null;
end $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  metadata jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  app_metadata jsonb := coalesce(new.raw_app_meta_data, '{}'::jsonb);
  requested_role text := lower(coalesce(app_metadata->>'role', metadata->>'role', 'student'));
  safe_role public.user_role := case
    when requested_role in ('staff', 'hod', 'admin', 'super_admin') then requested_role::public.user_role
    else 'student'::public.user_role
  end;
begin
  insert into public.profiles (
    id,
    email,
    full_name,
    role,
    matric_number,
    level,
    staff_id,
    staff_email,
    department,
    status,
    updated_at
  )
  values (
    new.id,
    new.email,
    coalesce(metadata->>'full_name', metadata->>'name', new.email),
    safe_role,
    case when safe_role = 'student' then nullif(metadata->>'matric_number', '') else null end,
    case when safe_role = 'student' and nullif(metadata->>'level', '') is not null then (metadata->>'level')::public.academic_level else null end,
    case when safe_role <> 'student' then nullif(metadata->>'staff_id', '') else null end,
    case when safe_role <> 'student' then coalesce(nullif(metadata->>'staff_email', ''), new.email) else null end,
    coalesce(nullif(metadata->>'department', ''), 'Agricultural and Resource Economics'),
    case when safe_role = 'student' then 'active' else 'pending' end,
    now()
  )
  on conflict (id) do update
  set email = excluded.email,
      full_name = excluded.full_name,
      role = excluded.role,
      matric_number = excluded.matric_number,
      level = excluded.level,
      staff_id = excluded.staff_id,
      staff_email = excluded.staff_email,
      department = excluded.department,
      status = excluded.status,
      updated_at = now();

  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  role public.user_role not null default 'student',
  matric_number text unique,
  staff_id text unique,
  staff_email text,
  level public.academic_level,
  department text,
  avatar_url text,
  status text not null default 'active' check (status in ('active', 'pending', 'suspended')),
  notification_preferences jsonb not null default '{"email": true, "in_app": true}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists role public.user_role not null default 'student';
alter table public.profiles add column if not exists matric_number text;
alter table public.profiles add column if not exists staff_id text;
alter table public.profiles add column if not exists staff_email text;
alter table public.profiles add column if not exists level public.academic_level;
alter table public.profiles add column if not exists department text;
alter table public.profiles add column if not exists title text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists status text not null default 'active';
alter table public.profiles add column if not exists notification_preferences jsonb not null default '{"email": true, "in_app": true}'::jsonb;
alter table public.profiles add column if not exists created_at timestamptz not null default now();
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

alter table public.profiles drop constraint if exists profiles_email_unique;
alter table public.profiles drop constraint if exists profiles_matric_number_unique;
alter table public.profiles drop constraint if exists profiles_staff_id_unique;
alter table public.profiles drop constraint if exists profiles_staff_email_unique;
drop index if exists public.profiles_email_unique;
drop index if exists public.profiles_matric_number_unique;
drop index if exists public.profiles_staff_id_unique;
drop index if exists public.profiles_staff_email_unique;

create unique index if not exists profiles_email_unique_idx
on public.profiles (email)
where email is not null;

create unique index if not exists profiles_matric_number_unique_idx
on public.profiles (matric_number)
where matric_number is not null;

create unique index if not exists profiles_staff_id_unique_idx
on public.profiles (staff_id)
where staff_id is not null;

create unique index if not exists profiles_staff_email_unique_idx
on public.profiles (staff_email)
where staff_email is not null;

alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles
  add constraint profiles_status_check
  check (status in ('active', 'pending', 'suspended'));

update public.profiles
set role = 'student'
where role is null;

update public.profiles
set email = coalesce(email, id::text || '@nexa.local')
where email is null;

update public.profiles
set matric_number = coalesce(matric_number, 'MIG-' || replace(id::text, '-', ''))
where role::text = 'student'
  and matric_number is null;

update public.profiles
set staff_id = coalesce(staff_id, 'STAFF-MIG-' || replace(id::text, '-', '')),
    staff_email = coalesce(staff_email, email, 'staff-' || replace(id::text, '-', '') || '@futa.edu.ng'),
    status = case when status = 'active' then 'pending' else status end
where role::text in ('staff', 'hod', 'admin', 'super_admin')
  and (staff_id is null or staff_email is null);

do $$ declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%staff_id%'
      and pg_get_constraintdef(oid) like '%matric_number%'
  loop
    execute format('alter table public.profiles drop constraint if exists %I', constraint_name);
  end loop;
end $$;

alter table public.profiles drop constraint if exists profiles_role_required_details;

alter table public.profiles
  add constraint profiles_role_required_details
  check (
    (role::text = 'student' and matric_number is not null and staff_id is null)
    or (role::text in ('staff', 'hod', 'admin', 'super_admin') and staff_id is not null and staff_email is not null)
  );

do $$ declare
  trigger_name text;
begin
  for trigger_name in
    select tgname
    from pg_trigger
    where tgrelid = 'auth.users'::regclass
      and not tgisinternal
  loop
    execute format('drop trigger if exists %I on auth.users', trigger_name);
  end loop;
end $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  abstract text,
  category text,
  year int not null check (year between 1990 and 2100),
  level public.academic_level,
  authors text[] not null default '{}',
  supervisor text,
  department text,
  file_path text,
  protected_file_id uuid,
  book_id text,
  cabinet text,
  archive_row text,
  archive_column text,
  cover_url text,
  uploaded_by uuid references public.profiles(id) on delete set null,
  status public.upload_status not null default 'draft',
  review_comment text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.academic_materials (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  course_code text not null,
  course_title text,
  level public.academic_level not null,
  material_type public.material_type not null,
  year int check (year between 1990 and 2100),
  department text,
  file_path text not null,
  protected_file_id uuid references public.protected_files(id) on delete set null,
  uploaded_by uuid references public.profiles(id) on delete set null,
  status public.upload_status not null default 'draft',
  review_comment text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.protected_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles(id) on delete set null,
  title text not null,
  original_name text not null,
  storage_path text not null,
  mime_type text,
  file_size bigint,
  status public.upload_status not null default 'pending_review',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.projects add column if not exists title text;
alter table public.projects add column if not exists abstract text;
alter table public.projects add column if not exists category text;
alter table public.projects add column if not exists year int;
alter table public.projects add column if not exists level public.academic_level;
alter table public.projects add column if not exists authors text[] not null default '{}';
alter table public.projects add column if not exists supervisor text;
alter table public.projects add column if not exists department text;
alter table public.projects add column if not exists file_path text;
alter table public.projects add column if not exists protected_file_id uuid;
alter table public.projects add column if not exists book_id text;
alter table public.projects add column if not exists cabinet text;
alter table public.projects add column if not exists archive_row text;
alter table public.projects add column if not exists archive_column text;
alter table public.projects add column if not exists cover_url text;
alter table public.projects add column if not exists uploaded_by uuid;
alter table public.projects add column if not exists status public.upload_status not null default 'draft';
alter table public.projects add column if not exists review_comment text;
alter table public.projects add column if not exists reviewed_by uuid;
alter table public.projects add column if not exists reviewed_at timestamptz;
alter table public.projects add column if not exists created_at timestamptz not null default now();
alter table public.projects add column if not exists updated_at timestamptz not null default now();

alter table public.academic_materials add column if not exists title text;
alter table public.academic_materials add column if not exists course_code text;
alter table public.academic_materials add column if not exists course_title text;
alter table public.academic_materials add column if not exists level public.academic_level;
alter table public.academic_materials add column if not exists material_type public.material_type;
alter table public.academic_materials add column if not exists year int;
alter table public.academic_materials add column if not exists department text;
alter table public.academic_materials add column if not exists file_path text;
alter table public.academic_materials add column if not exists protected_file_id uuid;
alter table public.academic_materials add column if not exists uploaded_by uuid;
alter table public.academic_materials add column if not exists status public.upload_status not null default 'draft';
alter table public.academic_materials add column if not exists review_comment text;
alter table public.academic_materials add column if not exists reviewed_by uuid;
alter table public.academic_materials add column if not exists reviewed_at timestamptz;
alter table public.academic_materials add column if not exists created_at timestamptz not null default now();
alter table public.academic_materials add column if not exists updated_at timestamptz not null default now();

alter table public.protected_files add column if not exists owner_id uuid;
alter table public.protected_files add column if not exists title text;
alter table public.protected_files add column if not exists file_name text;
alter table public.protected_files add column if not exists original_name text;
alter table public.protected_files add column if not exists storage_path text;
alter table public.protected_files add column if not exists mime_type text;
alter table public.protected_files add column if not exists file_size bigint;
alter table public.protected_files add column if not exists status public.upload_status not null default 'pending_review';
alter table public.protected_files add column if not exists created_at timestamptz not null default now();
alter table public.protected_files add column if not exists updated_at timestamptz not null default now();

do $$ begin
  alter table public.projects
  add constraint projects_protected_file_id_fkey
  foreign key (protected_file_id) references public.protected_files(id) on delete set null;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.projects
  add constraint projects_uploaded_by_fkey
  foreign key (uploaded_by) references public.profiles(id) on delete set null;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.projects
  add constraint projects_reviewed_by_fkey
  foreign key (reviewed_by) references public.profiles(id) on delete set null;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.academic_materials
  add constraint academic_materials_protected_file_id_fkey
  foreign key (protected_file_id) references public.protected_files(id) on delete set null;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.academic_materials
  add constraint academic_materials_uploaded_by_fkey
  foreign key (uploaded_by) references public.profiles(id) on delete set null;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.academic_materials
  add constraint academic_materials_reviewed_by_fkey
  foreign key (reviewed_by) references public.profiles(id) on delete set null;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.protected_files
  add constraint protected_files_owner_id_fkey
  foreign key (owner_id) references public.profiles(id) on delete set null;
exception when duplicate_object then null;
end $$;

create table if not exists public.saved_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  material_id uuid references public.academic_materials(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (
    (project_id is not null and material_id is null)
    or (project_id is null and material_id is not null)
  ),
  unique (user_id, project_id),
  unique (user_id, material_id)
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  target_role public.user_role,
  target_user_id uuid references public.profiles(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (target_role is not null or target_user_id is not null)
);

create table if not exists public.notification_reads (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  email text not null,
  subject text not null,
  message text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  assigned_to uuid references public.profiles(id) on delete set null,
  admin_reply text,
  replied_at timestamptz,
  replied_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.support_requests
  add column if not exists admin_reply text,
  add column if not exists replied_at timestamptz,
  add column if not exists replied_by uuid references public.profiles(id) on delete set null;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.maintenance_state (
  id bool primary key default true,
  enabled bool not null default false,
  message text not null default 'Maintenance in progress. Please check back shortly.',
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (id)
);

insert into public.maintenance_state (id)
values (true)
on conflict (id) do nothing;

create table if not exists public.security_system_status (
  id uuid primary key default gen_random_uuid(),
  singleton_key bool not null default true unique,
  mode text not null default 'NORMAL' check (mode in ('NORMAL', 'WARNING', 'LOCKDOWN', 'MAINTENANCE')),
  reason text,
  changed_by uuid references public.profiles(id) on delete set null,
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (singleton_key)
);

alter table public.security_system_status
  add column if not exists singleton_key bool not null default true;

create unique index if not exists security_system_status_singleton_key_idx
on public.security_system_status (singleton_key);

insert into public.security_system_status (singleton_key)
values (true)
on conflict (singleton_key) do nothing;

create table if not exists public.security_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  actor_email text,
  action text not null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'high', 'critical')),
  ip_address text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.security_logs add column if not exists actor_id uuid references public.profiles(id) on delete set null;
alter table public.security_logs add column if not exists actor_email text;
alter table public.security_logs add column if not exists action text not null default 'security.event';
alter table public.security_logs add column if not exists severity text not null default 'info';
alter table public.security_logs add column if not exists ip_address text;
alter table public.security_logs add column if not exists user_agent text;
alter table public.security_logs add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.security_logs add column if not exists created_at timestamptz not null default now();

create table if not exists public.security_alerts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  severity text not null default 'warning' check (severity in ('info', 'warning', 'high', 'critical', 'emergency')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'investigating', 'resolved')),
  metadata jsonb not null default '{}'::jsonb,
  acknowledged_by uuid references public.profiles(id) on delete set null,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.security_alerts add column if not exists title text not null default 'Security alert';
alter table public.security_alerts add column if not exists severity text not null default 'warning';
alter table public.security_alerts add column if not exists status text not null default 'open';
alter table public.security_alerts add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.security_alerts add column if not exists acknowledged_by uuid references public.profiles(id) on delete set null;
alter table public.security_alerts add column if not exists acknowledged_at timestamptz;
alter table public.security_alerts add column if not exists created_at timestamptz not null default now();
alter table public.security_alerts add column if not exists updated_at timestamptz not null default now();

create table if not exists public.security_threats (
  id uuid primary key default gen_random_uuid(),
  ip_address inet,
  category text not null,
  status text not null default 'monitored' check (status in ('allowed', 'monitored', 'challenged', 'blocked')),
  severity text not null default 'warning' check (severity in ('low', 'medium', 'high', 'critical')),
  threat_score int not null default 0 check (threat_score between 0 and 100),
  request_count int not null default 0,
  description text,
  source text not null default 'sentinel',
  metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.security_monitoring_snapshots (
  id uuid primary key default gen_random_uuid(),
  requests_per_second int not null default 0,
  api_usage_percent int not null default 0 check (api_usage_percent between 0 and 100),
  suspicious_routes int not null default 0,
  average_response_ms int not null default 0,
  active_connections jsonb not null default '[]'::jsonb,
  resource_usage jsonb not null default '{}'::jsonb,
  heatmap int[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.security_backup_points (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  size_label text,
  status text not null default 'successful' check (status in ('successful', 'warning', 'failed', 'pending')),
  integrity text not null default 'verified',
  storage_target text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.security_settings (
  id uuid primary key default gen_random_uuid(),
  singleton_key bool not null default true unique,
  policies jsonb not null default '{}'::jsonb,
  api_controls jsonb not null default '{}'::jsonb,
  infrastructure_controls jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (singleton_key)
);

alter table public.security_settings
  add column if not exists singleton_key bool not null default true;

create unique index if not exists security_settings_singleton_key_idx
on public.security_settings (singleton_key);

insert into public.security_settings (singleton_key)
values (true)
on conflict (singleton_key) do nothing;

create table if not exists public.admin_root_settings (
  id uuid primary key default gen_random_uuid(),
  singleton_key bool not null default true unique,
  theme text not null default 'Nexaa Classic',
  accent text not null default 'Gold' check (accent in ('Gold', 'Emerald')),
  dashboard_title text not null default 'Root Control Center',
  welcome_text text not null default 'Manage users, reviews, staff IDs, uploads, and archive operations.',
  default_admin_role text not null default 'Admin',
  maintenance_enabled bool not null default false,
  maintenance_message text not null default 'Maintenance in progress. Please check back shortly.',
  notifications jsonb not null default '[]'::jsonb,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (singleton_key)
);

alter table public.admin_root_settings
  add column if not exists singleton_key bool not null default true,
  add column if not exists theme text not null default 'Nexaa Classic',
  add column if not exists accent text not null default 'Gold',
  add column if not exists dashboard_title text not null default 'Root Control Center',
  add column if not exists welcome_text text not null default 'Manage users, reviews, staff IDs, uploads, and archive operations.',
  add column if not exists default_admin_role text not null default 'Admin',
  add column if not exists maintenance_enabled bool not null default false,
  add column if not exists maintenance_message text not null default 'Maintenance in progress. Please check back shortly.',
  add column if not exists notifications jsonb not null default '[]'::jsonb,
  add column if not exists updated_by uuid references public.profiles(id) on delete set null,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists admin_root_settings_singleton_key_idx
on public.admin_root_settings (singleton_key);

insert into public.admin_root_settings (singleton_key)
values (true)
on conflict (singleton_key) do nothing;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at before update on public.projects
for each row execute function public.set_updated_at();

drop trigger if exists academic_materials_set_updated_at on public.academic_materials;
create trigger academic_materials_set_updated_at before update on public.academic_materials
for each row execute function public.set_updated_at();

drop trigger if exists protected_files_set_updated_at on public.protected_files;
create trigger protected_files_set_updated_at before update on public.protected_files
for each row execute function public.set_updated_at();

drop trigger if exists support_requests_set_updated_at on public.support_requests;
create trigger support_requests_set_updated_at before update on public.support_requests
for each row execute function public.set_updated_at();

drop trigger if exists maintenance_state_set_updated_at on public.maintenance_state;
create trigger maintenance_state_set_updated_at before update on public.maintenance_state
for each row execute function public.set_updated_at();

drop trigger if exists security_system_status_set_updated_at on public.security_system_status;
create trigger security_system_status_set_updated_at before update on public.security_system_status
for each row execute function public.set_updated_at();

drop trigger if exists security_alerts_set_updated_at on public.security_alerts;
create trigger security_alerts_set_updated_at before update on public.security_alerts
for each row execute function public.set_updated_at();

drop trigger if exists security_threats_set_updated_at on public.security_threats;
create trigger security_threats_set_updated_at before update on public.security_threats
for each row execute function public.set_updated_at();

drop trigger if exists security_settings_set_updated_at on public.security_settings;
create trigger security_settings_set_updated_at before update on public.security_settings
for each row execute function public.set_updated_at();

drop trigger if exists admin_root_settings_set_updated_at on public.admin_root_settings;
create trigger admin_root_settings_set_updated_at before update on public.admin_root_settings
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.academic_materials enable row level security;
alter table public.protected_files enable row level security;
alter table public.saved_items enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_reads enable row level security;
alter table public.support_requests enable row level security;
alter table public.audit_logs enable row level security;
alter table public.maintenance_state enable row level security;
alter table public.security_system_status enable row level security;
alter table public.security_logs enable row level security;
alter table public.security_alerts enable row level security;
alter table public.security_threats enable row level security;
alter table public.security_monitoring_snapshots enable row level security;
alter table public.security_backup_points enable row level security;
alter table public.security_settings enable row level security;
alter table public.admin_root_settings enable row level security;

drop policy if exists "profiles can read own profile" on public.profiles;
create policy "profiles can read own profile"
on public.profiles for select
to authenticated
using (id = auth.uid());

drop policy if exists "profiles can update own profile" on public.profiles;
create policy "profiles can update own profile"
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "admins can manage profiles" on public.profiles;
create policy "admins can manage profiles"
on public.profiles for all
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'super_admin'))
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'super_admin'));

drop policy if exists "approved projects are readable" on public.projects;
create policy "approved projects are readable"
on public.projects for select
to authenticated
using (status = 'approved' or uploaded_by = auth.uid());

drop policy if exists "staff can create projects" on public.projects;
create policy "staff can create projects"
on public.projects for insert
to authenticated
with check (uploaded_by = auth.uid());

drop policy if exists "upload owners can update draft projects" on public.projects;
create policy "upload owners can update draft projects"
on public.projects for update
to authenticated
using (uploaded_by = auth.uid() and status in ('draft', 'rejected'))
with check (uploaded_by = auth.uid());

drop policy if exists "hod and admins manage projects" on public.projects;
create policy "hod and admins manage projects"
on public.projects for all
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('hod', 'admin', 'super_admin'))
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('hod', 'admin', 'super_admin'));

drop policy if exists "approved materials are readable" on public.academic_materials;
create policy "approved materials are readable"
on public.academic_materials for select
to authenticated
using (status = 'approved' or uploaded_by = auth.uid());

drop policy if exists "staff can create materials" on public.academic_materials;
create policy "staff can create materials"
on public.academic_materials for insert
to authenticated
with check (uploaded_by = auth.uid());

drop policy if exists "upload owners can update draft materials" on public.academic_materials;
create policy "upload owners can update draft materials"
on public.academic_materials for update
to authenticated
using (uploaded_by = auth.uid() and status in ('draft', 'rejected'))
with check (uploaded_by = auth.uid());

drop policy if exists "hod and admins manage materials" on public.academic_materials;
create policy "hod and admins manage materials"
on public.academic_materials for all
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('hod', 'admin', 'super_admin'))
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('hod', 'admin', 'super_admin'));

drop policy if exists "protected file owners and admins read metadata" on public.protected_files;
create policy "protected file owners and admins read metadata"
on public.protected_files for select
to authenticated
using (
  owner_id = auth.uid()
  or status = 'approved'
  or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('hod', 'admin', 'super_admin')
);

drop policy if exists "staff create protected files" on public.protected_files;
create policy "staff create protected files"
on public.protected_files for insert
to authenticated
with check (owner_id = auth.uid());

drop policy if exists "hod and admins manage protected files" on public.protected_files;
create policy "hod and admins manage protected files"
on public.protected_files for all
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('hod', 'admin', 'super_admin'))
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('hod', 'admin', 'super_admin'));

drop policy if exists "users manage own saved items" on public.saved_items;
create policy "users manage own saved items"
on public.saved_items for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "users read targeted notifications" on public.notifications;
create policy "users read targeted notifications"
on public.notifications for select
to authenticated
using (
  target_user_id = auth.uid()
  or target_role::text = (select role::text from public.profiles where id = auth.uid())
);

drop policy if exists "admins create role notifications" on public.notifications;
create policy "admins create role notifications"
on public.notifications for insert
to authenticated
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'super_admin'));

drop policy if exists "users manage own notification reads" on public.notification_reads;
create policy "users manage own notification reads"
on public.notification_reads for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "users create support requests" on public.support_requests;
create policy "users create support requests"
on public.support_requests for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "users read own support requests" on public.support_requests;
create policy "users read own support requests"
on public.support_requests for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "admins manage support requests" on public.support_requests;
create policy "admins manage support requests"
on public.support_requests for all
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'super_admin'))
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'super_admin'));

drop policy if exists "users read own audit logs" on public.audit_logs;
create policy "users read own audit logs"
on public.audit_logs for select
to authenticated
using (actor_id = auth.uid());

drop policy if exists "admins read audit logs" on public.audit_logs;
create policy "admins read audit logs"
on public.audit_logs for select
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'super_admin'));

drop policy if exists "admins insert audit logs" on public.audit_logs;
create policy "admins insert audit logs"
on public.audit_logs for insert
to authenticated
with check (actor_id = auth.uid());

drop policy if exists "authenticated users read maintenance state" on public.maintenance_state;
create policy "authenticated users read maintenance state"
on public.maintenance_state for select
to anon, authenticated
using (true);

drop policy if exists "super admins manage maintenance state" on public.maintenance_state;
create policy "super admins manage maintenance state"
on public.maintenance_state for update
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin')
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin');

drop policy if exists "super admins read security status" on public.security_system_status;
create policy "super admins read security status"
on public.security_system_status for select
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin');

drop policy if exists "super admins manage security status" on public.security_system_status;
create policy "super admins manage security status"
on public.security_system_status for update
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin')
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin');

drop policy if exists "super admins manage security logs" on public.security_logs;
create policy "super admins manage security logs"
on public.security_logs for all
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin')
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin');

drop policy if exists "super admins manage security alerts" on public.security_alerts;
create policy "super admins manage security alerts"
on public.security_alerts for all
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin')
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin');

drop policy if exists "super admins manage security threats" on public.security_threats;
create policy "super admins manage security threats"
on public.security_threats for all
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin')
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin');

drop policy if exists "super admins manage monitoring snapshots" on public.security_monitoring_snapshots;
create policy "super admins manage monitoring snapshots"
on public.security_monitoring_snapshots for all
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin')
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin');

drop policy if exists "super admins manage backup points" on public.security_backup_points;
create policy "super admins manage backup points"
on public.security_backup_points for all
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin')
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin');

drop policy if exists "super admins manage security settings" on public.security_settings;
create policy "super admins manage security settings"
on public.security_settings for all
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin')
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin');

drop policy if exists "super admins manage root settings" on public.admin_root_settings;
create policy "super admins manage root settings"
on public.admin_root_settings for all
to authenticated
using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin')
with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin');

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.academic_materials to authenticated;
grant select, insert, update, delete on public.protected_files to authenticated;
grant select, insert, update, delete on public.saved_items to authenticated;
grant select, insert, update, delete on public.notifications to authenticated;
grant select, insert, update, delete on public.notification_reads to authenticated;
grant select, insert, update on public.support_requests to authenticated;
grant select on public.audit_logs to authenticated;
grant select on public.maintenance_state to authenticated;
grant select on public.maintenance_state to anon;
grant select, update on public.security_system_status to authenticated;
grant select, insert, update, delete on public.security_logs to authenticated;
grant select, insert, update, delete on public.security_alerts to authenticated;
grant select, insert, update, delete on public.security_threats to authenticated;
grant select, insert, update, delete on public.security_monitoring_snapshots to authenticated;
grant select, insert, update, delete on public.security_backup_points to authenticated;
grant select, insert, update, delete on public.security_settings to authenticated;
grant select, insert, update, delete on public.admin_root_settings to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.notification_reads;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.maintenance_state;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.security_system_status;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.security_alerts;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.academic_materials;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.projects;
exception when duplicate_object then null;
end $$;

-- Super Admin bootstrap
-- This is safe to rerun; it only promotes the existing root auth/profile account.
update public.profiles
set role = 'super_admin'::public.user_role,
    status = 'active',
    staff_id = coalesce(staff_id, 'ROOT-' || upper(substr(replace(id::text, '-', ''), 1, 8))),
    staff_email = coalesce(staff_email, email),
    department = coalesce(department, 'Agricultural and Resource Economics'),
    updated_at = now()
where lower(email) = lower('admin.nexaa@gmail.com');
