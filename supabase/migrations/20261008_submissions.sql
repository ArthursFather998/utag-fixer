-- UTAG submissions inbox (2026-10-08)
-- Splotify (and later, other consumers) submit unknowns, corrections, and
-- learned fixes here. Insert-only for the public anon key; Hermes reads and
-- processes them with the service key. Nothing here is trusted until Hermes
-- verifies it: a submission is a lead, never a ruling.

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('miss', 'correction', 'learned_fix')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.submissions enable row level security;

-- Anyone with the public anon key may submit; nobody may read, update, or
-- delete through it. Reads happen service-side only.
drop policy if exists "public can submit" on public.submissions;
create policy "public can submit" on public.submissions
  for insert to anon, authenticated
  with check (true);

create index if not exists submissions_unprocessed_idx
  on public.submissions (created_at) where processed_at is null;
