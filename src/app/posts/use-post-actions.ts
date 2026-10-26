"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useConfirm } from "@/app/confirm-dialog";
import { useToast } from "@/app/toast";
import { callApi, fieldErrorsOf, userMessage } from "@/lib/client-api";
import { messageFor } from "@/lib/errors";
import { checkSchedule } from "@/lib/field-errors";

export type PostAction = "publish" | "schedule" | "cancel" | "delete";

/**
 * Actions shared by the list rows and the detail page: publish now / retry, schedule, cancel, and removing the record.
 * Returns true when the request succeeded, so callers can close menus or clear inputs.
 */
export function usePostActions({ id, lastErrorCode }: { id: string; lastErrorCode: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<PostAction | null>(null);
  const [error, setError] = useState("");
  /** What is wrong with the chosen schedule time (shown under the time box). */
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const confirm = useConfirm();
  const toast = useToast();
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

  /**
   * Removes the post's record from the app (never anything on Facebook), after asking. Only for a post that is not live:
   * never published, or already deleted on Facebook. Returns true when it was removed.
   */
  async function removeRecord(deletedOnFacebook: boolean): Promise<boolean> {
    setError("");
    const ask = ambiguous
      ? { title: "Xóa bản ghi khi chưa rõ kết quả?", message: "Chưa rõ bài này đã lên Facebook hay chưa. Xóa bản ghi sẽ mất dấu vết của bài.\nHãy kiểm tra Fanpage trước.", confirmLabel: "Vẫn xóa", cancelLabel: "Để tôi kiểm tra", tone: "danger" as const }
      : deletedOnFacebook
        ? { title: "Xóa bản ghi khỏi ứng dụng?", message: "Bài đã bị xóa trên Facebook; chỉ bản ghi trong ứng dụng bị xóa.", confirmLabel: "Xóa bản ghi", tone: "danger" as const }
        : { title: "Xóa bản ghi này?", message: "Bài chưa đăng lên Facebook nên chỉ bản ghi trong ứng dụng bị xóa. Hành động không thể hoàn tác.", confirmLabel: "Xóa bản ghi", tone: "danger" as const };
    if (!(await confirm(ask))) return false;
    setBusy("delete");
    try {
      await callApi(`/api/posts/${id}${ambiguous ? "?force=true" : ""}`, { method: "DELETE" });
      toast({ kind: "success", text: "Đã xóa bản ghi." });
      router.refresh();
      return true;
    } catch (e) {
      setError(userMessage(e));
      return false;
    } finally { setBusy(null); }
  }

  return { busy, error, scheduleError, clearScheduleError: () => setScheduleError(null), run, removeRecord };
}
