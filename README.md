# Page Publisher — đăng bài lên Facebook Page

Ứng dụng Next.js 15 + Supabase + Meta Graph API để soạn, lên lịch và đăng bài lên các **Facebook Page** bạn quản trị. Nhiều người dùng, mỗi tài khoản Google có dữ liệu riêng.

## Tính năng

- Đăng nhập bằng **Google** (Supabase Auth). Không dùng email/mật khẩu.
- Kết nối Facebook, lưu token đã mã hóa (AES-256-GCM), tự đồng bộ danh sách Fanpage.
- Soạn bài, lưu nháp, lên lịch, **Đăng ngay**, **Thử lại**, **Hủy**, **Nhân bản**.
- **Ảnh, video và Reels**: bài có một hoặc nhiều ảnh (JPG/PNG/GIF), hoặc đúng một video (MP4/MOV) hoặc Reels (video dọc 9:16, 3–90 giây). Tệp được trình duyệt tải thẳng lên Supabase Storage (bucket riêng tư), server kiểm tra loại và dung lượng thật ở ba lớp (trước khi tải, sau khi tải và ngay trước khi đăng). Mặc định mỗi tệp tối đa 50 MB, ảnh 10 MB; chỉnh bằng các biến `MEDIA_*`. Video/Reels đăng ở nền và hiện "Facebook đang xử lý" cho đến khi lên Fanpage. Tệp được dọn sau 7 ngày kể từ khi đăng. Nhập hàng loạt cũng tạo được bài ảnh/video kèm tệp (xem mục bên dưới).
- **Bài từ Facebook** (`/posts?source=facebook`): bản sao các bài trên Fanpage như Facebook đang hiển thị trong 7 ngày gần nhất (cả bài đăng trực tiếp trên Facebook lẫn bài do ứng dụng đăng, có nhãn "Đăng từ ứng dụng"). Mỗi Fanpage được đọc lại mỗi `FEED_SYNC_INTERVAL_MIN` phút (mặc định 5), ngay khi bạn mở danh sách bài mà dữ liệu cũ hơn 1 phút, hoặc bằng nút "Tải lại từ Facebook" (mỗi Fanpage tối đa một lần mỗi phút). Trang đang mở tự làm mới mỗi phút. Bài đăng trực tiếp trên Facebook chỉ để xem; ứng dụng không sửa, xóa hay đăng lại chúng.
- **Bài bị xóa trên Facebook**: một bài chỉ được coi là đã xóa sau hai lần đọc liên tiếp không thấy nó (nút "Tải lại" tự đọc hai lần cách nhau 2 giây, nên một lần bấm là đủ). Với bài do ứng dụng đăng, trạng thái được chuyển sang bảng bài của ứng dụng: danh sách và trang chi tiết hiện nhãn "Đã xóa trên Facebook", kèm một thông báo trong chuông; nếu bài hiện lại thì nhãn tự gỡ. Bài ứng dụng đăng cũ hơn 7 ngày (ngoài cửa sổ đọc) được hỏi trực tiếp Facebook, mỗi ngày một lần.
- **Bình luận**: trên trang chi tiết bài, đọc bình luận từ Facebook, trả lời, **thích / bỏ thích với tư cách Fanpage**, **sửa bình luận do chính Fanpage viết** (nút "Sửa" chỉ hiện ở bình luận có nhãn "Fanpage"; server kiểm tra lại tác giả với Facebook trước khi sửa), ẩn/hiện, xóa. Bình luận **không được lưu** trong ứng dụng; chỉ có nhật ký thao tác (không kèm chữ). Cần hai quyền `pages_read_user_content` và `pages_manage_engagement`.
- **Insights** (`/insights`): chọn Fanpage và khoảng ngày (7, 28, 90 ngày hoặc tùy chọn tối đa 93 ngày, Facebook giữ số liệu 2 năm), xem 6 chỉ số của Fanpage từ Facebook: lượt xem nội dung (`page_media_view`), người xem duy nhất (`page_total_media_view_unique`), người theo dõi (`page_follows`), theo dõi mới (`page_daily_follows`), hủy theo dõi (`page_daily_unfollows_unique`), tương tác với bài (`page_post_engagements`), mỗi chỉ số kèm biểu đồ theo ngày và so với kỳ trước cùng độ dài. **Không lưu số liệu**: gọi Facebook khi mở trang, giữ trong bộ nhớ khoảng 30 phút. Meta hay ngừng hoặc đổi tên chỉ số, nên mỗi chỉ số được đọc riêng: chỉ số Facebook từ chối chỉ hiện lý do ở đúng thẻ của nó, các thẻ khác vẫn hiển thị. Cần quyền `read_insights` (người dùng đã kết nối từ trước phải bấm “Kết nối Facebook” để cấp lại) và vai trò có tác vụ “Analyze” trên Fanpage; thiếu một trong hai thì trang nói rõ và chỉ đường xử lý. Mọi lỗi đều là lời của ứng dụng kèm mã tham chiếu, không bao giờ là chữ thô của Facebook.
- **Insights từng bài**: ở trang chi tiết bài (bài do ứng dụng đăng và bài từ Facebook) có khối "Insights của bài" đọc từ Facebook khi mở trang, không lưu (giữ trong bộ nhớ ~30 phút): lượt xem nội dung (`post_media_view`), người xem duy nhất (`post_total_media_view_unique`), lượt nhấp (`post_clicks`). Cảm xúc theo loại có mục riêng ngay phía trên (đọc trực tiếp từ bài), nên không còn là một thẻ Insights. Mỗi chỉ số đọc riêng nên chỉ số Facebook từ chối chỉ báo ở đúng thẻ của nó. Cần cùng điều kiện với trang Insights (quyền `read_insights`, tác vụ "Analyze"). **Bài video và Reels** có bộ số liệu riêng: lượt xem video (`post_video_views`), tổng thời gian xem (`post_video_view_time`), thời gian xem trung bình (`post_video_avg_time_watched`, hiện dạng "3 phút 25 giây"), cùng lượt xem nội dung và người xem duy nhất; Reels thêm lượt phát (`blue_reels_play_count`). Bài đăng từ ứng dụng được biết bằng mã video nên ứng dụng hỏi Facebook mã bài chứa video đó (một lần, có nhớ) và đọc số liệu theo mã bài. Bài từ Facebook được đọc như video vì Facebook không phân biệt Reels với video trong danh sách bài. Số liệu video có thể trễ hơn hoặc chưa có, nên từng thẻ báo riêng khi Facebook không trả.
- **Người theo dõi là ai** (cuối trang `/insights`, theo Fanpage đang chọn): Top 10 quốc gia, Top 10 thành phố và (nếu Facebook còn trả) giới tính + độ tuổi, dạng thanh ngang kèm số người và %, phần còn lại gộp thành "Khác". Đọc trực tiếp (`page_follows_country`, `page_follows_city`, `page_follows_gender_age`), mỗi khối một lời gọi riêng nên khối nào Facebook từ chối chỉ báo ở khối đó; Fanpage có ít người theo dõi (thường dưới 100) có thể chưa có số liệu. Không lưu, nhớ ~30 phút. Cùng điều kiện với trang Insights (`read_insights`, tác vụ "Analyze").
- **Bài của khách** (tab "Bài của khách" ở trang Bài viết, `/posts?source=visitor`): bài người khác viết trên tường Fanpage (`/{page}/visitor_posts`), chọn từng Fanpage (mặc định Fanpage đầu tiên), phân trang bằng "Xem tiếp". Đọc trực tiếp từ Facebook mỗi lần mở tab và **không lưu**. Mỗi bài có liên kết "Mở trên Facebook" và khung bình luận đầy đủ như bài của Fanpage (xem, trả lời, thích, sửa bình luận của Fanpage, ẩn, xóa). Xóa hoặc ẩn chính bài của khách thì làm trên Facebook. Cần `pages_read_user_content` (và `pages_manage_engagement` để thao tác bình luận).
- **Đánh giá** (tab "Đánh giá", `/posts?source=ratings`): đánh giá của khách về Fanpage (`/{page}/ratings`) kèm tổng số và điểm trung bình nếu Facebook trả; hiện số sao hoặc "Khuyên dùng / Không khuyên dùng". Đọc trực tiếp, không lưu. Fanpage không có mục Đánh giá sẽ được báo rõ chứ không phải lỗi chung. Facebook thay đổi mục này nhiều lần nên trường hợp không đọc được được xử lý riêng.
- **Đánh giá mới (không cần webhook)**: mỗi lần đồng bộ bài ứng dụng hỏi thêm số đánh giá của Fanpage (một lời gọi nhẹ, lỗi thì bỏ qua, không làm hỏng đồng bộ) và so với số đã lưu; tăng thì báo "N đánh giá mới" trong chuông, cộng dồn khi chưa đọc như bình luận mới. Lần đọc đầu tiên chỉ lập mốc. Mở tab Đánh giá sẽ đánh dấu đã xem và đọc thông báo. Chỉ lưu một con số `ratings_count` trên Fanpage, không lưu nội dung đánh giá. Cần chạy lại `supabase/schema.sql` (thêm cột đó, cho phép loại thông báo `NEW_RATINGS` và loại bài `visitor` trong nhật ký bình luận).
- **Cảm xúc theo loại** (trang chi tiết bài, cả bài ứng dụng và bài từ Facebook, kể cả video/Reels): số Thích / Yêu thích / Thương thương / Haha / Wow / Buồn / Phẫn nộ, đọc trực tiếp từ bài trên Facebook mỗi lần mở trang (một yêu cầu cho cả bảy loại; nếu Facebook từ chối thì hỏi từng loại, loại nào bị từ chối sẽ để trống kèm ghi chú, các loại khác vẫn hiện). Không lưu gì. Cần `pages_read_engagement`.
- **Bài nổi bật** (cuối trang `/insights`): 10 bài có tương tác cao nhất của Fanpage đang chọn trong 7 ngày gần nhất, xếp theo tổng tương tác (cảm xúc + bình luận + chia sẻ) hoặc riêng từng cột. Lấy từ bản sao đã đồng bộ (không gọi thêm Facebook, số mới trong vòng vài phút), gồm cả bài do ứng dụng đăng và bài đăng trực tiếp; bài đã bị xóa trên Facebook không được tính.
- **Thông báo trong ứng dụng** (chuông góc dưới bên phải, `/notifications`): đăng bài thất bại, kết quả chưa rõ, Fanpage mất quyền, kết nối cần xác thực lại, quyền truy cập dữ liệu sắp hết hạn, quyền bị thu hồi, **có bình luận mới**.
- **Bình luận mới (không cần webhook)**: mỗi lần đồng bộ bài (mặc định 5 phút/Fanpage) ứng dụng so số bình luận vừa đọc với số đã lưu; bài nào tăng thì báo "N bình luận mới" trong chuông. Mỗi bài một thông báo, **cộng dồn khi chưa đọc**; đã đọc rồi thì bình luận sau đó tạo thông báo mới. Chỉ lưu số đếm, không lưu chữ bình luận. Bài thấy lần đầu (kể cả lúc mới kết nối Fanpage) chỉ lập mốc, không báo; số bình luận giảm (xóa bình luận) không báo. Bình luận bạn tự trả lời trên bài từ ứng dụng không bị báo là "mới". Ở tab "Từ Facebook" cột Tương tác có chấm "N mới" cho tới khi bạn mở bài. Chỉ phủ bài trong 7 ngày gần nhất (cửa sổ đồng bộ), tối đa trễ vài phút. Cần chạy lại `supabase/schema.sql` (thêm cột `comments_seen_count` và cho phép loại thông báo `NEW_COMMENTS`; thiếu bước này thông báo sẽ bị cơ sở dữ liệu từ chối). Thích / bỏ thích / sửa bình luận cũng cần chạy lại file này: nó cho phép thêm các thao tác `like`, `unlike`, `edit` trong nhật ký `comment_actions` (thiếu bước này thao tác vẫn thành công trên Facebook nhưng dòng nhật ký bị cơ sở dữ liệu từ chối và chỉ ghi vào log máy chủ).
- **Kiểm tra sức khỏe token** mỗi ~20 giờ bằng `debug_token`: cảnh báo trước 7/3/1 ngày khi quyền truy cập dữ liệu sắp hết hạn, phát hiện quyền bị thu hồi, hiện cảnh báo ở `/pages`.
- **Tôn trọng giới hạn tốc độ của Meta**: đọc `X-App-Usage` / `X-Page-Usage`, làm chậm khi gần chạm và tạm dừng khi chạm; bài bị hoãn vì rate limit **không** bị đánh dấu thất bại. Đăng song song (mặc định 8 bài, không bao giờ hai bài cùng một Fanpage cùng lúc) để chịu được các đợt đăng hàng loạt.
- Quản lý bài (`/posts`): lọc theo trạng thái / Fanpage, tìm theo nội dung, phân trang, chọn nhiều để hủy hoặc xóa hàng loạt (chỉ bài chưa đăng).
- Trang chi tiết bài (`/posts/[id]`): nội dung đầy đủ, lịch sử từng lần đăng, nhật ký sửa/xóa, và số liệu sống từ Facebook (thích, bình luận, chia sẻ). Khi mở trang, ứng dụng tự phát hiện bài đã bị xóa trên Facebook và đánh dấu lại.
- **Sửa bài**: bài chưa đăng sửa được mọi thông tin; bài **đã đăng** chỉ sửa được nội dung chữ (Facebook hiển thị nhãn "Đã chỉnh sửa"). Muốn đổi liên kết, Fanpage hay giờ thì nhân bản rồi đăng lại.
- **Đăng lại** (`/posts/[id]/repost`), cho bài đã xóa trên Facebook, còn trên Facebook, lỗi hoặc đã hủy. Một form, ba cách (chỉ hiện cách hợp lệ cho trạng thái của bài):
  - *Đăng lại trên cùng bài*: đưa chính bài này vào hàng đợi lần nữa (bài đã xóa trên Facebook, lỗi, đã hủy). Mã bài Facebook cũ vẫn còn trong lịch sử đăng.
  - *Tạo bản sao mới*: tạo bài mới, bài gốc giữ nguyên; có thể chọn nhiều Fanpage cùng lúc. Nếu bài gốc còn trên Facebook, phải xác nhận vì sẽ trùng nội dung.
  - *Thay thế*: đăng bản mới trước, thành công rồi mới xóa bài cũ trên Facebook. Nếu Facebook từ chối vì trùng, ứng dụng hỏi có xóa bài cũ trước rồi đăng lại không.
  - Mỗi bài gốc chỉ được đăng lại tối đa 3 lần/24 giờ cho mỗi Fanpage. Mọi bản sao đều trỏ về bài gốc ban đầu và hiện trong mục "Đăng lại" của trang chi tiết.
  - Trong danh sách có thể chọn nhiều bài rồi *Đăng lại (tạo bản nháp)* hoặc *Đăng lại ngay*; bài còn trên Facebook bị bỏ qua.
