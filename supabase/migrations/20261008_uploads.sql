-- UTAG uploads: audio files sent to Hermes through the UTAG site.
-- Run in the Supabase SQL editor (dashboard) after 20261008_submissions.sql
-- (or run the combined RUN-IN-DASHBOARD file once, which covers both).

-- Private bucket for uploaded audio. 50 MB per file.
insert into storage.buckets (id, name, public, file_size_limit)
values ('uploads', 'uploads', false, 52428800)
on conflict (id) do nothing;

-- Anyone holding the public anon key may upload a file, nothing more:
-- no listing, no reading, no overwriting, no deleting.
create policy "public can upload audio"
on storage.objects for insert
to anon, authenticated
with check (bucket_id = 'uploads');

create table if not exists public.uploads (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  file_name text not null,
  file_size bigint,
  content_type text,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'done', 'failed')),
  notes text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.uploads enable row level security;

create policy "public can queue uploads"
on public.uploads for insert
to anon, authenticated
with check (true);

create index if not exists uploads_unprocessed_idx
on public.uploads (created_at) where processed_at is null;
