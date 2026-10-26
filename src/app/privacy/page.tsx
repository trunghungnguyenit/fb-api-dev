import LegalPage, { ContactLine } from "@/app/legal-page";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Chính sách quyền riêng tư · Page Publisher",
  description: "Page Publisher thu thập, dùng, lưu và xóa dữ liệu của bạn như thế nào: tài khoản Google, kết nối Facebook, Fanpage, bài viết và tệp tải lên.",
  path: "/privacy",
  index: true
});

// The text describes what the app really does (see the code and docs/security-client-protection.md); when the app changes what it
// keeps, this page changes with it, together with LEGAL_UPDATED.
export default function PrivacyPage() {
  return <LegalPage
    title="Chính sách quyền riêng tư"
    intro="Page Publisher giúp quản trị viên Fanpage Facebook soạn, lên lịch, đăng và theo dõi bài viết. Trang này nói rõ ứng dụng giữ dữ liệu nào của bạn, dùng để làm gì, chia sẻ với ai và cách bạn xóa chúng."
  >
    <section aria-labelledby="ai-van-hanh">
      <h2 id="ai-van-hanh">1. Ai vận hành ứng dụng</h2>
      <p><ContactLine /></p>
    </section>

    <section aria-labelledby="du-lieu-thu-thap">
      <h2 id="du-lieu-thu-thap">2. Dữ liệu ứng dụng giữ</h2>
      <ul>
        <li><strong>Tài khoản Google</strong> bạn dùng để đăng nhập: mã người dùng, địa chỉ email và tên hiển thị.</li>
        <li>
          <strong>Kết nối Facebook</strong> (chỉ khi bạn bấm “Kết nối Facebook” và đồng ý các quyền): mã và tên tài khoản Facebook, danh sách Fanpage bạn quản lý
          cùng vai trò của bạn trên từng Fanpage, các quyền đã cấp, và mã truy cập (token). Token được mã hóa (AES-256-GCM) trước khi lưu, chỉ máy chủ giải mã khi cần
          gọi Facebook và không bao giờ được gửi tới trình duyệt.
        </li>
        <li><strong>Nội dung bạn tạo</strong>: bài viết, liên kết, lịch đăng, ghi chú nội bộ, kết quả và lịch sử từng lần đăng, và ảnh, video bạn tải lên (lưu trong kho riêng tư, chỉ bạn xem được).</li>
        <li>
          <strong>Bản sao bài trên Fanpage của bạn</strong> trong 7 ngày gần nhất (nội dung, liên kết, số cảm xúc, bình luận, chia sẻ) để hiển thị danh sách bài và
          báo khi có bình luận hoặc đánh giá mới. Ứng dụng chỉ lưu <em>số lượng</em> bình luận và đánh giá để biết có cái mới, không lưu nội dung của chúng.
        </li>
        <li><strong>Nhật ký thao tác</strong> với bình luận (thích, trả lời, ẩn, xóa, sửa): loại thao tác, thời điểm, mã bình luận và kết quả, không kèm nội dung.</li>
        <li><strong>Thông báo</strong> trong ứng dụng (đăng thất bại, Fanpage mất quyền, có bình luận hoặc đánh giá mới...).</li>
      </ul>
      <p>
        <strong>Đọc trực tiếp từ Facebook mỗi lần bạn mở và không lưu:</strong> nội dung bình luận, bài do khách viết trên tường Fanpage, đánh giá, số liệu Insights của Fanpage và
        của từng bài, thông tin người theo dõi theo quốc gia, thành phố, giới tính và độ tuổi.
      </p>
    </section>

    <section aria-labelledby="cookie">
      <h2 id="cookie">3. Cookie và dữ liệu trong trình duyệt</h2>
      <ul>
        <li>Cookie phiên đăng nhập (chỉ máy chủ đọc được, không script nào đọc được) và một cookie trạng thái ngắn (10 phút) trong lúc kết nối Facebook, để chặn giả mạo yêu cầu.</li>
        <li>Chữ bạn đang gõ trong form soạn bài được giữ trong bộ nhớ của trình duyệt (không gửi đi đâu) để khỏi mất khi đóng tab; tự xóa sau 14 ngày hoặc khi bạn đăng xuất.</li>
        <li>Ứng dụng không dùng cookie quảng cáo, không dùng công cụ theo dõi hay phân tích của bên thứ ba.</li>
      </ul>
    </section>

    <section aria-labelledby="muc-dich">
      <h2 id="muc-dich">4. Mục đích sử dụng</h2>
      <p>
        Dữ liệu chỉ dùng để cung cấp các chức năng bạn yêu cầu: đăng nhập, đăng và lên lịch bài lên Fanpage, hiển thị và quản lý bình luận, hiển thị số liệu, và gửi thông báo cho bạn.
        Ứng dụng không bán, cho thuê dữ liệu của bạn và không dùng chúng để quảng cáo.
      </p>
    </section>

    <section aria-labelledby="ben-thu-ba">
      <h2 id="ben-thu-ba">5. Chia sẻ với bên thứ ba</h2>
      <ul>
        <li><strong>Google</strong>: xác thực khi bạn đăng nhập.</li>
        <li><strong>Meta (Facebook)</strong>: ứng dụng gọi Facebook Graph API thay mặt bạn, trong phạm vi quyền bạn cấp, để đăng bài và đọc dữ liệu Fanpage. Dữ liệu Facebook trả về không được chuyển cho ai khác.</li>
        <li><strong>Supabase</strong>: lưu cơ sở dữ liệu và tệp tải lên của ứng dụng.</li>
        <li><strong>Nhà cung cấp máy chủ</strong> chạy ứng dụng.</li>
      </ul>
      <p>Ngoài các bên trên, dữ liệu chỉ được cung cấp khi pháp luật yêu cầu.</p>
    </section>

    <section aria-labelledby="thoi-gian-luu">
      <h2 id="thoi-gian-luu">6. Thời gian lưu giữ</h2>
      <ul>
        <li>Dữ liệu tài khoản, bài viết và lịch sử được giữ cho tới khi bạn yêu cầu xóa.</li>
        <li>Khi bạn gỡ một Fanpage khỏi ứng dụng, token của Fanpage đó bị xóa ngay; bài viết cũ được giữ làm lịch sử nếu bạn không yêu cầu xóa.</li>
        <li>Ảnh, video đã tải lên nhưng chưa gắn vào bài nào tự bị xóa sau 24 giờ.</li>
        <li>Bản sao bài từ Facebook chỉ phủ 7 ngày gần nhất và được làm mới khoảng 5 phút một lần.</li>
      </ul>
    </section>

    <section aria-labelledby="xoa-du-lieu">
      <h2 id="xoa-du-lieu">7. Quyền của bạn và cách xóa dữ liệu</h2>
      <ul>
        <li><strong>Ngừng cho ứng dụng truy cập Facebook:</strong> gỡ Fanpage ở trang “Fanpage” của ứng dụng, và/hoặc gỡ ứng dụng trong Facebook (Cài đặt → Ứng dụng và trang web).</li>
        <li><strong>Xem, sửa hoặc xóa từng bài:</strong> ngay trong ứng dụng.</li>
        <li><strong>Xóa toàn bộ dữ liệu của bạn</strong> (tài khoản, token, bài viết, tệp, nhật ký, thông báo): gửi yêu cầu qua địa chỉ liên hệ ở mục 1 từ chính email Google bạn đã dùng để đăng nhập. Yêu cầu được xử lý trong thời gian hợp lý, không quá 30 ngày.</li>
        <li><strong>Hỏi, xem hoặc yêu cầu bản sao</strong> dữ liệu ứng dụng đang giữ về bạn: cũng qua địa chỉ liên hệ đó.</li>
      </ul>
    </section>

    <section aria-labelledby="bao-mat">
      <h2 id="bao-mat">8. Bảo mật</h2>
      <p>
        Kết nối tới ứng dụng đi qua HTTPS; token Facebook được mã hóa và có thể thay khóa mã hóa định kỳ; dữ liệu của mỗi tài khoản được tách riêng và kiểm tra quyền ở máy chủ
        cho mọi yêu cầu; có giới hạn tốc độ cho các thao tác đọc từ Facebook. Không hệ thống nào an toàn tuyệt đối: nếu bạn nghi ngờ tài khoản bị lộ, hãy gỡ kết nối Facebook và liên hệ chúng tôi.
      </p>
    </section>

    <section aria-labelledby="thay-doi">
      <h2 id="thay-doi">9. Thay đổi chính sách</h2>
      <p>Khi ứng dụng thay đổi cách dùng dữ liệu, trang này được cập nhật cùng ngày cập nhật ở đầu trang.</p>
    </section>
  </LegalPage>;
}
