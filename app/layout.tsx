import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Sky } from "@/components/sky";
import {
  BITCOIN_DONATION_ADDRESS,
  FEEDBACK_EMAIL,
  SITE_DESCRIPTION,
  SITE_ORIGIN,
  SITE_TITLE,
} from "@/lib/site";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  applicationName: "passing.cloud",
  title: {
    default: SITE_TITLE,
    template: "%s · passing.cloud",
  },
  description: SITE_DESCRIPTION,
  // Shared previews describe the service, never a transfer or its contents.
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    siteName: "passing.cloud",
    type: "website",
    url: SITE_ORIGIN,
  },
  twitter: { card: "summary_large_image" },
  appleWebApp: {
    capable: true,
    title: "passing.cloud",
    statusBarStyle: "default",
  },
  // Keep pages out of search results unless a page overrides this setting.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#88bad5",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <div className="site-shell">
          {children}
          <footer className="site-footer">
            <nav className="footer-links" aria-label="Footer">
              <Link prefetch={true} href="/help">
                Help
              </Link>
              {FEEDBACK_EMAIL && (
                <a href={`mailto:${FEEDBACK_EMAIL}`}>Send feedback</a>
              )}
              {BITCOIN_DONATION_ADDRESS && (
                <Link prefetch={true} href="/donate">
                  Donate
                </Link>
              )}
              <Link prefetch={true} href="/privacy">
                Privacy
              </Link>
              <Link prefetch={true} href="/report">
                Report
              </Link>
              <Link prefetch={true} href="/install" className="install-link">
                Install
              </Link>
            </nav>
            <Sky />
          </footer>
        </div>
      </body>
    </html>
  );
}
