import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The test setup does not compile JSX, so the component is checked through its source and its style: what matters is that the
// day-by-day table lives in a real modal <dialog> and cannot be wider than it.
const dialog = readFileSync("src/app/insights/daily-values-dialog.tsx", "utf8");
const view = readFileSync("src/app/insights/insights-view.tsx", "utf8");
const css = readFileSync("src/app/neo.css", "utf8");

describe("the day-by-day numbers of an Insights card", () => {
  it("opens in a modal dialog of its own that closes with Esc, the Đóng button or a click outside, instead of an inline table", () => {
    expect(dialog).toContain("showModal()");
    expect(dialog).toContain('<form method="dialog">');
    expect(dialog).toContain("Đóng");
    expect(dialog).toMatch(/e\.target === dialogRef\.current\) dialogRef\.current\?\.close\(\)/);
    expect(view).toContain("<DailyValuesDialog");
    expect(view).not.toContain("<details");
  });

  it("is named and described for screen readers, and its scrolling table can be reached with the keyboard", () => {
    expect(dialog).toContain("aria-labelledby={titleId}");
    expect(dialog).toContain("aria-describedby={subtitleId}");
    expect(dialog).toContain('aria-haspopup="dialog"');
    expect(dialog).toContain('role="region"');
    expect(dialog).toContain("tabIndex={0}");
  });

  it("sets each day against the same day of the previous period, with the difference and its percent, and the whole period on top", () => {
    expect(dialog).toContain("compareDays(series, previousSeries)");
    expect(dialog).toContain("Kỳ trước");
    expect(dialog).toContain("Chênh lệch");
    expect(dialog).toContain("Cả kỳ:");
    // colour is never the only signal: an arrow, a sign and a hidden word say it too
    expect(dialog).toContain("▲");
    expect(dialog).toContain("signed(r.diff)");
    expect(dialog).toContain("visually-hidden");
    expect(dialog).toContain("Chưa có kỳ trước để so sánh.");
  });

  it("gets the previous period and what is good news for the metric from the card", () => {
    expect(view).toContain("previousSeries={metric.previousSeries ?? null}");
    expect(view).toContain("goodWhen={metric.goodWhen}");
  });

  it("shows the number the way the cards do, and a dash for a day without a value", () => {
    expect(dialog).toContain('new Intl.NumberFormat("vi-VN"');
    expect(dialog).toContain('r.value === null ? "—"');
  });
});

describe("its style", () => {
  it("overrides the site-wide 640px minimum width of tables, which is what used to push the table out of its card", () => {
    expect(css).toMatch(/\.neo table \{[^}]*min-width: 640px/);
    expect(css).toMatch(/\.neo \.daily-table \{[^}]*min-width: 0/);
  });

  it("scrolls inside the dialog, keeps the header in view, and becomes a bottom sheet on a phone", () => {
    expect(css).toMatch(/\.neo \.daily-scroll \{[^}]*overflow: auto/);
    expect(css).toMatch(/\.neo thead th \{[^}]*position: sticky/); // the header rule every table shares...
    expect(css).not.toMatch(/\.neo \.daily-table thead th \{[^}]*position: (static|relative)/); // ...is not switched off for this one
    expect(css).toMatch(/@media \(max-width: 760px\)[^{]*\{[\s\S]*?\.neo \.daily-dialog \{ margin: auto 0 0;/);
  });

  it("no longer styles the old inline table", () => {
    expect(css).not.toContain(".insight-table table");
  });
});
