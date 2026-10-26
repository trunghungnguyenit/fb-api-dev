"use client";

import { useId } from "react";
import { IconKindImages, IconKindLink, IconKindReel, IconKindText, IconKindVideo } from "@/app/icons";
import { KIND_INFO, POST_KINDS, type PostKind } from "@/lib/post-kind";

const ICONS: Record<PostKind, () => React.ReactNode> = {
  text: IconKindText, link: IconKindLink, images: IconKindImages, video: IconKindVideo, reel: IconKindReel
};

/**
 * "Loại bài đăng": one choice of five (or of the `kinds` given). The form below shows only the fields of the chosen
 * kind. A radio group, so arrow keys move the choice and screen readers read "n of 5". Choosing is the parent's call
 * (it may first ask before dropping files), so the group stays on the old value until the parent changes `value`.
 */
export default function PostKindPicker({ value, onChange, kinds = POST_KINDS, disabled }: {
  value: PostKind; onChange: (kind: PostKind) => void; kinds?: readonly PostKind[]; disabled?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return <fieldset className="form-section kind-picker" disabled={disabled}>
    <legend>Loại bài đăng</legend>
    <div className="kind-grid">
      {kinds.map((kind) => {
        const KindIcon = ICONS[kind];
        return <label key={kind} className={`choice-chip kind-option${value === kind ? " is-selected" : ""}`}>
          <input className="visually-hidden" type="radio" name={`${id}-kind`} value={kind} checked={value === kind}
            aria-describedby={hintId} onChange={() => onChange(kind)} />
          <KindIcon />
          <span className="kind-label">{KIND_INFO[kind].label}</span>
          <span className="kind-check" aria-hidden="true">✓</span>
        </label>;
      })}
    </div>
    <p id={hintId} className="subtle form-hint" aria-live="polite">{KIND_INFO[value].hint}</p>
  </fieldset>;
}

/** The kind of a post whose kind can no longer be chosen (already published, or its files are reused): shown, not editable. */
export function KindBadge({ kind, note }: { kind: PostKind; note: string }) {
  const KindIcon = ICONS[kind];
  return <div className="field">
    <span className="label">Loại bài đăng</span>
    <p className="static-field kind-static"><KindIcon /><strong>{KIND_INFO[kind].label}</strong><span className="subtle"> · {note}</span></p>
  </div>;
}
