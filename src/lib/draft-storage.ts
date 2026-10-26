// The copy of a form's text that the browser keeps (see app/posts/use-local-draft.tsx). Pure apart from the storage it is given, so
// the rules (what counts as the same, how long a copy lives, what is thrown away as unreadable) can be tested without a browser.

export type DraftValues = Record<string, string>;
export type StoredDraft = { savedAt: number; values: DraftValues };

export const DRAFT_PREFIX = "page-publisher:draft:";
export const DRAFT_MAX_AGE_MS = 14 * 24 * 3600_000;

/** Two sets of fields hold the same text (a missing field is an empty one). */
export const sameValues = (a: DraftValues, b: DraftValues) => Object.keys({ ...a, ...b }).every((k) => (a[k] ?? "") === (b[k] ?? ""));

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type ListableStore = Store & Pick<Storage, "length" | "key">;

/** A value an <input type=datetime-local> accepts ("2026-10-27T09:00"), or "": a copy that was damaged must not break the form when it is brought back. */
export const dateTimeLocalOrEmpty = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : "");

/** The copy kept under `key`, or null: none, too old (and then removed), or not something this app wrote. Never throws. */
export function readDraft(store: Store, key: string, now = Date.now()): StoredDraft | null {
  try {
    const raw = store.getItem(DRAFT_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft> | null;
    if (!parsed || typeof parsed.savedAt !== "number" || !parsed.values || typeof parsed.values !== "object" || Array.isArray(parsed.values)) return null;
    if (now - parsed.savedAt > DRAFT_MAX_AGE_MS) { store.removeItem(DRAFT_PREFIX + key); return null; }
    return { savedAt: parsed.savedAt, values: Object.fromEntries(Object.entries(parsed.values).filter(([, v]) => typeof v === "string")) };
  } catch { return null; }
}

/** Browsers can refuse storage (private windows, blocked site data, full): the form works the same without a copy. */
export function writeDraft(store: Store, key: string, values: DraftValues, now = Date.now()) {
  try { store.setItem(DRAFT_PREFIX + key, JSON.stringify({ savedAt: now, values } satisfies StoredDraft)); } catch { /* no copy, no harm */ }
}

/** Every copy this app keeps: for signing out, so the next person on a shared browser is not offered the previous one's unposted text. */
export function clearAllDrafts(store: ListableStore) {
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) { const key = store.key(i); if (key?.startsWith(DRAFT_PREFIX)) keys.push(key); }
    keys.forEach((key) => store.removeItem(key));
  } catch { /* nothing to clear */ }
}

/** Removes the copies that are too old or unreadable (a form that is never opened again would otherwise keep its copy forever). */
export function sweepDrafts(store: ListableStore, now = Date.now()) {
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) { const key = store.key(i); if (key?.startsWith(DRAFT_PREFIX)) keys.push(key.slice(DRAFT_PREFIX.length)); }
    for (const key of keys) if (!readDraft(store, key, now)) removeDraft(store, key);
  } catch { /* the sweep is a courtesy */ }
}

export function removeDraft(store: Store, key: string) {
  try { store.removeItem(DRAFT_PREFIX + key); } catch { /* nothing to remove */ }
}
