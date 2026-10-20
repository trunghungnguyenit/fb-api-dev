import Link from "next/link";

export default function NotFound() {
  return <main className="shell"><section className="panel">
    <h1 className="brand">Không tìm thấy trang</h1>
    <p className="subtle">Trang bạn mở không tồn tại hoặc đã được di chuyển.</p>
    <div className="actions"><Link className="btn primary" href="/">Về trang chủ</Link></div>
  </section></main>;
}
