// The ONE place that knows the media size limits. Pure module with no app imports (no "@/" alias, no env.ts), so
// the bucket-sync script (scripts/sync-media-bucket.ts, run by Node directly) and the app read exactly the same
// numbers. Everything else asks `limitFor(...)`; nothing else mentions "50 MB".

export type MediaKind = "image" | "video" | "reel";

const MB = 1024 * 1024;

/** Uploads that belong to no post yet, per user, at any moment (a cap so signed upload URLs cannot be requested without end). */
export const MAX_UNATTACHED_UPLOADS = 60;

export type MediaLimits = {
  /** Absolute ceiling for any single file; also the bucket's own file_size_limit. */
  maxFileBytes: number;
  /** Effective per-file limit per kind (never above the ceiling). */
  perKindBytes: Record<MediaKind, number>;
  /** Total size of the images of one multi-photo post. */
  imagesTotalBytes: number;
  imagesPerPost: number;
  /** Files at or above this size use the resumable upload channel (see plan: "Nâng giới hạn"). */
  resumableThresholdBytes: number;
  /** One import: how many different files it may upload, and their total size. */
  importFiles: number;
  importTotalBytes: number;
};

const VARIABLES = {
  MEDIA_MAX_FILE_MB: 50,
  MEDIA_MAX_IMAGE_MB: 10,
  MEDIA_MAX_VIDEO_MB: 50,
  MEDIA_MAX_REEL_MB: 50,
  MEDIA_MAX_IMAGES_TOTAL_MB: 50,
  MEDIA_RESUMABLE_THRESHOLD_MB: 50,
  MEDIA_IMPORT_MAX_TOTAL_MB: 500
} as const;

function readNumber(raw: Record<string, string | undefined>, name: keyof typeof VARIABLES) {
  const text = raw[name]?.trim();
  if (!text) return VARIABLES[name];
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 100_000) throw new Error(`${name} must be a positive number of megabytes (got "${text}")`);
  return value;
}

/** Reads the limits from environment-style values. Throws a clear error for a value that cannot be right. */
export function buildLimits(raw: Record<string, string | undefined>): MediaLimits {
  const ceiling = readNumber(raw, "MEDIA_MAX_FILE_MB") * MB;
  const kind = (name: "MEDIA_MAX_IMAGE_MB" | "MEDIA_MAX_VIDEO_MB" | "MEDIA_MAX_REEL_MB") => Math.min(readNumber(raw, name) * MB, ceiling);

  const perPostText = raw.MEDIA_MAX_IMAGES_PER_POST?.trim();
  const imagesPerPost = perPostText ? Number(perPostText) : 10;
  if (!Number.isInteger(imagesPerPost) || imagesPerPost < 1 || imagesPerPost > 30) {
    throw new Error(`MEDIA_MAX_IMAGES_PER_POST must be a whole number from 1 to 30 (got "${perPostText}")`);
  }
  // Every file of an import is uploaded before any post exists, so it must fit under the cap on unattached uploads.
  const importFilesText = raw.MEDIA_IMPORT_MAX_FILES?.trim();
  const importFiles = importFilesText ? Number(importFilesText) : 50;
  if (!Number.isInteger(importFiles) || importFiles < 1 || importFiles > MAX_UNATTACHED_UPLOADS) {
    throw new Error(`MEDIA_IMPORT_MAX_FILES must be a whole number from 1 to ${MAX_UNATTACHED_UPLOADS} (got "${importFilesText}")`);
  }
  return {
    maxFileBytes: Math.floor(ceiling),
    perKindBytes: {
      image: Math.floor(kind("MEDIA_MAX_IMAGE_MB")),
      video: Math.floor(kind("MEDIA_MAX_VIDEO_MB")),
      reel: Math.floor(kind("MEDIA_MAX_REEL_MB"))
    },
    imagesTotalBytes: Math.floor(readNumber(raw, "MEDIA_MAX_IMAGES_TOTAL_MB") * MB),
    imagesPerPost,
    resumableThresholdBytes: Math.floor(readNumber(raw, "MEDIA_RESUMABLE_THRESHOLD_MB") * MB),
    importFiles,
    importTotalBytes: Math.floor(readNumber(raw, "MEDIA_IMPORT_MAX_TOTAL_MB") * MB)
  };
}

export const limitFor = (limits: MediaLimits, kind: MediaKind) => limits.perKindBytes[kind];

/** "10 MB", "2,5 MB": for messages shown to users, always taken from the configured number. */
export function formatMb(bytes: number) {
  const mb = bytes / MB;
  const text = Number.isInteger(mb) ? String(mb) : mb.toFixed(1).replace(".", ",");
  return `${text} MB`;
}

/** What the browser needs to warn early (the server re-checks everything). */
export type ClientMediaLimits = {
  imageBytes: number; videoBytes: number; reelBytes: number; imagesTotalBytes: number; imagesPerPost: number;
  importFiles: number; importTotalBytes: number;
};

export const clientLimits = (limits: MediaLimits): ClientMediaLimits => ({
  imageBytes: limitFor(limits, "image"), videoBytes: limitFor(limits, "video"), reelBytes: limitFor(limits, "reel"),
  imagesTotalBytes: limits.imagesTotalBytes, imagesPerPost: limits.imagesPerPost,
  importFiles: limits.importFiles, importTotalBytes: limits.importTotalBytes
});
