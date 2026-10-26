import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { env } from "@/lib/env";
import { INDEXABLE_PATHS, OG_IMAGE, pageMetadata, siteOrigin } from "@/lib/site";
import { PUBLIC_PAGES } from "@/lib/security-headers";
import { config } from "@/middleware";

// The test setup does not compile JSX, so the pages are checked through their source; the rest is real code.
const read = (path: string) => readFileSync(path, "utf8");

describe("what each page says about itself", () => {
  const login = pageMetadata({ title: "Tiêu đề", description: "Mô tả", path: "/login", index: true });

  it("shows its title as it is, names its own address as the canonical one, and may be listed when it says so", () => {
    expect(login.title).toEqual({ absolute: "Tiêu đề" });
    expect(login.alternates).toEqual({ canonical: "/login" });
    expect(login.robots).toEqual({ index: true, follow: true });
    expect(pageMetadata({ title: "t", description: "d", path: "/x", index: false }).robots).toEqual({ index: false, follow: false });
  });

  it("is complete for the apps links are shared in: an Open Graph card and a large Twitter card, with the same picture", () => {
    expect(login.openGraph).toMatchObject({ type: "website", locale: "vi_VN", siteName: "Page Publisher", title: "Tiêu đề", description: "Mô tả", url: "/login" });
    expect(login.twitter).toMatchObject({ card: "summary_large_image", title: "Tiêu đề", description: "Mô tả", images: [OG_IMAGE.url] });
    expect((login.openGraph as { images: unknown[] }).images).toEqual([OG_IMAGE]);
    expect([OG_IMAGE.width, OG_IMAGE.height]).toEqual([1200, 630]);
    expect(existsSync(`public${OG_IMAGE.url}`)).toBe(true);
  });

  it("builds addresses from the setting of the app, and copes with one that is not a URL", () => {
    expect(siteOrigin("https://app.example.com/login?x=1")).toBe("https://app.example.com");
    expect(siteOrigin("not a url")).toBeNull();
    expect(siteOrigin(undefined)).toBeNull();
  });
});

describe("what is private stays out of search engines", () => {
  it("is not listed by default: the whole app says noindex, and only three pages say otherwise", () => {
    expect(read("src/app/layout.tsx")).toContain("robots: { index: false, follow: false }");
    const listed = ["src/app/login/page.tsx", "src/app/privacy/page.tsx", "src/app/terms/page.tsx"];
    for (const file of listed) expect(read(file), file).toMatch(/pageMetadata\(\{[\s\S]*index: true/);
    expect([...INDEXABLE_PATHS]).toEqual(["/login", "/privacy", "/terms"]);
    // no other page of the app turns indexing on
    const others = ["src/app/page.tsx", "src/app/posts/page.tsx", "src/app/insights/page.tsx", "src/app/pages/page.tsx", "src/app/notifications/page.tsx"];
    for (const file of others) expect(read(file), file).not.toContain("index: true");
  });

  it("answers the API with noindex, and tells crawlers to read three pages and nothing else", () => {
    expect(read("src/lib/security-headers.ts")).toContain('"X-Robots-Tag", value: "noindex, nofollow"');
    expect(robots().rules).toEqual([{ userAgent: "*", allow: ["/login", "/privacy", "/terms"], disallow: "/" }]);
    expect(robots().sitemap).toBe(`${new URL(env.NEXT_PUBLIC_APP_URL).origin}/sitemap.xml`);
  });

  it("lists only the public pages in the sitemap, at the address of the app, with no invented dates", () => {
    const origin = new URL(env.NEXT_PUBLIC_APP_URL).origin;
    const entries = sitemap();
    expect(entries.map((e) => e.url)).toEqual([`${origin}/login`, `${origin}/privacy`, `${origin}/terms`]);
    expect(entries.every((e) => !("lastModified" in e))).toBe(true);
  });

  it("reaches crawlers past the sign-in gate: robots.txt and the sitemap are not redirected, and the public pages are open", () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    for (const path of ["/robots.txt", "/sitemap.xml"]) expect(matcher.test(path), path).toBe(false);
    expect([...PUBLIC_PAGES]).toEqual(expect.arrayContaining(["/login", "/privacy", "/terms"]));
    for (const path of INDEXABLE_PATHS) expect(PUBLIC_PAGES as readonly string[], path).toContain(path);
  });
});

describe("the sign-in page", () => {
  const page = read("src/app/login/page.tsx");

  it("describes the app to a search engine (structured data) without a script that could run, and links to the legal pages with readable text", () => {
    expect(page).toContain('"@type": "WebApplication"');
    expect(page).toContain("inLanguage: \"vi\"");
    expect(page).toContain('href="/privacy"');
    expect(page).toContain("Chính sách quyền riêng tư");
    expect(page).toContain('href="/terms"');
    const jsonLd = read("src/app/json-ld.tsx");
    expect(jsonLd).toContain('type="application/ld+json"');
    expect(jsonLd).toContain('.replace(/</g, "\\\\u003c")'); // nothing inside the data can close the tag
  });

  it("has one heading, a title and a description of a length search engines show, and a real button to sign in", () => {
    expect(page.match(/<h1/g)).toHaveLength(1);
    const title = /title: "([^"]+)"/.exec(page)?.[1] ?? "";
    expect(title.length).toBeGreaterThan(30);
    expect(title.length).toBeLessThanOrEqual(65);
    expect(page).toContain("<button");
  });
});

describe("the two legal pages", () => {
  const privacy = read("src/app/privacy/page.tsx");
  const terms = read("src/app/terms/page.tsx");

  it("have an address of their own that Meta can be given, and a way to the other page and back", () => {
    expect(existsSync("src/app/privacy/page.tsx") && existsSync("src/app/terms/page.tsx")).toBe(true);
    const shell = read("src/app/legal-page.tsx");
    for (const link of ['href="/privacy"', 'href="/terms"', 'href="/login"']) expect(shell).toContain(link);
    expect(shell).toContain("Cập nhật lần cuối");
  });

  it("say what the app really keeps, and what it only reads and does not keep", () => {
    for (const fact of ["AES-256-GCM", "Google", "Supabase", "Meta (Facebook)", "nội dung bình luận", "đánh giá", "Insights", "24 giờ", "7 ngày", "14 ngày", "10 phút"]) {
      expect(privacy, fact).toContain(fact);
    }
    expect(privacy).toContain("không bao giờ được gửi tới trình duyệt");
    expect(privacy).toContain("không dùng cookie quảng cáo");
    expect(privacy).toContain("không bán");
  });

  it("explain how to delete the data, at an address a link can point to (Meta asks for data deletion instructions)", () => {
    expect(privacy).toContain('id="xoa-du-lieu"');
    expect(privacy).toContain("Xóa toàn bộ dữ liệu");
    expect(terms).toContain("/privacy#xoa-du-lieu");
  });

  it("take who runs the app and the contact address from the settings, never from a name written into the page", () => {
    expect(read("src/app/legal-page.tsx")).toContain("env.CONTACT_EMAIL");
    expect(read("src/app/legal-page.tsx")).toContain("env.OPERATOR_NAME");
    expect(read(".env.example")).toContain("CONTACT_EMAIL=");
    expect(`${privacy}${terms}`).not.toMatch(/@gmail\.com|@[a-z0-9-]+\.(com|vn)/i);
    expect(env.CONTACT_EMAIL).toBeUndefined(); // optional: the pages say the address is not set rather than failing
  });
});
