import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { invalidFields } from "@/lib/api-error";
import { ApiFailure, fieldErrorsOf } from "@/lib/client-api";
import {
  checkJumpPage, checkLink, checkMessage, checkNote, checkPageSelection, checkReply, checkSchedule, firstMessage, MESSAGE_MAX, zodFieldErrors
} from "@/lib/field-errors";

const NOW = Date.parse("2026-10-22T10:00:00");
const local = (ms: number) => { const d = new Date(ms); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

describe("checkMessage", () => {
  it("asks for text when it is required, and counts what is over the limit", () => {
    expect(checkMessage("   ", { required: true })).toMatch(/Nhập nội dung/);
    expect(checkMessage("", { required: false })).toBeNull();
    expect(checkMessage("Xin chào", { required: true })).toBeNull();
    expect(checkMessage("x".repeat(MESSAGE_MAX + 5), { required: true })).toMatch(/dài quá 63\.206 ký tự \(đang có 63\.211\)/);
  });
});

describe("checkLink", () => {
  it("accepts nothing, http and https; explains every other case", () => {
    expect(checkLink("")).toBeNull();
    expect(checkLink("  https://ten-mien.com/bai?a=1 ")).toBeNull();
    expect(checkLink("http://localhost:3000/x")).toBeNull();
    expect(checkLink("ftp://ten-mien.com")).toMatch(/http:\/\/ hoặc https:\/\//);
    expect(checkLink("ten-mien.com")).toMatch(/không hợp lệ/);
    expect(checkLink("https://abc")).toMatch(/thiếu tên miền/);
    expect(checkLink("https://a.vn/" + "x".repeat(2100))).toMatch(/dài quá 2\.048/);
  });
});

describe("checkSchedule", () => {
  it("requires a time only when asked, and rejects the past", () => {
    expect(checkSchedule("", NOW, { required: false })).toBeNull();
    expect(checkSchedule("", NOW, { required: true })).toMatch(/Chọn ngày và giờ/);
    expect(checkSchedule("không phải ngày", NOW, { required: true })).toMatch(/chưa đúng/);
    expect(checkSchedule(local(NOW - 3_600_000), NOW, { required: false })).toMatch(/đã qua/);
    expect(checkSchedule(local(NOW + 3_600_000), NOW, { required: true })).toBeNull();
  });
  it("lets a time a few seconds ago through (the clock moves while the user types)", () => {
    expect(checkSchedule(local(NOW - 30_000), NOW, { required: true })).toBeNull();
  });
});

describe("other field checks", () => {
  it("checks notes, replies, page selections and the jump-to-page box", () => {
    expect(checkNote("a".repeat(501))).toMatch(/Ghi chú dài quá 500/);
    expect(checkNote("ok")).toBeNull();
    expect(checkReply("  ")).toMatch(/Nhập nội dung trả lời/);
    expect(checkReply("x".repeat(8001))).toMatch(/8\.000/);
    expect(checkReply("Cảm ơn bạn")).toBeNull();
    expect(checkPageSelection([], 10)).toMatch(/ít nhất một Fanpage/);
    expect(checkPageSelection(Array(11).fill("a"), 10)).toMatch(/tối đa 10/);
    expect(checkPageSelection(["a"], 10)).toBeNull();
    expect(checkJumpPage("", 5)).toMatchObject({ ok: false, message: expect.stringContaining("1 đến 5") });
    expect(checkJumpPage("2.5", 5)).toMatchObject({ ok: false, message: expect.stringContaining("số nguyên") });
    expect(checkJumpPage("9", 5)).toMatchObject({ ok: false, message: expect.stringContaining("Chỉ có 5 trang") });
    expect(checkJumpPage(" 3 ", 5)).toEqual({ ok: true, page: 3 });
  });
});

describe("zodFieldErrors / invalidFields", () => {
  const schema = z.object({
    message: z.string().trim().min(1).max(10),
    linkUrl: z.string().url().refine((v) => /^https?:\/\//i.test(v)).optional().or(z.literal("")),
    pageIds: z.array(z.string().uuid()).min(1).max(2),
    when: z.union([z.literal("now"), z.string().datetime()]),
    mode: z.enum(["a", "b"])
  });
  const labels = { message: "Nội dung bài viết", linkUrl: "Liên kết", pageIds: "Fanpage", when: "Thời điểm đăng", mode: "Cách đăng lại" };

  it("says which field is wrong and why, in Vietnamese, never with the raw zod text", () => {
    const r = schema.safeParse({ message: "quá dài quá dài", linkUrl: "ftp://x", pageIds: [], when: "zzz" });
    expect(r.success).toBe(false);
    const fields = zodFieldErrors((r as { error: z.ZodError }).error, labels);
    expect(fields.message).toBe("Nội dung bài viết dài quá 10 ký tự.");
    expect(fields.linkUrl).toBe("Liên kết không hợp lệ.");
    expect(fields.pageIds).toBe("Hãy chọn ít nhất 1 fanpage.");
    expect(fields.when).toBe("Thời điểm đăng chưa đúng định dạng ngày giờ.");
    expect(fields.mode).toBeTruthy();
    expect(Object.values(fields).join(" ")).not.toMatch(/Invalid|expected|string|zod/i);
  });

  it("an empty message is 'không được để trống', a missing one is 'Thiếu …'", () => {
    const empty = schema.safeParse({ message: "   ", pageIds: ["x"], when: "now", mode: "a" });
    expect(zodFieldErrors((empty as { error: z.ZodError }).error, labels).message).toBe("Nội dung bài viết không được để trống.");
    const missing = schema.safeParse({ pageIds: [], when: "now", mode: "a" });
    expect(zodFieldErrors((missing as { error: z.ZodError }).error, labels).message).toBe("Thiếu nội dung bài viết.");
  });

  it("invalidFields answers 400 with the first message as the main text and the fields renamed to the form's names", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = schema.safeParse({ message: "ok", linkUrl: "nope", pageIds: [], when: "now", mode: "a" });
    const res = invalidFields((r as { error: z.ZodError }).error, labels, { linkUrl: "link", pageIds: "pages" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_REQUEST");
    expect(body.fields).toEqual({ link: "Liên kết không hợp lệ.", pages: "Hãy chọn ít nhất 1 fanpage." });
    expect(body.error).toBe(firstMessage(body.fields));
    expect(body.ref).toMatch(/^[A-Z0-9]{8}$/);
  });
});

describe("fieldErrorsOf", () => {
  it("reads the per-field messages of an API failure, and nothing from any other error", () => {
    expect(fieldErrorsOf(new ApiFailure("x", "INVALID_REQUEST", { fields: { message: "Thiếu nội dung", junk: 5 } }))).toEqual({ message: "Thiếu nội dung" });
    expect(fieldErrorsOf(new ApiFailure("x", "DB_ERROR", { error: "x" }))).toBeNull();
    expect(fieldErrorsOf(new Error("boom"))).toBeNull();
  });
});
