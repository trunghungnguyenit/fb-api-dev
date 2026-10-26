import Link from "next/link";
import { z } from "zod";
import { rows, userDb } from "@/lib/db";
import { AppFailure, messageFor } from "@/lib/errors";
import { FacebookActionError } from "@/lib/facebook-posts";

// What the two tabs about other people's content (visitor posts, ratings) have in common: which Fanpage is shown, and how a
// failure of Facebook is told to the user (always from our own catalog, never Facebook's text).

export type GuestTabPage = { id: string; page_name: string };

/** The Fanpages that can be shown (connected and switched on), and the one asked for in the address, or the first. */
export async function pickGuestPage(userId: string, requested: unknown): Promise<{ pages: GuestTabPage[]; selected: GuestTabPage | null }> {
  const { data, error } = await userDb(userId).pages.select("id,page_name").eq("is_active", true).is("removed_at", null).order("page_name");
  if (error) throw new AppFailure("DB_ERROR", error);
  const pages = rows<GuestTabPage>(data);
  const id = z.string().uuid().safeParse(requested);
  return { pages, selected: (id.success && pages.find((p) => p.id === id.data)) || pages[0] || null };
}

/** Failures the user fixes by granting permission again. */
const RECONNECT = new Set(["GUEST_SCOPES_MISSING", "GUEST_PERMISSION_DENIED", "PAGE_PERMISSION_LOST"]);

export type GuestProblem = { message: string; reconnect: boolean; code: string };

/** A failed read as something to show. Anything that is not one of our own failures is a Facebook outage as far as the user can tell. */
export function guestProblem(e: unknown): GuestProblem {
  const failure = e instanceof FacebookActionError ? e : new FacebookActionError("FB_UNAVAILABLE", false, e);
  if (failure.code === "DB_ERROR") throw new AppFailure("DB_ERROR", failure.cause);
  return { code: failure.code, message: messageFor(failure.code), reconnect: RECONNECT.has(failure.code) };
}

export function GuestProblemBox({ problem }: { problem: GuestProblem }) {
  return <div className="insight-error" role="alert">
    <p className="error">{problem.message}</p>
    {problem.reconnect && <div className="actions"><a className="btn primary" href="/api/auth/facebook">Kết nối lại Facebook</a></div>}
  </div>;
}

/** Choose the Fanpage (a plain GET form: it works without scripts and keeps the address shareable). */
export function GuestPagePicker({ source, pages, selected }: { source: "visitor" | "ratings"; pages: GuestTabPage[]; selected: string }) {
  if (pages.length < 2) return null;
  return <form method="get" action="/posts" className="filters" role="search">
    <input type="hidden" name="source" value={source} />
    <div className="field"><label htmlFor="guest-page">Fanpage</label>
      <select id="guest-page" name="page" defaultValue={selected}>
        {pages.map((p) => <option key={p.id} value={p.id}>{p.page_name}</option>)}
      </select></div>
    <div className="actions"><button className="btn" type="submit">Xem</button></div>
  </form>;
}

/** "Next page" / "back to the start" links of a list read from Facebook, which pages by cursor (no page numbers, no total). */
export function CursorNav({ source, page, after, next }: { source: "visitor" | "ratings"; page: string; after?: string; next: string | null }) {
  if (!after && !next) return null;
  const href = (cursor?: string) => {
    const params = new URLSearchParams({ source, page });
    if (cursor) params.set("after", cursor);
    return `/posts?${params}`;
  };
  return <nav className="neo-pager" aria-label="Phân trang">
    {after ? <Link className="page-btn" href={href()}>← Về đầu danh sách</Link> : <span />}
    {next ? <Link className="page-btn" href={href(next)} rel="next">Xem tiếp →</Link> : <span />}
  </nav>;
}
