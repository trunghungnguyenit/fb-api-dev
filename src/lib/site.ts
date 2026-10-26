import type { Metadata } from "next";

// What the public pages say about themselves to search engines and to the apps people share a link in. Everything with an address
// in it is built from NEXT_PUBLIC_APP_URL, never written out, so moving the app to another domain is one setting.

export const SITE_NAME = "Page Publisher";
export const SITE_DESCRIPTION = "Công cụ quản lý Fanpage Facebook: soạn bài, lên lịch đăng, đăng ảnh, video và Reels, theo dõi bình luận, thông báo và số liệu Insights ở một nơi.";
export const SITE_LOCALE = "vi_VN";

/** The picture shown when a link is shared (made by scripts/make-icons.mjs from the logo). */
export const OG_IMAGE = { url: "/icons/og-image.png", width: 1200, height: 630, alt: "Logo HT của Page Publisher" } as const;

/** The pages search engines may list. Everything else is private: it is behind sign-in and marked noindex. */
export const INDEXABLE_PATHS = ["/login", "/privacy", "/terms"] as const;

/**
 * The tags of one page. `title` is shown as it is (no site name added). A page that may be listed is `index: true`; the default of
 * the whole app (layout.tsx) is the opposite, so a page that forgets to say anything is never listed by mistake.
 * An `openGraph` or `twitter` block of a page replaces the one of the layout as a whole, hence they are complete here.
 */
export function pageMetadata({ title, description, path, index }: { title: string; description: string; path: string; index: boolean }): Metadata {
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    robots: index ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { type: "website", locale: SITE_LOCALE, siteName: SITE_NAME, title, description, url: path, images: [OG_IMAGE] },
    twitter: { card: "summary_large_image", title, description, images: [OG_IMAGE.url] }
  };
}

/** The address of the app (no trailing slash), or null when the setting is not a URL. */
export function siteOrigin(appUrl: string | undefined): string | null {
  try { return appUrl ? new URL(appUrl).origin : null; } catch { return null; }
}
