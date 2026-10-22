import { buildLimits } from "@/lib/media/limits";

/** The limits in force for this process (from the environment; see limits.ts). Invalid values throw on first import. */
export const mediaLimits = buildLimits(process.env);
