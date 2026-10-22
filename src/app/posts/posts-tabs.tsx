import Link from "next/link";
import RefreshFeedButton from "./refresh-feed-button";

/** Posts made with this app, and posts read from the Fanpage on Facebook (published outside this app). */
export default function PostsTabs({ active }: { active: "app" | "facebook" }) {
  return <div className="tabs-row">
    <nav className="tab-buttons" aria-label="Nguồn bài viết">
      <Link className={`btn${active === "app" ? " primary" : ""}`} href="/posts" aria-current={active === "app" ? "page" : undefined}>Bài của ứng dụng</Link>
      <Link className={`btn${active === "facebook" ? " primary" : ""}`} href="/posts?source=facebook" aria-current={active === "facebook" ? "page" : undefined}>Từ Facebook</Link>
    </nav>
    {active === "facebook" && <RefreshFeedButton />}
  </div>;
}
