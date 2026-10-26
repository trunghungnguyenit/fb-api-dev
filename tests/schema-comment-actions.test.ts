import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMENT_ACTIONS } from "@/lib/comments";

// The fake database used by the other tests does not enforce CHECK constraints, so an action that is missing from
// schema.sql would pass every test and then be refused by the real database (the log is best effort and only logs it).
describe("schema.sql", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");
  const check = /add constraint comment_actions_action_check check \(action in \(([^)]*)\)\)/.exec(sql);

  it("has a comment action check", () => {
    expect(check).not.toBeNull();
  });

  it("allows every comment action the app can write, and no other", () => {
    const allowed = [...(check?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(allowed).toEqual([...COMMENT_ACTIONS].sort());
  });

  it("does not keep an older inline check on the column that would still refuse the new actions", () => {
    expect(/action text not null check/.test(sql)).toBe(false);
  });
});

describe("schema.sql post kinds", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");
  const check = /add constraint comment_actions_post_kind_check check \(post_kind in \(([^)]*)\)\)/.exec(sql);

  it("allows every kind of post a comment can be on, and no other, and keeps no older inline check", async () => {
    const { kindSchema } = await import("@/lib/comments-http");
    const allowed = [...(check?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(allowed).toEqual([...kindSchema.options].sort());
    expect(/post_kind text not null check/.test(sql)).toBe(false);
  });
});
