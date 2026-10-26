import Link from "next/link";
import RefreshFeedButton from "./refresh-feed-button";

/** Posts made with this app, posts read from the Fanpage on Facebook, and what visitors left there (their posts and ratings). */
export default function PostsTabs({ active, page }: { active: "app" | "facebook" | "visitor" | "ratings"; page?: string }) {
  // The two tabs about visitors are per Fanpage: switching between them keeps the Fanpage that was chosen.
  const guest = (source: string) => `/posts?source=${source}${page ? `&page=${encodeURIComponent(page)}` : ""}`;
  return <div className="tabs-row">
    <nav className="tab-buttons" aria-label="Nguồn bài viết">
      <Link className={`btn${active === "app" ? " primary" : ""}`} href="/posts" aria-current={active === "app" ? "page" : undefined}>Bài của ứng dụng</Link>
      <Link className={`btn${active === "facebook" ? " primary" : ""}`} href="/posts?source=facebook" aria-current={active === "facebook" ? "page" : undefined}>Từ Facebook</Link>
      <Link className={`btn${active === "visitor" ? " primary" : ""}`} href={guest("visitor")} aria-current={active === "visitor" ? "page" : undefined}>Bài của khách</Link>
      <Link className={`btn${active === "ratings" ? " primary" : ""}`} href={guest("ratings")} aria-current={active === "ratings" ? "page" : undefined}>Đánh giá</Link>
    </nav>
    {active === "facebook" && <RefreshFeedButton />}
  </div>;
}
