"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * A thin bar at the top of the window while the next page is being prepared. Next.js keeps showing the old page until the new one
 * can be drawn, and for a page that waits on Facebook that can take seconds with nothing moving: this is the sign that the tap was
 * received. It starts when a link of the app is followed and ends when the address has changed.
 */
export default function RouteProgress() {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const where = `${usePathname()}?${useSearchParams()}`;
  const last = useRef(where);
  const timers = useRef<number[]>([]);
  const clear = () => { timers.current.forEach(window.clearTimeout); timers.current = []; };

  useEffect(() => {
    function onClick(event: MouseEvent) {
      // Capture phase and no check of defaultPrevented: Next's <Link> cancels the browser's own navigation before this listener could see it in the bubble phase.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      clear();
      setState("loading");
      timers.current.push(window.setTimeout(() => setState("idle"), 20_000)); // never stuck if the page does not change
    }
    document.addEventListener("click", onClick, true);
    return () => { document.removeEventListener("click", onClick, true); clear(); };
  }, []);

  useEffect(() => {
    if (where === last.current) return;
    last.current = where;
    clear();
    setState("done");
    timers.current.push(window.setTimeout(() => setState("idle"), 350));
  }, [where]);

  return <div className="route-progress" data-state={state} aria-hidden="true"><span /></div>;
}
