import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("./crypto");
  vi.unstubAllGlobals();
});

it("cancels a pending crypto load and allows a later download", async () => {
  const id = "0123456789abcdef0123456789abcdef";
  const key = "A".repeat(43);
  const details = {
    id,
    size: 3,
    encryptedSize: 180,
    expiresAt: "2030-01-01T01:00:00.000Z",
  };
  const response = new Response(JSON.stringify(details));
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  const decryptContainer = vi.fn();
  let finishCryptoLoad!: () => void;
  const cryptoLoad = new Promise<void>((resolve) => {
    finishCryptoLoad = resolve;
  });
  vi.doMock("./crypto", async () => {
    await cryptoLoad;
    return { decryptContainer };
  });
  const { downloadTransfer } = await import("./api");
  const controller = new AbortController();
  const settled = vi.fn();
  const pending = downloadTransfer(id, key, undefined, controller.signal).then(
    settled,
    settled,
  );

  try {
    await vi.waitFor(() => {
      expect(response.bodyUsed).toBe(true);
      expect(response.body?.locked).toBe(false);
    });
    // Let metadata validation finish, leaving only the crypto import pending.
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await vi.waitFor(() =>
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({ name: "AbortError" }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    finishCryptoLoad();
    await pending;
    await vi.dynamicImportSettled();
  }

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(decryptContainer).not.toHaveBeenCalled();
  const downloaded = { blob: new Blob(["abc"]), name: "test.txt" };
  decryptContainer.mockResolvedValueOnce(downloaded);
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify(details)))
    .mockResolvedValueOnce(new Response(new Uint8Array(180)));
  await expect(downloadTransfer(id, key)).resolves.toEqual(downloaded);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    `/api/transfers/${id}`,
    `/api/transfers/${id}`,
    `/api/transfers/${id}/content`,
  ]);
  expect(decryptContainer).toHaveBeenCalledTimes(1);
});
