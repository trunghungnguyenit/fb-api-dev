import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as healthRoute } from "@/app/api/health/route";
import { POST as cspReportRoute } from "@/app/api/csp-report/route";
import { absoluteUrl } from "@/lib/facebook-posts";
import { publicPost, publicPosts } from "@/lib/post-public";
import { FACEBOOK_READS_PER_MINUTE, rateLimit, resetRateLimits, tooManyFacebookReads } from "@/lib/rate-limit";
import { API_HEADERS, buildCsp, CSP_HEADER, newNonce, originOf, SECURITY_HEADERS } from "@/lib/security-headers";
import { hardenCookie } from "@/lib/session-cookie";
import nextConfig from "../next.config";

const read = (path: string) => readFileSync(path, "utf8");
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});

describe("headers sent with every response", () => {
  const byKey = (key: string) => SECURITY_HEADERS.find((h) => h.key === key)?.value;

  it("keep the app out of frames, stop type guessing, limit what the address gives away, and switch off what the app never uses", () => {
    expect(byKey("X-Frame-Options")).toBe("DENY");
    expect(byKey("X-Content-Type-Options")).toBe("nosniff");
    expect(byKey("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(byKey("Strict-Transport-Security")).toMatch(/max-age=\d{7,}/);
    expect(byKey("Cross-Origin-Opener-Policy")).toBe("same-origin");
    for (const feature of ["camera", "microphone", "geolocation"]) expect(byKey("Permissions-Policy")).toContain(`${feature}=()`);
  });

  it("answers of the API are never kept by anything in between", () => {
    expect(API_HEADERS).toEqual([{ key: "Cache-Control", value: "no-store" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }]);
  });

  it("are applied by the configuration to every path, the API ones on top, and the app does not announce what it is built with", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    expect(nextConfig.productionBrowserSourceMaps).toBe(false);
    const rules = await nextConfig.headers!();
    expect(rules.find((r) => r.source === "/:path*")?.headers).toEqual([...SECURITY_HEADERS]);
    expect(rules.find((r) => r.source === "/api/:path*")?.headers).toEqual([...API_HEADERS]);
  });
});

describe("content security policy", () => {
  const nonce = "abc123==";
  const csp = buildCsp({ nonce, supabaseUrl: "https://proj.supabase.co/rest/v1" });
  const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

  it("lets scripts run only with the nonce of this response, and never inline or from elsewhere", () => {
    expect(directive("script-src")).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
  });

  it("cannot be framed, cannot change the base address, and allows only the app and its own Supabase Storage for pictures, uploads and previews", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("base-uri")).toBe("base-uri 'self'");
    expect(directive("img-src")).toBe("img-src 'self' data: blob: https://proj.supabase.co");
    expect(directive("media-src")).toBe("media-src 'self' blob: https://proj.supabase.co");
    expect(directive("connect-src")).toBe("connect-src 'self' https://proj.supabase.co");
  });

  it("allows eval only while developing, and does not restrict where forms go (the sign-in form ends in a redirect to Google)", () => {
    expect(buildCsp({ nonce, dev: true })).toContain("'unsafe-eval'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("form-action");
  });

  it("reports what it would have blocked to the app, and copes with a project address that is not a URL", () => {
    expect(directive("report-uri")).toBe("report-uri /api/csp-report");
    expect(buildCsp({ nonce, supabaseUrl: "not a url" })).toContain("img-src 'self' data: blob:");
    expect(originOf("https://proj.supabase.co/storage/v1")).toBe("https://proj.supabase.co");
    expect(originOf(undefined)).toBeNull();
  });

  it("uses a different nonce for every response", () => {
    const nonces = new Set(Array.from({ length: 50 }, newNonce));
    expect(nonces.size).toBe(50);
    for (const n of nonces) expect(n.length).toBeGreaterThanOrEqual(24);
  });

  it("is applied by the middleware to the page, in report-only mode, and the same nonce goes to the page's own request", () => {
    const middleware = read("src/middleware.ts");
    expect(CSP_HEADER).toBe("Content-Security-Policy-Report-Only");
    expect(middleware).toContain("requestHeaders.set(CSP_HEADER, csp)");
    expect(middleware).toContain("response.headers.set(CSP_HEADER, csp)");
    expect(middleware).toContain('requestHeaders.set("x-nonce", nonce)');
    // a refreshed session cookie must reach the page being rendered together with the policy headers
    expect(middleware).toContain('requestHeaders.set("cookie"');
  });
});

