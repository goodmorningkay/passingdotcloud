import type { Metadata } from "next";
import { UploadTransfer } from "@/components/upload-transfer";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
};

export default function HomePage() {
  return (
    <main id="main" className="transfer-layout">
      <section
        id="transfer"
        className="transfer-surface"
        aria-label="Send files"
      >
        <UploadTransfer />
      </section>
    </main>
  );
}