- **Nhập nhiều bài một lần** (`/posts/import`): tải lên CSV, Excel (.xlsx), JSON hoặc dán thẳng từ Excel/Google Sheets (tối đa 100 dòng và 1 MB mỗi lần). Nhận cả bài chữ, liên kết, **ảnh, nhiều ảnh, video và Reels**.
  - Cột nhận: *Nội dung*, *Liên kết*, *Thời gian đăng* (dd/mm/yyyy hh:mm, giờ Việt Nam), *Fanpage* (tên hoặc ID, trống thì dùng Fanpage mặc định chọn trên form), *Ghi chú* (chỉ để quản lý, không đăng lên Facebook), *Loại bài* (tùy chọn), *Tệp đính kèm* (tên tệp; nhiều tệp cách nhau bằng `;`, `|` hoặc xuống dòng; JSON có thể ghi mảng). Có nút tải tệp mẫu CSV, Excel, JSON; dòng mẫu có tệp dùng tên giả, hãy đổi tên cho đúng tệp của bạn.
  - Loại bài suy ra từ tệp: 1 ảnh, nhiều ảnh, hoặc 1 video. Chỉ ghi `reel` ở *Loại bài* thì video mới thành Reels. Bài ảnh/video không cần *Nội dung*. Không ghi liên kết cùng tệp; một bài không trộn ảnh với video; một tệp không thể vừa là video vừa là Reels trong cùng lần nhập.
  - Có tệp thì ở bước nhập phải chọn đúng các tệp từ máy tính (tên tệp phải khớp với cột, kể cả đuôi `.jpg`, `.mp4`). Khi bấm **Nhập**, trình duyệt tải lên **mỗi tệp khác nhau một lần** vào bucket riêng tư (theo luồng liên kết ký sẵn như trên); máy chủ kiểm tra lại loại, dung lượng thật, giới hạn từng bài và của cả lần nhập. Một tệp dùng cho nhiều dòng chỉ tải một lần, các bài còn lại được sao chép tệp.
  - Có giờ thì lên lịch, để trống thì lưu **nháp**; giờ đã qua bị báo lỗi dòng đó. Có thể bật *Dãn lịch tự động* để các dòng không có giờ được xếp lịch cách nhau 1 giờ, 3 giờ, 1 ngày… Bên trong, mọi bài được tạo làm nháp trước, gắn đủ tệp rồi mới lên lịch; lỗi giữa chừng thì cả lô được thu hồi cùng tệp.
  - Luôn **xem trước** rồi mới nhập: dòng lỗi và dòng trùng (trong tệp hoặc đã có bài giống hệt trên cùng Fanpage, cùng tệp) được tô màu kèm lý do, chỉ các dòng hợp lệ được nhập, có thể tải báo cáo dòng lỗi. Việc nhập không đăng ngay bài nào.
  - Mỗi lần nhập là một lô: xem ở `/posts/imports`, mở các bài của lô, và **hoàn tác** (xóa các bài nháp/đã lên lịch chưa đăng của lô; bài đã đăng được giữ). Sau khi hoàn tác, bản sao tệp dùng chung còn lại đến khi job dọn tệp chạy (sau 24 giờ).
  - Trình duyệt đọc tệp dữ liệu và chỉ gửi các dòng dạng văn bản lên máy chủ; tệp ảnh/video tải thẳng lên Storage. Máy chủ kiểm tra lại từng dòng và từng tệp.
