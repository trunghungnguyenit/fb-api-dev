import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { one, rows, userDb } from "@/lib/db";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { apiError } from "@/lib/api-error";
import { summarizeImpact, type PostCountRow } from "@/lib/page-removal";

export const runtime = "nodejs";

/** GET /api/facebook/pages/[id]/impact — what removing this Fanpage would do to its posts (for the confirm dialog). */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("PAGE_NOT_FOUND", 404);

  const { data, error } = await userDb(user.id).pages.select("id,page_name,removed_at").eq("id", id).maybeSingle();
  if (error) return apiError("DB_ERROR", 500, { detail: error });
  const page = one<{ id: string; page_name: string; removed_at: string | null }>(data);
  if (!page) return apiError("PAGE_NOT_FOUND", 404);

  const counts = await supabaseAdmin.rpc("page_post_counts", { p_user: user.id, p_page: id });
  if (counts.error) return apiError("DB_ERROR", 500, { detail: counts.error });
  return NextResponse.json({ pageName: page.page_name, removed: Boolean(page.removed_at), impact: summarizeImpact(rows<PostCountRow>(counts.data)) });
}
