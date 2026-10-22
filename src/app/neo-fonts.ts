import { Be_Vietnam_Pro, JetBrains_Mono, Lexend } from "next/font/google";

// Fonts of the Neo theme: the CSS variables are set on <html> (layout.tsx) and used by neo.css.
const display = Lexend({ subsets: ["latin", "vietnamese"], weight: ["600", "700"], variable: "--neo-display", display: "swap" });
const body = Be_Vietnam_Pro({ subsets: ["latin", "vietnamese"], weight: ["400", "500", "600", "700"], variable: "--neo-body", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin", "vietnamese"], weight: ["400", "500"], variable: "--neo-mono", display: "swap" });

export const neoFonts = `${display.variable} ${body.variable} ${mono.variable}`;
