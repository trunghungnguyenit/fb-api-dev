import { describe, expect, it } from "vitest";
import { pickFair } from "@/lib/fair-queue";

const post = (id: string, user_id: string) => ({ id, user_id });

describe("pickFair", () => {
  it("round-robins across users so one backlog cannot starve the others", () => {
    const queue = [post("a1", "A"), post("a2", "A"), post("a3", "A"), post("a4", "A"), post("b1", "B"), post("c1", "C")];
    expect(pickFair(queue, 4).map((p) => p.id)).toEqual(["a1", "b1", "c1", "a2"]);
  });

  it("keeps oldest-first order within a user", () => {
    expect(pickFair([post("a1", "A"), post("a2", "A")], 2).map((p) => p.id)).toEqual(["a1", "a2"]);
  });

  it("respects the limit and handles empty input", () => {
    expect(pickFair([], 10)).toEqual([]);
    expect(pickFair([post("a1", "A"), post("b1", "B")], 1)).toHaveLength(1);
  });
});
