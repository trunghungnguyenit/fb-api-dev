# Page Publisher — đăng bài lên Facebook Page

Ứng dụng Next.js 15 + Supabase + Meta Graph API để soạn, lên lịch và đăng bài lên các **Facebook Page** bạn quản trị. Nhiều người dùng, mỗi tài khoản Google có dữ liệu riêng.

## Tính năng

- Đăng nhập bằng **Google** (Supabase Auth). Không dùng email/mật khẩu.
- Kết nối Facebook, lưu token đã mã hóa (AES-256-GCM), tự đồng bộ danh sách Fanpage.
- Soạn bài, lưu nháp, lên lịch, **Đăng ngay**, **Thử lại**, **Hủy**, **Nhân bản**.
- Quản lý bài (`/posts`): lọc theo trạng thái / Fanpage, tìm theo nội dung, phân trang, chọn nhiều để hủy hoặc xóa hàng loạt (chỉ bài chưa đăng).
- Trang chi tiết bài (`/posts/[id]`): nội dung đầy đủ, lịch sử từng lần đăng, nhật ký sửa/xóa, và số liệu sống từ Facebook (thích, bình luận, chia sẻ). Khi mở trang, ứng dụng tự phát hiện bài đã bị xóa trên Facebook và đánh dấu lại.
- **Sửa bài**: bài chưa đăng sửa được mọi thông tin; bài **đã đăng** chỉ sửa được nội dung chữ (Facebook hiển thị nhãn "Đã chỉnh sửa"). Muốn đổi liên kết, Fanpage hay giờ thì nhân bản rồi đăng lại.
- **Đăng lại** (`/posts/[id]/repost`), cho bài đã xóa trên Facebook, còn trên Facebook, lỗi hoặc đã hủy. Một form, ba cách (chỉ hiện cách hợp lệ cho trạng thái của bài):
  - *Đăng lại trên cùng bài*: đưa chính bài này vào hàng đợi lần nữa (bài đã xóa trên Facebook, lỗi, đã hủy). Mã bài Facebook cũ vẫn còn trong lịch sử đăng.
  - *Tạo bản sao mới*: tạo bài mới, bài gốc giữ nguyên; có thể chọn nhiều Fanpage cùng lúc. Nếu bài gốc còn trên Facebook, phải xác nhận vì sẽ trùng nội dung.
  - *Thay thế*: đăng bản mới trước, thành công rồi mới xóa bài cũ trên Facebook. Nếu Facebook từ chối vì trùng, ứng dụng hỏi có xóa bài cũ trước rồi đăng lại không.
  - Mỗi bài gốc chỉ được đăng lại tối đa 3 lần/24 giờ cho mỗi Fanpage. Mọi bản sao đều trỏ về bài gốc ban đầu và hiện trong mục "Đăng lại" của trang chi tiết.
  - Trong danh sách có thể chọn nhiều bài rồi *Đăng lại (tạo bản nháp)* hoặc *Đăng lại ngay*; bài còn trên Facebook bị bỏ qua.
- **Xóa bài**: bài chưa đăng xóa hẳn khỏi ứng dụng; bài đã đăng được xóa trên Facebook (không hoàn tác) và ứng dụng giữ lại bản ghi để đối soát. Nếu Facebook từ chối xóa qua API, hãy xóa tay trên Facebook rồi bấm "Đánh dấu đã xóa".
- Hàng đợi có khóa nguyên tử, lịch sử từng lần đăng (`publish_attempts`).
- Tự tắt Fanpage mất quyền; bài đã lên lịch của Fanpage đó **vẫn nằm trong hàng đợi** và tự đăng khi bạn kết nối lại Facebook.
- Thông báo lỗi tiếng Việt kèm mã tham chiếu; chi tiết kỹ thuật chỉ ghi vào log máy chủ.

## Giới hạn cần biết

- Chỉ đăng lên **Page**, không đăng lên trang cá nhân. Hiện hỗ trợ bài chữ và liên kết (`POST /{page-id}/feed`), chưa có ảnh/video.
- Meta có thể yêu cầu duyệt ứng dụng (App Review) và chế độ **Live** trước khi người ngoài vai trò app dùng được `pages_manage_posts`.
- **Sửa/xóa bài đã đăng phụ thuộc Meta:** tài liệu của Meta mâu thuẫn về việc xóa qua API. Hãy thử trên một Fanpage thử trước khi dùng cho Fanpage thật. Chỉ sửa/xóa được bài do ứng dụng này đăng, và bài ở trạng thái "chưa rõ kết quả" (không có mã bài trên Facebook) thì phải xử lý tay.
- Khi mạng hoặc Facebook lỗi giữa chừng, kết quả có thể **chưa rõ** (`AMBIGUOUS`): bài có thể đã lên. Hệ thống không tự đăng lại; hãy kiểm tra Fanpage rồi mới bấm "Thử lại".

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

Ứng dụng từ chối khởi động nếu còn giá trị mẫu (`replace-…`), nếu `META_OAUTH_REDIRECT_URI` không cùng origin với `NEXT_PUBLIC_APP_URL`, hoặc không kết thúc bằng `/api/auth/facebook/callback`.

> `SUPABASE_SERVICE_ROLE_KEY` phải là khóa **service_role** (hoặc secret key `sb_secret_…`), **không phải** khóa `anon`. Khóa anon sẽ bị RLS chặn mọi thao tác ghi.

## 3. Cơ sở dữ liệu

Mở Supabase → SQL Editor và chạy toàn bộ [supabase/schema.sql](supabase/schema.sql).

