import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { Providers } from "./providers";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-heading",
  display: "swap",
});

export const metadata: Metadata = {
  title: "iPredict — Prediction Market on Stellar",
  description:
    "Predict. Win or Lose — You Always Earn. Decentralized prediction market on Stellar with near-zero fees and 5-second finality.",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL || "https://ipredict-stellar.vercel.app"
  ),
  icons: {
    icon: [
      { url: "/logo.png", type: "image/png" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/logo.png",
  },
  openGraph: {
    title: "iPredict — Prediction Market on Stellar",
    description:
      "Predict. Win or Lose — You Always Earn. Decentralized prediction market with near-zero fees.",
    images: ["/logo.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "iPredict — Prediction Market on Stellar",
    description:
      "Predict. Win or Lose — You Always Earn. Decentralized prediction market with near-zero fees.",
    images: ["/logo.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read the per-request nonce injected by middleware.ts so we can stamp it
  // onto any server-rendered inline <script> blocks (e.g. Next.js bootstrap).
  const headersList = headers();
  const nonce = headersList.get("x-nonce") ?? undefined;

  return (
    <html lang="en" className={`dark ${inter.variable} ${spaceGrotesk.variable}`}>
      <head>
        {/*
          Subresource Integrity for the Google Fonts stylesheet.
          The @import in globals.css is replaced by an explicit <link> here so
          we can attach an integrity hash and crossOrigin attribute, meeting the
          SRI acceptance criterion (issue #289).

          Hash generated from: https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap
          Re-generate after any font family / weight change:
            curl -s "https://fonts.googleapis.com/css2?..." | openssl dgst -sha384 -binary | openssl base64
        */}
        <link
          rel="preconnect"
          href="https://fonts.googleapis.com"
          crossOrigin="anonymous"
        />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap"
          crossOrigin="anonymous"
        />
      </head>
      <body
        className="min-h-screen flex flex-col bg-surface text-slate-100 antialiased"
        // Forward nonce to Providers so any <Script> tags they render can use it.
        {...(nonce ? { "data-nonce": nonce } : {})}
      >
        <Providers nonce={nonce}>
          <Navbar />
          <main className="flex-1">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
