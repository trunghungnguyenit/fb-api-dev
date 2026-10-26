import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const MAX_BYTES = 10_000;
const short = (value: unknown) => (typeof value === "string" ? value.slice(0, 200) : undefined);

/**
 * POST /api/csp-report — the browser says what the content security policy would have blocked on a page (the policy is in
 * report-only mode). Anyone can post here, so it takes a small body, at most 60 reports a minute in all, keeps only a few short
 * text fields of it and writes one line to the log. Answers 204 whatever it was: a report is never worth an error page.
 */
export async function POST(request: NextRequest) {
  // One bucket for everybody: the address header can be forged, so a bucket per address would let a flood use a new one each time.
  if (!rateLimit("csp:all", 60).ok) return new NextResponse(null, { status: 204 });
  // A body that announces itself as too big is not even read.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return new NextResponse(null, { status: 204 });
  try {
    const text = await request.text();
    if (text.length > MAX_BYTES) return new NextResponse(null, { status: 204 });
    const body = JSON.parse(text) as Record<string, unknown>;
    // Two formats exist: the old one ({ "csp-report": {...} }) and the Reporting API one (a list of { body: {...} }).
    const entry = (body["csp-report"] ?? (Array.isArray(body) ? (body[0] as { body?: unknown })?.body : null) ?? body) as Record<string, unknown>;
    console.warn("csp: the policy would have blocked something:", {
      directive: short(entry["violated-directive"] ?? entry.effectiveDirective),
      blocked: short(entry["blocked-uri"] ?? entry.blockedURL),
      page: short(entry["document-uri"] ?? entry.documentURL)?.split("?")[0],
      source: short(entry["source-file"] ?? entry.sourceFile)?.split("?")[0]
    });
  } catch { /* not a report: nothing to keep */ }
  return new NextResponse(null, { status: 204 });
}
