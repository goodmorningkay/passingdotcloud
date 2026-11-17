import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { renderSVG } from "uqr";
import { BitcoinDonation } from "@/components/bitcoin-donation";
import { BITCOIN_DONATION_ADDRESS } from "@/lib/site";

export const metadata: Metadata = {
  title: "Donations",
  description: "Support this service with a Bitcoin donation.",
};

export default function DonatePage() {
  const address = BITCOIN_DONATION_ADDRESS;
  if (!address) notFound();

  const uri = `bitcoin:${address}`;
  const svg = renderSVG(uri, { border: 4 });
  const qrSource = `data:image/svg+xml,${encodeURIComponent(svg)}`;

  return (
    <main id="main" className="privacy-layout transfer-surface">
      <h1>Donate Bitcoin</h1>
      <div className="privacy-body">
        <p id="bitcoin-network">Use the Bitcoin network only.</p>
        <BitcoinDonation address={address} uri={uri} qrSource={qrSource} />
      </div>
      <Link prefetch={true} href="/" className="text-link privacy-return">
        Send files
      </Link>
    </main>
  );
}
