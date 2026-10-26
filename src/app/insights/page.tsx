import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import PageHeader from "@/app/page-header";
import { requireUser } from "@/lib/auth";
import { rows, userDb } from "@/lib/db";
import { AppFailure, type ErrorCode, messageFor } from "@/lib/errors";
import { resolveRange, todayVN } from "@/lib/meta/insights";
import { FEATURES, hasScopes } from "@/lib/meta/scopes";
import InsightsFilters from "./insights-filters";
import { loadTopPosts, parseTopSort, type TopSort } from "@/lib/top-posts";
import Demographics from "./demographics";
import InsightsView from "./insights-view";
import TopPosts from "./top-posts";

export const dynamic = "force-dynamic";

type Search = { page?: string; range?: string; since?: string; until?: string; top?: string };
type PageRow = { id: string; page_name: string; tasks: string[] | null; connection_id: string };
type ConnectionRow = { id: string; scopes: string[] | null };

/** Page Insights for one Fanpage at a time: the numbers Facebook still offers, for a range of days, against the period before. */
export default async function InsightsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const sp = await searchParams;
  const db = userDb(user.id);

  const [pagesResult, connectionsResult] = await Promise.all([
    db.pages.select("id,page_name,tasks,connection_id").eq("is_active", true).is("removed_at", null).order("page_name"),
    db.connections.select("id,scopes")
  ]);
  if (pagesResult.error) throw new AppFailure("DB_ERROR", pagesResult.error);
  if (connectionsResult.error) throw new AppFailure("DB_ERROR", connectionsResult.error);
  const pages = rows<PageRow>(pagesResult.data);
  const connections = new Map(rows<ConnectionRow>(connectionsResult.data).map((c) => [c.id, c]));

  const header = <PageHeader title="Insights" subtitle="Số liệu của Fanpage từ Facebook: lượt xem, người theo dõi, tương tác" />;
  if (!pages.length) {
    return <main className="shell">{header}
      <section className="panel">Bạn chưa có Fanpage nào đang kết nối. <Link href="/pages">Kết nối Facebook</Link> để xem số liệu.</section>
    </main>;
  }

  const selected = (z.string().uuid().safeParse(sp.page).success && pages.find((p) => p.id === sp.page)) || pages[0];
  const range = resolveRange({ range: sp.range, since: sp.since, until: sp.until });
  const today = todayVN(new Date());

  // What can be known without asking Facebook: say it here, with the way out, instead of showing an empty page.
  let blocker: { code: ErrorCode; action: { href: string; label: string } } | null = null;
  if (!hasScopes(connections.get(selected.connection_id)?.scopes, FEATURES.insights.scopes)) {
    blocker = { code: "INSIGHTS_SCOPES_MISSING", action: { href: "/api/auth/facebook", label: "Kết nối Facebook" } };
  } else if (selected.tasks?.length && !selected.tasks.includes("ANALYZE")) {
    blocker = { code: "INSIGHTS_NO_ANALYZE", action: { href: "/pages", label: "Mở trang Fanpage" } };
  }

  // The best posts come from the stored copy of the Fanpage, so they do not depend on the permission above or on Facebook answering.
  const sort = parseTopSort(sp.top);
  let top;
  try { top = await loadTopPosts(user.id, selected.id, sort); }
  catch (e) { throw new AppFailure("DB_ERROR", e); }
  const topHref = (next: TopSort) => {
    const query = new URLSearchParams({ page: selected.id });
    if (sp.range) query.set("range", sp.range);
    if (sp.since) query.set("since", sp.since);
    if (sp.until) query.set("until", sp.until);
    if (next !== "total") query.set("top", next);
    return `/insights?${query}`;
  };

  return <main className="shell wide">
    {header}
    <section className="panel">
      <InsightsFilters
        pages={pages.map((p) => ({ id: p.id, name: p.page_name }))} page={selected.id}
        range={range.ok ? range.range.preset : (sp.range ?? "custom")} since={sp.since ?? ""} until={sp.until ?? ""}
        today={today} errors={range.ok ? {} : range.errors}
      />
      {blocker
        ? <div className="notice warn" role="alert">
            <p>{messageFor(blocker.code)}</p>
            <div className="actions"><a className="btn primary" href={blocker.action.href}>{blocker.action.label}</a></div>
          </div>
        : range.ok && <InsightsView
            key={`${selected.id}|${range.range.preset}|${range.range.start}|${range.range.end}`}
            pageId={selected.id} range={range.range.preset} since={range.range.start} until={range.range.end}
          />}
    </section>
    <TopPosts result={top} hrefFor={topHref} />
    {!blocker && <section className="panel" aria-labelledby="demographics">
      <h2 id="demographics">Người theo dõi là ai</h2>
      <Demographics key={selected.id} pageId={selected.id} />
    </section>}
  </main>;
}
