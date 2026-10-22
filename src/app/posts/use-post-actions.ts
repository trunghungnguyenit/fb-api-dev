"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useConfirm } from "@/app/confirm-dialog";
import { callApi, fieldErrorsOf, userMessage } from "@/lib/client-api";
import { messageFor } from "@/lib/errors";
import { checkSchedule } from "@/lib/field-errors";

export type PostAction = "publish" | "schedule" | "cancel";

/**
 * Status transitions shared by the list rows and the detail page: publish now / retry, schedule, cancel.
 * Returns true when the request succeeded, so callers can close menus or clear inputs.
 */
export function usePostActions({ id, lastErrorCode }: { id: string; lastErrorCode: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<PostAction | null>(null);
  const [error, setError] = useState("");
  /** What is wrong with the chosen schedule time (shown under the time box). */
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const confirm = useConfirm();
  // A post whose outcome is unknown may already be on Facebook: re-queuing needs an explicit confirmation.
  const ambiguous = lastErrorCode === "AMBIGUOUS";

  async function run(action: PostAction, whenLocal?: string): Promise<boolean> {
    setError(""); setScheduleError(null);
    if (action === "schedule") {
      const wrong = checkSchedule(whenLocal ?? "", Date.now(), { required: true });
      if (wrong) { setScheduleError(wrong); return false; }
    }
    const needsForce = ambiguous && action !== "cancel";
    if (needsForce && !(await confirm({
      title: "Chưa rõ bài đã được đăng chưa",
      message: "Chưa rõ bài này đã được đăng lên Facebook hay chưa. Hãy kiểm tra Fanpage trước.\nVẫn muốn đăng lại?",
      confirmLabel: "Vẫn đăng lại", cancelLabel: "Để tôi kiểm tra", tone: "danger"
    }))) return false;

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
      const fields = fieldErrorsOf(e);
      if (fields?.schedule) setScheduleError(fields.schedule); else setError(userMessage(e));
      return false;
    } finally { setBusy(null); }
  }

  return { busy, error, scheduleError, clearScheduleError: () => setScheduleError(null), run };
}
