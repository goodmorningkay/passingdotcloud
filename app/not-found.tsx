import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="not-found transfer-surface">
      <h1>Page not found</h1>
      <Link prefetch={true} href="/" className="text-link">
        Send files
      </Link>
    </main>
  );
}
