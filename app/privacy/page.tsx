import type { Metadata } from "next";
import Link from "next/link";
import { FEEDBACK_EMAIL } from "@/lib/site";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <main id="main" className="privacy-layout transfer-surface">
      <h1>Privacy</h1>
      <div className="privacy-body">
        <section>
          <h2>Encryption</h2>
          <p>
            Your browser encrypts the file name and contents. The key stays
            after # in the share link. It is not sent to the server. Anyone with
            the full link can open the file while it is available.
          </p>
        </section>
        <section>
          <h2>Temporary storage</h2>
          <p>
            The server stores encrypted files, sizes, IDs, expiry times,
            download counts, and hashes of access tokens.
          </p>
          <p>
            Access stops at expiry or when the sender deletes the file. Cleanup
            removes the encrypted file. A storage fault can delay removal.
          </p>
          <p>
            A recipient can keep any file they already downloaded. File removal
            does not guarantee physical erasure from disks.
          </p>
        </section>
        <section>
          <h2>No accounts or access logs</h2>
          <p>
            File transfers need no accounts or cookies. There are no analytics
            or advertising trackers. The app does not retain request or IP
            address logs. Short-lived counters in memory use secret hashes of
            network addresses to limit abuse. Transfer keys and delete tokens
            are not saved in browser storage.
          </p>
          <p>Admin sign-in uses a session cookie that lasts up to one hour.</p>
        </section>
        <section>
          <h2>Reports</h2>
          <p>
            A report blocks access until review. The original expiry still
            applies. The owner can read the comment. Do not include personal
            details or share keys.
          </p>
          <p>
            Repeat reports keep the first comment. Comments are removed when
            review closes the report or cleanup removes the file. No IP address
            is added to the report.
          </p>
        </section>
        {FEEDBACK_EMAIL && (
          <section>
            <h2>Feedback by email</h2>
            <p>
              The site owner receives your email address and message. Email
              providers can store both.
            </p>
          </section>
        )}
        <section>
          <h2>Hosting</h2>
          <p>
            The host can see encrypted file sizes and transfer times. The host
            and network providers can see connection addresses.
          </p>
        </section>
      </div>
      <Link prefetch={true} href="/" className="text-link privacy-return">
        Send files
      </Link>
    </main>
  );
}
