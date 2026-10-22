import { buildLimits, formatMb, type MediaKind, type MediaLimits } from "@/lib/media/limits";
import { checkDeclaredFile, checkMediaSet, derivePostType, isImageMime, isVideoMime, type PostType } from "@/lib/media/rules";
import { normalizeHeader, type RawRow } from "./columns";
import { fileKey, parseTypeCell, POST_TYPE_LABELS, splitFileNames, type DeclaredFile } from "./files";
import { parseScheduleInput } from "./time";

// Row-by-row checking for an import. Pure: the API supplies the user's Fanpages, the set of posts that
// already exist and the files the user picked (name, size, type: never the bytes), so everything here is
// testable without a database.

export const MAX_IMPORT_ROWS = 100;
export const MAX_IMPORT_BYTES = 1_000_000;
export const MAX_MESSAGE_LENGTH = 63_206;
export const MAX_NOTE_LENGTH = 500;
export const MAX_LINK_LENGTH = 2048;

export type PageRef = { id: string; page_name: string; page_id: string };
export type IssueCode =
  | "MESSAGE_EMPTY" | "MESSAGE_TOO_LONG" | "LINK_INVALID" | "PAGE_NOT_FOUND" | "PAGE_AMBIGUOUS"
  | "TIME_INVALID" | "TIME_NO_TIME" | "TIME_PAST" | "TIME_TOO_FAR" | "NOTE_TOO_LONG"
  | "TYPE_INVALID" | "TYPE_MISMATCH" | "FILE_MISSING" | "FILE_REPEATED" | "FILE_INVALID" | "MEDIA_WITH_LINK" | "MEDIA_MIXED"
  | "FILE_KIND_CONFLICT" | "MEDIA_BUDGET"
  | "DUPLICATE_IN_FILE" | "DUPLICATE_EXISTING";
export type Issue = { code: IssueCode; message: string };
export type Duplicate = { kind: "file"; line: number } | { kind: "existing" };

export type ValidatedRow = {
  line: number;
  errors: Issue[];
  warnings: Issue[];
  pageId: string | null;
  pageName: string | null;
  message: string;
  linkUrl: string | null;
  scheduledAt: string | null;
  note: string | null;
  duplicate: Duplicate | null;
  /** The time was assigned by "dãn lịch tự động", not read from the file. */
  autoScheduled: boolean;
  /** Will be created on commit (valid, and not a skipped duplicate). */
  willImport: boolean;
  /** What the post will be, from its files and link. */
  postType: PostType;
  /** The files of the post as written in the file, in order, and their lookup keys. */
  files: string[];
  fileKeys: string[];
  /** image / video / reel when the row has files. */
  mediaKind: MediaKind | null;
};

export type ValidateOptions = {
  pages: PageRef[];
  defaultPageId: string;
  nowMs: number;
  /** `duplicateKey(pageId, message)` of posts that already exist. */
  existing: Set<string>;
  spread: { startMs: number; intervalMinutes: number } | null;
  includeDuplicates: boolean;
  /** The files the user picked, by `fileKey(name)`. Rows naming a file that is not here are errors. */
  files?: Map<string, DeclaredFile>;
  limits?: MediaLimits;
};

export const duplicateKey = (pageId: string, message: string) => `${pageId}\n${message}`;

const nameKey = (name: string) => normalizeHeader(name);

/** A Fanpage cell: the Facebook page id, or the page name (accents/case/spaces ignored). Empty = the default page. */
export function matchPage(input: string, pages: PageRef[], defaultPageId: string):
  { ok: true; page: PageRef } | { ok: false; reason: "not_found" | "ambiguous" } {
  const text = input.trim();
  if (!text) {
    const page = pages.find((p) => p.id === defaultPageId);
    return page ? { ok: true, page } : { ok: false, reason: "not_found" };
  }
  const byFacebookId = pages.filter((p) => p.page_id === text);
  if (byFacebookId.length === 1) return { ok: true, page: byFacebookId[0] };
  const key = nameKey(text);
  const byName = pages.filter((p) => nameKey(p.page_name) === key);
  if (byName.length === 1) return { ok: true, page: byName[0] };
  return { ok: false, reason: byName.length > 1 ? "ambiguous" : "not_found" };
}

