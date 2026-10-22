import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { rows, userDb } from "@/lib/db";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { apiError, invalidFields } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { createImportedPosts, ImportProblem } from "@/lib/import/commit";
import { fileKey, type DeclaredFile } from "@/lib/import/files";
import { mediaLimits } from "@/lib/media/config";
import { MediaConflict } from "@/lib/media/service";
import {
  duplicateKey, MAX_IMPORT_ROWS, summarize, validateImportRows, type PageRef, type ValidatedRow
} from "@/lib/import/validate";

export const runtime = "nodejs";
export const maxDuration = 60;

// Same ceiling as every other way of creating posts (draft + scheduled per user). The 20-per-minute limit of the
// compose form does not apply: an import is one deliberate action, limited by MAX_IMPORT_ROWS and batch rate.
const MAX_OPEN_POSTS = 500;
const MAX_BATCHES_PER_MINUTE = 3;
const PREVIEW_CHARS = 160;

const rowSchema = z.object({
  line: z.number().int().min(1).max(1_000_000),
  message: z.string().max(70_000),
  link: z.string().max(3_000),
  time: z.string().max(100),
  fanpage: z.string().max(200),
  note: z.string().max(700),
  type: z.string().max(50),
  files: z.string().max(3_000)
});

// The files the user picked in the browser (name, size, type: the bytes never come through here), and, on commit,
// the media id each was uploaded as. Everything is re-checked: the browser's claims are only claims.
const declaredFileSchema = z.object({ name: z.string().min(1).max(255), size: z.number().int().min(0), mime: z.string().max(100) });
const uploadedFileSchema = z.object({ name: z.string().min(1).max(255), mediaId: z.string().uuid() });

const bodySchema = z.object({
  mode: z.enum(["preview", "commit"]),
  defaultPageId: z.string().uuid(),
  rows: z.array(rowSchema).min(1),
  // "Dãn lịch tự động": rows with no time are scheduled start, start+gap, ...
  spread: z.object({ start: z.string().datetime(), intervalMinutes: z.number().int().min(5).max(10_080) }).nullable().optional(),
  includeDuplicates: z.boolean().optional(),
  files: z.array(declaredFileSchema).max(1000).default([]),
  uploaded: z.array(uploadedFileSchema).max(200).default([]),
  sourceName: z.string().max(120).optional(),
  sourceFormat: z.enum(["csv", "xlsx", "json", "paste"]).optional()
});

