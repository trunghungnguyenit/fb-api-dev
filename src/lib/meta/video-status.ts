// Reading Facebook's answer to GET /{video-id}?fields=status for a video or a Reel. Pure module.
//
// Documented shape (Reels publishing guide, Graph API v26.0):
//   status: {
//     video_status: uploading | upload_complete | processing | ready | error | upload_failed | expired,
//     uploading_phase:  { status, bytes_transfered, source_file_size, errors },
//     processing_phase: { status, error },
//     publishing_phase: { status, publish_status: draft | scheduled | published | error, publish_time, error }
//   }
// A phase's own `status` is not_started | in_progress | complete(d) | error.
// Anything we cannot read is "still processing", never "failed": a wrong "failed" would let the user post twice.

export type VideoProgress =
  | { state: "uploading" }      // Facebook has not finished receiving the file
  | { state: "processing" }     // received; converting / waiting to be published
  | { state: "published" }
  | { state: "failed"; reason: string };

type Phase = { status?: string; publish_status?: string; error?: unknown; errors?: unknown } | undefined;
export type VideoStatus = {
  video_status?: string;
  uploading_phase?: Phase;
  processing_phase?: Phase;
  publishing_phase?: Phase;
} | null | undefined;

const hasError = (phase: Phase) => phase?.status === "error" || Boolean(phase?.error) || (Array.isArray(phase?.errors) && phase.errors.length > 0);

export function interpretVideoStatus(status: VideoStatus, kind: "video" | "reel"): VideoProgress {
  if (!status || typeof status !== "object") return { state: "processing" };
  const video = status.video_status;
  if (video === "error" || video === "upload_failed" || video === "expired") return { state: "failed", reason: `video_status=${video}` };
  if (hasError(status.uploading_phase)) return { state: "failed", reason: "uploading_phase error" };
  if (hasError(status.processing_phase)) return { state: "failed", reason: "processing_phase error" };
  if (hasError(status.publishing_phase) || status.publishing_phase?.publish_status === "error") return { state: "failed", reason: "publishing_phase error" };

  // A Reel is live when its publishing phase says so; a plain video when it is ready.
  if (kind === "reel") {
    if (status.publishing_phase?.publish_status === "published") return { state: "published" };
  } else if (video === "ready") {
    return { state: "published" };
  }
  const uploaded = status.uploading_phase?.status;
  if (video === "uploading" && uploaded !== "complete" && uploaded !== "completed") return { state: "uploading" };
  return { state: "processing" };
}
