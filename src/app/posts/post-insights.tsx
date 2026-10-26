"use client";

import { useCallback, useEffect, useState } from "react";
import { messageFor, withRef } from "@/lib/errors";
import { formatDuration } from "@/lib/meta/post-insights";
import type { PostInsightsResult, PostMetricResult } from "@/lib/post-insights";

type State =
  | { kind: "loading" }
  | { kind: "ready"; result: PostInsightsResult }
  | { kind: "error"; text: string; code: string | null };

const number = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
/** Failures the user fixes by granting permission again. */
const NEEDS_RECONNECT = new Set(["INSIGHTS_SCOPES_MISSING", "INSIGHTS_PERMISSION_DENIED", "PAGE_PERMISSION_LOST"]);
/** Not a fault: this post just has no Insights to show. */
const JUST_INFO = new Set(["INSIGHTS_POST_UNAVAILABLE"]);

/** The post's Insights, read from Facebook after the page has rendered so a slow Graph call never blocks it. */
export default function PostInsights({ kind, id }: { kind: "app" | "feed"; id: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async (signal: AbortSignal) => {
    setState({ kind: "loading" });
    try {
      const response = await fetch(`/api/posts/${id}/insights?kind=${kind}`, { signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // Only text from our own catalog ever arrives here; anything else becomes the generic message.
        setState({ kind: "error", text: withRef(typeof body?.error === "string" ? body.error : messageFor("UNEXPECTED"), body?.ref), code: typeof body?.code === "string" ? body.code : null });
        return;
      }
      setState({ kind: "ready", result: body as PostInsightsResult });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setState({ kind: "error", text: messageFor("NETWORK"), code: "NETWORK" });
    }
  }, [id, kind]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, attempt]);

  if (state.kind === "loading") return <p className="subtle" role="status" aria-live="polite">Đang tải Insights của bài từ Facebook…</p>;

  if (state.kind === "error") {
    if (state.code && JUST_INFO.has(state.code)) return <p className="notice" role="note">{state.text}</p>;
    return <div role="alert" className="insight-error">
      <p className="error">{state.text}</p>
      <div className="actions">
        <button className="btn" type="button" onClick={() => setAttempt((n) => n + 1)}>Thử lại</button>
        {state.code && NEEDS_RECONNECT.has(state.code) && <a className="btn primary" href="/api/auth/facebook">Kết nối lại Facebook</a>}
      </div>
    </div>;
  }

  return <PostInsightsContent result={state.result} />;
}

/** The cards for one result (no fetching: the component above loads it). */
export function PostInsightsContent({ result }: { result: PostInsightsResult }) {
  return <div aria-live="polite">
    <div className="insight-grid insight-grid-mini">{result.metrics.map((metric) => <MetricCard key={metric.key} metric={metric} />)}</div>
    <p className="subtle form-hint">Facebook cập nhật số liệu khoảng một lần mỗi ngày, nên bài mới đăng có thể chưa đủ số.{result.variant !== "post" && " Số liệu video và Reels có thể trễ hơn, hoặc chưa có với video đăng lên bằng cách cũ."}</p>
  </div>;
}

function MetricCard({ metric }: { metric: PostMetricResult }) {
  const titleId = `post-insight-${metric.key}`;
  if (metric.state === "problem" || !metric.value) {
    return <article className="insight-card insight-card-problem" aria-labelledby={titleId}>
      <h3 id={titleId}>{metric.label}</h3>
      <p className="insight-problem" role="note">
        <svg className="neo-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17.5h0" />
        </svg>
        <span>{metric.message ?? messageFor(metric.code)}</span>
      </p>
    </article>;
  }
  return <article className="insight-card" aria-labelledby={titleId}>
    <h3 id={titleId}>{metric.label}</h3>
    <p className="insight-value">{metric.format === "duration" ? formatDuration(metric.value.total) : <>{number.format(metric.value.total)} <span className="insight-unit">{metric.unit}</span></>}</p>
    <p className="subtle insight-hint">{metric.hint}</p>
  </article>;
}