/** What the preview table needs. Full messages are not echoed back (100 rows x 63k chars would be huge). */
function toPreviewRow(r: ValidatedRow) {
  const chars = Array.from(r.message);
  return {
    line: r.line, willImport: r.willImport, errors: r.errors, warnings: r.warnings,
    pageName: r.pageName, messagePreview: chars.slice(0, PREVIEW_CHARS).join("") + (chars.length > PREVIEW_CHARS ? "…" : ""),
    messageLength: r.message.length, linkUrl: r.linkUrl, scheduledAt: r.scheduledAt, note: r.note,
    duplicate: r.duplicate, autoScheduled: r.autoScheduled,
    postType: r.postType, files: r.files, fileKeys: r.fileKeys, mediaKind: r.mediaKind
  };
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);

  const raw = await request.json().catch(() => null);
  if (Array.isArray(raw?.rows) && raw.rows.length > MAX_IMPORT_ROWS) return apiError("IMPORT_TOO_MANY_ROWS", 400);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return invalidFields(parsed.error, { rows: "Dữ liệu nhập", defaultPageId: "Fanpage mặc định", spread: "Lịch tự động", files: "Danh sách tệp", uploaded: "Tệp đã tải lên", mode: "Chế độ" });
  const input = parsed.data;
  const db = userDb(user.id);
  const nowMs = Date.now();

  const spread = input.spread ? { startMs: Date.parse(input.spread.start), intervalMinutes: input.spread.intervalMinutes } : null;
  if (spread && spread.startMs < nowMs - 60_000) return apiError("IMPORT_SPREAD_PAST", 400);

  const { data: pageData, error: pageError } = await db.pages.select("id,page_name,page_id").eq("is_active", true);
  if (pageError) return apiError("DB_ERROR", 500, { detail: pageError });
  const pages = rows<PageRef>(pageData);
  if (!pages.some((p) => p.id === input.defaultPageId)) return apiError("PAGE_NOT_FOUND", 404);

  // Pass 1 resolves each row's Fanpage; then we ask the database which (Fanpage, message) pairs already exist.
  const declared = new Map<string, DeclaredFile>(input.files.map((f) => [fileKey(f.name), f]));
  const base = { pages, defaultPageId: input.defaultPageId, nowMs, spread, includeDuplicates: Boolean(input.includeDuplicates), files: declared, limits: mediaLimits };
  const first = validateImportRows(input.rows, { ...base, existing: new Set() });
  // Posts with files are told apart by their files too, which the existing posts' messages cannot say: only text and link rows are looked up.
  const candidates = first.filter((r) => r.errors.length === 0 && r.pageId && !r.mediaKind);
  const existing = new Set<string>();
  if (candidates.length) {
    const { data, error } = await supabaseAdmin.rpc("find_duplicate_posts", {
      p_user: user.id,
      p_page_ids: [...new Set(candidates.map((r) => r.pageId))],
      p_messages: [...new Set(candidates.map((r) => r.message))]
    });
    if (error) return apiError("DB_ERROR", 500, { detail: error });
    for (const d of rows<{ page_id: string; message: string }>(data)) existing.add(duplicateKey(d.page_id, d.message));
  }
  const results = validateImportRows(input.rows, { ...base, existing });
  const summary = summarize(results);

  if (input.mode === "preview") return NextResponse.json({ summary, rows: results.map(toPreviewRow) });

  // --- commit: re-validated above from the raw rows, the preview is never trusted ----------------------
  const toImport = results.filter((r) => r.willImport);
  if (!toImport.length) return apiError("IMPORT_EMPTY", 422);

  const [open, recent] = await Promise.all([
    db.posts.select("id", { count: "exact", head: true }).in("status", ["draft", "scheduled"]),
    db.imports.select("id", { count: "exact", head: true }).gte("created_at", new Date(nowMs - 60_000).toISOString())
  ]);
  if (open.error || recent.error) return apiError("DB_ERROR", 500, { detail: open.error ?? recent.error });
  if ((recent.count ?? 0) >= MAX_BATCHES_PER_MINUTE) return apiError("RATE_LIMITED", 429);
  const room = MAX_OPEN_POSTS - (open.count ?? 0);
  if (toImport.length > room) {
    return apiError("QUEUE_FULL", 429, {
      message: `Bạn còn chỗ cho ${Math.max(0, room)} bài nháp/đã lên lịch (tối đa ${MAX_OPEN_POSTS}) nhưng lần nhập này có ${toImport.length} bài. Hãy hủy hoặc xóa bớt bài cũ, hoặc nhập ít dòng hơn.`
    });
  }

  const { data: batchData, error: batchError } = await db.imports.insert({
    source_name: input.sourceName?.trim() || null, source_format: input.sourceFormat ?? null,
    row_count: input.rows.length, created_count: toImport.length, skipped_count: input.rows.length - toImport.length
  }).select("id").single();
  const batchId = (batchData as { id: string } | null)?.id;
  if (batchError || !batchId) return apiError("DB_ERROR", 500, { detail: batchError });

  // All or none: the posts (and the files of the ones that have files) are created together, or the batch is taken back.
  const uploaded = new Map(input.uploaded.map((u) => [fileKey(u.name), u.mediaId]));
  try {
    await createImportedPosts(db, user.id, batchId, toImport, uploaded);
  } catch (e) {
    await db.imports.delete().eq("id", batchId);
    if (e instanceof ImportProblem) return apiError(e.problem.code, e.problem.status, { message: e.problem.message });
    if (e instanceof MediaConflict) return apiError("MEDIA_IN_USE", 409, { message: "Một tệp đã tải lên đang gắn với bài khác. Hãy quay lại bước xem trước và nhập lại." });
    return apiError("DB_ERROR", 500, { detail: e });
  }

  return NextResponse.json({
    batchId, created: toImport.length, skipped: input.rows.length - toImport.length, summary,
    rows: results.map(toPreviewRow).filter((r) => !r.willImport)
  }, { status: 201 });
}
