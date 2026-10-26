"use client";

// The files of the post are previews from this browser or signed URLs: next/image would need them configured.
/* eslint-disable @next/next/no-img-element */

import { useState } from "react";

export type PreviewMedia = { kind: "image" | "video" | "reel"; url: string; name: string };

const hostOf = (link: string) => { try { return new URL(link).hostname.replace(/^www\./, ""); } catch { return ""; } };

/**
 * "Xem trước bài viết": the post roughly as it will look on the Fanpage (name, text cut after a few lines with "Xem thêm", the
 * pictures or the video, the link). A guide to catch an empty caption or a wrong picture before posting, not a copy of Facebook.
 */
export default function PostPreview({ pageName, message, link, media }: { pageName: string; message: string; link: string; media: PreviewMedia[] }) {
  const [expanded, setExpanded] = useState(false);
  // A short text can still wrap past the clamp on a narrow phone, so the button is offered for anything but a line or two.
  const long = message.length > 100 || message.split("\n").length > 2;
  const host = link ? hostOf(link) : "";
  const images = media.filter((m) => m.kind === "image");
  const video = media.find((m) => m.kind !== "image");
  return <details className="preview-panel">
    <summary>Xem trước bài viết</summary>
    <article className="pv-card" aria-label="Xem trước bài viết">
      <header>
        <span className="pv-avatar" aria-hidden="true">{(pageName.trim()[0] ?? "P").toUpperCase()}</span>
        <div><strong>{pageName || "Fanpage"}</strong><span className="subtle pv-meta">Bây giờ · Công khai</span></div>
      </header>
      {message.trim()
        ? <p className={`pv-text${expanded ? "" : " is-clamped"}`}>{message}</p>
        : <p className="subtle">(chưa có nội dung)</p>}
      {long && <button type="button" className="link-button" onClick={() => setExpanded((v) => !v)}>{expanded ? "Thu gọn" : "Xem thêm"}</button>}
      {images.length > 0 && <div className={`pv-media pv-media-${Math.min(images.length, 4)}`}>
        {images.slice(0, 4).map((m, i) => <figure key={i}>
          <img src={m.url} alt="" />
          {i === 3 && images.length > 4 && <figcaption>+{images.length - 4}</figcaption>}
        </figure>)}
      </div>}
      {video && <div className="pv-media pv-media-1"><figure><video src={video.url} muted playsInline preload="metadata" aria-label={video.name} /></figure></div>}
      {host && <div className="pv-link"><span className="subtle">{host.toUpperCase()}</span><strong>{link}</strong></div>}
    </article>
  </details>;
}
