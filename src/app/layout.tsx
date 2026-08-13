import type { Metadata } from "next";
import "./globals.css";
import { SITE_URL } from "@/lib/siteConfig";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "The Ledger — GTA VI Claim Archive",
    template: "%s — The Ledger",
  },
  description:
    "A provenance-tracked historical record of claims, leaks, reports and rumours about Grand Theft Auto VI — what was said, when, by whom, and what actually happened.",
};

/**
 * Thin root layout, deliberately with NO site chrome (no header/footer/
 * nav). The public site's editorial header/footer lives in
 * (public)/layout.tsx, a NESTED (non-root) layout scoped only to public
 * pages via a route group -- admin pages are a sibling of that group, so
 * they inherit only this thin root and never the public chrome.
 *
 * Deliberately NOT using two parallel root layouts (one per route group)
 * -- that was tried and reverted: with two root layouts, Next.js's
 * robots.ts metadata-route resolution broke (sitemap.ts kept working,
 * robots.ts silently 404'd, no build warning). One root layout with
 * nested, route-group-scoped chrome is the standard, well-supported
 * pattern and avoids that.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/*
          Deliberately a plain stylesheet link rather than next/font/google:
          next/font fetches font files at BUILD time, which fails in any
          network-restricted build environment (including the sandbox this
          was verified in). A runtime <link> only needs the browser to reach
          Google Fonts, which is a much safer assumption, and degrades
          gracefully to the fallback stack in globals.css if it can't.
          Revisit next/font/local (self-hosted, zero request) once real
          font files are vendored into the repo.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,400;0,500;0,600;1,400;1,500;1,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
