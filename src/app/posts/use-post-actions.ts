"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { callApi, userMessage } from "@/lib/client-api";
import { messageFor } from "@/lib/errors";

export type PostAction = "publish" | "schedule" | "cancel";

/**
 * Status transitions shared by the list rows and the detail page: publish now / retry, schedule, cancel.
 * Returns true when the request succeeded, so callers can close menus or clear inputs.
 */
export function usePostActions({ id, lastErrorCode }: { id: string; lastErrorCode: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<PostAction | null>(null);
  const [error, setError] = useState("");
  // A post whose outcome is unknown may already be on Facebook: re-queuing needs an explicit confirmation.
  const ambiguous = lastErrorCode === "AMBIGUOUS";

  async function run(action: PostAction, whenLocal?: string): Promise<boolean> {
    setError("");
    if (action === "schedule") {
      if (!whenLocal) { setError("Hãy chọn thời gian đăng."); return false; }
      if (new Date(whenLocal).getTime() < Date.now() - 60_000) { setError(messageFor("SCHEDULE_IN_PAST")); return false; }
    }
    const needsForce = ambiguous && action !== "cancel";
    if (needsForce && !window.confirm("Chưa rõ bài này đã được đăng lên Facebook hay chưa. Hãy kiểm tra Fanpage trước. Vẫn muốn đăng lại?")) return false;

    setBusy(action);
    try {
      const force = needsForce || undefined;
      const body = action === "cancel" ? { action: "cancel" }
        : action === "schedule" ? { action: "schedule", scheduledAt: new Date(whenLocal as string).toISOString(), force }
        : { action: "schedule", publishNow: true, force };
      const result = await callApi(`/api/posts/${id}`, { method: "PATCH", body });
      if (result.post?.status === "failed") setError(`Đăng thất bại. ${messageFor(result.post.last_error_code, "PUBLISH_FAILED")}`);
      router.refresh();
      return true;
    } catch (e) {
      setError(userMessage(e));
      return false;
    } finally { setBusy(null); }
  }

  return { busy, error, run };
}
