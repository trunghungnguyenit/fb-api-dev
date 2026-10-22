"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useConfirm } from "@/app/confirm-dialog";
import { FieldError, focusFirstInvalid, invalidProps } from "@/app/form-field";
import { ApiFailure, callApi, userMessage } from "@/lib/client-api";
import { checkSchedule } from "@/lib/field-errors";
import { discardUpload, uploadMedia } from "@/lib/media/client-upload";
import { formatMb, type ClientMediaLimits, type MediaKind } from "@/lib/media/limits";
import { messageFor } from "@/lib/errors";
import { FIELD_LABELS, type RawRow } from "@/lib/import/columns";
import { fileKey, POST_TYPE_LABELS, splitFileNames } from "@/lib/import/files";
import type { PostType } from "@/lib/media/rules";
import { formatVietnamTime } from "@/lib/import/time";
import { MAX_IMPORT_ROWS } from "@/lib/import/validate";
import { downloadCsv, downloadCsvTemplate, downloadJsonTemplate, downloadXlsxTemplate } from "./templates";
import { parseImportFile, parsePastedText, type ImportFormat, type ParseOutcome } from "./parse-file";

type Page = { id: string; page_name: string };
type Issue = { code: string; message: string };
type PreviewRow = {
  line: number; willImport: boolean; errors: Issue[]; warnings: Issue[]; pageName: string | null;
  messagePreview: string; messageLength: number; linkUrl: string | null; scheduledAt: string | null; note: string | null;
  duplicate: { kind: "file"; line: number } | { kind: "existing" } | null; autoScheduled: boolean;
  postType: PostType; files: string[]; fileKeys: string[]; mediaKind: MediaKind | null;
};
type Summary = { total: number; willImport: number; errors: number; duplicates: number; scheduled: number; drafts: number; withMedia: number };
type PreviewResponse = { summary: Summary; rows: PreviewRow[] };
type CommitResponse = PreviewResponse & { batchId: string; created: number; skipped: number };
type Source = { rows: RawRow[]; ignoredColumns: string[]; format: ImportFormat; sourceName: string };

const INTERVALS = [
  { value: 60, label: "1 giờ" }, { value: 180, label: "3 giờ" }, { value: 360, label: "6 giờ" },
  { value: 720, label: "12 giờ" }, { value: 1440, label: "1 ngày" }, { value: 2880, label: "2 ngày" }
];

/** Next full hour, as a value for <input type="datetime-local"> in the browser's own zone. */
function defaultStart() {
  const d = new Date(Date.now() + 3_600_000);
  d.setMinutes(0, 0, 0);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}

function failureText(outcome: Extract<ParseOutcome, { ok: false }>) {
  return outcome.detail ?? messageFor(outcome.code);
}

/** Names the rows refer to, once each (case-insensitive), as written the first time. */
function referencedNames(rows: RawRow[]) {
  const byKey = new Map<string, string>();
  for (const r of rows) for (const name of splitFileNames(r.files)) if (!byKey.has(fileKey(name))) byKey.set(fileKey(name), name);
  return byKey;
}