- **Gỡ Fanpage** (`/pages`, nút "Gỡ" từng Fanpage): ngắt kết nối một Fanpage khỏi ứng dụng nhưng **giữ lịch sử bài**.
  - Hộp thoại cho biết trước tác động: bao nhiêu bài chưa đăng sẽ bị hủy (nháp, đã lên lịch, lỗi), bao nhiêu bài đã đăng được giữ lịch sử.
  - Token đã lưu của Fanpage bị xóa. Các bài chưa đăng chuyển sang "Đã hủy" kèm lý do "Đã hủy do gỡ Fanpage" (muốn đăng lại dùng nút "Đăng lại"); bài chưa rõ kết quả được giữ nguyên vì có thể đã lên Facebook.
  - Fanpage đã gỡ **không tự quay lại** khi bấm "Kết nối Facebook", "Kiểm tra lại quyền" hay khi job kiểm tra chạy hằng ngày. Muốn dùng lại, mở mục "Fanpage đã gỡ" và bấm "Kết nối lại" (cần Facebook vẫn cho tài khoản của bạn quản lý Fanpage đó). Fanpage đã gỡ và không còn bài nào có nút "Xóa hẳn".
  - Sau khi gỡ, ứng dụng chưa xem số liệu, sửa hoặc xóa trên Facebook được các bài đã đăng của Fanpage đó cho đến khi kết nối lại.
  - Facebook không có API thu hồi quyền riêng từng Fanpage: ứng dụng chỉ xóa dữ liệu của mình. Muốn thu hồi hoàn toàn, vào Facebook → Cài đặt → Ứng dụng và trang web.
