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
-- Token health, from Meta's debug_token at the last check: when it ran, whether Meta calls the token valid
-- (null = never checked), and when the user's data access ends (token_expires_at is when the token itself ends).
alter table public.facebook_connections add column if not exists token_checked_at timestamptz;
alter table public.facebook_connections add column if not exists token_is_valid boolean;
alter table public.facebook_connections add column if not exists data_access_expires_at timestamptz;

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

-- Set when the user removes (disconnects) a Fanpage: the row is kept so its posts keep their history, the stored
-- token is wiped, and syncing with Facebook never re-activates it until the user explicitly reconnects it.
alter table public.facebook_pages add column if not exists removed_at timestamptz;
-- Reading the Page's own posts from Facebook (posts published outside this app): when it last worked, when it is
-- next due (null = as soon as possible, e.g. a Page just connected), and the error code of the last failed attempt.
alter table public.facebook_pages add column if not exists feed_synced_at timestamptz;
alter table public.facebook_pages add column if not exists feed_next_sync_at timestamptz;
alter table public.facebook_pages add column if not exists feed_sync_error text;

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
-- Meta rate limit back-off: a scheduled post that hit a rate limit is not picked up again before this time.
-- Nothing was created on Facebook, so the post stays `scheduled` (it is not failed).
alter table public.posts add column if not exists next_attempt_at timestamptz;
-- What the post contains (kept in step with its media by the app): text, link, photo (one image), photos (several),
-- video, reel. Decides how it is published and which publisher lane it uses.
alter table public.posts add column if not exists post_type text not null default 'text';
-- Video and Reels are published in steps on Facebook's side. While they run, the post stays `publishing` and these
-- say where it is: publish_phase = 'uploading' (a Reel's upload session exists, the post is not created yet; safe to
-- resume) or 'processing' (Facebook accepted it and is converting it; we poll). facebook_video_id is Facebook's id for
-- the video, so progress can be looked up instead of guessed (a post in a phase is never "unknown outcome").
alter table public.posts add column if not exists publish_phase text;
alter table public.posts add column if not exists facebook_video_id text;
alter table public.posts add column if not exists processing_since timestamptz;
alter table public.posts add column if not exists phase_checked_at timestamptz;

-- Bulk import: one row per imported file / paste, so a whole batch can be reviewed and undone.
create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_name text,
  source_format text check (source_format in ('csv', 'xlsx', 'json', 'paste')),
  row_count integer not null default 0,
  created_count integer not null default 0,
  skipped_count integer not null default 0,
  undone_at timestamptz,
  undone_count integer,
  created_at timestamptz not null default now()
);
-- The batch a post came from (kept, with the batch row, as history if the post is later deleted), and a private
-- note that is never sent to Facebook.
alter table public.posts add column if not exists import_batch_id uuid references public.import_batches(id) on delete set null;
alter table public.posts add column if not exists note text;

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

-- Posts read FROM Facebook (published on the Page by someone or something other than this app, or by this app: those
-- are linked through post_id and shown with the app's own posts instead). Read-only mirror: nothing in the app edits,
-- deletes, re-posts or schedules these rows, and nothing here is ever sent to Facebook.
create table if not exists public.page_feed_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  page_id uuid not null,
  facebook_post_id text not null,
  message text not null default '',
  permalink_url text,
  status_type text,
  created_time timestamptz not null,
  -- Short description of what is attached: [{ "type": "photo", "url": "...", "target_id": "..." }]
  media jsonb not null default '[]'::jsonb,
  reactions_count integer,
  comments_count integer,
  shares_count integer,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- How many complete syncs in a row did not find the post inside the sync window (capped at 2); at 2 it is
  -- treated as deleted on Facebook (missing_since), and any later sync that sees it again clears both.
  absent_checks integer not null default 0,
  missing_since timestamptz,
  -- The app's own post when this one was published by the app (so it is not listed twice).
  post_id uuid,
  updated_at timestamptz not null default now(),
  unique (user_id, page_id, facebook_post_id)
);

-- How many of the comments counted by the last read the user has looked at (set when the post is opened). Comments
-- above this number are "N mới" in the list and drive the "có N bình luận mới" notification. Null = no baseline yet.
alter table public.page_feed_posts add column if not exists comments_seen_count integer;
update public.page_feed_posts set comments_seen_count = comments_count where comments_seen_count is null and comments_count is not null;

