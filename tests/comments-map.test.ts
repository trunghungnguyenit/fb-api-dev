import { describe, expect, it } from "vitest";
import { COMMENT_ID_PATTERN, mapComment, mapComments } from "@/lib/meta/comments";

describe("mapComment", () => {
  it("maps a full comment", () => {
    expect(mapComment({
      id: "111_222", message: "Hay quá", from: { id: "9", name: "Lan" }, created_time: "2026-10-21T08:00:00+0000", like_count: 3, comment_count: 2,
      is_hidden: true, can_hide: true, can_remove: false, can_comment: false, parent: { id: "111_100" }, attachment: { type: "photo", url: "https://example.com/x.jpg" }
    })).toEqual({
      id: "111_222", message: "Hay quá", author: "Lan", createdTime: "2026-10-21T08:00:00.000Z", likeCount: 3, replyCount: 2, isHidden: true,
      canHide: true, canRemove: false, canReply: false, byPage: false, likedByPage: null, parentId: "111_100", attachment: { type: "photo", url: "https://example.com/x.jpg" }
    });
  });

  it("assumes an action is allowed when Facebook does not say (it refuses clearly if not)", () => {
    expect(mapComment({ id: "111_222" })).toMatchObject({ message: "", author: null, createdTime: null, likeCount: null, isHidden: false, canHide: true, canRemove: true, canReply: true, parentId: null, attachment: null });
  });

  it("drops entries it cannot trust", () => {
    for (const bad of [null, {}, { id: "abc" }, { id: "12/../34" }, { id: "1_2_3" }, { id: 5 }]) expect(mapComment(bad as never)).toBeNull();
    expect(mapComments(undefined)).toEqual([]);
    expect(mapComments([{ id: "1_2" }, { id: "x" }, { id: "3_4" }]).map((c) => c.id)).toEqual(["1_2", "3_4"]);
  });

  it("never keeps an attachment link that is not http(s), and ignores bad dates and counts", () => {
    expect(mapComment({ id: "1_2", attachment: { type: "share", url: "javascript:alert(1)" } })?.attachment).toEqual({ type: "share", url: null });
    expect(mapComment({ id: "1_2", created_time: "garbage", like_count: -3 })).toMatchObject({ createdTime: null, likeCount: null });
  });
});

describe("COMMENT_ID_PATTERN", () => {
  it("accepts Graph comment ids only", () => {
    for (const ok of ["123", "123_456", "122111511207403780_998877"]) expect(COMMENT_ID_PATTERN.test(ok)).toBe(true);
    for (const bad of ["", "abc", "1_2_3", "12/34", "12 34", "../1", "1_", "_1", "1".repeat(31)]) expect(COMMENT_ID_PATTERN.test(bad)).toBe(false);
  });
});