- **Xóa bài**: bài chưa đăng xóa hẳn khỏi ứng dụng; bài đã đăng được xóa trên Facebook (không hoàn tác) và ứng dụng giữ lại bản ghi để đối soát. Nếu Facebook từ chối xóa qua API, hãy xóa tay trên Facebook rồi bấm "Đánh dấu đã xóa".
- Hàng đợi có khóa nguyên tử, lịch sử từng lần đăng (`publish_attempts`).
- Tự tắt Fanpage mất quyền; bài đã lên lịch của Fanpage đó **vẫn nằm trong hàng đợi** và tự đăng khi bạn kết nối lại Facebook.
- Thông báo lỗi tiếng Việt kèm mã tham chiếu; chi tiết kỹ thuật chỉ ghi vào log máy chủ.
- **Trang công khai và SEO:** chỉ `/login`, `/privacy` (Chính sách quyền riêng tư) và `/terms` (Điều khoản) được công cụ tìm kiếm lập chỉ mục; mọi trang khác cần đăng nhập và đánh dấu `noindex`. Có `robots.txt`, `sitemap.xml`, thẻ Open Graph/Twitter với ảnh chia sẻ, dữ liệu có cấu trúc cho trang đăng nhập. Hai trang pháp lý lấy tên đơn vị và email liên hệ từ `OPERATOR_NAME` và `CONTACT_EMAIL` trong `.env` (xem `.env.example`); Meta cần địa chỉ `/privacy` làm Privacy Policy URL và hướng dẫn xóa dữ liệu (`/privacy#xoa-du-lieu`). Chi tiết và điểm Lighthouse: [docs/seo-and-legal-pages.md](docs/seo-and-legal-pages.md).
- **Dùng trên điện thoại:** menu ☰ trượt từ phải (chuông thông báo nằm trên thanh trên), danh sách dạng thẻ gọn với bộ lọc thu gọn và nút "Xem thêm", màn hình chờ (skeleton + thanh tiến trình) khi trang đang tải, form Soạn/Sửa có nhóm gập được, xem trước bài và **tự lưu chữ đang gõ trong trình duyệt** (không gửi đi đâu, giữ 14 ngày; hỏi có lấy lại khi mở lại). Cài được lên màn hình chính (trình duyệt: "Thêm vào màn hình chính"), mở toàn màn hình; chưa có chế độ ngoại tuyến. Logo (chữ HT) lấy từ `public/logo-mark.png`; muốn đổi logo hoặc icon, thay tệp đó rồi chạy `node scripts/make-icons.mjs` (tạo lại `public/icons/*`: icon 192/512, maskable, iOS 180, favicon, logo thanh trên).