-- What the user DID to comments on their Fanpages (reply, hide, unhide, delete, like, unlike, edit): who, which comment on which post and
-- Page, what, when, and whether Facebook accepted it. Deliberately holds NO comment text and no reply text: other
-- people's words are shown on demand and never kept.
create table if not exists public.comment_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  page_id uuid not null,
  facebook_page_id text not null,
  post_kind text not null,
  -- posts.id (post_kind = app) or page_feed_posts.id (post_kind = feed); null for a visitor post (not stored); no foreign key because it can be either table.
  post_ref uuid,
  facebook_post_id text not null,
  facebook_comment_id text not null,
  action text not null,
  result text not null check (result in ('success', 'failed')),
  error_code text,
  -- For a reply that went through: the id of the new comment.
  result_comment_id text,
  created_at timestamptz not null default now()
);

-- The allowed actions grow with the features (like, unlike, edit), so the check is re-created on every run.
alter table public.comment_actions drop constraint if exists comment_actions_action_check;
alter table public.comment_actions add constraint comment_actions_action_check check (action in (
  'reply', 'hide', 'unhide', 'delete', 'like', 'unlike', 'edit'
));

-- Same for the kinds of post a comment can be on: app = a post made here, feed = a post read from the Fanpage, visitor = a post
-- a visitor wrote on the Fanpage wall (read live, never stored).
alter table public.comment_actions drop constraint if exists comment_actions_post_kind_check;
alter table public.comment_actions add constraint comment_actions_post_kind_check check (post_kind in ('app', 'feed', 'visitor'));

-- How many ratings the Fanpage had at the last feed read (or when the user last opened them): a count that went up means
-- new ratings (only the number is kept, never the ratings themselves).
alter table public.facebook_pages add column if not exists ratings_count integer;

-- Images (later also video / Reels) attached to posts. The FILE lives in the private Storage bucket `post-media`
-- (path = storage_path); this row is the record of it. A row with no post_id is an upload not (or no longer)
-- attached to a post: the cleanup job deletes it after 24 hours. Several rows may point at the same file
-- (re-posting reuses it), so a file is only deleted when no row references it any more.
create table if not exists public.post_media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id uuid,
  kind text not null check (kind in ('image', 'video', 'reel')),
  storage_path text not null,
  file_name text,
  mime text not null,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  position integer not null default 0,
  -- Facebook's id for the photo once uploaded unpublished (multi-photo posts), so a retry does not upload it again.
  facebook_media_id text,
  -- pending = signed URL issued, upload not confirmed; uploaded = verified by the server; failed = rejected;
  -- purged = the file was deleted by the cleanup job (the row stays as history of the post).
  state text not null default 'pending' check (state in ('pending', 'uploaded', 'failed', 'purged')),
  created_at timestamptz not null default now(),
  uploaded_at timestamptz,
  purged_at timestamptz
);

