import { Be_Vietnam_Pro, Lexend } from "next/font/google";

// Fonts of the Neo theme: the CSS variables are set on <html> (layout.tsx) and used by neo.css.
const display = Lexend({ subsets: ["latin", "vietnamese"], weight: ["600", "700"], variable: "--neo-display", display: "swap" });
const body = Be_Vietnam_Pro({ subsets: ["latin", "vietnamese"], weight: ["400", "600", "700"], variable: "--neo-body", display: "swap" });

// Two families and five font files in all (the numbers and ids use the system monospace font): less to download on a phone's network.
export const neoFonts = `${display.variable} ${body.variable}`;
