import { one, userDb } from "@/lib/db";
import { FacebookActionError, runWithPageToken } from "@/lib/facebook-posts";
import { markRatingsSeen } from "@/lib/new-ratings";
import { MetaApiError, metaGet } from "@/lib/meta/client";
import {
  CURSOR_PATTERN, GUEST_PAGE_SIZE, mapRatings, mapRatingSummary, mapVisitorPosts, RATING_FIELDS_BASIC, RATING_FIELDS_FULL,
  VISITOR_FIELDS_BASIC, VISITOR_FIELDS_FULL, type GraphRating, type GraphVisitorPost, type RatingSummary, type RatingView, type VisitorPostView
} from "@/lib/meta/guest";
import { describeMetaError } from "@/lib/meta/pages";
import { COMMENT_READ_SCOPES, hasScopes } from "@/lib/meta/scopes";

// Reads what other people left on a Fanpage, from Facebook, when the user opens the tab: the posts they wrote on its wall and
// their ratings. Nothing is stored (see lib/new-ratings.ts for the one number that is).

export type GuestPage = { id: string; page_id: string; page_name: string };
type Paged<T> = { items: T[]; next: string | null };

/** The Fanpage a guest tab is about: the user's, still connected and switched on, and the read permission was granted. */
export async function requireGuestPage(userId: string, pageRowId: string): Promise<GuestPage> {
  const db = userDb(userId);
  const { data, error } = await db.pages.select("id,page_id,page_name,connection_id,is_active,removed_at").eq("id", pageRowId).maybeSingle();
  if (error) throw new FacebookActionError("DB_ERROR", false, error);
  const page = one<GuestPage & { connection_id: string; is_active: boolean; removed_at: string | null }>(data);
  if (!page) throw new FacebookActionError("PAGE_NOT_FOUND");
  if (page.removed_at) throw new FacebookActionError("PAGE_REMOVED_ACTION");
  if (!page.is_active) throw new FacebookActionError("PAGE_INACTIVE");
  const { data: connection, error: connectionError } = await db.connections.select("scopes").eq("id", page.connection_id).maybeSingle();
  if (connectionError) throw new FacebookActionError("DB_ERROR", false, connectionError);
  if (!hasScopes(one<{ scopes: string[] | null }>(connection)?.scopes, COMMENT_READ_SCOPES)) throw new FacebookActionError("GUEST_SCOPES_MISSING");
  return { id: page.id, page_id: page.page_id, page_name: page.page_name };
}

const checkCursor = (after: string | undefined) => {
  if (after !== undefined && !CURSOR_PATTERN.test(after)) throw new FacebookActionError("INVALID_REQUEST");
};

/** Facebook refusing the Page its guests' content is a permission problem to fix, not "the post was rejected". */
function permissionOr(e: unknown): never {
  if (e instanceof MetaApiError && describeMetaError(e) === "FB_PERMISSION_DENIED") throw new FacebookActionError("GUEST_PERMISSION_DENIED", false, e);
  throw e;
}

type Edge<T> = { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } };
// `paging.next` carries the access token, so only the cursor ever goes back to the browser.
const nextCursor = (res: Edge<unknown>) => (res.paging?.next ? res.paging.cursors?.after ?? null : null);

/** Posts that visitors wrote on the Fanpage's wall, newest first. */
export async function loadVisitorPosts(userId: string, pageRowId: string, after?: string): Promise<{ page: GuestPage } & Paged<VisitorPostView>> {
  checkCursor(after);
  const page = await requireGuestPage(userId, pageRowId);
  return runWithPageToken(userId, page.id, "read", `visitor posts of page ${page.id}`, async (token) => {
    let fields = VISITOR_FIELDS_FULL;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await metaGet<Edge<GraphVisitorPost>>(`${page.page_id}/visitor_posts`, token, { fields, limit: String(GUEST_PAGE_SIZE), ...(after ? { after } : {}) });
        return { page, items: mapVisitorPosts(res.data), next: nextCursor(res) };
      } catch (e) {
        // A refused field (100): ask again for the plain post, once. Refused again, the posts cannot be read at all.
        if (e instanceof MetaApiError && e.code === "100") {
          if (fields === VISITOR_FIELDS_FULL && attempt === 0) { fields = VISITOR_FIELDS_BASIC; continue; }
          throw new FacebookActionError("GUEST_POSTS_UNAVAILABLE", false, e);
        }
        return permissionOr(e);
      }
    }
  });
}

export type RatingsResult = { page: GuestPage } & Paged<RatingView> & { summary: RatingSummary | null };

/** The Page's totals (count, average); never fails the list: without them the tab just shows no summary. */
async function readSummary(token: string, facebookPageId: string): Promise<RatingSummary | null> {
  try {
    const summary = mapRatingSummary(await metaGet(facebookPageId, token, { fields: "rating_count,overall_star_rating" }));
    return summary.count === null && summary.average === null ? null : summary;
  } catch (e) {
    console.warn("ratings: the totals of the Page could not be read:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Ratings of the Fanpage, newest first. A Page without a ratings section (Facebook answers 100) gets RATINGS_UNAVAILABLE. */
export async function loadRatings(userId: string, pageRowId: string, after?: string): Promise<RatingsResult> {
  checkCursor(after);
  const page = await requireGuestPage(userId, pageRowId);
  const result = await runWithPageToken(userId, page.id, "read", `ratings of page ${page.id}`, async (token) => {
    let fields = RATING_FIELDS_FULL;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await metaGet<Edge<GraphRating>>(`${page.page_id}/ratings`, token, { fields, limit: String(GUEST_PAGE_SIZE), ...(after ? { after } : {}) });
        const summary = after ? null : await readSummary(token, page.page_id);
        return { page, items: mapRatings(res.data), next: nextCursor(res), summary };
      } catch (e) {
        // The fuller list was refused: ask for the plain one, once. Refused again, the Page has no ratings to read.
        if (e instanceof MetaApiError && e.code === "100") {
          if (fields === RATING_FIELDS_FULL && attempt === 0) { fields = RATING_FIELDS_BASIC; continue; }
          throw new FacebookActionError("RATINGS_UNAVAILABLE", false, e);
        }
        return permissionOr(e);
      }
    }
  });
  // The user is looking at the ratings: what is there now counts as seen (the live total when Facebook gave it).
  if (!after) await markRatingsSeen(userId, pageRowId, result.summary?.count ?? null);
  return result;
}
