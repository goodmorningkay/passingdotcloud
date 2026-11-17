import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Add to Home Screen" };

export default function InstallPage() {
  return (
    <main id="main" className="privacy-layout transfer-surface">
      <h1>Add to Home Screen</h1>
      <div className="privacy-body">
        <section>
          <h2>iPhone or iPad</h2>
          <ol className="install-steps">
            <li>
              Open{" "}
              <Link prefetch={true} href="/">
                passing.cloud
              </Link>{" "}
              in Safari.
            </li>
            <li>
              Tap <strong>Share</strong>. You may need to open the page menu
              first.
            </li>
            <li>
              Tap <strong>Add to Home Screen</strong>. If it is not in the list,
              tap <strong>Edit Actions</strong> to add it.
            </li>
            <li>
              Keep <strong>Open as Web App</strong> on, if shown. Then tap{" "}
              <strong>Add</strong>.
            </li>
          </ol>
        </section>
        <section>
          <h2>During a transfer</h2>
          <p>
            You need an internet connection to send or receive a file. Keep the
            app open and the screen on until the transfer is complete.
          </p>
        </section>
      </div>
      <Link prefetch={true} href="/" className="text-link privacy-return">
        Send files
      </Link>
    </main>
  );
}
