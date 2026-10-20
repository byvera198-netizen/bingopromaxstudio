-- Bingo ProMax Studio: persistence and role model.
-- Run this migration in the Supabase SQL editor before enabling cloud sync.

create table if not exists public.studio_members (
  email text primary key,
  role text not null check (role in ('developer', 'admin', 'operator')),
  permissions jsonb not null default '{"dashboard": true, "generator": false, "blocks": false, "games": false, "patterns": false, "integration": false, "users": false, "audit": false}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.studio_members (email, role)
values
  ('byvera198@gmail.com', 'developer'),
  ('bveraalvear@gmail.com', 'developer')
on conflict (email) do update set role = excluded.role, active = true, updated_at = now();

alter table public.studio_members
  add column if not exists permissions jsonb not null default '{"dashboard": true}'::jsonb;

create or replace function public.studio_actor_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.studio_members
  where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    and active = true
  limit 1;
$$;

create or replace function public.studio_can_manage()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.studio_actor_role() in ('developer', 'admin'), false);
$$;

create table if not exists public.studio_campaigns (
  code text primary key,
  name text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.studio_blocks (
  code text primary key,
  campaign_code text not null references public.studio_campaigns(code) on update cascade,
  range_text text not null default '',
  pages integer not null check (pages > 0 and pages <= 40),
  status text not null check (status in ('Listo', 'Descargado', 'Entregado')),
  distributor text,
  delivered_at timestamptz,
  notes text not null default '',
  payload jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.studio_patterns (
  id text primary key,
  name text not null,
  description text not null default '',
  pattern_group text not null default 'Personalizados',
  color text not null default '#f5c84b',
  cells jsonb not null,
  active boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.studio_games (
  id text primary key,
  name text not null,
  game_date date,
  prize text not null default '',
  status text not null default 'ready' check (status in ('ready', 'running', 'paused', 'finished')),
  active_pattern_ids jsonb not null default '[]'::jsonb,
  drawn_numbers jsonb not null default '[]'::jsonb,
  winner_history jsonb not null default '[]'::jsonb,
  notes text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.studio_games
  add column if not exists drawn_numbers jsonb not null default '[]'::jsonb;
alter table public.studio_games
  add column if not exists winner_history jsonb not null default '[]'::jsonb;

create table if not exists public.studio_audit_events (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  detail text not null default '',
  actor_email text not null default '',
  created_at timestamptz not null default now()
);

alter table public.studio_members enable row level security;
alter table public.studio_campaigns enable row level security;
alter table public.studio_blocks enable row level security;
alter table public.studio_patterns enable row level security;
alter table public.studio_games enable row level security;
alter table public.studio_audit_events enable row level security;

drop policy if exists studio_members_developers on public.studio_members;
create policy studio_members_developers on public.studio_members
  for all using (public.studio_actor_role() = 'developer')
  with check (public.studio_actor_role() = 'developer');

drop policy if exists studio_members_read on public.studio_members;
create policy studio_members_read on public.studio_members
  for select using (public.studio_actor_role() is not null);

drop policy if exists studio_campaigns_manage on public.studio_campaigns;
create policy studio_campaigns_manage on public.studio_campaigns
  for all using (public.studio_can_manage())
  with check (public.studio_can_manage());

drop policy if exists studio_blocks_manage on public.studio_blocks;
create policy studio_blocks_manage on public.studio_blocks
  for all using (public.studio_can_manage())
  with check (public.studio_can_manage());

drop policy if exists studio_patterns_manage on public.studio_patterns;
create policy studio_patterns_manage on public.studio_patterns
  for all using (public.studio_can_manage())
  with check (public.studio_can_manage());

drop policy if exists studio_games_manage on public.studio_games;
create policy studio_games_manage on public.studio_games
  for all using (public.studio_can_manage())
  with check (public.studio_can_manage());

drop policy if exists studio_audit_insert on public.studio_audit_events;
create policy studio_audit_insert on public.studio_audit_events
  for insert with check (public.studio_can_manage());

drop policy if exists studio_audit_read on public.studio_audit_events;
create policy studio_audit_read on public.studio_audit_events
  for select using (public.studio_can_manage());

create index if not exists studio_blocks_campaign_idx on public.studio_blocks(campaign_code, created_at);
create index if not exists studio_blocks_status_idx on public.studio_blocks(status, updated_at);
create index if not exists studio_audit_created_idx on public.studio_audit_events(created_at desc);
