import type { CSSProperties } from "react";
import PageHeader from "./page-header";
import PostsTabs from "./posts/posts-tabs";

// Waiting screens: grey shapes where the content will be, in the layout of the real page, so nothing jumps when it arrives.
// Used by the loading.tsx files (a page opening) and by the tabs that read Facebook (a Suspense fallback).

/** One shimmering block. Decorative: the region around it says "loading". */
export function Skel({ w, h = 14, r, className = "" }: { w?: number | string; h?: number | string; r?: number | string; className?: string }) {
  const style: CSSProperties = { width: w, height: h, borderRadius: r };
  return <span className={`skel ${className}`.trim()} style={style} aria-hidden="true" />;
}

/** The frame of a waiting page: announced once to screen readers as loading. */
export function Waiting({ label = "Đang tải…", wide = false, children }: { label?: string; wide?: boolean; children: React.ReactNode }) {
  return <main className={`shell${wide ? " wide" : ""}`} aria-busy="true">
    <p className="visually-hidden" role="status">{label}</p>
    {children}
  </main>;
}

export function SkelHeader({ title }: { title: string }) {
  return <PageHeader title={title} subtitle={<Skel w={220} h={14} />} />;
}

/** Lines of text of a panel. */
export function SkelLines({ lines = 3 }: { lines?: number }) {
  return <div className="skel-lines">{Array.from({ length: lines }, (_, i) => <Skel key={i} w={i === lines - 1 ? "62%" : "100%"} />)}</div>;
}

/** A list as the phone shows it (cards) and the computer shows it (rows): the same blocks, laid out by CSS. */
export function SkelList({ rows = 6 }: { rows?: number }) {
  return <ul className="skel-list" aria-hidden="true">
    {Array.from({ length: rows }, (_, i) => <li key={i}>
      <Skel w="70%" h={16} /><Skel w="38%" h={12} /><span className="skel-chips"><Skel w={86} h={26} r={999} /><Skel w={110} h={26} r={999} /></span>
    </li>)}
  </ul>;
}

/** The cards of the Insights page and of the numbers of a post. */
export function SkelCards({ count = 6 }: { count?: number }) {
  return <div className="insight-grid" aria-hidden="true">
    {Array.from({ length: count }, (_, i) => <div key={i} className="insight-card insight-skeleton"><Skel w="45%" h={14} /><Skel w="35%" h={30} /><Skel w="100%" h={90} r={12} /></div>)}
  </div>;
}

/** The tabs that read Facebook (visitor posts, ratings) while Facebook answers: the real tabs, so the page can already be left. */
export function GuestTabSkeleton({ active, subtitle }: { active: "visitor" | "ratings"; subtitle: string }) {
  return <main className="shell wide" aria-busy="true">
    <p className="visually-hidden" role="status">Đang đọc từ Facebook…</p>
    <PageHeader title="Bài viết" subtitle={subtitle} />
    <section className="panel">
      <PostsTabs active={active} />
      <SkelList rows={5} />
    </section>
  </main>;
}

/** The four numbers at the top of the overview. */
export function SkelStats() {
  return <section className="grid" aria-hidden="true">
    {Array.from({ length: 4 }, (_, i) => <div key={i} className="panel"><Skel w="60%" h={13} /><Skel w="30%" h={32} /></div>)}
  </section>;
}
