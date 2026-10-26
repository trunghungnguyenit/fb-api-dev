import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The test setup does not compile JSX, so the phone version of the interface is checked through its source and its style.
const read = (path: string) => readFileSync(path, "utf8");
const css = read("src/app/neo.css");
/** The CSS inside the media query that starts at `head` (up to its closing brace, found by counting braces). */
function block(head: string): string {
  const start = css.indexOf(head);
  if (start < 0) return "";
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  return "";
}
const phone = css.split("@media (max-width: 760px) {").slice(1).join("\n");

describe("navigation on a phone", () => {
  const nav = read("src/app/app-nav.tsx");
  const menu = read("src/app/mobile-menu.tsx");

  it("has the logo, the bell and a menu button in the top bar; the sections and the account are in a drawer", () => {
    expect(nav).toContain('<NotificationBell placement="nav" />');
    expect(nav).toContain("<MobileMenu");
    expect(menu).toContain("showModal()");
    expect(menu).toContain('aria-haspopup="dialog"');
    expect(menu).toContain("<LogoutForm");
    expect(read("src/app/logout-form.tsx")).toContain("/api/auth/logout");
    expect(read("src/app/logout-form.tsx")).toContain("clearAllDrafts(window.localStorage)"); // the next person on a shared browser is not offered the previous one's text
    expect(menu).toContain("activeHref(pathname, items)");
  });

  it("closes the drawer on a tap outside, on Esc (a modal dialog does), on a new page, and when the window grows to a computer's", () => {
    expect(menu).toContain("e.target === dialogRef.current");
    expect(menu).toContain("[pathname]");
    expect(menu).toContain('matchMedia("(min-width: 1001px)")'); // the same width where neo.css stops drawing the drawer
    expect(css).toContain("@media (min-width: 1001px) { .neo .nav-drawer { display: none; } }");
  });

  it("shows only one bell: floating on a computer, in the bar on a phone", () => {
    expect(read("src/app/layout.tsx")).toContain('<NotificationBell placement="float" />');
    expect(css).toMatch(/\.neo \.nav-mobile, \.neo \.notif-bell-nav \{ display: none; \}/);
    expect(block("@media (max-width: 1000px) {\n  .neo .neo-nav")).toContain(".neo .notif-bell-float { display: none; }");
    // the bell in the bar must out-rank the rule that pins the floating one to the corner (right / bottom), or it drifts out of the bar
    expect(css).toMatch(/\.neo \.nav-mobile \.notif-bell-nav \{[^}]*position: relative;[^}]*right: auto; bottom: auto;/);
  });

  it("counts the unread notifications once per request even though the bell is drawn twice", () => {
    expect(read("src/app/notification-bell.tsx")).toMatch(/cache\(async/);
  });
});

describe("waiting screens", () => {
  it("exist for every page that waits on the database or on Facebook, and say they are loading", () => {
    for (const path of ["src/app/loading.tsx", "src/app/posts/loading.tsx", "src/app/posts/[id]/loading.tsx", "src/app/insights/loading.tsx", "src/app/pages/loading.tsx", "src/app/notifications/loading.tsx"]) {
      expect(existsSync(path), path).toBe(true);
      expect(read(path)).toContain("Waiting");
    }
    expect(read("src/app/skeleton.tsx")).toContain('role="status"');
    expect(read("src/app/skeleton.tsx")).toContain('aria-busy="true"');
  });

  it("show the tabs that read Facebook at once, with a skeleton, and the real list when it arrives", () => {
    const page = read("src/app/posts/page.tsx");
    expect(page).toContain("<Suspense key={`visitor|");
    expect(page).toContain("<Suspense key={`ratings|");
    expect(page).toContain("GuestTabSkeleton");
  });

  it("move whatever the user's device says about motion: the shimmer and the bar are part of the theme and always on", () => {
    expect(css).not.toMatch(/prefers-reduced-motion/);
    expect(css).toMatch(/\.neo \.skel \{[^}]*animation: skel-shimmer/);
  });

  it("also exist for the pages under Bài viết that have another shape, so none shows the list skeleton by mistake, and the sign-in page has none", () => {
    for (const path of ["src/app/posts/new/loading.tsx", "src/app/posts/import/loading.tsx", "src/app/posts/imports/loading.tsx", "src/app/posts/facebook/[id]/loading.tsx", "src/app/login/loading.tsx"]) expect(existsSync(path), path).toBe(true);
    expect(read("src/app/login/loading.tsx")).toContain("return null");
  });

  it("has a bar at the top of the window while a link is followed, that never stays stuck", () => {
    const progress = read("src/app/route-progress.tsx");
    expect(progress).toContain("20_000");
    // Next's <Link> cancels the browser navigation itself, so a listener in the bubble phase that gives up on defaultPrevented never starts the bar
    expect(progress).toContain('addEventListener("click", onClick, true)');
    expect(progress).not.toContain("event.defaultPrevented");
    expect(progress).toContain("url.pathname.startsWith(\"/api/\")");
    expect(read("src/app/layout.tsx")).toContain("<RouteProgress />");
  });
});

