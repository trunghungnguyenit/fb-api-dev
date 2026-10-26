import type { MetadataRoute } from "next";

// Lets the app be installed on a phone's home screen and opened without the browser's address bar. It needs the network (every
// number comes from Facebook), so there is deliberately no offline mode and no service worker.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Page Publisher",
    short_name: "Page Publisher",
    description: "Quản lý và lên lịch đăng bài Facebook Page",
    lang: "vi",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // The splash screen of the installed app is the logo on its own black; the bar of the window keeps the colour of the pages.
    background_color: "#000000",
    theme_color: "#f1f5f9",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}