## Giới hạn cần biết

- Chỉ đăng lên **Page**, không đăng lên trang cá nhân. Hỗ trợ bài chữ, liên kết, ảnh, video và Reels.
- Ứng dụng Meta đang ở chế độ **Development** với **Standard Access**: chỉ người có vai trò trong app dùng được. Để phục vụ khách ngoài cần App Review (Advanced Access), có thể cả Business Verification, rồi chuyển **Live**: xem [plans/A1/launch-readiness.md](plans/A1/launch-readiness.md).
- Reels: Facebook cho đăng tối đa 30 Reels/24 giờ/Fanpage qua API; server không kiểm tra tỉ lệ khung hình hay độ dài video, Facebook sẽ từ chối sau khi xử lý nếu không phù hợp.
- Bình luận và đồng bộ bài **không real-time** (cần webhook, chưa làm: xem [plans/A1/webhook-design.md](plans/A1/webhook-design.md)).
- **Sửa/xóa bài đã đăng phụ thuộc Meta:** tài liệu của Meta mâu thuẫn về việc xóa qua API. Hãy thử trên một Fanpage thử trước khi dùng cho Fanpage thật. Chỉ sửa/xóa được bài do ứng dụng này đăng, và bài ở trạng thái "chưa rõ kết quả" (không có mã bài trên Facebook) thì phải xử lý tay.
- Khi mạng hoặc Facebook lỗi giữa chừng, kết quả có thể **chưa rõ** (`AMBIGUOUS`): bài có thể đã lên. Hệ thống không tự đăng lại; hãy kiểm tra Fanpage rồi mới bấm "Thử lại".
- Nhập bài có tệp: mỗi người dùng chỉ có tối đa 60 tệp tải lên chưa thuộc bài nào tại một thời điểm, nên chia lô lớn thành nhiều lần nhập. Hoàn tác một lô để lại bản sao tệp dùng chung đến khi job dọn tệp chạy.

## 1. Yêu cầu

- Node.js 20+ và npm
- Một project Supabase
- Một ứng dụng Meta (Facebook Login)
- Một OAuth Client của Google Cloud

## 2. Cài đặt

```bash
npm install
cp .env.example .env
```

Điền mọi biến trong `.env`. Sinh các khóa ngẫu nhiên:

```bash
openssl rand -hex 32   # dùng cho APP_ENCRYPTION_KEY (đúng 64 ký tự hex)
openssl rand -hex 32   # dùng cho CRON_SECRET
```

Khóa mã hóa token có thể xoay mà không mất dữ liệu: xem mục 11.

Ứng dụng từ chối khởi động nếu còn giá trị mẫu (`replace-…`), nếu `META_OAUTH_REDIRECT_URI` không cùng origin với `NEXT_PUBLIC_APP_URL`, hoặc không kết thúc bằng `/api/auth/facebook/callback`.

> `SUPABASE_SERVICE_ROLE_KEY` phải là khóa **service_role** (hoặc secret key `sb_secret_…`), **không phải** khóa `anon`. Khóa anon sẽ bị RLS chặn mọi thao tác ghi.

