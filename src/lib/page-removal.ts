// Pure rules for removing ("gỡ") a Fanpage. Shared by the confirmation dialog and the API.

/** Statuses of posts that are cancelled when their Fanpage is removed (nothing of them is on Facebook yet). */
export const CANCELLED_ON_REMOVAL = ["draft", "scheduled", "failed"] as const;

export type PostCountRow = { status: string; n: number | string; ambiguous: number | string };

export type Impact = {
  drafts: number;
  scheduled: number;
  /** Failed posts that WILL be cancelled (outcome known: nothing was posted). */
  failed: number;
  /** Failed posts whose outcome is unknown (they may be live): never touched, so they stay as evidence. */
  ambiguousKept: number;
  published: number;
  publishing: number;
  cancelled: number;
  willCancel: number;
  total: number;
};

/** What removing a Fanpage will do to its posts, from per-status counts. */
export function summarizeImpact(counts: PostCountRow[]): Impact {
  const sum = (status: string, key: "n" | "ambiguous" = "n") =>
    counts.filter((c) => c.status === status).reduce((a, c) => a + Number(c[key] ?? 0), 0);
  const failedAll = sum("failed");
  const ambiguousKept = Math.min(sum("failed", "ambiguous"), failedAll);
  const drafts = sum("draft");
  const scheduled = sum("scheduled");
  const failed = failedAll - ambiguousKept;
  return {
    drafts, scheduled, failed, ambiguousKept,
    published: sum("published"), publishing: sum("publishing"), cancelled: sum("cancelled"),
    willCancel: drafts + scheduled + failed,
    total: counts.reduce((a, c) => a + Number(c.n ?? 0), 0)
  };
}

/** Drops Facebook pages the user removed: sync must never bring them back on its own. */
export function excludeRemoved<T extends { id: string }>(pages: T[], removedFacebookIds: ReadonlySet<string>) {
  return pages.filter((p) => !removedFacebookIds.has(p.id));
}
