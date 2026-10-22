import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { one, rows, userDb } from "@/lib/db";
import { apiError } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";

export const runtime = "nodejs";

/**
 * POST /api/posts/import/[batchId]/undo — deletes the posts of an import that have NOT been published
 * (drafts and scheduled). Anything already published, being published or failed is kept: it is real history,
 * and a failed post may be live on Facebook.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ batchId: string }> }) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { batchId } = await context.params;
  if (!z.string().uuid().safeParse(batchId).success) return apiError("IMPORT_NOT_FOUND", 404);
  const db = userDb(user.id);

  const { data, error } = await db.imports.select("id,undone_at").eq("id", batchId).maybeSingle();
  if (error) return apiError("DB_ERROR", 500, { detail: error });
  const batch = one<{ id: string; undone_at: string | null }>(data);
  if (!batch) return apiError("IMPORT_NOT_FOUND", 404);
  if (batch.undone_at) return apiError("IMPORT_ALREADY_UNDONE", 409);

  // Status guard in the DELETE itself: a post the scheduler claimed a moment ago is not deleted.
  const { data: deletedData, error: deleteError } = await db.posts.delete()
    .eq("import_batch_id", batchId).in("status", ["draft", "scheduled"]).select("id");
  if (deleteError) return apiError("DB_ERROR", 500, { detail: deleteError });
  const deleted = rows<{ id: string }>(deletedData).length;

  const { count, error: countError } = await db.posts.select("id", { count: "exact", head: true }).eq("import_batch_id", batchId);
  if (countError) console.error("counting remaining posts of a batch failed:", countError);

  const { error: markError } = await db.imports.update({ undone_at: new Date().toISOString(), undone_count: deleted }).eq("id", batchId);
  if (markError) console.error(`marking batch ${batchId} as undone failed:`, markError);

  return NextResponse.json({ deleted, kept: count ?? 0 });
}
