// Constants shared by the app and the bucket-sync script. Pure module (no imports), so Node can run it directly.

/** The private Storage bucket that holds every uploaded file. Never public: Meta and browsers use signed URLs. */
export const MEDIA_BUCKET = "post-media";

/** Image types Facebook accepts for a photo post and that we can verify by content. WebP is deliberately absent. */
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif"] as const;

/** Video types for a video post or a Reel (MP4 and QuickTime/MOV share the same container family). */
export const VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"] as const;

/** Every type the bucket accepts. */
export const BUCKET_MIME_TYPES: readonly string[] = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES];
