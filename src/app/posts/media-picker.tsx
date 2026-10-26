"use client";

// Previews of private-bucket files come through blob / signed URLs, which next/image would need configured.
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";
import { FieldError } from "@/app/form-field";
import { IconUpload } from "@/app/icons";
import { userMessage } from "@/lib/client-api";
import { discardUpload, uploadMedia } from "@/lib/media/client-upload";
import { formatMb, type ClientMediaLimits, type MediaKind } from "@/lib/media/limits";
import { IMAGE_MIME_TYPES, VIDEO_MIME_TYPES } from "@/lib/media/types";
import { isImageMime, isVideoMime, noun } from "@/lib/media/rules";

/** One file in the form: already on the post, copied from another post, or just uploaded. */
export type MediaItem = {
  key: string;
  kind: MediaKind;
  /** Server id of the file. Missing while it is still uploading or if the upload failed. */
  mediaId?: string;
  /** A file of ANOTHER post that this post gets a copy of. */
  clone?: boolean;
  /** Already attached to the post being edited (removing it only drops it from the list). */
  kept?: boolean;
  previewUrl: string;
  blobUrl?: boolean;
  name: string;
  size: number | null;
  status: "uploading" | "ready" | "error";
  progress: number;
  error?: string;
};

export type MediaRef = { id: string; clone?: boolean };

