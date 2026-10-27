import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SayOps — do the chore once, say why, get safe automation",
  description: "Record an ops chore once while explaining it with Wispr Flow. SayOps turns your commands and spoken reasons into a guarded, sandbox-tested script, a GitHub workflow and a runbook, and catches the steps you said but never ran.",
  openGraph: {
    title: "SayOps — say why, get safe automation",
    description: "Your spoken reasons become guards, checks and rollbacks. It even catches what you said but never did.",
    type: "website",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-background text-foreground">{children}</body>
    </html>
  );
}
