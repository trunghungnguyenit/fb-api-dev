import { describe, expect, it } from "vitest";
import { isMissingSchemaError } from "@/lib/schema-check";

describe("isMissingSchemaError", () => {
  it("recognises a missing column or table", () => {
    expect(isMissingSchemaError({ code: "42703" })).toBe(true); // undefined_column
    expect(isMissingSchemaError({ code: "42P01" })).toBe(true); // undefined_table
    expect(isMissingSchemaError({ code: "PGRST204" })).toBe(true); // column not in schema cache
    expect(isMissingSchemaError({ code: "PGRST205" })).toBe(true); // table not in schema cache
  });

  it("does not mistake other failures for an outdated schema", () => {
    expect(isMissingSchemaError({ code: "42501" })).toBe(false); // RLS / permission
    expect(isMissingSchemaError({ code: "PGRST301" })).toBe(false);
    expect(isMissingSchemaError({})).toBe(false);
    expect(isMissingSchemaError(null)).toBe(false);
    expect(isMissingSchemaError(undefined)).toBe(false);
  });
});
