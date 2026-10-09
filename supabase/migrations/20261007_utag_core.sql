-- UTAG Fixer metadata knowledge base — core schema (Phase 1)
-- Applied with: psql "<db-connection-string>" -f 20261007_utag_core.sql
--
-- Confidence / status states used across entities:
--   'verified' | 'high_confidence' | 'needs_review' | 'conflicting' | 'unknown'
-- Reads are public (the control-center site is a public static page);
-- writes go through the service role / Edge Functions only.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- artists ---
create table if not exists public.artists (
  id             uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  aliases        text[] not null default '{}',
  mbid           text,
  spotify_id     text,
  apple_id       text,
  deezer_id      text,
  discogs_id     text,
  image_url      text,
  genres         text[] not null default '{}',
  confidence     text not null default 'unknown'
    check (confidence in ('verified','high_confidence','needs_review','conflicting','unknown')),
  status         text not null default 'unknown'
    check (status in ('verified','high_confidence','needs_review','conflicting','unknown')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists artists_canonical_lower_uidx
  on public.artists (lower(canonical_name));
create index if not exists artists_aliases_gin
  on public.artists using gin (aliases);
create index if not exists artists_mbid_idx
  on public.artists (mbid) where mbid is not null;

-- --------------------------------------------------------------- releases ---
-- Edition-aware: original / remaster / deluxe / reissue / regional /
-- anniversary are SEPARATE rows. This is where cover art goes wrong, so the
-- schema forces the distinction instead of hoping for it.
create table if not exists public.releases (
  id             uuid primary key default gen_random_uuid(),
  artist_id      uuid references public.artists(id) on delete cascade,
  title          text not null,
  release_type   text not null default 'album'
    check (release_type in ('album','ep','single','compilation','soundtrack','other')),
  edition        text not null default 'original'
    check (edition in ('original','remaster','deluxe','reissue','regional','anniversary','other')),
  release_date   date,
  release_year   int,
  label          text,
  catalog_number text,
  barcode        text,
  country        text,
  mbid           text,
  spotify_id     text,
  apple_id       text,
  deezer_id      text,
  discogs_id     text,
  confidence     text not null default 'unknown'
    check (confidence in ('verified','high_confidence','needs_review','conflicting','unknown')),
  status         text not null default 'unknown'
    check (status in ('verified','high_confidence','needs_review','conflicting','unknown')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists releases_artist_idx
  on public.releases (artist_id);
create unique index if not exists releases_identity_uidx
  on public.releases (artist_id, lower(title), edition, coalesce(release_year, 0));
create index if not exists releases_mbid_idx
  on public.releases (mbid) where mbid is not null;
create index if not exists releases_barcode_idx
  on public.releases (barcode) where barcode is not null;

-- ----------------------------------------------------------------- tracks ---
create table if not exists public.tracks (
  id           uuid primary key default gen_random_uuid(),
  release_id   uuid references public.releases(id) on delete cascade,
  artist_id    uuid references public.artists(id) on delete set null,
  title        text not null,
  track_number int,
  disc_number  int not null default 1,
  isrc         text,
  duration_ms  int,
  mbid         text,
  spotify_id   text,
  apple_id     text,
  deezer_id    text,
  confidence   text not null default 'unknown'
    check (confidence in ('verified','high_confidence','needs_review','conflicting','unknown')),
  status       text not null default 'unknown'
    check (status in ('verified','high_confidence','needs_review','conflicting','unknown')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists tracks_release_idx
  on public.tracks (release_id);
create unique index if not exists tracks_identity_uidx
  on public.tracks (release_id, disc_number, coalesce(track_number, 0), lower(title));
create index if not exists tracks_isrc_idx
  on public.tracks (isrc) where isrc is not null;

-- ---------------------------------------------------------------- artwork ---
-- Per-edition artwork. phash lets the pipeline detect that two source URLs
-- are the same image, and that two images are genuinely different art.
create table if not exists public.artwork (
  id            uuid primary key default gen_random_uuid(),
  release_id    uuid references public.releases(id) on delete cascade,
  source_url    text,
  stored_path   text,   -- path inside the 'artwork' storage bucket
  phash         text,   -- perceptual hash (hex)
  width         int,
  height        int,
  source        text,   -- 'apple' | 'deezer' | 'musicbrainz-caa' | 'discogs' | 'user' ...
  role          text not null default 'candidate'
    check (role in ('canonical','alternate','candidate','rejected')),
  edition_label text,    -- e.g. '2021 remaster', 'deluxe edition'
  confidence    text not null default 'unknown'
    check (confidence in ('verified','high_confidence','needs_review','conflicting','unknown')),
  status        text not null default 'unknown'
    check (status in ('verified','high_confidence','needs_review','conflicting','unknown')),
  created_at    timestamptz not null default now()
);
create index if not exists artwork_release_idx
  on public.artwork (release_id);
create index if not exists artwork_phash_idx
  on public.artwork (phash) where phash is not null;
create unique index if not exists artwork_canonical_uidx
  on public.artwork (release_id) where role = 'canonical';

-- ---------------------------------------------------------- source_results ---
-- Raw candidate payloads from every metadata source, kept for audit and
-- re-adjudication. Nothing is thrown away.
create table if not exists public.source_results (
  id         uuid primary key default gen_random_uuid(),
  source     text not null,  -- 'apple' | 'deezer' | 'musicbrainz' | 'discogs' | 'spotify-scrape'
  query_type text not null check (query_type in ('artist','release','track','artwork')),
  query_text text not null,
  payload    jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists source_results_lookup_idx
  on public.source_results (source, query_type, lower(query_text));

-- ------------------------------------------------------------ verifications ---
-- Every AI / heuristic verification run: what was asked, what was considered,
-- what was decided, why, and how confident. The audit trail the chat agent
-- answers "why did you choose this release?" from.
create table if not exists public.verifications (
  id                 uuid primary key default gen_random_uuid(),
  entity_type        text not null check (entity_type in ('artist','release','track','artwork')),
  entity_id          uuid,
  input              jsonb not null,
  candidates         jsonb,
  decision           jsonb not null,
  rationale          text,
  field_confidence   jsonb,
  overall_confidence text not null default 'unknown'
    check (overall_confidence in ('verified','high_confidence','needs_review','conflicting','unknown')),
  status             text not null default 'needs_review'
    check (status in ('verified','high_confidence','needs_review','conflicting','unknown')),
  model              text,   -- e.g. 'groq/llama-3.3-70b-versatile' | 'heuristic'
  created_by         text not null default 'system',
  created_at         timestamptz not null default now()
);
create index if not exists verifications_entity_idx
  on public.verifications (entity_type, entity_id);
create index if not exists verifications_created_idx
  on public.verifications (created_at desc);

-- -------------------------------------------------------------- corrections ---
-- Human rulings. These OUTRANK AI decisions permanently and are injected
-- into future adjudications as constraints. This table is the learning.
create table if not exists public.corrections (
  id          uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('artist','release','track','artwork')),
  entity_id   uuid,
  field       text not null,
  old_value   text,
  new_value   text not null,
  source      text not null default 'manual'
    check (source in ('manual','chat','approval','import')),
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists corrections_entity_idx
  on public.corrections (entity_type, entity_id);

-- ---------------------------------------------------------- canonical_rules ---
-- Learned normalization rules, e.g. artist alias collapsing
-- ('d4vd' variants -> 'd4vd'). Applied before every lookup and verification.
create table if not exists public.canonical_rules (
  id          uuid primary key default gen_random_uuid(),
  rule_type   text not null,  -- 'artist_alias' | 'title_normalization' | ...
  pattern     text not null,
  replacement text not null,
  created_by  text not null default 'manual',
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------------- chat ---
create table if not exists public.chat_sessions (
  id         uuid primary key default gen_random_uuid(),
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  role       text not null check (role in ('user','assistant','tool')),
  content    text not null,
  tool_calls jsonb,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_session_idx
  on public.chat_messages (session_id, created_at);

-- ------------------------------------------------------- updated_at trigger ---
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['artists','releases','tracks','chat_sessions'] loop
    execute format('drop trigger if exists trg_touch_updated_at on public.%I', t);
    execute format(
      'create trigger trg_touch_updated_at before update on public.%I
       for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ storage ---
-- Canonical + alternate cover art lives here, served publicly to the site
-- and to Splotify.
insert into storage.buckets (id, name, public)
values ('artwork', 'artwork', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------- rls ---
-- Public read everywhere (control center is a public static page).
-- All writes go through service_role / Edge Functions (no write policies).
do $$
declare t text;
begin
  foreach t in array array['artists','releases','tracks','artwork','source_results',
                           'verifications','corrections','canonical_rules',
                           'chat_sessions','chat_messages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select using (true)', t);
  end loop;
end $$;

-- storage: public read on the artwork bucket
drop policy if exists "public read artwork" on storage.objects;
create policy "public read artwork" on storage.objects
  for select using (bucket_id = 'artwork');