## 3. Cơ sở dữ liệu

Mở Supabase → SQL Editor và chạy toàn bộ [supabase/schema.sql](supabase/schema.sql).

File chạy lại được nhiều lần: chạy lại mỗi khi cập nhật code làm thay đổi schema (ví dụ các cột mới của `posts` và `facebook_pages`, các bảng `post_events`, `import_batches`, `notifications`, `post_media`, `page_feed_posts`, `comment_actions` và các hàm SQL `find_duplicate_posts`, `import_batch_stats`, `page_post_counts`). Nếu chưa chạy, ứng dụng hiện màn hình "Cần cập nhật cơ sở dữ liệu" thay vì báo lỗi khó hiểu. Nó cũng tạo ràng buộc để dữ liệu của mỗi người dùng không thể gắn nhầm sang người khác, và chặn đọc token / ghi trạng thái bài trực tiếp bằng khóa `anon`.

## 4. Đăng nhập Google

1. **Google Cloud Console** → APIs & Services → Credentials → tạo *OAuth client ID* loại **Web application**. Thêm vào *Authorized redirect URIs*: `https://<project-ref>.supabase.co/auth/v1/callback`.
2. **Supabase** → Authentication → Providers → **Google**: bật và dán Client ID, Client Secret.
3. **Supabase** → Authentication → URL Configuration → *Redirect URLs*: thêm `http://localhost:3000/auth/callback` (và URL production, ví dụ `https://your-domain/auth/callback`).

Mọi tài khoản Google đều có thể đăng nhập; mỗi tài khoản là một người dùng riêng.

## 5. Ứng dụng Meta

1. Tạo app tại https://developers.facebook.com/apps/ và thêm sản phẩm Facebook Login.
2. **Cài đặt > Cơ bản > Miền ứng dụng (App Domains)**: điền tên miền của `NEXT_PUBLIC_APP_URL`, không có `http://` và không có cổng. Chạy trên máy: `localhost`. Khi triển khai: tên miền thật (ví dụ `app.ten-mien.com`).
3. **Facebook Login > Cài đặt**: bật *Client OAuth Login* và *Web OAuth Login*, và đặt *Valid OAuth Redirect URIs* **đúng từng ký tự** bằng `META_OAUTH_REDIRECT_URI` (ví dụ `http://localhost:3000/api/auth/facebook/callback`).
4. Quyền được xin khi đăng nhập Facebook: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, `read_insights`. Chỉ hai quyền đầu là **bắt buộc**: nếu người dùng bỏ chọn một trong hai, kết nối bị từ chối với thông báo rõ ràng. Các quyền còn lại là tùy chọn; thiếu thì chỉ tính năng tương ứng (số liệu bài, bình luận, Insights) bị khóa và `/pages` nhắc cấp thêm. Người dùng cũ cần bấm "Kết nối Facebook" lại để cấp quyền mới.
5. Tài khoản Facebook phải có quyền tạo nội dung trên Page (task `CREATE_CONTENT`).

Nếu Facebook báo **"Không thể tải URL: Miền của URL này không được đưa vào miền của ứng dụng"** khi bấm "Kết nối Facebook": miền của `META_OAUTH_REDIRECT_URI` chưa nằm trong *Miền ứng dụng* (bước 2) hoặc địa chỉ chưa có trong *Valid OAuth Redirect URIs* (bước 3). Lưu cài đặt trên Meta rồi thử lại, không cần sửa code. Địa chỉ trong thanh trình duyệt cũng phải trùng `NEXT_PUBLIC_APP_URL` (đừng mở bằng `127.0.0.1` khi cấu hình là `localhost`).

## 6. Lưu trữ ảnh và video

Tệp ảnh/video nằm trong bucket Supabase Storage **riêng tư** `post-media` (không bao giờ công khai; Facebook và trình duyệt chỉ dùng liên kết tạm). Tạo hoặc cập nhật bucket từ cấu hình:

```bash
npm run media:sync-bucket              # tạo bucket nếu chưa có, giữ riêng tư, đặt giới hạn dung lượng và loại tệp
npm run media:sync-bucket -- --dry-run # chỉ xem sẽ đổi gì
```

Giới hạn nằm ở một chỗ duy nhất, các biến `MEDIA_*` trong `.env` (xem `.env.example`). Đổi giới hạn thì sửa biến rồi chạy lại lệnh trên. Giới hạn bucket không thể vượt giới hạn upload toàn cục của gói Supabase (50 MB ở gói Free).

Riêng *Nhập nhiều bài có tệp* có hai biến: `MEDIA_IMPORT_MAX_FILES` (mặc định 50, tối đa 60: số tệp khác nhau một lần nhập được tải lên) và `MEDIA_IMPORT_MAX_TOTAL_MB` (mặc định 500: tổng dung lượng). Hai biến này không thuộc bucket nên đổi xong chỉ cần khởi động lại, không cần chạy `media:sync-bucket`. Giới hạn 100 dòng và 1 MB mỗi tệp dữ liệu không đổi.

Các lệnh trong `scripts/` (`media:sync-bucket`, `reencrypt`) cần **Node 22.18 trở lên** vì chạy thẳng file TypeScript.

