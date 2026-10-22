// Browser side of uploading an image: ask the server for a signed upload URL, PUT the file to Storage directly
// (so it never passes through a Next.js route and its body-size limit), then ask the server to confirm what arrived.
// The server re-checks everything (type, real size, content); the limits the page shows are only an early warning.
import { callApi, UserError } from "@/lib/client-api";
import { messageFor } from "@/lib/errors";
import type { MediaKind } from "@/lib/media/limits";

function putFile(url: string, file: File, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve()
      : reject(new UserError(`Tải ảnh lên thất bại (mã ${xhr.status}). Vui lòng thử lại.`)));
    xhr.onerror = () => reject(new UserError(messageFor("NETWORK")));
    xhr.onabort = () => reject(new UserError("Đã hủy tải ảnh lên."));
    // Same shape the Storage SDK sends: the file goes in the unnamed part.
    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", file);
    xhr.send(form);
  });
}

/** Removes an upload that was never attached to a post (best effort: the cleanup job catches what is missed). */
export async function discardUpload(mediaId: string) {
  try { await callApi(`/api/media/${mediaId}`, { method: "DELETE" }); } catch { /* left for the cleanup job */ }
}

/** Uploads one image, video or Reel and returns its media id, ready to be attached to a post. Throws a user-facing error. */
export async function uploadMedia(file: File, kind: MediaKind, onProgress: (fraction: number) => void): Promise<{ mediaId: string; size: number }> {
  const issued = await callApi<{ mediaId: string; uploadUrl: string }>("/api/media/upload-url", {
    method: "POST", body: { kind, mime: file.type, size: file.size, name: file.name }
  });
  try {
    await putFile(issued.uploadUrl, file, onProgress);
    const confirmed = await callApi<{ media: { size: number } }>("/api/media/complete", { method: "POST", body: { mediaId: issued.mediaId } });
    return { mediaId: issued.mediaId, size: confirmed.media.size };
  } catch (e) {
    await discardUpload(issued.mediaId);
    throw e;
  }
}
