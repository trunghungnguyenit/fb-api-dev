import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { config } from "@/middleware";

// sharp comes with Next.js as an optional install: where it is missing, the sizes cannot be read and only the files are checked.
const sharp = await import("sharp").then((m) => m.default).catch(() => null);

describe("installing the app on a phone", () => {
  const m = manifest();

  it("opens in its own window, in Vietnamese, from the home page", () => {
    expect(m).toMatchObject({ name: "Page Publisher", short_name: "Page Publisher", lang: "vi", start_url: "/", scope: "/", display: "standalone" });
    // The splash screen is the logo on its own black (the icons are black tiles), the window bar keeps the colour of the pages.
    expect(m.background_color).toBe("#000000");
    expect(m.theme_color).toBe("#f1f5f9");
  });

  it("lists icons that exist, at the size they say, and a maskable one", async () => {
    expect(m.icons?.length).toBeGreaterThanOrEqual(3);
    for (const icon of m.icons ?? []) {
      const file = `public${icon.src}`;
      expect(existsSync(file), file).toBe(true);
      if (!sharp) continue;
      const meta = await sharp(file).metadata();
      const [w, h] = (icon.sizes ?? "").split("x").map(Number);
      expect([meta.width, meta.height], icon.src).toEqual([w, h]);
      expect(meta.format).toBe("png");
    }
    expect(m.icons?.some((i) => i.purpose === "maskable")).toBe(true);
    expect(m.icons?.some((i) => i.sizes === "192x192" && i.purpose === "any")).toBe(true);
    expect(m.icons?.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
  });

  it("has the icons of the tab and of the iPhone home screen, linked from the layout", async () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    for (const path of ["/icons/icon-192.png", "/icons/favicon-32.png", "/icons/apple-touch-icon.png"]) {
      expect(layout).toContain(path);
      expect(existsSync(`public${path}`), path).toBe(true);
    }
    if (sharp) expect((await sharp("public/icons/apple-touch-icon.png").metadata()).width).toBe(180);
    expect(layout).toContain("appleWebApp");
  });

  it("shows the logo of the brand (HT), from the one source picture, in the bar, on the sign-in page and in every icon", async () => {
    expect(existsSync("public/logo-mark.png")).toBe(true);
    expect(readFileSync("scripts/make-icons.mjs", "utf8")).toContain("public/logo-mark.png");
    for (const file of ["src/app/app-nav.tsx", "src/app/login/page.tsx"]) expect(readFileSync(file, "utf8"), file).toContain("/icons/logo-tile.png");
    expect(existsSync("public/icons/logo-tile.png")).toBe(true);
    if (sharp) {
      const tileMeta = await sharp("public/icons/logo-tile.png").metadata();
      expect([tileMeta.width, tileMeta.height]).toEqual([128, 128]);
    }
  });

  it("has no service worker: the app needs the network for everything, so there is no offline mode to pretend", () => {
    expect(existsSync("public/sw.js")).toBe(false);
    expect(readFileSync("src/app/layout.tsx", "utf8")).not.toMatch(/serviceWorker/);
  });
});

describe("the files a phone fetches before anyone is signed in", () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`);

  it("are not sent through the sign-in session refresh", () => {
    for (const path of ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon.svg", "/favicon.ico"]) expect(matcher.test(path), path).toBe(false);
  });

  it("while the pages still are", () => {
    for (const path of ["/", "/posts", "/posts/123", "/insights", "/notifications", "/login"]) expect(matcher.test(path), path).toBe(true);
  });
});
