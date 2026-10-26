"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DraftValues, readDraft, removeDraft, sameValues, type StoredDraft, sweepDrafts, writeDraft } from "@/lib/draft-storage";
import { formatDateTime } from "@/lib/labels";

// A copy of what was typed in a form, kept in THIS browser only (localStorage: nothing is sent anywhere), so that closing the tab,
// switching to another app on a phone or losing the connection does not lose a long text. Only the text fields are kept: files
// cannot be, and the Fanpage is chosen again. When the form is opened again the user is asked whether to bring the text back.

const SAVE_DELAY_MS = 600;
type Values = DraftValues;
type Stored = StoredDraft;

// Even asking for the storage can throw (site data blocked): then there is no copy, and nothing else changes.
const storage = () => { try { return window.localStorage; } catch { return null; } };
const read = (key: string) => { const store = storage(); return store ? readDraft(store, key) : null; };
const write = (key: string, values: Values) => { const store = storage(); if (store) writeDraft(store, key, values); };
const remove = (key: string) => { const store = storage(); if (store) removeDraft(store, key); };
const same = sameValues;

/**
 * `values`: the text fields of the form now; `baseline`: what the form held when it opened (an empty form, or the post being
 * edited). A copy is kept while `values` differ from `baseline`, and removed when they are the same again or `clear()` is called.
 * `pending` is a copy found when the form opened (to offer back); `restore()` hands its values over, `discard()` drops it.
 */
export function useLocalDraft(key: string, values: Values, baseline: Values, enabled = true) {
  const [pending, setPending] = useState<Stored | null>(null);
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;

  useEffect(() => {
    if (!enabled) return;
    const store = storage();
    if (store) sweepDrafts(store);
    const found = read(key);
    if (found && !same(found.values, baselineRef.current)) setPending(found);
    else if (found) remove(key);
  }, [key, enabled]);

  const snapshot = JSON.stringify(values);
  useEffect(() => {
    // While a copy is waiting to be restored or discarded, an empty form must not overwrite it.
    if (!enabled || pending) return;
    const timer = window.setTimeout(() => {
      const now = JSON.parse(snapshot) as Values;
      if (same(now, baselineRef.current)) remove(key); else write(key, now);
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [snapshot, key, enabled, pending]);

  const restore = useCallback(() => { const values = pending?.values ?? null; setPending(null); return values; }, [pending]);
  const discard = useCallback(() => { remove(key); setPending(null); }, [key]);
  const clear = useCallback(() => { remove(key); setPending(null); }, [key]);
  return useMemo(() => ({ pending, restore, discard, clear }), [pending, restore, discard, clear]);
}

/** The question shown when a copy was found: bring the text back, or throw it away. */
export function DraftBanner({ savedAt, dirty = false, onRestore, onDiscard }: { savedAt: number; /** The form already holds new text: bringing the copy back would replace it. */ dirty?: boolean; onRestore: () => void; onDiscard: () => void }) {
  return <div className="notice draft-banner" role="status">
    <p>Có nội dung chưa lưu từ lần trước ({formatDateTime(new Date(savedAt).toISOString())}). Bạn có muốn lấy lại?{dirty && <> <strong>Lấy lại sẽ thay nội dung bạn vừa gõ.</strong></>}</p>
    <div className="actions">
      <button type="button" className="btn small primary" onClick={onRestore}>Lấy lại</button>
      <button type="button" className="btn small" onClick={onDiscard}>Bỏ qua</button>
    </div>
  </div>;
}
