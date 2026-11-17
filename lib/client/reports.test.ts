import { afterEach, describe, expect, it, vi } from "vitest";
import { reportTransfer } from "./reports";

afterEach(() => vi.unstubAllGlobals());
const id = "a".repeat(32);
const comment = "This file contains a suspicious program. Please review it.";

describe("report client", () => {
  it("sends only the file id and comment, without a share key or transfer capabilities", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"accepted":true}', { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    await reportTransfer(id, ` ${comment} `);
    expect(fetch).toHaveBeenCalledWith(
      `/api/transfers/${id}/report`,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment }),
        referrerPolicy: "no-referrer",
        cache: "no-store",
      }),
    );
  });
  it("rejects accidental full share links and keys before a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const text of [
      `See https://passing.cloud/t/${id}#${"A".repeat(43)}`,
      `Key: ${"A".repeat(43)}`,
      "short",
    ]) {
      await expect(reportTransfer(id, text)).rejects.toThrow();
    }
    await expect(
      reportTransfer(`https://passing.cloud/t/${id}`, comment),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps report rate limits and their retry time available to the form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"error":{"code":"RATE_LIMITED"}}', {
          status: 429,
          headers: { "Retry-After": "3600" },
        }),
      ),
    );
    await expect(reportTransfer(id, comment)).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      retryAfter: 3600,
    });
  });
});
