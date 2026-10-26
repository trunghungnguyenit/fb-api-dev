"use client";

import { useCallback, useEffect, useState } from "react";
import { messageFor, withRef } from "@/lib/errors";
import type { DemographicResult, DemographicsResult } from "@/lib/demographics";

type State =
  | { kind: "loading" }
  | { kind: "ready"; result: DemographicsResult }
  | { kind: "error"; text: string; code: string | null };

const number = new Intl.NumberFormat("vi-VN");
const percent = new Intl.NumberFormat("vi-VN", { style: "percent", maximumFractionDigits: 1 });
/** Failures the user fixes by granting permission again. */
const NEEDS_RECONNECT = new Set(["INSIGHTS_SCOPES_MISSING", "INSIGHTS_PERMISSION_DENIED", "PAGE_PERMISSION_LOST"]);

/** Who follows the Fanpage, read from Facebook after the page has rendered so a slow Graph call never blocks it. */
export default function Demographics({ pageId }: { pageId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async (signal: AbortSignal) => {
    setState({ kind: "loading" });
    try {
      const response = await fetch(`/api/insights/demographics?page=${encodeURIComponent(pageId)}`, { signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // Only text from our own catalog ever arrives here; anything else becomes the generic message.
        setState({ kind: "error", text: withRef(typeof body?.error === "string" ? body.error : messageFor("UNEXPECTED"), body?.ref), code: typeof body?.code === "string" ? body.code : null });
        return;
      }
      setState({ kind: "ready", result: body as DemographicsResult });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setState({ kind: "error", text: messageFor("NETWORK"), code: "NETWORK" });
    }
  }, [pageId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, attempt]);

  if (state.kind === "loading") return <p className="subtle" role="status" aria-live="polite">Đang tải thông tin người theo dõi từ Facebook…</p>;

  if (state.kind === "error") {
    return <div role="alert" className="insight-error">
      <p className="error">{state.text}</p>
      <div className="actions">
        <button className="btn" type="button" onClick={() => setAttempt((n) => n + 1)}>Thử lại</button>
        {state.code && NEEDS_RECONNECT.has(state.code) && <a className="btn primary" href="/api/auth/facebook">Kết nối lại Facebook</a>}
      </div>
    </div>;
  }

  return <DemographicsContent result={state.result} />;
}

/** The blocks for one result (no fetching: the component above loads it). */
export function DemographicsContent({ result }: { result: DemographicsResult }) {
  return <div aria-live="polite" className="demo-grid">
    {result.blocks.map((block) => <Block key={block.key} block={block} />)}
  </div>;
}

function Block({ block }: { block: DemographicResult }) {
  const titleId = `demo-${block.key}`;
  if (block.state === "problem" || !block.block) {
    return <article className="insight-card insight-card-problem" aria-labelledby={titleId}>
      <h3 id={titleId}>{block.label}</h3>
      <p className="insight-problem" role="note">
        <svg className="neo-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17.5h0" />
        </svg>
        <span>{block.message ?? messageFor(block.code)}</span>
      </p>
    </article>;
  }
  const { rows, others, total } = block.block;
  const biggest = Math.max(...rows.map((r) => r.value));
  return <article className="insight-card" aria-labelledby={titleId}>
    <h3 id={titleId}>{block.label}</h3>
    <ul className="demo-list">
      {rows.map((row) => <li key={row.key}>
        <span className="demo-label" title={row.label}>{row.label}</span>
        <span className="reaction-track" aria-hidden="true"><span className="reaction-fill" style={{ width: `${Math.round((row.value / biggest) * 100)}%` }} /></span>
        <strong>{number.format(row.value)} <span className="subtle">({percent.format(row.share)})</span></strong>
      </li>)}
    </ul>
    {others > 0 && <p className="subtle">Khác: {number.format(others)} người ({percent.format(others / total)}).</p>}
    <p className="subtle insight-hint">{block.hint} Tính trên {number.format(total)} người theo dõi mà Facebook có thông tin.</p>
  </article>;
}