## 7. Chạy

```bash
npm run dev      # phát triển
npm run build && npm start
npm test         # kiểm thử
npm run typecheck && npm run lint
```

Mở http://localhost:3000 → **Đăng nhập bằng Google** → **Fanpage** → **Kết nối Facebook** → **Soạn bài**.

## 8. Lập lịch (chọn một cách)

Bài đã lên lịch chỉ được đăng khi có thứ gì đó gọi hàng đợi, và các việc nền khác (đọc bài từ Facebook, theo dõi video đang xử lý, dọn tệp) cũng cần được gọi. Chọn theo nơi bạn triển khai:

**A. Server chạy liên tục** (VPS, Docker, `next start`): đặt trong `.env`

```
INTERNAL_SCHEDULER=true
```

Một bộ lập lịch trong tiến trình sẽ đăng bài đến hạn mỗi 30 giây (lượt nào hết thời gian mà vẫn còn bài thì chạy tiếp ngay), theo dõi video/Reels đang xử lý trong mỗi lượt đó, đọc bài từ Facebook mỗi phút (mỗi Fanpage chỉ mỗi `FEED_SYNC_INTERVAL_MIN` phút một lần, mặc định 5) và hỏi trực tiếp Facebook về vài bài cũ hơn 7 ngày (mỗi bài một lần mỗi ngày), kiểm tra quyền Fanpage và token mỗi giờ (mỗi kết nối chỉ ~20 giờ một lần) và dọn tệp mỗi giờ. Khi chạy `npm run dev` bộ lập lịch này **luôn bật**, nên đừng trỏ `.env` dev vào dữ liệu production.

**B. Serverless (Vercel…)**: tiến trình không sống đủ lâu, hãy dùng bộ lập lịch bên ngoài gọi (GET hoặc POST) với header `Authorization: Bearer $CRON_SECRET`:

| Endpoint | Tần suất gợi ý | Việc làm |
|---|---|---|
| `/api/cron/publish` | mỗi phút | đăng các bài đến hạn (dừng sau ~25 giây, kết quả có `stats.hasMore`: còn bài thì gọi lại ngay) và theo dõi video/Reels đang xử lý |
| `/api/cron/sync-posts` | mỗi phút | đọc bài trên Facebook của các Fanpage đến lượt (mỗi `FEED_SYNC_INTERVAL_MIN` phút, mặc định 5), rồi kiểm tra vài bài app đăng cũ hơn 7 ngày còn trên Facebook không |
| `/api/cron/check-pages` | mỗi giờ | kiểm tra quyền và token (`debug_token`), tắt Page mất quyền, cảnh báo sắp hết hạn |
| `/api/cron/cleanup-media` | mỗi giờ | xóa tệp tải lên không dùng sau 24 giờ và tệp của bài đã đăng sau 7 ngày |

```bash
curl -X POST https://your-domain/api/cron/publish -H "Authorization: Bearer $CRON_SECRET"
```

> Cron gói Hobby của Vercel chỉ chạy tối đa **một lần mỗi ngày**, không đủ cho bài đăng theo giờ. Dùng gói Pro hoặc một dịch vụ ping bên ngoài (GitHub Actions, cron-job.org…).

## 9. Lỗi thường gặp

| Hiện tượng | Nguyên nhân |
|---|---|
| Đăng nhập xong quay lại trang đăng nhập | Chưa thêm `…/auth/callback` vào Supabase Redirect URLs |
| "Không lưu được kết nối Facebook" / lỗi RLS `42501` | `SUPABASE_SERVICE_ROLE_KEY` đang là khóa anon |
| Bài `scheduled` mãi không đăng | Chưa bật `INTERNAL_SCHEDULER=true` hoặc chưa có cron ngoài |
| Lỗi `column … does not exist` / bảng không tồn tại | Chưa chạy lại `supabase/schema.sql` |
| "Facebook không cho xóa bài này qua ứng dụng" | Meta hạn chế xóa qua API; xóa tay trên Facebook rồi bấm "Đánh dấu đã xóa" |
| "Fanpage đang bị tắt" | Mất quyền; kết nối lại Facebook, bài trong hàng đợi sẽ tự đăng |
| Màn hình "Cần cập nhật cơ sở dữ liệu" | Chưa chạy lại `supabase/schema.sql` sau khi cập nhật code; chi tiết cột còn thiếu có trong log |
| Ảnh/video tải lên báo lỗi loại hoặc dung lượng | Vượt giới hạn `MEDIA_*`, hoặc tệp không đúng định dạng thật (ví dụ HTML đổi đuôi `.jpg`) |
| Tải lên báo lỗi dù tệp nhỏ | Bucket chưa tạo: chạy `npm run media:sync-bucket` |
| Video báo "Facebook không tải được tệp video" (lỗi 389) | Đặt `META_VIDEO_UPLOAD_MODE=binary` để server tự gửi dữ liệu |
| Bài video/Reels ở "Facebook đang xử lý" lâu | Bình thường vài phút; quá 2 giờ ứng dụng báo "chưa rõ kết quả" để bạn kiểm tra Fanpage |
| "Chưa cấp quyền quản lý bình luận" | Bấm "Kết nối Facebook" và tích đủ quyền; cần quyền Moderate trên Fanpage |
| Nhập bài báo "Chưa chọn tệp …" | Tên trong cột *Tệp đính kèm* chưa khớp tệp đã chọn ở bước nhập (kiểm tra cả đuôi `.jpg`, `.mp4`) |
| Tab "Từ Facebook" trống | Fanpage chưa có bài đăng trực tiếp trong 7 ngày, hoặc lần đồng bộ đầu chưa chạy; xem cột "Bài từ Facebook" ở `/pages` (có nút "Đồng bộ bài ngay") |

