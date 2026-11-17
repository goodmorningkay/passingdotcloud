import type { Metadata } from "next";
import { ReportTransfer } from "@/components/report-transfer";
import { TRANSFER_ID_PATTERN } from "@/lib/shared/constants";

export const metadata: Metadata = { title: "Report a file" };

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string | string[] }>;
}) {
  const { id } = await searchParams;
  const initialId =
    typeof id === "string" && TRANSFER_ID_PATTERN.test(id) ? id : "";
  return (
    <main id="main" className="transfer-layout report-layout">
      <section className="transfer-surface" aria-label="Report a file">
        <ReportTransfer key={initialId} initialId={initialId} />
      </section>
    </main>
  );
}
