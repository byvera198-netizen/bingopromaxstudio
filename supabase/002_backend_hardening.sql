-- Bingo ProMax Studio: integrity, timestamps and resumable generation jobs.
-- Run after 001_studio.sql in the same Supabase project.

create table if not exists public.studio_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  campaign_code text not null,
  total_sheets integer not null check (total_sheets between 100 and 200000),
  completed_sheets integer not null default 0 check (completed_sheets >= 0),
  next_page integer not null default 1 check (next_page >= 1),
  next_block_number integer not null default 1 check (next_block_number >= 1),
  status text not null default 'active' check (status in ('active', 'completed', 'failed')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_code, created_by)
);

create or replace function public.studio_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists studio_members_updated_at on public.studio_members;
create trigger studio_members_updated_at
before update on public.studio_members
for each row execute function public.studio_touch_updated_at();

drop trigger if exists studio_campaigns_updated_at on public.studio_campaigns;
create trigger studio_campaigns_updated_at
before update on public.studio_campaigns
for each row execute function public.studio_touch_updated_at();

drop trigger if exists studio_blocks_updated_at on public.studio_blocks;
create trigger studio_blocks_updated_at
before update on public.studio_blocks
for each row execute function public.studio_touch_updated_at();

drop trigger if exists studio_patterns_updated_at on public.studio_patterns;
create trigger studio_patterns_updated_at
before update on public.studio_patterns
for each row execute function public.studio_touch_updated_at();

drop trigger if exists studio_games_updated_at on public.studio_games;
create trigger studio_games_updated_at
before update on public.studio_games
for each row execute function public.studio_touch_updated_at();

drop trigger if exists studio_generation_jobs_updated_at on public.studio_generation_jobs;
create trigger studio_generation_jobs_updated_at
before update on public.studio_generation_jobs
for each row execute function public.studio_touch_updated_at();

alter table public.studio_generation_jobs enable row level security;

drop policy if exists studio_generation_jobs_manage on public.studio_generation_jobs;
create policy studio_generation_jobs_manage on public.studio_generation_jobs
  for all using (public.studio_can_access('generator'))
  with check (public.studio_can_access('generator'));

drop policy if exists studio_members_read on public.studio_members;
create policy studio_members_read on public.studio_members
  for select using (
    lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    or public.studio_actor_role() in ('developer', 'admin')
  );

drop policy if exists studio_audit_insert on public.studio_audit_events;
create policy studio_audit_insert on public.studio_audit_events
  for insert with check (
    public.studio_actor_role() is not null
    and lower(actor_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

create index if not exists studio_generation_jobs_status_idx
  on public.studio_generation_jobs(status, updated_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'studio_blocks_payload_object_check'
  ) then
    alter table public.studio_blocks
      add constraint studio_blocks_payload_object_check
      check (jsonb_typeof(payload) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'studio_patterns_cells_array_check'
  ) then
    alter table public.studio_patterns
      add constraint studio_patterns_cells_array_check
      check (jsonb_typeof(cells) = 'array');
  end if;
end;
$$;
