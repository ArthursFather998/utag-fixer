-- UTAG Fixer: create the 'artwork' storage bucket (Phase 1 follow-up).
-- Run this in the Supabase dashboard SQL editor, same as the main migration.
-- Idempotent: safe to run more than once.

insert into storage.buckets (id, name, public)
values ('artwork', 'artwork', true)
on conflict (id) do nothing;

drop policy if exists "public read artwork" on storage.objects;
create policy "public read artwork" on storage.objects
  for select using (bucket_id = 'artwork');
