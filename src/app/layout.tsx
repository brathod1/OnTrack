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
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