describe("session cookies", () => {
  it("cannot be read by a script on the page, and are only sent over https when the app is served over it", () => {
    expect(hardenCookie({ httpOnly: false, path: "/", maxAge: 100 }, "https://app.example.com")).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 100 });
    expect(hardenCookie({ sameSite: "strict" }, "https://app.example.com").sameSite).toBe("strict");
    expect(hardenCookie(undefined, "http://localhost:3000")).toMatchObject({ httpOnly: true, secure: false, sameSite: "lax" });
    expect(hardenCookie({}, undefined)).toMatchObject({ httpOnly: true, secure: false });
  });

  it("are written that way both by the middleware and by the server client, and no page script reads cookies", () => {
    expect(read("src/middleware.ts")).toContain("hardenCookie(options, process.env.NEXT_PUBLIC_APP_URL)");
    expect(read("src/lib/supabase/server.ts")).toContain("hardenCookie(options, env.NEXT_PUBLIC_APP_URL)");
    expect(files("src/app").filter((f) => /\.tsx?$/.test(f)).filter((f) => read(f).includes("document.cookie"))).toEqual([]);
    expect(existsSync("src/lib/supabase/client.ts")).toBe(false); // no browser client: every call goes through the server
  });
});

describe("a post as the browser receives it", () => {
  const row = {
    id: "p1", user_id: "u1", message: "Xin chào", status: "failed", last_error_code: "FB_REJECTED", last_error_message: "(#100) raw text from Facebook",
    locked_at: "2026-10-26T00:00:00Z", attempt_count: 3, sent_at: "x", next_attempt_at: "x", processing_since: "x", phase_checked_at: "x", facebook_checked_at: "x", page_id: "pg"
  };

  it("has what the screens use, and none of what only the server needs, above all Facebook's raw error text", () => {
    const shown = publicPost(row) as Record<string, unknown>;
    expect(shown).toEqual({ id: "p1", message: "Xin chào", status: "failed", last_error_code: "FB_REJECTED", page_id: "pg" });
    expect(JSON.stringify(shown)).not.toContain("raw text");
    expect(row.last_error_message).toBe("(#100) raw text from Facebook"); // the row itself is untouched
  });

  it("is chosen column by column where a post is read for the answer, so a column added later is not sent by accident", async () => {
    const { POST_PUBLIC_COLUMNS } = await import("@/lib/post-public");
    const columns = POST_PUBLIC_COLUMNS.split(",");
    for (const secret of ["user_id", "last_error_message", "locked_at", "attempt_count", "sent_at", "next_attempt_at", "processing_since", "phase_checked_at", "facebook_checked_at"]) expect(columns).not.toContain(secret);
    for (const needed of ["id", "status", "last_error_code", "page_id", "message", "scheduled_at"]) expect(columns).toContain(needed);
    expect(read("src/app/api/posts/route.ts")).not.toMatch(/\.select\(\)/); // no query that takes every column
  });

  it("copes with no post, and with a list", () => {
    expect(publicPost(null)).toBeNull();
    expect(publicPost(undefined)).toBeUndefined();
    expect(publicPosts([row, row]).every((p) => !("last_error_message" in (p as object)))).toBe(true);
    expect(publicPosts(null)).toEqual([]);
  });

  it("is how every API answer that carries a post is made: none sends a whole database row", () => {
    const routes = files("src/app/api/posts").filter((f) => f.endsWith("route.ts"));
    const offenders: string[] = [];
    for (const file of routes) {
      const source = read(file);
      for (const match of source.matchAll(/NextResponse\.json\(\{ (post|posts): ([^}]*?)(,|\})/g)) {
        if (!/publicPosts?\(/.test(match[2])) offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("a link made from what Facebook sends", () => {
  it("is a web address or nothing: never javascript:, data: or a script in disguise", () => {
    expect(absoluteUrl("/page/videos/123/")).toBe("https://www.facebook.com/page/videos/123/");
    expect(absoluteUrl("https://www.facebook.com/x/posts/1")).toBe("https://www.facebook.com/x/posts/1");
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "file:///etc/passwd", "", undefined]) expect(absoluteUrl(bad), String(bad)).toBeNull();
  });
});

describe("what a scraper can get", () => {
  beforeEach(() => resetRateLimits());

  it("is capped per user and minute for the reads that go on to Facebook, with the time to wait", () => {
    for (let i = 0; i < FACEBOOK_READS_PER_MINUTE; i++) expect(tooManyFacebookReads("u1")).toBeNull();
    const blocked = tooManyFacebookReads("u1");
    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(tooManyFacebookReads("u2")).toBeNull(); // somebody else is not slowed down
  });

  it("counts a window of time: it lets one through again once the oldest has aged out", () => {
    const t0 = 1_000_000;
    expect(rateLimit("k", 2, 1000, t0).ok).toBe(true);
    expect(rateLimit("k", 2, 1000, t0 + 100).ok).toBe(true);
    expect(rateLimit("k", 2, 1000, t0 + 200)).toEqual({ ok: false, retryAfter: 1 });
    expect(rateLimit("k", 2, 1000, t0 + 1001).ok).toBe(true);
  });

  it("is on every API that reads from Facebook for a signed-in user", () => {
    for (const file of [
      "src/app/api/insights/route.ts", "src/app/api/insights/demographics/route.ts", "src/app/api/posts/[id]/insights/route.ts",
      "src/app/api/posts/[id]/reactions/route.ts", "src/app/api/posts/[id]/comments/route.ts",
      "src/app/api/posts/[id]/facebook/route.ts", "src/app/api/facebook/sync/route.ts"
    ]) expect(read(file), file).toContain("tooManyFacebookReads(user.id)");
  });

  it("keeps no more keys than a bound, however many different ones are made up, dropping the one quiet the longest", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 6000; i++) rateLimit(`k${i}`, 5, 60_000, t0 + i);
    // the first ones were dropped (they start again from nothing), the latest are still counted
    for (let n = 0; n < 5; n++) expect(rateLimit("k5999", 5, 60_000, t0 + 6000 + n).ok).toBe(n < 4);
    expect(rateLimit("k0", 5, 60_000, t0 + 7000).ok).toBe(true);
  });

  it("does not exist without signing in: every API route needs a user or the cron secret, apart from the two public ones", () => {
    const open = files("src/app/api").filter((f) => f.endsWith("route.ts")).filter((f) => !/requireUser|isCronAuthorized/.test(read(f)));
    expect(open.map((f) => f.replaceAll("\\", "/")).sort()).toEqual([
      "src/app/api/auth/logout/route.ts", "src/app/api/csp-report/route.ts", "src/app/api/health/route.ts"
    ]);
  });
});

describe("the two public endpoints say as little as possible", () => {
  it("health tells only that the app is alive", async () => {
    const res = await healthRoute();
    expect(await res.json()).toEqual({ ok: true });
  });

  describe("the report of the content security policy", () => {
    const post = (body: string, ip = "9.9.9.9") => cspReportRoute(new NextRequest("http://localhost/api/csp-report", { method: "POST", body, headers: { "x-forwarded-for": ip } }));
    beforeEach(() => { resetRateLimits(); vi.spyOn(console, "warn").mockImplementation(() => {}); });

    it("keeps a few short fields of a report, without the query string of the page, and answers 204", async () => {
      const warn = vi.spyOn(console, "warn");
      const res = await post(JSON.stringify({ "csp-report": { "violated-directive": "img-src", "blocked-uri": "https://evil.example/x.png", "document-uri": "https://app/posts?q=secret", extra: "x".repeat(5000) } }));
      expect(res.status).toBe(204);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warn.mock.calls[0]);
      expect(logged).toContain("img-src");
      expect(logged).toContain("evil.example");
      expect(logged).not.toContain("secret");
      expect(logged).not.toContain("xxxx");
    });

    it("answers 204 and logs nothing for junk, a huge body, or too many reports from one address", async () => {
      const warn = vi.spyOn(console, "warn");
      expect((await post("not json")).status).toBe(204);
      expect((await post("x".repeat(20_000))).status).toBe(204);
      expect(warn).not.toHaveBeenCalled();
      // The address header can be forged, so a flood from "many" addresses shares ONE allowance of 60 a minute.
      for (let i = 0; i < 100; i++) await post(JSON.stringify({ "csp-report": { "violated-directive": "img-src" } }), `10.0.0.${i}`);
      expect(warn.mock.calls.length).toBeLessThanOrEqual(60);
      expect(warn.mock.calls.length).toBeGreaterThan(0);
    });

    it("does not read a body that says it is too big", async () => {
      const warn = vi.spyOn(console, "warn");
      const res = await cspReportRoute(new NextRequest("http://localhost/api/csp-report", {
        method: "POST", body: JSON.stringify({ "csp-report": { "violated-directive": "img-src" } }), headers: { "content-length": "999999" }
      }));
      expect(res.status).toBe(204);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe("who gets a page", () => {
  it("is nobody who is not signed in, apart from the sign-in page and the return of Google: they are redirected before anything is drawn", async () => {
    const { isPublicPage, PUBLIC_PAGES } = await import("@/lib/security-headers");
    expect([...PUBLIC_PAGES]).toEqual(["/login", "/auth/callback", "/privacy", "/terms"]);
    for (const open of ["/login", "/login/", "/auth/callback", "/privacy", "/terms/"]) expect(isPublicPage(open), open).toBe(true);
    for (const closed of ["/", "/posts", "/posts/new", "/insights", "/notifications", "/pages", "/login/x", "/auth/callback/x", "/loginx", "/privacy/x", "/termsx"]) expect(isPublicPage(closed), closed).toBe(false);
    const middleware = read("src/middleware.ts");
    expect(middleware).toContain("!claimsData?.claims?.sub && !isPublicPage(request.nextUrl.pathname)");
    // to the address the app is known by, 303 for anything that is not a read, and a cookie the check wanted to clear goes along
    expect(middleware).toContain('new URL("/login", process.env.NEXT_PUBLIC_APP_URL ?? request.url)');
    expect(middleware).toContain('request.method === "GET" || request.method === "HEAD" ? 307 : 303');
    expect(middleware).toContain("redirect.cookies.set(cookie)");
    // the redirect carries the security headers too, and is never kept
    expect(middleware).toContain("redirect.headers.set(header.key, header.value)");
    expect(middleware).toContain('redirect.headers.set("Cache-Control", "no-store")');
  });
});
