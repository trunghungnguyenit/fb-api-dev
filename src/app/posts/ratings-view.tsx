import Link from "next/link";
import NewPostButton from "@/app/new-post-button";
import PageHeader from "@/app/page-header";
import { loadRatings } from "@/lib/guest-content";
import { formatDateTime } from "@/lib/labels";
import { CURSOR_PATTERN, type RatingView } from "@/lib/meta/guest";
import { CursorNav, GuestPagePicker, GuestProblemBox, guestProblem, pickGuestPage } from "./guest-shared";
import PostsTabs from "./posts-tabs";

const average = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function Verdict({ rating }: { rating: RatingView }) {
  if (rating.stars !== null) {
    return <span className="rating-stars" role="img" aria-label={`${rating.stars} trên 5 sao`}>{"★".repeat(rating.stars)}{"☆".repeat(5 - rating.stars)}</span>;
  }
  if (rating.recommendation) return <span className={`pill ${rating.recommendation === "positive" ? "pill-ok" : "pill-bad"}`}>{rating.recommendation === "positive" ? "Khuyên dùng" : "Không khuyên dùng"}</span>;
  return null;
}

/**
 * The ratings a Fanpage has received, read from Facebook each time the tab is opened (nothing is stored). Opening it also marks
 * the ratings as seen, which clears the "new ratings" notification.
 */
export default async function RatingsView({ userId, search }: { userId: string; search: { page?: string; after?: string } }) {
  const { pages, selected } = await pickGuestPage(userId, search.page);
  const after = typeof search.after === "string" && CURSOR_PATTERN.test(search.after) ? search.after : undefined;

  let result: Awaited<ReturnType<typeof loadRatings>> | null = null;
  let problem = null;
  if (selected) {
    try { result = await loadRatings(userId, selected.id, after); }
    catch (e) { problem = guestProblem(e); }
  }

  return <main className="shell wide">
    <PageHeader title="Bài viết" subtitle="Đánh giá của khách về Fanpage, đọc từ Facebook"><NewPostButton /></PageHeader>
    <section className="panel">
      <PostsTabs active="ratings" page={selected?.id} />
      <p className="notice" role="note">
        Đánh giá được đọc trực tiếp từ Facebook mỗi lần bạn mở tab này và <strong>không được lưu</strong> trong ứng dụng. Khi có đánh giá mới,
        chuông thông báo sẽ báo trong vòng vài phút. Muốn trả lời đánh giá, hãy mở Fanpage trên Facebook.
      </p>
      {!selected
        ? <p>Bạn chưa có Fanpage nào đang kết nối. <Link href="/pages">Kết nối Facebook</Link> để xem đánh giá.</p>
        : <>
            <GuestPagePicker source="ratings" pages={pages} selected={selected.id} />
            {problem && <GuestProblemBox problem={problem} />}
            {result?.summary && <p className="reaction-total" aria-live="polite">
              {result.summary.count !== null && <><strong>{result.summary.count.toLocaleString("vi-VN")}</strong> đánh giá</>}
              {result.summary.count !== null && result.summary.average !== null && " · "}
              {result.summary.average !== null && <>trung bình <strong>{average.format(result.summary.average)}</strong> trên 5 sao</>}
            </p>}
            {result && (result.items.length === 0
              ? <p className="subtle">{after ? "Không còn đánh giá nào nữa." : `“${selected.page_name}” chưa có đánh giá nào mà Facebook cho phép đọc.`}</p>
              : <ul className="comment-list">
                  {result.items.map((rating) => <li key={rating.key} className="comment">
                    <div className="comment-head">
                      <strong>{rating.reviewer ?? "Người dùng Facebook"}</strong>
                      {rating.createdTime && <span className="subtle"> · {formatDateTime(rating.createdTime)}</span>}
                      <Verdict rating={rating} />
                    </div>
                    {rating.text ? <p className="comment-body">{rating.text}</p> : <p className="subtle">(không có nội dung)</p>}
                  </li>)}
                </ul>)}
            {result && <CursorNav source="ratings" page={selected.id} after={after} next={result.next} />}
          </>}
    </section>
  </main>;
}
