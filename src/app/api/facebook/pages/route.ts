import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { userDb } from "@/lib/db";
import { apiError } from "@/lib/api-error";

export async function GET() {
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { data, error } = await userDb(user.id).pages
    .select("id,page_id,page_name,tasks,is_active,removed_at,created_at").order("page_name");
  if (error) return apiError("DB_ERROR", 500, { detail: error });
  return NextResponse.json({ pages: data ?? [] });
}
