import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { checkSchema } from "@/lib/schema-check";
import AppNav from "./app-nav";
import { ConfirmProvider } from "./confirm-dialog";
import { ToastProvider } from "./toast";
import NotificationBell from "./notification-bell";
import RouteProgress from "./route-progress";
import { env } from "@/lib/env";
import { SITE_DESCRIPTION, SITE_NAME, siteOrigin } from "@/lib/site";
import { neoFonts } from "./neo-fonts";
import "./globals.css";
import "./neo.css";

// Private by default: only the pages that name themselves "index: true" (the sign-in page and the two legal pages, see lib/site.ts) may
// be listed by a search engine. What is behind the sign-in is never reachable by one, and says so as well.
export const metadata: Metadata = {
  metadataBase: siteOrigin(env.NEXT_PUBLIC_APP_URL) ? new URL(siteOrigin(env.NEXT_PUBLIC_APP_URL) as string) : undefined,
  title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  robots: { index: false, follow: false },
  applicationName: SITE_NAME,
  // The manifest (manifest.ts) is linked by Next.js itself. These are the icons of the tab and of "add to home screen".
  icons: {
    icon: [{ url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" }, { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }]
  },
  appleWebApp: { capable: true, title: "Page Publisher", statusBarStyle: "default" },
  formatDetection: { telephone: false }
};

// viewport-fit=cover lets the layout use the whole phone screen (the sticky bars add the safe-area padding themselves).
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#f1f5f9" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection(); // the check talks to the database, so never run it at build time
  const schema = await checkSchema();
  return <html lang="vi" className={neoFonts}><body className="neo">{schema.ok ? <ToastProvider><ConfirmProvider><Suspense fallback={null}><RouteProgress /></Suspense><Suspense fallback={null}><AppNav /></Suspense>{children}<Suspense fallback={null}><NotificationBell placement="float" /></Suspense></ConfirmProvider></ToastProvider> : <main className="shell"><section className="panel" role="alert">
    <h1 className="brand">Cần cập nhật cơ sở dữ liệu</h1>
    <p className="error">Hệ thống đang được cập nhật nên tạm thời chưa dùng được. Vui lòng thử lại sau ít phút.</p>
    <p className="subtle">Dành cho quản trị viên: mở Supabase, vào SQL Editor, chạy toàn bộ tệp <strong>supabase/schema.sql</strong> (chạy lại nhiều lần không sao) rồi tải lại trang. Chi tiết các cột còn thiếu có trong log máy chủ.</p>
  </section></main>}</body></html>;
}