-- In-app notifications (a post failed, a Page lost access, a connection needs attention). One row per event;
-- dedupe_key makes repeating the same event (a retried job, a daily re-check) a no-op. Message text is built at
-- read time from type/code/params, so it never stores Meta's raw error text.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  page_id uuid,
  post_id uuid,
  code text,
  params jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, dedupe_key)
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
create index if not exists posts_phase_idx on public.posts(phase_checked_at nulls first) where publish_phase is not null;
create index if not exists page_feed_posts_list_idx on public.page_feed_posts(user_id, created_time desc);
create index if not exists page_feed_posts_page_idx on public.page_feed_posts(page_id, created_time desc);
create index if not exists page_feed_posts_post_idx on public.page_feed_posts(post_id) where post_id is not null;
create index if not exists facebook_pages_feed_due_idx on public.facebook_pages(feed_next_sync_at nulls first) where is_active and removed_at is null;
create index if not exists comment_actions_user_idx on public.comment_actions(user_id, created_at desc);
create index if not exists comment_actions_page_idx on public.comment_actions(page_id, created_at desc);
create index if not exists post_media_post_idx on public.post_media(post_id, position) where post_id is not null;
create index if not exists post_media_unattached_idx on public.post_media(created_at) where post_id is null;
create index if not exists post_media_path_idx on public.post_media(storage_path);
create index if not exists post_media_user_idx on public.post_media(user_id, created_at desc);
create index if not exists notifications_user_idx on public.notifications(user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications(user_id) where read_at is null;
create index if not exists posts_due_idx on public.posts(status, scheduled_at) where status = 'scheduled';
create index if not exists posts_user_created_idx on public.posts(user_id, created_at desc);
create index if not exists posts_user_status_idx on public.posts(user_id, status);
create index if not exists posts_page_idx on public.posts(page_id);
create index if not exists posts_reposted_from_idx on public.posts(reposted_from) where reposted_from is not null;
create index if not exists posts_import_batch_idx on public.posts(import_batch_id) where import_batch_id is not null;
create index if not exists import_batches_user_idx on public.import_batches(user_id, created_at desc);
create index if not exists post_events_post_idx on public.post_events(post_id, created_at desc);
create index if not exists publish_attempts_post_idx on public.publish_attempts(post_id, started_at desc);
create index if not exists facebook_connections_checked_idx on public.facebook_connections(last_checked_at nulls first);

-- The allowed event types grew after the table first shipped, so the check is re-created on every run.
alter table public.post_events drop constraint if exists post_events_type_check;
alter table public.post_events add constraint post_events_type_check check (type in (
  'edited', 'edit_failed', 'deleted_on_facebook', 'delete_failed', 'detected_missing', 'detected_live', 'marked_deleted', 'republished'
));

-- Same for post types (video and Reels arrive later).
alter table public.posts drop constraint if exists posts_post_type_check;
alter table public.posts add constraint posts_post_type_check check (post_type in ('text', 'link', 'photo', 'photos', 'video', 'reel'));
alter table public.posts drop constraint if exists posts_publish_phase_check;
alter table public.posts add constraint posts_publish_phase_check check (publish_phase is null or publish_phase in ('uploading', 'processing'));
-- Posts that existed before post_type: a post with a link is a link post. Safe to repeat.
update public.posts set post_type = 'link' where post_type = 'text' and link_url is not null;

-- Same idea for notifications: the allowed types grow with the features, so the check is re-created on every run.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'PUBLISH_FAILED', 'PUBLISH_AMBIGUOUS', 'PAGE_ACCESS_LOST', 'REAUTH_REQUIRED', 'TOKEN_EXPIRING', 'SCOPES_MISSING', 'POST_DELETED_ON_FACEBOOK',
  'NEW_COMMENTS', 'NEW_RATINGS'
));

-- When the app last asked Facebook directly whether a published post still exists (posts older than the 7-day feed
-- window cannot be seen in the feed, so a few are checked every run, each about once a day).
alter table public.posts add column if not exists facebook_checked_at timestamptz;
create index if not exists posts_liveness_idx on public.posts(facebook_checked_at nulls first)
  where status = 'published' and facebook_deleted_at is null and facebook_post_id is not null;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.facebook_connections enable row level security;
alter table public.facebook_pages enable row level security;
alter table public.posts enable row level security;
alter table public.publish_attempts enable row level security;
alter table public.post_events enable row level security;
alter table public.import_batches enable row level security;
-- No policy on purpose: the mirror of Facebook posts is read and written only by the server (service role).
alter table public.page_feed_posts enable row level security;
-- No policy on purpose: the log of comment actions is read and written only by the server (service role).
alter table public.comment_actions enable row level security;
-- No policy on purpose: media rows are read and written only by the server (service role).
alter table public.post_media enable row level security;
-- No policy on purpose: notifications are read and written only by the server (service role), never with the anon key.
alter table public.notifications enable row level security;

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
  if not exists (select 1 from pg_constraint where conname = 'posts_note_length_chk') then
    alter table public.posts add constraint posts_note_length_chk check (note is null or char_length(note) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'post_events_post_owner_fk') then
    alter table public.post_events add constraint post_events_post_owner_fk
      foreign key (post_id, user_id) references public.posts (id, user_id) on delete cascade;
  end if;
  -- page_id / post_id may be null (e.g. a connection-level notification); a null skips the check.
  if not exists (select 1 from pg_constraint where conname = 'notifications_page_owner_fk') then
    alter table public.notifications add constraint notifications_page_owner_fk
      foreign key (page_id, user_id) references public.facebook_pages (id, user_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'notifications_post_owner_fk') then
    alter table public.notifications add constraint notifications_post_owner_fk
      foreign key (post_id, user_id) references public.posts (id, user_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'comment_actions_page_owner_fk') then
    alter table public.comment_actions add constraint comment_actions_page_owner_fk
      foreign key (page_id, user_id) references public.facebook_pages (id, user_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'page_feed_posts_page_owner_fk') then
    alter table public.page_feed_posts add constraint page_feed_posts_page_owner_fk
      foreign key (page_id, user_id) references public.facebook_pages (id, user_id) on delete cascade;
  end if;
  -- If the app's post is deleted the mirror row stays, and shows up again as a post "from Facebook".
  if not exists (select 1 from pg_constraint where conname = 'page_feed_posts_post_owner_fk') then
    begin
      alter table public.page_feed_posts add constraint page_feed_posts_post_owner_fk
        foreign key (post_id, user_id) references public.posts (id, user_id) on delete set null (post_id);
    exception when syntax_error then
      alter table public.page_feed_posts add constraint page_feed_posts_post_owner_fk
        foreign key (post_id) references public.posts (id) on delete set null;
    end;
  end if;
  -- A deleted post keeps its media row (post_id becomes null) so the cleanup job can remove the file. The column list
  -- in SET NULL (PostgreSQL 15+) is needed because user_id is part of the same foreign key and must stay.
  if not exists (select 1 from pg_constraint where conname = 'post_media_post_owner_fk') then
    begin
      alter table public.post_media add constraint post_media_post_owner_fk
        foreign key (post_id, user_id) references public.posts (id, user_id) on delete set null (post_id);
    exception when syntax_error then
      -- Older PostgreSQL: same behaviour without the same-owner guarantee at database level.
      alter table public.post_media add constraint post_media_post_owner_fk
        foreign key (post_id) references public.posts (id) on delete set null;
    end;
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
drop trigger if exists notifications_user_immutable on public.notifications;
create trigger notifications_user_immutable before update on public.notifications
  for each row execute function public.forbid_user_id_change();
