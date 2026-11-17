import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES } from "../shared/constants";
import {
  downloadTransfer,
  deleteTransfer,
  getTransfer,
  uploadFile,
  updateTransferExpiry,
} from "./api";
import { ApiError } from "./errors";
import { retryAfter } from "./http";
import { encryptInWorker } from "./worker";
import { encryptContainer } from "./crypto";

vi.mock("./worker", () => ({ encryptInWorker: vi.fn() }));

const id = "0123456789abcdef0123456789abcdef";
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const uploadToken = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const deleteToken = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const ciphertext = new Blob([new Uint8Array(180)], {
  type: "application/octet-stream",
});
const file = new File(["private text"], "private name.txt", {
  type: "text/plain",
});
const session = {
  id,
  uploadToken,
  deleteToken,
  uploadExpiresAt: "2030-01-01T00:30:00.000Z",
};
const details = {
  id,
  size: file.size,
  encryptedSize: ciphertext.size,
  expiresAt: "2030-01-01T01:00:00.000Z",
};

function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

class FakeXHR {
  static last: FakeXHR | undefined;
  static action: (xhr: FakeXHR) => void;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onprogress: ((event: { loaded: number }) => void) | null = null;
  upload = { onprogress: null as ((event: { loaded: number }) => void) | null };
  status = 200;
  responseText = JSON.stringify(details);
  timeout = 0;
  headers: Record<string, string> = {};
  method = "";
  url = "";
  body?: Blob;
  aborted = false;
  constructor() {
    FakeXHR.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getResponseHeader() {
    return "7";
  }
  send(blob: Blob) {
    this.body = blob;
    queueMicrotask(() => FakeXHR.action(this));
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  fetchMock.mockReset();
  vi.mocked(encryptInWorker).mockResolvedValue({ blob: ciphertext, key });
  FakeXHR.last = undefined;
  FakeXHR.action = (xhr) => {
    xhr.upload.onprogress?.({ loaded: 90 });
    xhr.onload?.();
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("expiry API", () => {
  it("sends only the duration and sender capability and validates the returned metadata", async () => {
    const updated = { ...details, expiresAt: "2030-01-02T00:00:00.000Z" };
    fetchMock.mockResolvedValueOnce(json(updated));
    const controller = new AbortController();
    expect(
      await updateTransferExpiry(id, deleteToken, 86400, controller.signal),
    ).toEqual(updated);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/transfers/${id}/expiry`,
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: `Bearer ${deleteToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttlSeconds: 86400 }),
        signal: controller.signal,
        cache: "no-store",
      }),
    );
    const request = JSON.stringify(fetchMock.mock.calls);
    for (const secret of [key, uploadToken, file.name, file.type])
      expect(request).not.toContain(secret);
    for (const response of [
      { ...updated, id: "bad" },
      { ...updated, expiresAt: "tomorrow" },
    ]) {
      fetchMock.mockResolvedValueOnce(json(response));
      await expect(
        updateTransferExpiry(id, deleteToken, 3600),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });

  it("rejects bad inputs and cancellation before sending a request", async () => {
    await expect(
      updateTransferExpiry("../bad", deleteToken, 3600),
    ).rejects.toMatchObject({ code: "INVALID_ID" });
    await expect(updateTransferExpiry(id, "bad", 3600)).rejects.toMatchObject({
      code: "INVALID_TOKEN",
    });
    for (const ttl of [0, -1, 3600.5, 604801, NaN])
      await expect(
        updateTransferExpiry(id, deleteToken, ttl),
      ).rejects.toMatchObject({ code: "INVALID_TTL" });
    await expect(
      updateTransferExpiry(id, deleteToken, 3600, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns safe permission, availability, and rate limit errors", async () => {
    for (const status of [401, 404, 429, 503]) {
      fetchMock.mockResolvedValueOnce(
        json(
          { error: { code: "REQUEST_FAILED", message: "private token" } },
          status,
        ),
      );
      const error = await updateTransferExpiry(id, deleteToken, 3600).catch(
        (cause: unknown) => cause,
      );
      expect(error).toMatchObject({ status, code: "REQUEST_FAILED" });
      expect((error as Error).message).not.toContain("private token");
    }
  });
});

describe("upload API", () => {
  it("sends only sizes, expiry, and ciphertext and returns separate deletion capability", async () => {
    fetchMock.mockResolvedValue(json(session, 201));
    const progress = vi.fn();
    const result = await uploadFile(file, {
      ttlSeconds: 3_600,
      onProgress: progress,
    });
    expect(result).toEqual({ ...details, key, deleteToken });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, request] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/transfers");
    expect(JSON.parse(request!.body as string)).toEqual({
      size: file.size,
      encryptedSize: ciphertext.size,
      ttlSeconds: 3_600,
    });
    expect(request).toMatchObject({
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    const xhr = FakeXHR.last!;
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe(`/api/transfers/${id}/content`);
    expect(xhr.headers).toEqual({
      Authorization: `Bearer ${uploadToken}`,
      "Content-Type": "application/octet-stream",
    });
    expect(xhr.body).toBe(ciphertext);
    const wire =
      JSON.stringify(fetchMock.mock.calls) +
      JSON.stringify(xhr.headers) +
      xhr.url;
    for (const secret of [key, deleteToken, file.name, file.type])
      expect(wire).not.toContain(secret);
    expect(progress).toHaveBeenCalledWith({
      stage: "uploading",
      loaded: 90,
      total: 180,
      percent: 50,
    });
  });

  it("rejects an unsupported expiry or oversized file before starting a session", async () => {
    await expect(uploadFile(file, { ttlSeconds: 100 })).rejects.toMatchObject({
      code: "INVALID_TTL",
    });
    await expect(
      uploadFile({ size: MAX_FILE_BYTES + 1 } as File, { ttlSeconds: 3_600 }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not create a session if encryption fails or is cancelled", async () => {
    vi.mocked(encryptInWorker).mockRejectedValueOnce(
      new Error("Encryption failed"),
    );
    await expect(uploadFile(file, { ttlSeconds: 3_600 })).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadFile(file, { ttlSeconds: 3_600, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["network", "http", "timeout", "badResponse", "wrongSize"])(
    "deletes the session after %s failure",
    async (failure) => {
      fetchMock
        .mockResolvedValueOnce(json(session, 201))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      FakeXHR.action = (xhr) => {
        if (failure === "network") xhr.onerror?.();
        else if (failure === "timeout") xhr.ontimeout?.();
        else {
          if (failure === "http") {
            xhr.status = 429;
            xhr.responseText = JSON.stringify({
              error: { code: "RATE_LIMIT", message: "private name.txt" },
            });
          }
          if (failure === "badResponse")
            xhr.responseText = "<html>bad gateway</html>";
          if (failure === "wrongSize")
            xhr.responseText = JSON.stringify({ ...details, size: 1 });
          xhr.onload?.();
        }
      };
      await expect(
        uploadFile(file, { ttlSeconds: 3_600 }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock.mock.calls[1]).toEqual([
        `/api/transfers/${id}`,
        expect.objectContaining({
          method: "DELETE",
          headers: { Authorization: `Bearer ${deleteToken}` },
        }),
      ]);
    },
  );

  it("aborts XHR and deletes with a fresh signal after user cancellation", async () => {
    const controller = new AbortController();
    fetchMock
      .mockResolvedValueOnce(json(session, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    FakeXHR.action = () => controller.abort();
    await expect(
      uploadFile(file, { ttlSeconds: 3_600, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXHR.last!.aborted).toBe(true);
    const cleanup = fetchMock.mock.calls[1]![1]!;
    expect(cleanup.signal).not.toBe(controller.signal);
    expect(cleanup.signal!.aborted).toBe(false);
  });

  it("cleans up a session whose response has an invalid upload capability", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ ...session, uploadToken: "bad" }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(uploadFile(file, { ttlSeconds: 3_600 })).rejects.toMatchObject(
      { code: "INVALID_RESPONSE" },
    );
    expect(fetchMock.mock.calls[1]![1]!.method).toBe("DELETE");
    expect(FakeXHR.last).toBeUndefined();
  });

  it("keeps the original failure if cleanup also fails", async () => {
    fetchMock
      .mockResolvedValueOnce(json(session, 201))
      .mockRejectedValueOnce(new Error("Offline"));
    FakeXHR.action = (xhr) => xhr.ontimeout?.();
    await expect(uploadFile(file, { ttlSeconds: 3_600 })).rejects.toMatchObject(
      { code: "TIMEOUT" },
    );
  });
});

describe("metadata, download, and delete API", () => {
  it("streams a valid encrypted response and returns only a download Blob and name", async () => {
    const encrypted = await encryptContainer(file);
    const bytes = new Uint8Array(await encrypted.blob.arrayBuffer());
    let offset = 0;
    fetchMock
      .mockResolvedValueOnce(json({ ...details, encryptedSize: bytes.length }))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            pull(controller) {
              if (offset === bytes.length) return controller.close();
              controller.enqueue(bytes.slice(offset, offset + 7));
              offset = Math.min(bytes.length, offset + 7);
            },
          }),
        ),
      );
    const result = await downloadTransfer(id, encrypted.key);
    expect(result.name).toBe(file.name);
    expect(result.blob).toBeInstanceOf(Blob);
    expect(await result.blob.text()).toBe(await file.text());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/transfers/${id}`,
      `/api/transfers/${id}/content`,
    ]);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(encrypted.key);
  });

  it("rejects invalid keys and ids before any request or download attempt", async () => {
    await expect(downloadTransfer(id, "bad")).rejects.toThrow();
    await expect(getTransfer("../other")).rejects.toMatchObject({
      code: "INVALID_ID",
    });
    await expect(deleteTransfer(id, "bad")).rejects.toMatchObject({
      code: "INVALID_TOKEN",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed metadata and excessive API JSON", async () => {
    for (const value of [
      { ...details, size: -1 },
      { ...details, id: "bad" },
      { ...details, encryptedSize: 100_100_000 },
      { ...details, expiresAt: "tomorrow" },
    ]) {
      fetchMock.mockResolvedValueOnce(json(value));
      await expect(getTransfer(id)).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    }
    fetchMock.mockResolvedValueOnce(new Response(" ".repeat(16_385)));
    await expect(getTransfer(id)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("uses safe API errors with status, code, and Retry-After", async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            code: "RATE_LIMIT",
            message: "secret name.txt and server path",
          },
        },
        429,
        { "Retry-After": "12" },
      ),
    );
    const error = await getTransfer(id).catch((value: unknown) => value);
    expect(error).toMatchObject({
      status: 429,
      code: "RATE_LIMIT",
      retryAfter: 12,
    });
    expect((error as Error).message).not.toContain("secret");
    fetchMock.mockResolvedValueOnce(
      new Response("bad gateway", { status: 503 }),
    );
    await expect(getTransfer(id)).rejects.toMatchObject({
      status: 503,
      code: "REQUEST_FAILED",
    });
    fetchMock.mockRejectedValueOnce(new Error("Sensitive network details"));
    await expect(getTransfer(id)).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
    });
  });

  it("parses date Retry-After and bounds unexpected values", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-01-01T00:00:00Z"));
    expect(retryAfter("Tue, 01 Jan 2030 00:00:30 GMT")).toBe(30);
    expect(retryAfter("999999999")).toBe(604_800);
    expect(retryAfter("bad value")).toBeUndefined();
  });

  it("uses only the separate deletion token for DELETE", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await deleteTransfer(id, deleteToken);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/transfers/${id}`,
      expect.objectContaining({
        method: "DELETE",
        headers: { Authorization: `Bearer ${deleteToken}` },
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(key);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(uploadToken);
  });

  it("cancels a waiting metadata response", async () => {
    const controller = new AbortController();
    let cancelled = false;
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    const pending = getTransfer(id, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });

  it("does not wait for a stalled metadata cancellation hook", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          cancel: () => new Promise<void>(() => {}),
        }),
      ),
    );
    const pending = getTransfer(id, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
