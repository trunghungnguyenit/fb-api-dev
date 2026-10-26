// Pure module (client and server): which posts may have their RECORD removed from the app. It never touches Facebook:
// removing a post that is live there is a different, much more dangerous action ("Xóa bài trên Facebook").
// Mirrors DELETE /api/posts/[id]: never-published posts, and published ones already deleted on Facebook.

const NEVER_PUBLISHED = ["draft", "scheduled", "failed", "cancelled"];

export function canRemoveRecord(status: string, deletedOnFacebook: boolean): boolean {
  if (NEVER_PUBLISHED.includes(status)) return true;
  return status === "published" && deletedOnFacebook;
}
