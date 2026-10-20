-- Single source of truth for the database. Safe to run on a fresh project AND to re-run on an existing
-- one (every statement is idempotent), so run it again after pulling code that changes the schema.
--
-- Security model: the app reads/writes everything through the service-role key after checking the signed-in
-- user, so the public anon key gets almost no direct table access (see the policies section).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.facebook_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  meta_user_id text not null,
  meta_user_name text,
  user_token_encrypted text not null,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, meta_user_id)
);
-- Phase 2: when the daily permission check last ran for this connection (oldest-first scheduling).
alter table public.facebook_connections add column if not exists last_checked_at timestamptz;

create table if not exists public.facebook_pages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.facebook_connections(id) on delete cascade,
  page_id text not null,
  page_name text not null,
  page_access_token_encrypted text not null,
  tasks text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, page_id)
);

do $$
begin
  if not exists (select 1 from pg_type where typname = 'post_status' and typnamespace = 'public'::regnamespace) then
    create type public.post_status as enum ('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled');
  end if;
end $$;

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  page_id uuid not null references public.facebook_pages(id) on delete restrict,
  message text not null,
  link_url text,
  status public.post_status not null default 'draft',
  scheduled_at timestamptz,
  published_at timestamptz,
  facebook_post_id text,
  last_error_code text,
  last_error_message text,
  attempt_count integer not null default 0,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(message) <= 63206),
  check (link_url is null or link_url ~ '^https?://')
);
-- Phase 2: set right before the request to Facebook leaves our server. A stale `publishing` post with
-- sent_at null was never sent (safe to re-queue); with sent_at set its outcome is unknown (AMBIGUOUS).
alter table public.posts add column if not exists sent_at timestamptz;
-- Post management: when the content of an already-published post was last edited on Facebook, and when the
-- post was deleted (by us) or found missing (on Facebook). The row is kept as an audit trail.
alter table public.posts add column if not exists edited_at timestamptz;
alter table public.posts add column if not exists facebook_deleted_at timestamptz;
-- Re-posting: the ORIGINAL post a row was re-posted from (always the root, never a copy of a copy), so a
-- post and all of its re-posts form a flat family. The link is lost (set null) if the original row is deleted.
alter table public.posts add column if not exists reposted_from uuid references public.posts(id) on delete set null;

create table if not exists public.publish_attempts (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempt_number integer not null,
  outcome text not null check (outcome in ('started', 'success', 'failure', 'ambiguous')),
  http_status integer,
  facebook_post_id text,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- Compact audit log of what happened to a post AFTER it was published (edit, delete, found missing).
-- It never stores post content or tokens.
create table if not exists public.post_events (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('edited', 'edit_failed', 'deleted_on_facebook', 'delete_failed', 'detected_missing', 'detected_live', 'marked_deleted')),
  error_code text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists posts_due_idx on public.posts(status, scheduled_at) where status = 'scheduled';
create index if not exists posts_user_created_idx on public.posts(user_id, created_at desc);
create index if not exists posts_user_status_idx on public.posts(user_id, status);
create index if not exists posts_page_idx on public.posts(page_id);
create index if not exists posts_reposted_from_idx on public.posts(reposted_from) where reposted_from is not null;
create index if not exists post_events_post_idx on public.post_events(post_id, created_at desc);
create index if not exists publish_attempts_post_idx on public.publish_attempts(post_id, started_at desc);
create index if not exists facebook_connections_checked_idx on public.facebook_connections(last_checked_at nulls first);

-- The allowed event types grew after the table first shipped, so the check is re-created on every run.
alter table public.post_events drop constraint if exists post_events_type_check;
alter table public.post_events add constraint post_events_type_check check (type in (
  'edited', 'edit_failed', 'deleted_on_facebook', 'delete_failed', 'detected_missing', 'detected_live', 'marked_deleted', 'republished'
));

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.facebook_connections enable row level security;
alter table public.facebook_pages enable row level security;
alter table public.posts enable row level security;
alter table public.publish_attempts enable row level security;
alter table public.post_events enable row level security;

-- Obsolete policies from earlier versions: token ciphertext and Meta's raw error text must not be
-- readable with the public anon key, and post state must not be writable from the browser.
drop policy if exists "connections owner read" on public.facebook_connections;
drop policy if exists "pages owner read" on public.facebook_pages;
drop policy if exists "attempts owner read" on public.publish_attempts;
drop policy if exists "posts owner all" on public.posts;

drop policy if exists "profile owner read" on public.profiles;
create policy "profile owner read" on public.profiles
  for select to authenticated using (auth.uid() = id);
drop policy if exists "profile owner update" on public.profiles;
create policy "profile owner update" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "posts owner read" on public.posts;
create policy "posts owner read" on public.posts
  for select to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Per-user isolation enforced by the database itself: a child row may only reference a parent that
-- belongs to the SAME user, so an app bug can never attach one user's post to another user's Page.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'facebook_connections_id_user_key') then
    alter table public.facebook_connections add constraint facebook_connections_id_user_key unique (id, user_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'facebook_pages_id_user_key') then
    alter table public.facebook_pages add constraint facebook_pages_id_user_key unique (id, user_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'posts_id_user_key') then
    alter table public.posts add constraint posts_id_user_key unique (id, user_id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'facebook_pages_connection_owner_fk') then
    alter table public.facebook_pages add constraint facebook_pages_connection_owner_fk
      foreign key (connection_id, user_id) references public.facebook_connections (id, user_id) on delete cascade;
  end if;
  -- NO ACTION (not RESTRICT): checked at end of statement, so deleting an auth user can still cascade
  -- through connections -> pages -> posts, while deleting a Page that still has posts is blocked.
  -- Re-created on every run so databases that already have the RESTRICT version are fixed too.
  alter table public.posts drop constraint if exists posts_page_owner_fk;
  alter table public.posts add constraint posts_page_owner_fk
    foreign key (page_id, user_id) references public.facebook_pages (id, user_id) on delete no action;
  if not exists (select 1 from pg_constraint where conname = 'post_events_post_owner_fk') then
    alter table public.post_events add constraint post_events_post_owner_fk
      foreign key (post_id, user_id) references public.posts (id, user_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'publish_attempts_post_owner_fk') then
    alter table public.publish_attempts add constraint publish_attempts_post_owner_fk
      foreign key (post_id, user_id) references public.posts (id, user_id) on delete cascade;
  end if;
end $$;

-- A row can never be handed to another user.
create or replace function public.forbid_user_id_change() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'user_id is immutable';
  end if;
  return new;
end $$;

drop trigger if exists facebook_connections_user_immutable on public.facebook_connections;
create trigger facebook_connections_user_immutable before update on public.facebook_connections
  for each row execute function public.forbid_user_id_change();
drop trigger if exists facebook_pages_user_immutable on public.facebook_pages;
create trigger facebook_pages_user_immutable before update on public.facebook_pages
  for each row execute function public.forbid_user_id_change();
drop trigger if exists posts_user_immutable on public.posts;
create trigger posts_user_immutable before update on public.posts
  for each row execute function public.forbid_user_id_change();
