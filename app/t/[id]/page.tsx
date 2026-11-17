import type { Metadata } from "next";
import { DownloadTransfer } from "@/components/download-transfer";

export const metadata: Metadata = { title: "Receive a file" };

export default async function ReceiverPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DownloadTransfer key={id} id={id} />;
}
