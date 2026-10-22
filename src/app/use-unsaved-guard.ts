"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useConfirm } from "./confirm-dialog";

/**
 * While `dirty`, leaving the page asks first: closing the tab or reloading (browser prompt) and following a link inside
 * the app (themed dialog). Pressing the browser's Back button cannot be intercepted reliably and is not covered.
 */
export function useUnsavedGuard(dirty: boolean) {
  const confirm = useConfirm();
  const router = useRouter();

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return;
      e.preventDefault();
      e.stopPropagation();
      void confirm({
        title: "Rời trang khi chưa lưu?", message: "Nội dung bạn vừa nhập chưa được lưu và sẽ mất nếu rời đi.",
        confirmLabel: "Rời trang", cancelLabel: "Ở lại", tone: "danger"
      }).then((leave) => { if (leave) router.push(url.pathname + url.search + url.hash); });
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", onClick, true); };
  }, [dirty, confirm, router]);
}
