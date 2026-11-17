"use client";

import { RotateCcw } from "lucide-react";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main" className="not-found transfer-surface">
      <h1>Could not load this page</h1>
      <button type="button" className="button button-primary" onClick={reset}>
        <RotateCcw size={16} aria-hidden="true" /> Try again
      </button>
    </main>
  );
}
