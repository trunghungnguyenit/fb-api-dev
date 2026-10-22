import { rows } from "@/lib/db";
import { markFacebookGone, isGoneOnFacebook, runWithPageToken, FacebookActionError } from "@/lib/facebook-posts";
import { metaGet } from "@/lib/meta/client";
import { SYNC_WINDOW_MS } from "@/lib/meta/feed-posts";
import { dedupeKeys } from "@/lib/notification-text";
import { notify } from "@/lib/notifications";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Posts this app published more than 7 days ago are outside the window the feed read covers, so a deletion made on
// Facebook would never be seen there. A few of them are asked about directly on each run, each at most once a day.

const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 10;

export type LivenessStats = { checked: number; gone: number; failed: number; stoppedEarly: boolean };

type OldPost = { id: string; user_id: string; page_id: string; post_type: string; facebook_post_id: string };

/** Asks Facebook about the oldest-checked published posts that are past the feed window. Never throws for one post's trouble. */
export async function verifyOlderPosts(opts: { limit?: number; now?: Date } = {}): Promise<LivenessStats> {
  const now = opts.now ?? new Date();
  const stats: LivenessStats = { checked: 0, gone: 0, failed: 0, stoppedEarly: false };
  const publishedBefore = new Date(now.getTime() - SYNC_WINDOW_MS).toISOString();
  const checkedBefore = new Date(now.getTime() - RECHECK_AFTER_MS).toISOString();

  const { data, error } = await supabaseAdmin.from("posts")
    .select("id,user_id,page_id,post_type,facebook_post_id")
    .eq("status", "published").is("facebook_deleted_at", null).not("facebook_post_id", "is", null)
    .lt("published_at", publishedBefore).or(`facebook_checked_at.is.null,facebook_checked_at.lt.${checkedBefore}`)
    .order("facebook_checked_at", { ascending: true, nullsFirst: true }).limit(opts.limit ?? DEFAULT_LIMIT);
  if (error) throw error;

  for (const post of rows<OldPost>(data)) {
    try {
      stats.checked++;
      // "Does not exist" and "not allowed to see" look alike on Facebook, so before believing it the Page's own token
      // must be shown to work (a Page read with it succeeds): then the post, not the access, is the problem.
      if (await isGoneOnFacebook(post.user_id, post) && await pageTokenWorks(post)) {
        await markFacebookGone(post.user_id, post.id, "detected_missing");
        await notify(post.user_id, { type: "POST_DELETED_ON_FACEBOOK", dedupeKey: dedupeKeys.postDeleted(post.id, now.toISOString()), pageId: post.page_id, postId: post.id });
        stats.gone++;
      }
      await stamp(post.id, now);
    } catch (e) {
      // Rate limited: stop and try again next run (nothing stamped, so these posts stay first in line).
      if (e instanceof FacebookActionError && e.code === "FB_RATE_LIMITED") { stats.stoppedEarly = true; return stats; }
      stats.failed++;
      console.warn(`post liveness check of ${post.id} failed:`, e instanceof FacebookActionError ? e.code : e);
      await stamp(post.id, now); // a Page that is off or a post Facebook will not answer for waits a day instead of blocking the line
    }
  }
  return stats;
}

async function pageTokenWorks(post: OldPost) {
  try {
    await runWithPageToken(post.user_id, post.page_id, "read", `liveness of post ${post.id}`, (token) => metaGet("me", token, { fields: "id" }));
    return true;
  } catch { return false; }
}

async function stamp(postId: string, now: Date) {
  const { error } = await supabaseAdmin.from("posts").update({ facebook_checked_at: now.toISOString() }).eq("id", postId);
  if (error) console.error(`recording the liveness check of post ${postId} failed:`, error);
}