export default function ImportWizard({ pages, limits }: { pages: Page[]; limits: ClientMediaLimits }) {
  const router = useRouter();
  const [step, setStep] = useState<"input" | "preview" | "done">("input");
  const [defaultPageId, setDefaultPageId] = useState(pages[0].id);
  const [tab, setTab] = useState<"file" | "paste">("file");
  const [pasted, setPasted] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [parseError, setParseError] = useState("");
  const [spreadOn, setSpreadOn] = useState(false);
  const [spreadStart, setSpreadStart] = useState("");
  const [spreadError, setSpreadError] = useState<string | null>(null);
  const confirm = useConfirm();
  const [spreadInterval, setSpreadInterval] = useState(360);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [result, setResult] = useState<CommitResponse | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | "undo" | null>(null);
  // The files picked for the rows that name files: they stay in the browser until the commit uploads the ones needed.
  const [picked, setPicked] = useState<Map<string, File>>(new Map());
  const [pickNote, setPickNote] = useState("");
  const [uploadNote, setUploadNote] = useState("");
  const [error, setError] = useState("");
  const [undone, setUndone] = useState<{ deleted: number; kept: number } | null>(null);

  // The browser's own zone is only known on the client.
  useEffect(() => setSpreadStart(defaultStart()), []);

  function accept(outcome: ParseOutcome) {
    setPreview(null); setError("");
    if (outcome.ok) { setSource(outcome); setParseError(""); }
    else { setSource(null); setParseError(failureText(outcome)); }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    accept(await parseImportFile(file));
  }

  // Pasted text is parsed shortly after the user stops typing/pasting.
  useEffect(() => {
    if (tab !== "paste") return;
    if (!pasted.trim()) { setSource(null); setParseError(""); return; }
    const timer = setTimeout(() => accept(parsePastedText(pasted)), 250);
    return () => clearTimeout(timer);
  }, [pasted, tab]);

  const referenced = useMemo(() => referencedNames(source?.rows ?? []), [source]);
  const missingNames = [...referenced].filter(([key]) => !picked.has(key)).map(([, name]) => name);

  function onPickFiles(list: FileList | null) {
    if (!list?.length) return;
    // The newest pick wins, so a wrong file is replaced by picking the right one with the same name.
    const next = new Map(picked);
    const replaced: string[] = [];
    for (const file of Array.from(list)) {
      const key = fileKey(file.name);
      const existing = next.get(key);
      if (existing && (existing.size !== file.size || existing.lastModified !== file.lastModified)) replaced.push(file.name);
      next.set(key, file);
    }
    setPicked(next); setPreview(null);
    setPickNote(replaced.length ? `Đã thay tệp cùng tên bằng tệp vừa chọn: ${replaced.slice(0, 3).join(", ")}.` : "");
  }

  const spread = useMemo(() => {
    if (!spreadOn || !spreadStart) return null;
    const start = new Date(spreadStart);
    return Number.isNaN(start.getTime()) ? null : { start: start.toISOString(), intervalMinutes: spreadInterval };
  }, [spreadOn, spreadStart, spreadInterval]);

  // Only the files the rows name are described to the server (name, size, type); the bytes go to Storage on commit.
  const declaredFiles = () => [...referenced.keys()].flatMap((key) => {
    const f = picked.get(key);
    return f ? [{ name: f.name, size: f.size, mime: f.type }] : [];
  });

  const request = (mode: "preview" | "commit", includeDup = includeDuplicates) => ({
    mode, defaultPageId, rows: source?.rows ?? [], spread, includeDuplicates: includeDup,
    sourceName: source?.sourceName, sourceFormat: source?.format, files: declaredFiles()
  });

  async function runPreview(includeDup = includeDuplicates) {
    if (!source) { setParseError("Chọn tệp CSV, Excel (.xlsx) hoặc JSON, hoặc dán dữ liệu từ bảng tính, rồi mới xem trước."); return; }
    if (spreadOn) {
      const wrong = checkSchedule(spreadStart, Date.now(), { required: true });
      if (wrong) { setSpreadError(wrong); focusFirstInvalid(); return; }
    }
    setBusy("preview"); setError(""); setSpreadError(null);
    try {
      setPreview(await callApi<PreviewResponse>("/api/posts/import", { method: "POST", body: request("preview", includeDup) }));
      setStep("preview");
    } catch (e) {
      // A start time in the past is a problem of that one field, not of the whole import.
      if (e instanceof ApiFailure && e.code === "IMPORT_SPREAD_PAST") { setSpreadError(e.message); focusFirstInvalid(); }
      else setError(userMessage(e));
    }
    finally { setBusy(null); }
  }

  /** Uploads each file the importable rows need, once, as the kind it is used as. On any failure the uploads so far are dropped. */
  async function uploadNeeded(): Promise<{ name: string; mediaId: string }[]> {
    const needed = new Map<string, MediaKind>();
    for (const r of preview?.rows ?? []) if (r.willImport && r.mediaKind) r.fileKeys.forEach((k) => needed.set(k, r.mediaKind as MediaKind));
    const uploaded: { name: string; mediaId: string }[] = [];
    try {
      let done = 0;
      for (const [key, kind] of needed) {
        const file = picked.get(key);
        if (!file) throw new Error("missing file");
        setUploadNote(`Đang tải tệp lên (${done + 1}/${needed.size}): ${file.name}`);
        const { mediaId } = await uploadMedia(file, kind, () => undefined);
        uploaded.push({ name: file.name, mediaId });
        done++;
      }
    } catch (e) {
      await Promise.all(uploaded.map((u) => discardUpload(u.mediaId)));
      throw e;
    }
    return uploaded;
  }

  async function commit() {
    if (!source) return;
    setBusy("commit"); setError(""); setUploadNote("");
    let uploaded: { name: string; mediaId: string }[] = [];
    try {
      uploaded = await uploadNeeded();
      setUploadNote(uploaded.length ? "Đang tạo bài viết…" : "");
      setResult(await callApi<CommitResponse>("/api/posts/import", { method: "POST", body: { ...request("commit"), uploaded } }));
      setStep("done");
      router.refresh();
    } catch (e) {
      // The server takes the batch back when it fails; uploads it did not use are dropped here too (a retry uploads again).
      await Promise.all(uploaded.map((u) => discardUpload(u.mediaId)));
      setError(e instanceof Error && e.message === "missing file" ? "Thiếu tệp ảnh/video. Hãy quay lại và chọn đủ tệp." : userMessage(e));
    } finally { setBusy(null); setUploadNote(""); }
  }

  async function undo() {
    if (!result || !(await confirm({ title: "Hoàn tác lần nhập này?", message: "Các bài nháp và bài đã lên lịch chưa đăng của lần nhập này sẽ bị xóa.", confirmLabel: "Hoàn tác", tone: "danger" }))) return;
    setBusy("undo"); setError("");
    try {
      setUndone(await callApi<{ deleted: number; kept: number }>(`/api/posts/import/${result.batchId}/undo`, { method: "POST" }));
      router.refresh();
    } catch (e) { setError(userMessage(e)); }
    finally { setBusy(null); }
  }

  function downloadReport() {
    if (!source) return;
    const byLine = new Map(source.rows.map((r) => [r.line, r]));
    const skipped = (step === "done" ? result?.rows : preview?.rows)?.filter((r) => !r.willImport) ?? [];
    const lines = skipped.map((r) => {
      const raw = byLine.get(r.line);
      const issues = [...r.errors, ...r.warnings].map((i) => i.message).join(" | ");
      return [r.line, r.errors.length ? "Lỗi" : "Bỏ qua (trùng)", issues,
        raw?.message ?? "", raw?.link ?? "", raw?.time ?? "", raw?.fanpage ?? "", raw?.note ?? "", raw?.type ?? "", raw?.files ?? ""];
    });
    downloadCsv("bao-cao-dong-loi.csv", [["Dòng", "Kết quả", "Vấn đề", ...Object.values(FIELD_LABELS)], ...lines], true);
  }

  function restart() {
    setStep("input"); setSource(null); setPreview(null); setResult(null); setPasted(""); setUndone(null); setError(""); setParseError("");
    setPicked(new Map()); setPickNote("");
    setIncludeDuplicates(false);
  }

  const steps = [["input", "1. Chọn dữ liệu"], ["preview", "2. Xem trước"], ["done", "3. Hoàn tất"]] as const;
  const stepIndex = steps.findIndex(([key]) => key === step);

  return <div>
    <ol className="steps" aria-label="Các bước">
      {steps.map(([key, label], i) => <li key={key} className={i === stepIndex ? "is-current" : i < stepIndex ? "is-done" : ""} aria-current={i === stepIndex ? "step" : undefined}>{label}</li>)}
    </ol>

    {step === "input" && <form className="repost-grid" noValidate onSubmit={(e) => { e.preventDefault(); void runPreview(); }}>
      <div className="repost-main">
        <fieldset className="form-section">
          <legend>Fanpage mặc định</legend>
          <div className="field"><label htmlFor="default-page" className="visually-hidden">Fanpage mặc định</label>
            <select id="default-page" value={defaultPageId} onChange={(e) => { setDefaultPageId(e.target.value); setPreview(null); }}>
              {pages.map((p) => <option key={p.id} value={p.id}>{p.page_name}</option>)}
            </select></div>
          <p className="subtle form-hint">Dòng nào không ghi Fanpage sẽ đăng lên Fanpage này. Muốn đăng sang Fanpage khác, ghi tên hoặc ID Fanpage ở cột “Fanpage”.</p>
        </fieldset>

        <fieldset className="form-section">
          <legend>Dữ liệu bài viết</legend>
          <div className="tab-buttons" role="group" aria-label="Nguồn dữ liệu">
            <button type="button" className={`btn small${tab === "file" ? " primary" : ""}`} aria-pressed={tab === "file"} onClick={() => { setTab("file"); setSource(null); setParseError(""); }}>Tải tệp lên</button>
            <button type="button" className={`btn small${tab === "paste" ? " primary" : ""}`} aria-pressed={tab === "paste"} onClick={() => { setTab("paste"); setSource(null); setParseError(""); }}>Dán từ bảng tính</button>
          </div>

          {tab === "file"
            ? <label className="dropzone">
                <input type="file" accept=".csv,.tsv,.txt,.xlsx,.json" onChange={(e) => void onFile(e.target.files?.[0])} />
                <strong>Chọn tệp CSV, Excel (.xlsx) hoặc JSON</strong>
                <span className="subtle">Tối đa {MAX_IMPORT_ROWS} dòng và 1 MB mỗi lần</span>
              </label>
            : <div className="field"><label htmlFor="paste" className="visually-hidden">Dữ liệu dán từ bảng tính</label>
                <textarea id="paste" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Chọn các ô trong Excel / Google Sheets (gồm cả dòng tiêu đề) rồi dán vào đây…" /></div>}

          {parseError && <p className="error" role="alert">{parseError}</p>}
          {source && <p className="success" role="status">
            Đã đọc <strong>{source.rows.length}</strong> dòng từ “{source.sourceName}”.
            {source.ignoredColumns.length > 0 && <span className="subtle"> Bỏ qua các cột lạ: {source.ignoredColumns.join(", ")}.</span>}
          </p>}
        </fieldset>

        {source && referenced.size > 0 && <fieldset className="form-section">
          <legend>Tệp ảnh / video</legend>
          <label className="dropzone">
            <input type="file" multiple accept=".jpg,.jpeg,.png,.gif,.mp4,.mov" onChange={(e) => { onPickFiles(e.target.files); e.target.value = ""; }} />
            <strong>Chọn các tệp ảnh, video, Reels của các dòng trên</strong>
            <span className="subtle">Tên tệp phải trùng với cột “{FIELD_LABELS.files}”. Chọn nhiều tệp cùng lúc được.</span>
          </label>
          <p className={missingNames.length ? "error" : "success"} role="status">
            Cần {referenced.size} tệp: đã chọn {referenced.size - missingNames.length}
            {missingNames.length > 0 && <>, còn thiếu {missingNames.length} ({missingNames.slice(0, 4).join(", ")}{missingNames.length > 4 ? "…" : ""})</>}.
          </p>
          {pickNote && <p className="subtle" role="status">{pickNote}</p>}
          <p className="subtle form-hint">
            Tệp được tải lên khi bạn bấm “Nhập”, mỗi tệp một lần dù nhiều bài dùng chung. Mỗi lần nhập tối đa {limits.importFiles} tệp khác nhau, tổng {formatMb(limits.importTotalBytes)}.
          </p>
        </fieldset>}
      </div>

      <aside className="repost-side" aria-label="Tùy chọn và hướng dẫn">
        <div className="side-card">
          <fieldset className="form-section">
            <legend>Lên lịch tự động</legend>
            <label className="choice-inline"><input type="checkbox" checked={spreadOn} onChange={(e) => { setSpreadOn(e.target.checked); setPreview(null); }} />
              <span>Dãn lịch cho các dòng không có giờ đăng (thay vì lưu nháp)</span></label>
            {spreadOn && <div className="spread-grid">
              <div className="field"><label htmlFor="spread-start">Bắt đầu lúc</label>
                <input id="spread-start" type="datetime-local" value={spreadStart} onChange={(e) => { setSpreadStart(e.target.value); setSpreadError(null); }} {...invalidProps("spread-start", spreadError)} />
                <FieldError id="spread-start" message={spreadError} /></div>
              <div className="field"><label htmlFor="spread-gap">Mỗi bài cách nhau</label>
                <select id="spread-gap" value={spreadInterval} onChange={(e) => setSpreadInterval(Number(e.target.value))}>
                  {INTERVALS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
                </select></div>
            </div>}
          </fieldset>

          {error && <p className="error" role="alert">{error}</p>}
          <div className="form-footer">
            <p className="summary">{source ? `Sẵn sàng kiểm tra ${source.rows.length} dòng.` : "Chọn tệp hoặc dán dữ liệu để tiếp tục."}</p>
            <button className="btn primary" type="submit" disabled={busy !== null}>{busy === "preview" ? "Đang kiểm tra…" : "Xem trước"}</button>
            <Link className="btn" href="/posts">Hủy</Link>
          </div>
        </div>

        <div className="help-card">
          <strong>Các cột được nhận</strong>
          <ul>
            <li><b>Nội dung</b> (bắt buộc): có thể nhiều dòng.</li>
            <li><b>Liên kết</b>: bắt đầu bằng http:// hoặc https://.</li>
            <li><b>Thời gian đăng</b>: dd/mm/yyyy hh:mm, giờ Việt Nam. Có giờ thì lên lịch, trống thì lưu nháp.</li>
            <li><b>Fanpage</b>: tên hoặc ID; trống thì dùng Fanpage mặc định.</li>
            <li><b>Ghi chú</b>: chỉ để quản lý, không đăng lên Facebook.</li>
            <li><b>Tệp đính kèm</b>: tên tệp ảnh/video, nhiều tệp cách nhau bằng dấu ;. Bài có tệp không kèm liên kết; không cần Nội dung nếu bài có tệp.</li>
            <li><b>Loại bài</b> (tùy chọn): tự nhận ra từ tệp (1 ảnh, nhiều ảnh, video). Chỉ cần ghi <b>reel</b> để đăng video thành Reels.</li>
          </ul>
          <p className="subtle">Ảnh JPG/PNG/GIF tối đa {formatMb(limits.imageBytes)} mỗi ảnh, {limits.imagesPerPost} ảnh mỗi bài; video MP4/MOV tối đa {formatMb(limits.videoBytes)}, Reels {formatMb(limits.reelBytes)}. Dòng tệp mẫu dùng tên giả: hãy đổi thành tên tệp của bạn.</p>
          <p className="subtle">
            Tải tệp mẫu: <button type="button" className="link-button" onClick={downloadCsvTemplate}>CSV</button> ·{" "}
            <button type="button" className="link-button" onClick={() => void downloadXlsxTemplate()}>Excel</button> ·{" "}
            <button type="button" className="link-button" onClick={downloadJsonTemplate}>JSON</button>
          </p>
        </div>
      </aside>
    </form>}

    {step === "preview" && preview && <PreviewStep
      preview={preview} onlyProblems={onlyProblems} setOnlyProblems={setOnlyProblems}
      includeDuplicates={includeDuplicates}
      onToggleDuplicates={(v) => { setIncludeDuplicates(v); void runPreview(v); }}
      busy={busy} error={error} uploadNote={uploadNote} onBack={() => setStep("input")} onCommit={() => void commit()} onReport={downloadReport} />}

    {step === "done" && result && <div className="form-narrow" role="status">
      {undone
        ? <p className="success">Đã hoàn tác: xóa {undone.deleted} bài{undone.kept > 0 ? `, giữ lại ${undone.kept} bài đã đăng hoặc đang xử lý` : ""}.</p>
        : <p className="success"><strong>Đã nhập {result.created} bài</strong>
            {result.summary.scheduled > 0 && <> · {result.summary.scheduled} lên lịch</>}{result.summary.drafts > 0 && <> · {result.summary.drafts} bản nháp</>}
            {result.skipped > 0 && <> · bỏ qua {result.skipped} dòng</>}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions" style={{ marginTop: 16 }}>
        <Link className="btn primary" href={`/posts?batch=${result.batchId}`}>Xem các bài đã nhập</Link>
        {result.rows.length > 0 && <button type="button" className="btn" onClick={downloadReport}>Tải báo cáo dòng bị bỏ qua</button>}
        {!undone && <button type="button" className="btn danger" disabled={busy !== null} onClick={() => void undo()}>{busy === "undo" ? "Đang hoàn tác…" : "Hoàn tác lần nhập"}</button>}
        <button type="button" className="btn" onClick={restart}>Nhập tiếp</button>
      </div>
    </div>}
  </div>;
}

export function PreviewStep(props: {
  preview: PreviewResponse; onlyProblems: boolean; setOnlyProblems: (v: boolean) => void;
  includeDuplicates: boolean; onToggleDuplicates: (v: boolean) => void;
  busy: "preview" | "commit" | "undo" | null; error: string; uploadNote?: string; onBack: () => void; onCommit: () => void; onReport: () => void;
}) {
  const { preview, onlyProblems, includeDuplicates, busy } = props;
  const s = preview.summary;
  const shown = onlyProblems ? preview.rows.filter((r) => r.errors.length || r.warnings.length) : preview.rows;
  const skipped = s.total - s.willImport;

  return <div>
    <div className="chips" aria-live="polite">
      <span className="chip">{s.total} dòng</span>
      <span className="chip ok">{s.willImport} sẽ nhập ({s.scheduled} lên lịch · {s.drafts} nháp)</span>
      {s.withMedia > 0 && <span className="chip">{s.withMedia} bài có ảnh/video</span>}
      {s.errors > 0 && <span className="chip bad">{s.errors} lỗi</span>}
      {s.duplicates > 0 && <span className="chip warn">{s.duplicates} trùng</span>}
    </div>

    <div className="preview-options">
      {s.duplicates > 0 && <label className="choice-inline"><input type="checkbox" checked={includeDuplicates} disabled={busy !== null} onChange={(e) => props.onToggleDuplicates(e.target.checked)} /><span>Vẫn nhập cả các dòng trùng</span></label>}
      <label className="choice-inline"><input type="checkbox" checked={onlyProblems} onChange={(e) => props.setOnlyProblems(e.target.checked)} /><span>Chỉ hiện dòng có vấn đề</span></label>
    </div>

    <div className="table-wrap"><table className="import-table">
      <thead><tr>
        <th scope="col">Dòng</th><th scope="col">Kết quả</th><th scope="col">Fanpage</th><th scope="col">Loại</th><th scope="col" className="col-content">Nội dung</th>
        <th scope="col">Giờ đăng</th><th scope="col">Ghi chú</th><th scope="col" className="col-issues">Vấn đề</th>
      </tr></thead>
      <tbody>
        {shown.map((r) => <tr key={r.line} className={r.errors.length ? "row-bad" : r.duplicate && !r.willImport ? "row-warn" : ""}>
          <td>{r.line}</td>
          <td><span className={`pill ${r.errors.length ? "pill-bad" : r.willImport ? "pill-ok" : "pill-warn"}`}>
            {r.errors.length ? "Lỗi" : !r.willImport ? "Bỏ qua (trùng)" : r.scheduledAt ? "Lên lịch" : "Nháp"}
          </span></td>
          <td className="cell-nowrap">{r.pageName ?? "—"}</td>
          <td><div className="cell-nowrap">{POST_TYPE_LABELS[r.postType]}</div>
            {r.files.length > 0 && <div className="subtle cell-meta clamp-3">{r.files.join(", ")}</div>}</td>
          <td className="col-content"><div className="clamp-3">{r.messagePreview || <span className="subtle">(trống)</span>}</div>
            <div className="subtle cell-meta">{r.messageLength.toLocaleString("vi-VN")} ký tự{r.linkUrl && <> · có liên kết</>}</div></td>
          <td className="cell-nowrap">{r.scheduledAt ? formatVietnamTime(r.scheduledAt) : "—"}{r.autoScheduled && <span className="badge">tự động</span>}</td>
          <td>{r.note ?? "—"}</td>
          <td className="col-issues">
            {r.errors.map((i) => <div key={i.code} className="issue bad">{i.message}</div>)}
            {r.warnings.map((i) => <div key={i.code} className="issue warn">{i.message}</div>)}
            {!r.errors.length && !r.warnings.length && <span className="subtle">—</span>}
          </td>
        </tr>)}
        {shown.length === 0 && <tr><td colSpan={8}>Không có dòng nào để hiện.</td></tr>}
      </tbody>
    </table></div>

    {props.error && <p className="error" role="alert" style={{ marginTop: 12 }}>{props.error}</p>}
    {props.uploadNote && <p className="subtle" role="status" style={{ marginTop: 12 }}>{props.uploadNote}</p>}
    <div className="import-footer">
      <p className="summary">{s.willImport > 0
        ? `Sẽ nhập ${s.willImport} bài${skipped > 0 ? `, bỏ qua ${skipped} dòng` : ""}. Bài nhập vào chưa đăng ngay: bài có giờ sẽ tự đăng đúng giờ, bài nháp chờ bạn duyệt.`
        : "Không có dòng hợp lệ nào để nhập. Hãy sửa tệp rồi tải lại."}</p>
      <div className="actions">
        <button type="button" className="btn" onClick={props.onBack} disabled={busy !== null}>← Quay lại</button>
        {skipped > 0 && <button type="button" className="btn" onClick={props.onReport}>Tải báo cáo lỗi</button>}
        <button type="button" className="btn primary" onClick={props.onCommit} disabled={busy !== null || s.willImport === 0}>
          {busy === "commit" ? "Đang nhập…" : `Nhập ${s.willImport} bài`}
        </button>
      </div>
    </div>
  </div>;
}
