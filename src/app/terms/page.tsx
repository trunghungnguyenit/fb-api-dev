import Link from "next/link";
import LegalPage, { ContactLine } from "@/app/legal-page";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Điều khoản sử dụng · Page Publisher",
  description: "Điều kiện sử dụng Page Publisher: ai được dùng, trách nhiệm với nội dung đăng, các giới hạn và phụ thuộc vào Facebook.",
  path: "/terms",
  index: true
});

export default function TermsPage() {
  return <LegalPage
    title="Điều khoản sử dụng"
    intro="Khi đăng nhập và dùng Page Publisher, bạn đồng ý với các điều khoản dưới đây. Nếu bạn không đồng ý, vui lòng không sử dụng ứng dụng."
  >
    <section aria-labelledby="dich-vu">
      <h2 id="dich-vu">1. Dịch vụ</h2>
      <p>
        Page Publisher là công cụ giúp quản trị viên Fanpage Facebook soạn, lên lịch, đăng bài (chữ, liên kết, ảnh, video, Reels), quản lý bình luận và xem số liệu.
        Ứng dụng hoạt động thông qua Facebook Graph API và các quyền bạn cấp; nó không phải sản phẩm của Meta hay của Google.
      </p>
    </section>

    <section aria-labelledby="tai-khoan">
      <h2 id="tai-khoan">2. Tài khoản và quyền sử dụng</h2>
      <ul>
        <li>Bạn đăng nhập bằng tài khoản Google của mình và chịu trách nhiệm giữ an toàn cho tài khoản đó.</li>
        <li>Bạn chỉ được kết nối những Fanpage mà bạn là quản trị viên hoặc đã được chủ Fanpage cho phép thao tác.</li>
        <li>Bạn phải tuân thủ điều khoản của Meta (Facebook) và của Google khi dùng các dịch vụ đó qua ứng dụng.</li>
      </ul>
    </section>

    <section aria-labelledby="noi-dung">
      <h2 id="noi-dung">3. Nội dung bạn đăng</h2>
      <ul>
        <li>Bạn chịu trách nhiệm về mọi nội dung, hình ảnh, video, liên kết bạn đăng và về quyền sử dụng chúng.</li>
        <li>Không dùng ứng dụng để đăng nội dung vi phạm pháp luật, lừa đảo, thư rác, xâm phạm quyền của người khác hoặc vi phạm tiêu chuẩn cộng đồng của Facebook.</li>
        <li>Ứng dụng không kiểm duyệt nội dung của bạn trước khi đăng; Facebook có thể gỡ bài hoặc hạn chế Fanpage theo quy định của họ.</li>
      </ul>
    </section>

    <section aria-labelledby="su-dung-hop-le">
      <h2 id="su-dung-hop-le">4. Sử dụng hợp lệ</h2>
      <ul>
        <li>Không tìm cách truy cập dữ liệu của tài khoản khác, vượt qua giới hạn kỹ thuật hay bảo mật, hoặc gây quá tải cho ứng dụng và cho Facebook (ví dụ thu thập dữ liệu hàng loạt bằng công cụ tự động).</li>
        <li>Ứng dụng có giới hạn tốc độ và số lượng cho một số thao tác để bảo vệ hệ thống và hạn mức của Facebook.</li>
      </ul>
    </section>

    <section aria-labelledby="gioi-han">
      <h2 id="gioi-han">5. Giới hạn của dịch vụ</h2>
      <ul>
        <li>Dịch vụ được cung cấp “như hiện có”. Việc đăng bài, đọc số liệu và quản lý bình luận phụ thuộc vào Facebook: Facebook có thể thay đổi, hạn chế hoặc ngừng các chức năng, và bài có thể đăng chậm hoặc thất bại.</li>
        <li>Số liệu Insights, nhân khẩu học và các thông tin đọc từ Facebook do Facebook cung cấp và có thể trễ, thiếu hoặc không còn được hỗ trợ.</li>
        <li>Trong phạm vi pháp luật cho phép, vận hành ứng dụng không chịu trách nhiệm về thiệt hại gián tiếp, mất cơ hội hay mất dữ liệu phát sinh từ việc dùng hoặc không dùng được dịch vụ.</li>
      </ul>
    </section>

    <section aria-labelledby="cham-dut">
      <h2 id="cham-dut">6. Chấm dứt</h2>
      <p>
        Bạn có thể ngừng dùng ứng dụng bất cứ lúc nào và yêu cầu xóa dữ liệu theo mục “Quyền của bạn và cách xóa dữ liệu” trong <Link href="/privacy#xoa-du-lieu">Chính sách quyền riêng tư</Link>.
        Chúng tôi có thể tạm ngừng hoặc chấm dứt quyền dùng của tài khoản vi phạm điều khoản này.
      </p>
    </section>

    <section aria-labelledby="thay-doi">
      <h2 id="thay-doi">7. Thay đổi và luật áp dụng</h2>
      <p>
        Điều khoản có thể thay đổi; ngày cập nhật ở đầu trang cho biết bản hiện hành, và việc tiếp tục dùng ứng dụng sau khi thay đổi nghĩa là bạn chấp nhận bản mới.
        Điều khoản này được điều chỉnh bởi pháp luật Việt Nam.
      </p>
    </section>

    <section aria-labelledby="lien-he">
      <h2 id="lien-he">8. Liên hệ</h2>
      <p><ContactLine /></p>
    </section>
  </LegalPage>;
}
