"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export type NavItem = { href: string; label: string; icon: ReactNode };

/** The link of the current section is the one whose href is the longest prefix of the path (/posts/import beats /posts). */
export function activeHref(pathname: string, items: NavItem[]) {
  const hits = items.filter(({ href }) => (href === "/" ? pathname === "/" : pathname.startsWith(href)));
  return hits.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

export default function NavLinks({ items }: { items: NavItem[] }) {
  const active = activeHref(usePathname(), items);
  return <ul className="nav-links">
    {items.map(({ href, label, icon }) => <li key={href}>
      <Link className="nav-link" href={href} aria-current={href === active ? "page" : undefined}>{icon}{label}</Link>
    </li>)}
  </ul>;
}