Mỗi thông báo lỗi có "Mã tham chiếu": tìm mã đó trong log máy chủ để xem chi tiết kỹ thuật.

## 10. Bảo mật

- **Dữ liệu tới trình duyệt** (phân tích đầy đủ và những việc còn lại ở [docs/security-client-protection.md](docs/security-client-protection.md)): không thể giấu khỏi DevTools thứ trình duyệt phải nhận để hiển thị, nên ứng dụng không gửi thứ không cần (khóa, token, cột nội bộ, chữ lỗi thô của Facebook) và kiểm tra quyền ở server. Cookie phiên `httpOnly`; người chưa đăng nhập bị chuyển về `/login` ngay ở middleware; header bảo mật cho mọi phản hồi; CSP đang ở chế độ báo cáo (`/api/csp-report`); API đọc từ Facebook giới hạn 120 lượt/phút/người dùng. Khi triển khai, đặt `NEXT_PUBLIC_APP_URL` đúng giao thức thật (https) vì cờ `Secure` của cookie dựa vào đó.

- Không bao giờ đặt `NEXT_PUBLIC_` trước App Secret, Page token hay service-role key.
- Mọi truy vấn của người dùng đi qua `userDb(userId)` (`src/lib/db.ts`) nên luôn có `user_id`; DB có thêm khóa ngoại kép và trigger chống đổi `user_id`.
- OAuth `state` của Facebook gắn với người dùng (HMAC) và cookie HttpOnly; các thao tác ghi kiểm tra cùng nguồn (CSRF).
- Có giới hạn mỗi người dùng: tối đa 500 bài nháp/đã lên lịch, 20 bài tạo mỗi phút, 30 thao tác bình luận mỗi phút, 60 tệp tải lên chưa dùng.
- Token Facebook mã hóa AES-256-GCM với **khóa có phiên bản** (xoay được); bucket tệp riêng tư, tệp được kiểm tra lại bằng nội dung thật; bình luận của người ngoài không được lưu.
- Bảng `page_feed_posts` (bài đồng bộ từ Facebook) chỉ được ghi bởi `src/lib/feed-sync.ts`; có test quét mã nguồn để giữ điều này.
- Token chỉ gửi qua header `Authorization`, không đưa vào URL hay log.
- Dùng HTTPS ở production và đổi khóa định kỳ.

## 11. Vận hành

**Xoay khóa mã hóa token** (không mất dữ liệu): giữ `APP_ENCRYPTION_KEY` như cũ (được coi là khóa `1`), thêm khóa mới vào `APP_ENCRYPTION_KEYS` và đặt `APP_ENCRYPTION_KEY_ID` là khóa mới (xem `.env.example`), khởi động lại, rồi:

```bash
npm run reencrypt -- --report    # đếm số dòng theo từng khóa (không đổi gì)
npm run reencrypt -- --dry-run   # xem sẽ chuyển những dòng nào
npm run reencrypt                # mã hóa lại theo lô bằng khóa mới (chạy lại được, có thể dừng giữa chừng)
```

Chỉ gỡ khóa cũ khỏi `.env` khi `--report` cho thấy không còn dòng nào dùng nó.

**Theo dõi hoạt động nền:** `/api/cron/publish` trả thống kê mỗi lượt (số bài đăng được, thất bại, bị hoãn, thời gian trung bình, lý do dừng); `/api/cron/sync-posts` trả số Fanpage đến lượt, đã đọc, lỗi; `/api/cron/cleanup-media` trả số tệp đã dọn. Mỗi Fanpage có trạng thái đồng bộ bài ở `/pages`.

**Số lượng đồng thời:** `PUBLISH_CONCURRENCY` (mặc định 8) và `PUBLISH_HEAVY_CONCURRENCY` (mặc định 2, cho bài nhiều ảnh, video, Reels). Một Fanpage luôn đăng tuần tự.

**Dữ liệu cá nhân:** bình luận của người ngoài không được lưu. Khi cần xóa toàn bộ dữ liệu của một người dùng, hiện phải làm thủ công trong Supabase (chưa có callback xóa dữ liệu của Meta: xem [plans/A1/launch-readiness.md](plans/A1/launch-readiness.md)).

**Tài liệu kế hoạch:** [plans/A1/plan.md](plans/A1/plan.md) (các phase P0–P7, quyết định và những gì chưa kiểm chứng với Facebook thật), [plans/A1/launch-readiness.md](plans/A1/launch-readiness.md) (ra mắt cho khách ngoài), [plans/A1/webhook-design.md](plans/A1/webhook-design.md) (hướng phát triển webhook).