File chạy lại được nhiều lần: chạy lại mỗi khi cập nhật code làm thay đổi schema (ví dụ cột `posts.sent_at`, `posts.edited_at`, `posts.facebook_deleted_at`, `posts.reposted_from`, bảng `post_events`). Nó cũng tạo ràng buộc để dữ liệu của mỗi người dùng không thể gắn nhầm sang người khác, và chặn đọc token / ghi trạng thái bài trực tiếp bằng khóa `anon`.

## 4. Đăng nhập Google

1. **Google Cloud Console** → APIs & Services → Credentials → tạo *OAuth client ID* loại **Web application**. Thêm vào *Authorized redirect URIs*: `https://<project-ref>.supabase.co/auth/v1/callback`.
2. **Supabase** → Authentication → Providers → **Google**: bật và dán Client ID, Client Secret.
3. **Supabase** → Authentication → URL Configuration → *Redirect URLs*: thêm `http://localhost:3000/auth/callback` (và URL production, ví dụ `https://your-domain/auth/callback`).

Mọi tài khoản Google đều có thể đăng nhập; mỗi tài khoản là một người dùng riêng.

## 5. Ứng dụng Meta

1. Tạo app tại https://developers.facebook.com/apps/ và thêm sản phẩm Facebook Login.
2. Đặt *Valid OAuth Redirect URIs* đúng bằng `META_OAUTH_REDIRECT_URI`.
3. Quyền cần dùng: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`. Nếu người dùng bỏ chọn `pages_show_list` hoặc `pages_manage_posts` ở màn hình cấp quyền, kết nối bị từ chối với thông báo rõ ràng.
4. Tài khoản Facebook phải có quyền tạo nội dung trên Page (task `CREATE_CONTENT`).

## 6. Chạy

```bash
npm run dev      # phát triển
npm run build && npm start
npm test         # kiểm thử
npm run typecheck && npm run lint
```

Mở http://localhost:3000 → **Đăng nhập bằng Google** → **Fanpage** → **Kết nối Facebook** → **Soạn bài**.

## 7. Lập lịch đăng bài (chọn một cách)

Bài đã lên lịch chỉ được đăng khi có thứ gì đó gọi hàng đợi. Chọn theo nơi bạn triển khai:

**A. Server chạy liên tục** (VPS, Docker, `next start`): đặt trong `.env`

```
INTERNAL_SCHEDULER=true
```

Một bộ lập lịch trong tiến trình sẽ đăng bài đến hạn mỗi 30 giây và kiểm tra quyền Fanpage mỗi giờ (mỗi kết nối chỉ kiểm tra lại sau ~20 giờ). Khi chạy `npm run dev` bộ lập lịch này **luôn bật**, nên đừng trỏ `.env` dev vào dữ liệu production.

**B. Serverless (Vercel…)**: tiến trình không sống đủ lâu, hãy dùng bộ lập lịch bên ngoài gọi (GET hoặc POST) với header `Authorization: Bearer $CRON_SECRET`:

| Endpoint | Tần suất gợi ý | Việc làm |
|---|---|---|
| `/api/cron/publish` | mỗi phút | đăng các bài đến hạn (dừng sau ~35 giây) |
| `/api/cron/check-pages` | mỗi giờ | kiểm tra quyền Fanpage, tắt Page mất quyền |

```bash
curl -X POST https://your-domain/api/cron/publish -H "Authorization: Bearer $CRON_SECRET"
```

> Cron gói Hobby của Vercel chỉ chạy tối đa **một lần mỗi ngày**, không đủ cho bài đăng theo giờ. Dùng gói Pro hoặc một dịch vụ ping bên ngoài (GitHub Actions, cron-job.org…).

## 8. Lỗi thường gặp

| Hiện tượng | Nguyên nhân |
|---|---|
| Đăng nhập xong quay lại trang đăng nhập | Chưa thêm `…/auth/callback` vào Supabase Redirect URLs |
| "Không lưu được kết nối Facebook" / lỗi RLS `42501` | `SUPABASE_SERVICE_ROLE_KEY` đang là khóa anon |
| Bài `scheduled` mãi không đăng | Chưa bật `INTERNAL_SCHEDULER=true` hoặc chưa có cron ngoài |
| Lỗi `column … does not exist` / bảng không tồn tại | Chưa chạy lại `supabase/schema.sql` |
| "Facebook không cho xóa bài này qua ứng dụng" | Meta hạn chế xóa qua API; xóa tay trên Facebook rồi bấm "Đánh dấu đã xóa" |
| "Fanpage đang bị tắt" | Mất quyền; kết nối lại Facebook, bài trong hàng đợi sẽ tự đăng |

Mỗi thông báo lỗi có "Mã tham chiếu": tìm mã đó trong log máy chủ để xem chi tiết kỹ thuật.

## 9. Bảo mật

- Không bao giờ đặt `NEXT_PUBLIC_` trước App Secret, Page token hay service-role key.
- Mọi truy vấn của người dùng đi qua `userDb(userId)` (`src/lib/db.ts`) nên luôn có `user_id`; DB có thêm khóa ngoại kép và trigger chống đổi `user_id`.
- OAuth `state` của Facebook gắn với người dùng (HMAC) và cookie HttpOnly; các thao tác ghi kiểm tra cùng nguồn (CSRF).
- Có giới hạn mỗi người dùng: tối đa 500 bài nháp/đã lên lịch, 20 bài tạo mỗi phút.
- Token chỉ gửi qua header `Authorization`, không đưa vào URL hay log.
- Dùng HTTPS ở production và đổi khóa định kỳ.
