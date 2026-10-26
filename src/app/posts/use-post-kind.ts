"use client";

import { useCallback, useState } from "react";
import { useConfirm } from "@/app/confirm-dialog";
import { noun } from "@/lib/media/rules";
import { KIND_INFO, mediaKindOf, type PostKind } from "@/lib/post-kind";
import type { MediaState } from "./media-picker";

/**
 * The chosen kind of a post, and how to change it. What the fields hold is kept when the kind changes (text, link,
 * schedule, Fanpage); only files that the new kind does not use are dropped, and only after the user agrees.
 * `onChanged` lets the form clear the messages of fields that are no longer shown.
 */
export function usePostKind(initial: PostKind, media: MediaState, onChanged?: () => void) {
  const confirm = useConfirm();
  const [kind, setKind] = useState<PostKind>(initial);

  const choose = useCallback(async (next: PostKind) => {
    if (next === kind) return;
    const dropsFiles = media.items.length > 0 && media.kind !== mediaKindOf(next);
    if (dropsFiles) {
      const what = media.kind ? (media.items.length > 1 ? `${media.items.length} ${noun(media.kind)}` : `${noun(media.kind)} đã chọn`) : "tệp đã chọn";
      const ok = await confirm({
        title: `Chuyển sang “${KIND_INFO[next].label}”?`,
        message: `${what.charAt(0).toUpperCase()}${what.slice(1)} sẽ bị bỏ vì loại bài này không dùng. Nội dung, liên kết, Fanpage và giờ đăng được giữ nguyên.`,
        confirmLabel: "Bỏ tệp và chuyển", cancelLabel: "Giữ loại hiện tại", tone: "danger"
      });
      if (!ok) return;
      media.clear();
    }
    setKind(next);
    onChanged?.();
  }, [kind, media, confirm, onChanged]);

  return { kind, choose, mediaKind: mediaKindOf(kind) };
}