const TIME_MESSAGES = {
  invalid: "Giờ đăng không đọc được. Dùng dạng dd/mm/yyyy hh:mm (giờ Việt Nam).",
  no_time: "Giờ đăng thiếu giờ phút. Dùng dạng dd/mm/yyyy hh:mm.",
  past: "Giờ đăng đã qua. Hãy sửa giờ hoặc để trống để lưu nháp.",
  too_far: "Giờ đăng quá xa (tối đa 3 năm)."
} as const;
const TIME_CODES = { invalid: "TIME_INVALID", no_time: "TIME_NO_TIME", past: "TIME_PAST", too_far: "TIME_TOO_FAR" } as const;

function validateLink(raw: string): { link: string | null; error?: Issue } {
  const text = raw.trim();
  if (!text) return { link: null };
  const bad = { code: "LINK_INVALID" as const, message: "Liên kết không hợp lệ (phải bắt đầu bằng http:// hoặc https://)." };
  if (text.length > MAX_LINK_LENGTH) return { link: null, error: { ...bad, message: `Liên kết dài quá ${MAX_LINK_LENGTH} ký tự.` } };
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { link: null, error: bad };
    return { link: text };
  } catch { return { link: null, error: bad }; }
}

const quoted = (names: string[]) => names.slice(0, 3).map((n) => `“${n}”`).join(", ") + (names.length > 3 ? ` và ${names.length - 3} tệp khác` : "");

type RowFiles = { names: string[]; keys: string[]; kind: MediaKind | null; postType: PostType; errors: Issue[]; sizes: Map<string, number> };

/** The files of one row: do they exist, are they one kind, do they fit, and do they agree with the "Loại bài" cell. */
function checkRowFiles(raw: RawRow, hasLink: boolean, opts: ValidateOptions, limits: MediaLimits): RowFiles {
  const errors: Issue[] = [];
  const names = splitFileNames(raw.files);
  const keys = names.map(fileKey);
  const sizes = new Map<string, number>();
  const declaredType = parseTypeCell(raw.type);
  if (declaredType === null) {
    errors.push({ code: "TYPE_INVALID", message: `Loại bài “${raw.type.trim()}” không hợp lệ. Dùng: bài viết, liên kết, ảnh, nhiều ảnh, video hoặc reel.` });
  }

  if (!names.length) {
    const derived = derivePostType({ linkUrl: hasLink ? "x" : null, media: [] });
    if (declaredType && ["photo", "photos", "video", "reel"].includes(declaredType)) {
      errors.push({ code: "TYPE_MISMATCH", message: `Loại bài ghi “${POST_TYPE_LABELS[declaredType]}” nhưng dòng không có tệp đính kèm.` });
    } else if (declaredType && declaredType !== derived) {
      errors.push({ code: "TYPE_MISMATCH", message: `Loại bài ghi “${POST_TYPE_LABELS[declaredType]}” nhưng dòng ${hasLink ? "có" : "không có"} liên kết.` });
    }
    return { names, keys, kind: null, postType: derived, errors, sizes };
  }

  if (hasLink) errors.push({ code: "MEDIA_WITH_LINK", message: "Bài có tệp ảnh/video không kèm liên kết. Hãy bỏ liên kết hoặc bỏ tệp." });
  if (new Set(keys).size !== keys.length) errors.push({ code: "FILE_REPEATED", message: "Một tệp được ghi hai lần trong cùng một dòng." });

  const picked = opts.files ?? new Map<string, DeclaredFile>();
  const missing = names.filter((_, i) => !picked.has(keys[i]));
  if (missing.length) errors.push({ code: "FILE_MISSING", message: `Chưa chọn tệp ${quoted(missing)} ở bước nhập. Hãy chọn đúng tên tệp (có đuôi .jpg, .mp4…).` });
  if (errors.length) return { names, keys, kind: null, postType: "text", errors, sizes };

  const files = keys.map((k) => picked.get(k) as DeclaredFile);
  const types = files.map((f) => (isImageMime(f.mime) ? "image" : isVideoMime(f.mime) ? "video" : null));
  const unknown = files.filter((_, i) => types[i] === null).map((f) => f.name);
  if (unknown.length) {
    errors.push({ code: "FILE_INVALID", message: `${quoted(unknown)} không phải ảnh JPG, PNG, GIF hoặc video MP4, MOV.` });
    return { names, keys, kind: null, postType: "text", errors, sizes };
  }
  const videos = types.filter((t) => t === "video").length;
  if (videos > 0 && files.length > 1) {
    errors.push({ code: "MEDIA_MIXED", message: "Một bài chỉ có ảnh, hoặc đúng một video / Reels, không trộn lẫn." });
    return { names, keys, kind: null, postType: "text", errors, sizes };
  }

  const kind: MediaKind = videos ? (declaredType === "reel" ? "reel" : "video") : "image";
  const postType = derivePostType({ linkUrl: null, media: files.map(() => ({ kind })) });
  if (declaredType && declaredType !== postType) {
    errors.push({ code: "TYPE_MISMATCH", message: `Loại bài ghi “${POST_TYPE_LABELS[declaredType]}” nhưng tệp của dòng là “${POST_TYPE_LABELS[postType]}”.` });
  }
  for (const f of files) {
    const check = checkDeclaredFile({ kind, mime: f.mime, size: f.size }, limits);
    if (!check.ok) errors.push({ code: "FILE_INVALID", message: `“${f.name}”: ${check.message}` });
    sizes.set(fileKey(f.name), f.size);
  }
  if (!errors.length) {
    const set = checkMediaSet(files.map((f) => ({ kind, size: f.size })), limits);
    if (!set.ok) errors.push({ code: "FILE_INVALID", message: set.message });
  }
  return { names, keys, kind, postType, errors, sizes };
}

