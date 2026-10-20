import Link from "next/link";

export default function PostNotFound() {
  return <main className="shell"><section className="panel">
    <h1 className="brand">Không tìm thấy bài viết</h1>
    <p className="subtle">Bài viết không tồn tại, đã bị xóa, hoặc không thuộc tài khoản của bạn.</p>
    <div className="actions"><Link className="btn primary" href="/posts">Về danh sách bài viết</Link></div>
  </section></main>;
}
