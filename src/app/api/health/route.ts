import { NextResponse } from "next/server";

// For uptime monitors: alive or not, nothing about what runs here.
export async function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