describe("lighter on a phone, the same on a computer", () => {
  it("drops the grain and the drawn network behind the page, and the glow and masked border of the panels, only on a phone", () => {
    expect(phone).toMatch(/\.neo::after \{ display: none; \}/);
    expect(phone).toMatch(/\.neo \.panel::before \{ display: none; \}/);
    expect(css).toMatch(/\.neo::after \{\s*opacity: \.05;/); // still there outside the media query
    expect(css).toMatch(/\.neo \.panel::before \{\s*content: ""/);
  });

  it("uses two font families and no monospace download", () => {
    const fonts = read("src/app/neo-fonts.ts");
    expect(fonts).not.toMatch(/JetBrains/);
    expect(fonts).toMatch(/weight: \["400", "600", "700"\]/);
    expect(css).not.toContain("var(--neo-mono)");
    expect(css).toMatch(/\.neo \.mono \{ font-family: ui-monospace/);
  });

  it("uses the dynamic viewport height where the screen is full height, so the address bar of a phone does not cut it", () => {
    expect(css).toContain("min-height: 100dvh");
    expect(css).toContain("86dvh");
  });
});

describe("lists on a phone", () => {
  it("fold the filters behind a button that counts the ones that are on, keeping the search box and the fields in the form", () => {
    const bar = read("src/app/posts/filter-bar.tsx");
    expect(bar).toContain("aria-expanded={open}");
    expect(bar).toContain("{children}");
    expect(css).toMatch(/\.filter-bar:not\(\[data-open="true"\]\) \.filters \.field:not\(\.field-search\)/);
    for (const file of ["src/app/posts/page.tsx", "src/app/posts/facebook-feed-view.tsx"]) {
      const source = read(file);
      expect(source, file).toContain("<FilterBar active=");
      expect(source, file).toContain("field field-search");
    }
  });

  it("add the next page under the list (\"Xem thêm\") instead of the page numbers, and keep the numbers on a computer", () => {
    const pager = read("src/app/posts/pagination.tsx");
    expect(pager).toContain("Xem thêm");
    expect(pager).toContain("scroll={false}");
    expect(css).toMatch(/\.neo \.pager-numbers \{ display: none; \}/);
    expect(css).toMatch(/\.neo \.filter-toggle, \.neo \.pager-more \{ display: none; \}/);
    for (const file of ["src/app/posts/page.tsx", "src/app/posts/facebook-feed-view.tsx"]) {
      const source = read(file);
      expect(source, file).toContain('const more = ');
      expect(source, file).toContain("requested * PAGE_SIZE - 1");
    }
  });

  it("show a post as a short card: the content on a line, then the facts in pairs", () => {
    expect(css).toMatch(/\.neo table\.cards tr \{\s*display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/\.neo table\.posts-table\.cards tr \{ grid-template-columns: 30px repeat\(2, minmax\(0, 1fr\)\); \}/);
    expect(css).not.toContain("flex: 0 0 86px"); // the old label column that made every card tall
    expect(css).toContain(".neo table.cards td.col-error:has(> .cell-none) { display: none; }"); // no line for an empty field
  });
});

describe("long forms on a phone", () => {
  it("fold the Fanpage and the schedule into groups that say what is chosen, and open again when a field is wrong", () => {
    const section = read("src/app/posts/form-section.tsx");
    expect(section).toContain("aria-expanded={open}");
    expect(section).toContain("forceOpen");
    for (const file of ["src/app/posts/new/post-composer.tsx", "src/app/posts/[id]/edit/post-editor.tsx"]) {
      const source = read(file);
      expect(source, file).toContain('<FormSection title="Fanpage và loại bài"');
      expect(source, file).toContain('<FormSection title="Thời gian đăng"');
      expect(source, file).toContain("forceOpen={Boolean(form.errors.schedule)}");
      expect(source, file).toContain("<PostPreview");
      expect(source, file).toContain("<DraftBanner");
      expect(source, file).toContain("draft.clear()");
    }
    expect(css).toMatch(/\.neo \.section-toggle \{ display: none; \}/); // on a computer a group is only a group
  });

  it("keep the typed text when the form is saved only until it is saved", () => {
    const hook = read("src/app/posts/use-local-draft.tsx");
    expect(hook).toContain("window.localStorage");
    expect(hook).toContain("SAVE_DELAY_MS");
    expect(read("src/app/posts/new/post-composer.tsx")).toMatch(/useLocalDraft\("new",[^)]*!initial\)/); // not for a duplicate of a post
  });

  it("offer the camera of a phone, only on a touch screen", () => {
    const picker = read("src/app/posts/media-picker.tsx");
    expect(picker).toContain('capture="environment"');
    expect(css).toMatch(/@media \(pointer: coarse\) \{ \.neo \.btn\.media-camera/);
  });
});

describe("touch", () => {
  it("answers a tap at once and does not drag the page along when a list or a dialog is scrolled to its end", () => {
    expect(css).toMatch(/touch-action: manipulation/);
    expect(css).toMatch(/overscroll-behavior: contain/);
  });
});
