"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// One-shot banners arrive as query params. Strip them after the first render (without a server
// round-trip) so a reload or a shared URL does not replay the message.
export default function ClearQuery() {
  const pathname = usePathname();
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, "", pathname);
  }, [pathname]);
  return null;
}
