import { describe, expect, it } from "vitest";
import { interpretVideoStatus } from "@/lib/meta/video-status";

describe("interpretVideoStatus", () => {
  it("a plain video is live when it is ready", () => {
    expect(interpretVideoStatus({ video_status: "ready" }, "video")).toEqual({ state: "published" });
    expect(interpretVideoStatus({ video_status: "processing" }, "video")).toEqual({ state: "processing" });
    expect(interpretVideoStatus({ video_status: "upload_complete" }, "video")).toEqual({ state: "processing" });
  });

  it("a Reel is live only when its publishing phase says published, even if the video is ready", () => {
    const ready = { video_status: "ready", uploading_phase: { status: "complete" }, processing_phase: { status: "complete" } };
    expect(interpretVideoStatus({ ...ready, publishing_phase: { status: "complete", publish_status: "published" } }, "reel")).toEqual({ state: "published" });
    expect(interpretVideoStatus({ ...ready, publishing_phase: { status: "not_started", publish_status: "draft" } }, "reel")).toEqual({ state: "processing" });
    expect(interpretVideoStatus({ ...ready, publishing_phase: { status: "in_progress", publish_status: "scheduled" } }, "reel")).toEqual({ state: "processing" });
  });

  it("tells uploading (the file has not all arrived) from processing", () => {
    expect(interpretVideoStatus({ video_status: "uploading", uploading_phase: { status: "in_progress" } }, "reel")).toEqual({ state: "uploading" });
    expect(interpretVideoStatus({ video_status: "uploading", uploading_phase: { status: "completed" } }, "reel")).toEqual({ state: "processing" });
    expect(interpretVideoStatus({ video_status: "uploading" }, "video")).toEqual({ state: "uploading" });
  });

  it("fails on every documented failure signal", () => {
    for (const video_status of ["error", "upload_failed", "expired"]) {
      expect(interpretVideoStatus({ video_status }, "video")).toMatchObject({ state: "failed" });
    }
    expect(interpretVideoStatus({ video_status: "processing", processing_phase: { status: "error", error: { message: "bad codec" } } }, "reel")).toMatchObject({ state: "failed" });
    expect(interpretVideoStatus({ uploading_phase: { status: "in_progress", errors: [{ code: 1 }] } }, "reel")).toMatchObject({ state: "failed" });
    expect(interpretVideoStatus({ publishing_phase: { status: "error", publish_status: "error" } }, "reel")).toMatchObject({ state: "failed" });
  });

  it("never calls an unreadable answer a failure", () => {
    for (const odd of [null, undefined, {}, { video_status: "something_new" }, "weird" as unknown as undefined]) {
      expect(interpretVideoStatus(odd, "video")).toEqual({ state: "processing" });
      expect(interpretVideoStatus(odd, "reel")).toEqual({ state: "processing" });
    }
  });

  it("an empty error list is not an error", () => {
    expect(interpretVideoStatus({ video_status: "processing", uploading_phase: { status: "complete", errors: [] } }, "video")).toEqual({ state: "processing" });
  });
});
