"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { callApi, userMessage } from "@/lib/client-api";

type Props = { id: string; status: string; lastErrorCode: string | null; deletedOnFacebook: boolean };
type Busy = "record" | "facebook" | "mark" | null;

// Destructive actions on one post. Each one asks for an explicit confirmation that says what is lost.
export default function PostDangerActions({ id, status, lastErrorCode, deletedOnFacebook }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [showMark, setShowMark] = useState(false);

  const ambiguous = lastErrorCode === "AMBIGUOUS";
  const published = status === "published";
  const neverPublished = ["draft", "scheduled", "failed", "cancelled"].includes(status);

  async function run(kind: Exclude<Busy, null>, confirmText: string, call: () => Promise<unknown>, after: () => void) {
    if (!window.confirm(confirmText)) return;
    setBusy(kind); setError("");
    try { await call(); after(); }
    catch (e) {
      setError(userMessage(e));
      // Facebook refused the delete: offer the manual route.
      if (kind === "facebook") setShowMark(true);
    }
    finally { setBusy(null); }
  }

  const goToList = () => { router.push("/posts"); router.refresh(); };

  return <div>
    <div className="actions">
      {neverPublished && <button className="btn danger" type="button" disabled={busy !== null}
        onClick={() => void run("record",
          ambiguous ? "Chưa rõ bài này đã lên Facebook hay chưa. Xóa bản ghi sẽ mất dấu vết của bài. Hãy kiểm tra Fanpage trước. Vẫn xóa?" : "Xóa bài viết này? Hành động không thể hoàn tác.",
          () => callApi(`/api/posts/${id}${ambiguous ? "?force=true" : ""}`, { method: "DELETE" }), goToList)}>
        {busy === "record" ? "Đang xóa…" : "Xóa bài viết"}
      </button>}

      {published && !deletedOnFacebook && <button className="btn danger" type="button" disabled={busy !== null}
        onClick={() => void run("facebook",
          "Xóa bài này khỏi Facebook?\n\nBài sẽ biến mất khỏi Fanpage cùng toàn bộ lượt thích, bình luận và chia sẻ, và KHÔNG thể khôi phục.",
          () => callApi(`/api/posts/${id}?scope=facebook`, { method: "DELETE" }), () => router.refresh())}>
        {busy === "facebook" ? "Đang xóa trên Facebook…" : "Xóa bài trên Facebook"}
      </button>}

      {published && deletedOnFacebook && <button className="btn danger" type="button" disabled={busy !== null}
        onClick={() => void run("record", "Xóa bản ghi bài viết này khỏi ứng dụng? Bài đã bị xóa trên Facebook.",
          () => callApi(`/api/posts/${id}`, { method: "DELETE" }), goToList)}>
        {busy === "record" ? "Đang xóa…" : "Xóa bản ghi"}
      </button>}
    </div>

    {published && !deletedOnFacebook && <p className="subtle" style={{ marginTop: 12 }}>
      Đã xóa bài trực tiếp trên Facebook?{" "}
      <button className="link-button" type="button" disabled={busy !== null} onClick={() => setShowMark((v) => !v)}>Đánh dấu đã xóa</button>
    </p>}
    {showMark && published && !deletedOnFacebook && <div className="actions" style={{ marginTop: 8 }}>
      <button className="btn" type="button" disabled={busy !== null}
        onClick={() => void run("mark", "Ứng dụng sẽ kiểm tra với Facebook rằng bài đã thật sự bị xóa. Tiếp tục?",
          () => callApi(`/api/posts/${id}`, { method: "PATCH", body: { action: "mark_deleted" } }), () => router.refresh())}>
        {busy === "mark" ? "Đang kiểm tra…" : "Đánh dấu đã xóa trên Facebook"}
      </button>
    </div>}
    {error && <p className="error" role="alert" style={{ marginTop: 8 }}>{error}</p>}
  </div>;
}
