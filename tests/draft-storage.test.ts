import { describe, expect, it } from "vitest";
import { clearAllDrafts, dateTimeLocalOrEmpty, DRAFT_MAX_AGE_MS, DRAFT_PREFIX, readDraft, removeDraft, sameValues, sweepDrafts, writeDraft } from "@/lib/draft-storage";

function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); }
  };
}
const NOW = 1_800_000_000_000;

describe("sameValues", () => {
  it("is true for the same text, treating a missing field as an empty one, and false when any field differs", () => {
    expect(sameValues({ a: "x", b: "" }, { a: "x" })).toBe(true);
    expect(sameValues({}, { a: "" })).toBe(true);
    expect(sameValues({ a: "x" }, { a: "y" })).toBe(false);
    expect(sameValues({ a: "x" }, { a: "x", b: "z" })).toBe(false);
  });
});

describe("copies that must not stay", () => {
  it("are all removed when the user signs out, and nothing else in the browser is touched", () => {
    const store = fakeStore({ other: "keep", [`${DRAFT_PREFIX}new`]: "{}", [`${DRAFT_PREFIX}edit:1`]: "{}" });
    clearAllDrafts(store);
    expect([...store.data.keys()]).toEqual(["other"]);
  });

  it("are swept when too old or unreadable, without opening their forms, and a fresh one stays", () => {
    const store = fakeStore();
    writeDraft(store, "fresh", { message: "mới" }, NOW);
    writeDraft(store, "old", { message: "cũ" }, NOW - DRAFT_MAX_AGE_MS - 1000);
    store.setItem(`${DRAFT_PREFIX}broken`, "not json");
    store.setItem("other", "keep");
    sweepDrafts(store, NOW);
    expect([...store.data.keys()].sort()).toEqual(["other", `${DRAFT_PREFIX}fresh`]);
  });

  it("never throw on a browser that refuses storage", () => {
    const broken = { length: 1, key: () => { throw new Error("SecurityError"); }, getItem: () => null, setItem: () => {}, removeItem: () => { throw new Error("x"); } };
    expect(() => clearAllDrafts(broken)).not.toThrow();
    expect(() => sweepDrafts(broken)).not.toThrow();
  });
});

describe("a time brought back from a copy", () => {
  it("is used only if a date-time field accepts it, otherwise it is left empty instead of breaking the form", () => {
    expect(dateTimeLocalOrEmpty("2026-10-27T09:00")).toBe("2026-10-27T09:00");
    for (const bad of [undefined, "", "27/10/2026", "2026-10-27", "2026-10-27T09:00:00Z", "2026-13-40T99:99", "<script>"]) expect(dateTimeLocalOrEmpty(bad as string | undefined)).toBe("");
  });
});

describe("keeping a copy of a form in the browser", () => {
  it("writes and reads back the text with the time it was kept, under the app's own prefix", () => {
    const store = fakeStore();
    writeDraft(store, "new", { message: "Xin chào", linkUrl: "" }, NOW);
    expect([...store.data.keys()]).toEqual([`${DRAFT_PREFIX}new`]);
    expect(readDraft(store, "new", NOW + 1000)).toEqual({ savedAt: NOW, values: { message: "Xin chào", linkUrl: "" } });
  });

  it("keeps a separate copy for each form", () => {
    const store = fakeStore();
    writeDraft(store, "new", { message: "một" }, NOW);
    writeDraft(store, "edit:123", { message: "hai" }, NOW);
    expect(readDraft(store, "new", NOW)?.values.message).toBe("một");
    expect(readDraft(store, "edit:123", NOW)?.values.message).toBe("hai");
    removeDraft(store, "new");
    expect(readDraft(store, "new", NOW)).toBeNull();
    expect(readDraft(store, "edit:123", NOW)).not.toBeNull();
  });

  it("forgets a copy older than 14 days, and removes it", () => {
    const store = fakeStore();
    writeDraft(store, "new", { message: "cũ" }, NOW);
    expect(readDraft(store, "new", NOW + DRAFT_MAX_AGE_MS - 1)).not.toBeNull();
    expect(readDraft(store, "new", NOW + DRAFT_MAX_AGE_MS + 1)).toBeNull();
    expect(store.data.size).toBe(0);
  });

  it("treats anything it did not write as no copy: bad JSON, the wrong shape, text that is not text", () => {
    for (const raw of ["not json", "null", "5", "[]", '{"savedAt":"x","values":{}}', '{"savedAt":1,"values":[1]}', '{"savedAt":1}']) {
      expect(readDraft(fakeStore({ [`${DRAFT_PREFIX}new`]: raw }), "new", 1)).toBeNull();
    }
    const mixed = fakeStore({ [`${DRAFT_PREFIX}new`]: JSON.stringify({ savedAt: NOW, values: { message: "ok", n: 5, o: { a: 1 } } }) });
    expect(readDraft(mixed, "new", NOW)?.values).toEqual({ message: "ok" });
  });

  it("never throws when the browser refuses its storage (private window, blocked site data, full)", () => {
    const broken = {
      getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => { throw new Error("SecurityError"); }
    };
    expect(() => writeDraft(broken, "new", { message: "x" })).not.toThrow();
    expect(() => removeDraft(broken, "new")).not.toThrow();
    expect(readDraft(broken, "new")).toBeNull();
  });
});