export function validateImportRows(rows: RawRow[], opts: ValidateOptions): ValidatedRow[] {
  const limits = opts.limits ?? buildLimits({});
  const firstSeen = new Map<string, number>(); // duplicateKey -> first line in this file
  // Files used by the rows that will be imported: what each is used as, and the running totals against the import caps.
  const usedKind = new Map<string, MediaKind>();
  let usedBytes = 0;

  const out: ValidatedRow[] = rows.map((raw) => {
    const errors: Issue[] = [];
    const warnings: Issue[] = [];
    const message = raw.message.replace(/\r\n?/g, "\n").trim();
    const { link, error: linkError } = validateLink(raw.link);
    if (linkError) errors.push(linkError);

    const media = checkRowFiles(raw, Boolean(link), opts, limits);
    errors.push(...media.errors);

    // A photo or video needs no caption (the compose form allows it too).
    if (!message && !media.names.length) errors.push({ code: "MESSAGE_EMPTY", message: "Thiếu nội dung bài viết." });
    else if (message.length > MAX_MESSAGE_LENGTH) errors.push({ code: "MESSAGE_TOO_LONG", message: `Nội dung dài quá ${MAX_MESSAGE_LENGTH.toLocaleString("vi-VN")} ký tự.` });

    const matched = matchPage(raw.fanpage, opts.pages, opts.defaultPageId);
    let page: PageRef | null = null;
    if (matched.ok) page = matched.page;
    else if (matched.reason === "ambiguous") errors.push({ code: "PAGE_AMBIGUOUS", message: `Có nhiều Fanpage tên “${raw.fanpage.trim()}”. Hãy ghi ID Fanpage.` });
    else errors.push({ code: "PAGE_NOT_FOUND", message: raw.fanpage.trim() ? `Không tìm thấy Fanpage “${raw.fanpage.trim()}” trong các Fanpage đang kết nối.` : "Chưa chọn Fanpage mặc định." });

    let scheduledAt: string | null = null;
    if (raw.time.trim()) {
      const t = parseScheduleInput(raw.time, opts.nowMs);
      if (t.ok) scheduledAt = t.iso;
      else errors.push({ code: TIME_CODES[t.reason], message: TIME_MESSAGES[t.reason] });
    }

    const note = raw.note.replace(/\r\n?/g, "\n").trim();
    if (note.length > MAX_NOTE_LENGTH) errors.push({ code: "NOTE_TOO_LONG", message: `Ghi chú dài quá ${MAX_NOTE_LENGTH} ký tự.` });

    // A row with files is the same post as another only if the files match too (two photo posts may share a caption).
    let duplicate: Duplicate | null = null;
    let registered: string | null = null;
    if (!errors.length && page) {
      const key = duplicateKey(page.id, media.keys.length ? `${message}\n#${media.postType}:${media.keys.join("|")}` : message);
      const first = firstSeen.get(key);
      if (first !== undefined) {
        duplicate = { kind: "file", line: first };
        warnings.push({ code: "DUPLICATE_IN_FILE", message: `Trùng nội dung với dòng ${first} cùng Fanpage.` });
      } else {
        firstSeen.set(key, raw.line);
        registered = key;
        if (opts.existing.has(key)) {
          duplicate = { kind: "existing" };
          warnings.push({ code: "DUPLICATE_EXISTING", message: "Đã có bài trùng nội dung trên Fanpage này." });
        }
      }
    }

    // Files are uploaded once however many rows use them, and only for rows that will be imported: check the
    // caps of one import against those rows, in file order.
    const imports = errors.length === 0 && (!duplicate || opts.includeDuplicates);
    if (imports && media.kind) {
      const clash = media.keys.find((k) => usedKind.has(k) && usedKind.get(k) !== media.kind);
      if (clash !== undefined) {
        if (registered) firstSeen.delete(registered);
        errors.push({ code: "FILE_KIND_CONFLICT", message: `Tệp “${media.names[media.keys.indexOf(clash)]}” đã dùng cho một dòng khác với vai trò khác (video và Reels). Hãy dùng bản sao riêng.` });
      } else {
        const fresh = media.keys.filter((k) => !usedKind.has(k));
        const freshBytes = fresh.reduce((sum, k) => sum + (media.sizes.get(k) ?? 0), 0);
        if (usedKind.size + fresh.length > limits.importFiles) {
          if (registered) firstSeen.delete(registered);
          errors.push({ code: "MEDIA_BUDGET", message: `Mỗi lần nhập tối đa ${limits.importFiles} tệp khác nhau. Hãy chia thành nhiều lần nhập.` });
        } else if (usedBytes + freshBytes > limits.importTotalBytes) {
          if (registered) firstSeen.delete(registered);
          errors.push({ code: "MEDIA_BUDGET", message: `Tổng dung lượng tệp của một lần nhập tối đa ${formatMb(limits.importTotalBytes)}. Hãy chia thành nhiều lần nhập.` });
        } else {
          for (const k of fresh) usedKind.set(k, media.kind);
          usedBytes += freshBytes;
        }
      }
    }

    return {
      line: raw.line, errors, warnings, pageId: page?.id ?? null, pageName: page?.page_name ?? null,
      message, linkUrl: link, scheduledAt, note: note || null, duplicate, autoScheduled: false,
      willImport: errors.length === 0 && (!duplicate || opts.includeDuplicates),
      postType: media.postType, files: media.names, fileKeys: media.keys, mediaKind: media.kind
    };
  });

  // "Dãn lịch tự động": rows that will be imported without a time get start, start+gap, start+2*gap... in file order.
  if (opts.spread) {
    let k = 0;
    for (const row of out) {
      if (!row.willImport || row.scheduledAt) continue;
      row.scheduledAt = new Date(opts.spread.startMs + k * opts.spread.intervalMinutes * 60_000).toISOString();
      row.autoScheduled = true;
      k++;
    }
  }
  return out;
}

export function summarize(results: ValidatedRow[]) {
  return {
    total: results.length,
    willImport: results.filter((r) => r.willImport).length,
    errors: results.filter((r) => r.errors.length > 0).length,
    duplicates: results.filter((r) => r.duplicate).length,
    scheduled: results.filter((r) => r.willImport && r.scheduledAt).length,
    drafts: results.filter((r) => r.willImport && !r.scheduledAt).length,
    withMedia: results.filter((r) => r.willImport && r.mediaKind).length
  };
}
