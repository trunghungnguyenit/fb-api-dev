import { StatusIcon } from "./icons";

/** Colour family of the status pill of a post (the palette is in neo.css). A post gone from Facebook keeps status "published". */
export function postTone(status: string, deletedOnFacebook = false) {
  if (deletedOnFacebook) return "deleted";
  return ({ published: "published", failed: "error", draft: "draft", scheduled: "scheduled", publishing: "processing", cancelled: "cancelled" } as Record<string, string>)[status] ?? "cancelled";
}

/** Status pill with its icon, so the status is not carried by colour alone. */
export default function StatusPill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`pill pill-${tone}`}><StatusIcon tone={tone} />{children}</span>;
}
