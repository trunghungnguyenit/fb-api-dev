import type { Metadata } from "next";
import { connection } from "next/server";
import { checkSchema } from "@/lib/schema-check";
import "./globals.css";

export const metadata: Metadata = {
  title: "Page Publisher",
  description: "Quản lý và lên lịch đăng bài Facebook Page"
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection(); // the check talks to the database, so never run it at build time
  const schema = await checkSchema();
  return <html lang="vi"><body>{schema.ok ? children : <main className="shell"><section className="panel" role="alert">
    <h1 className="brand">Cần cập nhật cơ sở dữ liệu</h1>
    <p className="error">Hệ thống đang được cập nhật nên tạm thời chưa dùng được. Vui lòng thử lại sau ít phút.</p>
    <p className="subtle">Dành cho quản trị viên: mở Supabase, vào SQL Editor, chạy toàn bộ tệp <strong>supabase/schema.sql</strong> (chạy lại nhiều lần không sao) rồi tải lại trang. Chi tiết các cột còn thiếu có trong log máy chủ.</p>
  </section></main>}</body></html>;
}
