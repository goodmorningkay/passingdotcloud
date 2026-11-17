import type { Metadata } from "next";
import Link from "next/link";
import { formatBytes } from "@/components/transfer-utils";
import { MAX_FILE_BYTES } from "@/lib/shared/constants";
import { FEEDBACK_EMAIL, SITE_IMAGE } from "@/lib/site";

const description =
  "Send an encrypted file, change its expiry, or delete it early.";

export const metadata: Metadata = {
  title: "How to send a file",
  description,
  alternates: { canonical: "/help" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "How to send a file · passing.cloud",
    description,
    siteName: "passing.cloud",
    type: "website",
    url: "/help",
    images: [SITE_IMAGE],
  },
};

export default function HelpPage() {
  return (
    <main id="main" className="privacy-layout transfer-surface">
      <h1>How to send a file</h1>
      <div className="privacy-body help-body">
        <ol className="help-steps">
          <li>
            Choose or drop your files. Each file can be up to{" "}
            {formatBytes(MAX_FILE_BYTES)}.
          </li>
          <li>
            Choose when the links expire, then select{" "}
            <strong>Create link</strong> or <strong>Create links</strong>. Keep
            the app open until the upload finishes.
          </li>
          <li>
            Send the full link for each file. The recipient opens the link and
            selects <strong>Download file</strong>.
          </li>
        </ol>
        <section>
          <h2>Who can open a file?</h2>
          <p>
            Anyone who has the full link can open the file while it is
            available. Keep the part after # when you copy the link. It contains
            the encryption key. See the{" "}
            <Link prefetch={true} href="/privacy">
              privacy page
            </Link>{" "}
            for how the app handles file data.
          </p>
        </section>
        <section>
          <h2>When does a link expire?</h2>
          <p>
            The default is 1 hour from the end of the upload. You can select 30
            minutes to 7 days.
          </p>
        </section>
        <section>
          <h2>Can I change the expiry or delete a file?</h2>
          <p>
            Keep the upload tab open. To change the expiry, select the pencil
            beside the expiry time. The new period starts when you save it. To
            stop access, select <strong>Delete file early</strong> and confirm.
          </p>
        </section>
        <section>
          <h2>How many times can a file be downloaded?</h2>
          <p>
            The default limit is 10 attempts per file. Failed or cancelled
            attempts can count. If a file reaches its limit, upload it again to
            make a new link.
          </p>
        </section>
        <section>
          <h2>Do both people need to stay online?</h2>
          <p>
            The sender can go offline after the upload. Keep the app open and
            the screen on while a transfer is in progress.
          </p>
        </section>
        {FEEDBACK_EMAIL && (
          <section>
            <h2>Send feedback</h2>
            <p>
              Describe the problem and include your browser and device. Omit
              share links and file contents. Email{" "}
              <a href={`mailto:${FEEDBACK_EMAIL}`}>{FEEDBACK_EMAIL}</a>.
            </p>
          </section>
        )}
      </div>
      <Link prefetch={true} href="/" className="text-link privacy-return">
        Send files
      </Link>
    </main>
  );
}
