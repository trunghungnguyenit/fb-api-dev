import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_TYPES } from "@/lib/notification-text";

// The fake database used by the other tests does not enforce CHECK constraints, so a new notification type that is
// missing from schema.sql would pass every test and then be refused by the real database (and `notify` only logs).
describe("schema.sql", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");
  const check = /add constraint notifications_type_check check \(type in \(([^)]*)\)\)/.exec(sql);

  it("has a notifications type check", () => {
    expect(check).not.toBeNull();
  });

  it("allows every notification type the app can write, and no other", () => {
    const allowed = [...(check?.[1] ?? "").matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(allowed).toEqual([...NOTIFICATION_TYPES].sort());
  });
});
