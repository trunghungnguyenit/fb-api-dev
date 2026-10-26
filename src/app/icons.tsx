import type { ReactNode } from "react";

// Small outline icons for the posts list (no icon library). Decorative: the buttons carry the text.
function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return <svg className="neo-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>;
}

/** The icon in front of a status pill, so the status is not carried by colour alone (tones: see neo.css). */
export function StatusIcon({ tone }: { tone: string }) {
  switch (tone) {
    case "published": case "ok": return <Icon size={14}><path d="m5 12.5 4.5 4.5L19 7.5" /></Icon>;
    case "draft": return <Icon size={14}><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></Icon>;
    case "scheduled": return <Icon size={14}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
    case "processing": case "warn": return <Icon size={14}><path d="M6 3h12M6 21h12" /><path d="M7 3c0 5 5 5 5 9s-5 4-5 9M17 3c0 5-5 5-5 9s5 4 5 9" /></Icon>;
    case "error": return <Icon size={14}><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17.5h0" /></Icon>;
    case "deleted": case "bad": return <Icon size={14}><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></Icon>;
    default: return <Icon size={14}><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></Icon>;
  }
}

export const IconFlag = () => <Icon><path d="M5 22V4" /><path d="M5 4h13l-2.5 4.5L18 13H5" /></Icon>;
export const IconList = () => <Icon><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></Icon>;
export const IconBell = () => <Icon><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></Icon>;
export const IconEye = () => <Icon><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></Icon>;
export const IconRepeat = () => <Icon><path d="M17 2l4 4-4 4" /><path d="M3 11V9a3 3 0 0 1 3-3h15" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a3 3 0 0 1-3 3H3" /></Icon>;
export const IconSend = () => <Icon><path d="M22 2 11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7Z" /></Icon>;
export const IconBug = () => <Icon><rect x="8" y="6" width="8" height="14" rx="4" /><path d="M9 6a3 3 0 0 1 6 0" /><path d="M3 13h5M16 13h5M4 6l4 3M20 6l-4 3M4 20l4-3M20 20l-4-3" /></Icon>;
export const IconFeather = () => <Icon><path d="M20.2 3.8a6 6 0 0 0-8.5 0L5 10.5V19h8.5l6.7-6.7a6 6 0 0 0 0-8.5Z" /><path d="M16 8 2 22" /><path d="M17.5 15H9" /></Icon>;
export const IconHome = () => <Icon><path d="M3 11.5 12 4l9 7.5" /><path d="M5 10v10h14V10" /></Icon>;
export const IconUpload = () => <Icon><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></Icon>;
export const IconSliders = () => <Icon><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></Icon>;

// The five kinds of post (see lib/post-kind.ts).
export const IconKindText = () => <Icon size={20}><path d="M4 6h16M4 11h16M4 16h10" /></Icon>;
export const IconKindLink = () => <Icon size={20}><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></Icon>;
export const IconKindImages = () => <Icon size={20}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.8" /><path d="m21 16-5-5-8 9" /></Icon>;
export const IconKindVideo = () => <Icon size={20}><rect x="3" y="6" width="13" height="12" rx="3" /><path d="m16 10.5 5-3v9l-5-3" /></Icon>;
export const IconKindReel = () => <Icon size={20}><rect x="7" y="2.5" width="10" height="19" rx="3" /><path d="m11 9.5 3.2 2.5L11 14.5v-5Z" /></Icon>;
export const IconMenu = () => <Icon size={22}><path d="M4 7h16M4 12h16M4 17h16" /></Icon>;
export const IconClose = () => <Icon size={20}><path d="M6 6l12 12M18 6 6 18" /></Icon>;
export const IconChart = () => <Icon><path d="M4 20V10M10 20V4M16 20v-8M22 20H2" /></Icon>;
