import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "OnTrack",
    template: "%s · OnTrack",
  },
  description: "Internal task and time management",
  // This is an internal tool behind authentication. Keep it out of any index
  // that might somehow reach it.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN">
      {/*
        suppressHydrationWarning is on <body> deliberately and narrowly.

        Browser extensions — Grammarly, password managers, ad blockers —
        inject attributes into <body> before React hydrates, producing a
        hydration mismatch that has nothing to do with our code and that we
        cannot prevent. Suppressing it here is the accepted remedy.

        It applies to THIS element's own attributes only, not to descendants,
        so a genuine mismatch anywhere inside the page still surfaces. Do not
        move it to a wrapper div or add it to <html> — that would hide real
        bugs along with the noise.
      */}
      <body className="min-h-screen" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