drop trigger if exists comment_actions_user_immutable on public.comment_actions;
create trigger comment_actions_user_immutable before update on public.comment_actions
  for each row execute function public.forbid_user_id_change();
drop trigger if exists page_feed_posts_user_immutable on public.page_feed_posts;
create trigger page_feed_posts_user_immutable before update on public.page_feed_posts
  for each row execute function public.forbid_user_id_change();
drop trigger if exists post_media_user_immutable on public.post_media;
create trigger post_media_user_immutable before update on public.post_media
  for each row execute function public.forbid_user_id_change();
drop trigger if exists import_batches_user_immutable on public.import_batches;
create trigger import_batches_user_immutable before update on public.import_batches
  for each row execute function public.forbid_user_id_change();

-- Which of these (Fanpage, message) pairs already exist as posts? Called with the service role from the import
-- preview. A function (instead of a filter in the URL) because messages can be tens of KB each.
create or replace function public.find_duplicate_posts(p_user uuid, p_page_ids uuid[], p_messages text[])
returns table (page_id uuid, message text)
language sql stable set search_path = public as $$
  select distinct p.page_id, p.message
  from public.posts p
  where p.user_id = p_user
    and p.page_id = any(p_page_ids)
    and p.message = any(p_messages)
    and p.status <> 'cancelled'
$$;
revoke all on function public.find_duplicate_posts(uuid, uuid[], text[]) from public, anon, authenticated;
grant execute on function public.find_duplicate_posts(uuid, uuid[], text[]) to service_role;

-- Current status of every post of each import, for the import history page (counts per batch and status).
create or replace function public.import_batch_stats(p_user uuid)
returns table (batch_id uuid, status text, n bigint)
language sql stable set search_path = public as $$
  select p.import_batch_id, p.status::text, count(*)
  from public.posts p
  where p.user_id = p_user and p.import_batch_id is not null
  group by p.import_batch_id, p.status
$$;
revoke all on function public.import_batch_stats(uuid) from public, anon, authenticated;
grant execute on function public.import_batch_stats(uuid) to service_role;

-- How many posts a Fanpage has, per status (and how many have an unknown outcome). p_page = null: every Fanpage.
-- Used by the "remove Fanpage" impact summary and to know which removed Fanpages can be deleted for good.
create or replace function public.page_post_counts(p_user uuid, p_page uuid default null)
returns table (page_id uuid, status text, n bigint, ambiguous bigint)
language sql stable set search_path = public as $$
  select p.page_id, p.status::text, count(*), count(*) filter (where p.last_error_code = 'AMBIGUOUS')
  from public.posts p
  where p.user_id = p_user and (p_page is null or p.page_id = p_page)
  group by p.page_id, p.status
$$;
revoke all on function public.page_post_counts(uuid, uuid) from public, anon, authenticated;
grant execute on function public.page_post_counts(uuid, uuid) to service_role;
