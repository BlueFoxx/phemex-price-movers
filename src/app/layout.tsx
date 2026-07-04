import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Phemex Price Movers — 5m / 10m / 15m / 30m Coin Price Change Ranking",
  description:
    "Real-time ranking of Phemex USDⓈ-M perpetual and spot trading pairs by their price change over the last 5, 10, 15, and 30 minutes. Sort any timeframe column asc/desc. Pairs under $300K 24h volume are filtered out.",
  keywords: [
    "Phemex",
    "crypto",
    "price change",
    "perpetual",
    "spot",
    "market scanner",
    "crypto screener",
  ],
  authors: [{ name: "Phemex Price Movers" }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
