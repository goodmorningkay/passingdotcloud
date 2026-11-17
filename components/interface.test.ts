import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DownloadTransfer } from "./download-transfer";

describe("initial interface rendering", () => {
  it("does not parse a fragment or request file data on the server", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    renderToStaticMarkup(
      createElement(DownloadTransfer, { id: "a".repeat(32) }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
