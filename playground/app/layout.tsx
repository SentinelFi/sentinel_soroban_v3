import type { Metadata } from "next";
import { Lora } from "next/font/google";
import "./globals.css";
import { Providers } from "@/app/providers";
import { Header } from "@/components/Header";

const lora = Lora({
  subsets: ["latin"],
  variable: "--font-lora",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sentinel Playground",
  description:
    "Interact with the Sentinel flight-delay insurance contracts on Stellar testnet: call functions, inspect global protocol state and your own positions.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={lora.variable}>
      <body>
        <Providers>
          <Header />
          <main className="container">{children}</main>
          <footer className="site-footer">
            <div className="container">
              Sentinel Playground — Stellar testnet only. Nothing here is
              financial advice; test tokens have no value. All signing happens
              in your wallet; this site never sees a secret key.
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