export function useMediaItems(initial: MediaItem[], limits: ClientMediaLimits) {
  const [items, setItems] = useState<MediaItem[]>(initial);
  const [notice, setNotice] = useState("");
  const latest = useRef(items);
  latest.current = items;

  // Object URLs made for previews are released when the form goes away.
  useEffect(() => () => { latest.current.forEach((i) => { if (i.blobUrl) URL.revokeObjectURL(i.previewUrl); }); }, []);

  const patch = (key: string, change: Partial<MediaItem>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...change } : i)));

  function addFiles(files: File[], kind: MediaKind) {
    setNotice("");
    const current = latest.current.filter((i) => i.status !== "error");
    const accepted: File[] = [];
    const rejected: string[] = [];

    if (kind !== "image") {
      // A video or a Reel is the ONLY media of its post.
      const file = files[0];
      if (current.length) rejected.push("Một bài chỉ có ảnh, hoặc đúng một video / Reels. Hãy bỏ các tệp đang chọn trước.");
      else if (files.length > 1) rejected.push("Chỉ chọn được một video cho mỗi bài.");
      else if (!isVideoMime(file.type)) rejected.push(`“${file.name}”: chỉ hỗ trợ video MP4 hoặc MOV.`);
      else {
        const max = kind === "reel" ? limits.reelBytes : limits.videoBytes;
        if (file.size > max) rejected.push(`“${file.name}”: mỗi ${noun(kind)} tối đa ${formatMb(max)}.`);
        else accepted.push(file);
      }
    } else {
      let count = current.length;
      let total = current.reduce((sum, i) => sum + (i.size ?? 0), 0);
      if (current.some((i) => i.kind !== "image")) rejected.push("Bài đang có video. Hãy bỏ video trước nếu muốn đăng ảnh.");
      else for (const file of files) {
        if (!isImageMime(file.type)) rejected.push(`“${file.name}”: chỉ hỗ trợ ảnh JPG, PNG hoặc GIF.`);
        else if (file.size > limits.imageBytes) rejected.push(`“${file.name}”: mỗi ảnh tối đa ${formatMb(limits.imageBytes)}.`);
        else if (count + 1 > limits.imagesPerPost) rejected.push(`“${file.name}”: mỗi bài tối đa ${limits.imagesPerPost} ảnh.`);
        else if (count + 1 > 1 && total + file.size > limits.imagesTotalBytes) rejected.push(`“${file.name}”: tổng dung lượng ảnh của một bài tối đa ${formatMb(limits.imagesTotalBytes)}.`);
        else { accepted.push(file); count++; total += file.size; }
      }
    }
    if (rejected.length) setNotice(rejected.join(" "));

    for (const file of accepted) {
      const key = crypto.randomUUID();
      setItems((list) => [...list, {
        key, kind, previewUrl: URL.createObjectURL(file), blobUrl: true, name: file.name, size: file.size, status: "uploading", progress: 0
      }]);
      uploadMedia(file, kind, (fraction) => patch(key, { progress: fraction }))
        .then((done) => patch(key, { status: "ready", progress: 1, mediaId: done.mediaId, size: done.size }))
        .catch((e) => patch(key, { status: "error", error: userMessage(e) }));
    }
  }

  function remove(key: string) {
    const item = latest.current.find((i) => i.key === key);
    if (!item) return;
    if (item.blobUrl) URL.revokeObjectURL(item.previewUrl);
    // An upload nobody attached is deleted right away; a file already on a post is only dropped from the list.
    if (item.mediaId && !item.kept && !item.clone) void discardUpload(item.mediaId);
    setItems((list) => list.filter((i) => i.key !== key));
    setNotice("");
  }

  function move(key: string, direction: -1 | 1) {
    setItems((list) => {
      const index = list.findIndex((i) => i.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= list.length) return list;
      const next = [...list];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  /** The kind of post changed to one that does not use these files: drops them all (uploads nobody attached are deleted). */
  function clear() {
    for (const item of latest.current) {
      if (item.blobUrl) URL.revokeObjectURL(item.previewUrl);
      if (item.mediaId && !item.kept && !item.clone) void discardUpload(item.mediaId);
    }
    setItems([]);
    setNotice("");
  }

  /** The form was saved: the files now belong to a post, so they must not be deleted when the form is cleared. */
  function reset() {
    latest.current.forEach((i) => { if (i.blobUrl) URL.revokeObjectURL(i.previewUrl); });
    setItems([]);
    setNotice("");
  }

  const refs: MediaRef[] = items
    .filter((i) => i.status === "ready" && i.mediaId)
    .map((i) => (i.clone ? { id: i.mediaId as string, clone: true } : { id: i.mediaId as string }));

  return {
    items, notice, refs, addFiles, remove, move, reset, clear,
    uploading: items.some((i) => i.status === "uploading"),
    hasErrors: items.some((i) => i.status === "error"),
    /** What the post is made of right now: null (nothing), "image", "video" or "reel". */
    kind: items[0]?.kind ?? null
  };
}

export type MediaState = ReturnType<typeof useMediaItems>;

const ACCEPT = { image: IMAGE_MIME_TYPES.join(","), video: VIDEO_MIME_TYPES.join(","), reel: VIDEO_MIME_TYPES.join(",") } as const;

const TITLE: Record<MediaKind, string> = { image: "Ảnh", video: "Video", reel: "Video Reels" };
const CHOOSE: Record<MediaKind, string> = { image: "Chọn ảnh", video: "Chọn video", reel: "Chọn video cho Reels" };

/**
 * The files of a post of ONE kind (the form decides the kind: images, a video or a Reel), with the rules of that kind
 * only. A video or a Reel is a single file, so once it is chosen there is nothing more to add.
 */
export default function MediaPicker({ state, limits, kind, disabled, error }: {
  state: MediaState; limits: ClientMediaLimits; kind: MediaKind; disabled?: boolean; error?: string | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const { items } = state;
  const full = kind === "image" ? items.filter((i) => i.status !== "error").length >= limits.imagesPerPost : items.some((i) => i.status !== "error");
  const choose = (e: React.ChangeEvent<HTMLInputElement>) => { state.addFiles([...(e.target.files ?? [])], kind); e.target.value = ""; };
  const help = kind === "image"
    ? `Ảnh JPG, PNG hoặc GIF: tối đa ${limits.imagesPerPost} ảnh, mỗi ảnh ${formatMb(limits.imageBytes)}, tổng ${formatMb(limits.imagesTotalBytes)}.`
    : kind === "video"
      ? `Một video MP4 hoặc MOV, tối đa ${formatMb(limits.videoBytes)}.`
      : `Một video MP4 hoặc MOV, tối đa ${formatMb(limits.reelBytes)}. Reels nên là video dọc 9:16, dài 3–90 giây.`;

  return <div className="field">
    <span className={`label${error ? " label-invalid" : ""}`} id="media-label">{TITLE[kind]} <span className="subtle">(bắt buộc)</span></span>
    <div className="media-grid" role="group" aria-labelledby="media-label">
      {items.map((item, index) => <figure key={item.key} className={`media-item${item.status === "error" ? " media-error" : ""}`}>
        {item.kind === "image"
          ? <img src={item.previewUrl} alt={item.name} />
          : <video src={item.previewUrl} muted playsInline preload="metadata" controls aria-label={item.name} />}
        <figcaption>
          <span className="media-name" title={item.name}>{item.kind !== "image" && <span className="badge">{noun(item.kind)}</span>}{item.name}</span>
          {item.status === "uploading" && <progress max={1} value={item.progress} aria-label={`Đang tải ${item.name}`} />}
          {item.status === "error" && <span className="media-problem" role="alert">{item.error}</span>}
          {item.size !== null && item.status === "ready" && <span className="subtle">{formatMb(item.size)}</span>}
        </figcaption>
        <div className="media-actions">
          {item.kind === "image" && <>
            <button type="button" className="btn" onClick={() => state.move(item.key, -1)} disabled={disabled || index === 0} aria-label={`Đưa ${item.name} lên trước`}>↑</button>
            <button type="button" className="btn" onClick={() => state.move(item.key, 1)} disabled={disabled || index === items.length - 1} aria-label={`Đưa ${item.name} xuống sau`}>↓</button>
          </>}
          <button type="button" className="btn" onClick={() => state.remove(item.key)} disabled={disabled} aria-label={`Bỏ ${item.name}`}>✕</button>
        </div>
      </figure>)}
    </div>

    <input ref={input} type="file" accept={ACCEPT[kind]} multiple={kind === "image"} className="visually-hidden" tabIndex={-1} aria-hidden="true" disabled={disabled} onChange={choose} />
    {/* Opens the camera of a phone straight away (the other one opens the gallery); only touch screens show the button for it. */}
    <input ref={camera} type="file" accept={kind === "image" ? "image/*" : "video/*"} capture="environment" className="visually-hidden" tabIndex={-1} aria-hidden="true" disabled={disabled} onChange={choose} />
    {items.length === 0
      ? <button type="button" className={`media-drop${error ? " is-invalid" : ""}`} disabled={disabled} data-invalid={error ? "true" : undefined} aria-describedby={error ? "media-error" : "media-help"} onClick={() => input.current?.click()}>
          <IconUpload /><strong>{CHOOSE[kind]}</strong><span className="subtle">{kind === "image" ? "Chọn một hoặc nhiều ảnh" : "Chọn một tệp"}</span>
        </button>
      : kind === "image" && <div className="actions">
          <button type="button" className="btn" disabled={disabled || full} onClick={() => input.current?.click()}>Thêm ảnh</button>
          <button type="button" className="btn media-camera" disabled={disabled || full} onClick={() => camera.current?.click()}>Chụp thêm ảnh</button>
        </div>}
    {items.length === 0 && <div className="actions media-camera"><button type="button" className="btn" disabled={disabled} onClick={() => camera.current?.click()}>{kind === "image" ? "Chụp ảnh bằng camera" : "Quay video bằng camera"}</button></div>}
    <FieldError id="media" message={error} />
    <div className="subtle" id="media-help">{help}</div>
    {kind !== "image" && <p className="notice" role="note">Video và Reels được đăng ở nền: Facebook cần vài phút để xử lý nên bài sẽ hiện “Facebook đang xử lý” trước khi lên Fanpage.</p>}
    <div role="alert">{state.notice && <p className="error">{state.notice}</p>}</div>
  </div>;
}
