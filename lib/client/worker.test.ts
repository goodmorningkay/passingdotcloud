import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encryptInWorker,
  warmEncryptionWorker,
  clearWarmedEncryptionWorker,
} from "./worker";
import type { EncryptResponse } from "./worker-types";

class FakeWorker {
  static last: FakeWorker;
  onmessage: ((event: { data: EncryptResponse }) => void) | null = null;
  onerror: ((event: { preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  request?: unknown;
  constructor(
    public url: URL,
    public options: unknown,
  ) {
    FakeWorker.last = this;
  }
  postMessage(request: unknown) {
    this.request = request;
  }
  terminate() {
    this.terminated = true;
  }
  reply(message: EncryptResponse) {
    this.onmessage?.({ data: message });
  }
}

afterEach(() => {
  clearWarmedEncryptionWorker();
  vi.unstubAllGlobals();
});

describe("encryption worker bridge", () => {
  it("uses a local module worker, reports progress, and terminates after completion", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const file = new File(["abc"], "test.txt");
    const progress = vi.fn();
    const pending = encryptInWorker(file, { onProgress: progress });
    const worker = FakeWorker.last;
    expect(worker.url.pathname).toMatch(
      /\/lib\/client\/encryption\.worker\.ts$/,
    );
    expect(worker.options).toEqual({ type: "module" });
    expect(worker.request).toEqual({ type: "encrypt", file });
    worker.reply({
      type: "progress",
      progress: { stage: "encrypting", loaded: 1, total: 3, percent: 100 / 3 },
    });
    expect(progress).toHaveBeenCalled();
    const result = {
      blob: new Blob(["cipher"]),
      key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    worker.reply({ type: "complete", ...result });
    await expect(pending).resolves.toEqual(result);
    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
  });

  it("terminates promptly on cancellation", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const controller = new AbortController();
    const pending = encryptInWorker(new File(["abc"], "test"), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.last.terminated).toBe(true);
  });

  it("reports a safe error and terminates on worker failure", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const pending = encryptInWorker(new File(["abc"], "test"), {});
    const preventDefault = vi.fn();
    FakeWorker.last.onerror?.({ preventDefault });
    await expect(pending).rejects.toThrow("The file could not be encrypted.");
    expect(preventDefault).toHaveBeenCalled();
    expect(FakeWorker.last.terminated).toBe(true);
  });
});

describe("encryption worker warm-up", () => {
  it("loads one idle worker without sending file data and reuses it on upload", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    warmEncryptionWorker();
    const idle = FakeWorker.last;
    expect(idle.request).toBeUndefined();
    warmEncryptionWorker();
    expect(FakeWorker.last).toBe(idle);
    const file = new File(["abc"], "test.txt");
    const pending = encryptInWorker(file, {});
    expect(FakeWorker.last).toBe(idle);
    expect(idle.request).toEqual({ type: "encrypt", file });
    const result = { blob: new Blob(["cipher"]), key: "A".repeat(43) };
    idle.reply({ type: "complete", ...result });
    await expect(pending).resolves.toEqual(result);
    expect(idle.terminated).toBe(true);
  });

  it("terminates and releases an idle worker when cleared", () => {
    vi.stubGlobal("Worker", FakeWorker);
    warmEncryptionWorker();
    const first = FakeWorker.last;
    clearWarmedEncryptionWorker();
    expect(first.terminated).toBe(true);
    warmEncryptionWorker();
    expect(FakeWorker.last).not.toBe(first);
  });

  it("can retry an upload after an idle worker fails to load", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    warmEncryptionWorker();
    const failed = FakeWorker.last;
    failed.onerror?.({ preventDefault: vi.fn() });
    expect(failed.terminated).toBe(true);
    const pending = encryptInWorker(new File(["abc"], "test"), {});
    expect(FakeWorker.last).not.toBe(failed);
    const result = { blob: new Blob(["cipher"]), key: "A".repeat(43) };
    FakeWorker.last.reply({ type: "complete", ...result });
    await expect(pending).resolves.toEqual(result);
  });

  it("still aborts a worker that was loaded before upload", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    warmEncryptionWorker();
    const worker = FakeWorker.last;
    const controller = new AbortController();
    const pending = encryptInWorker(new File(["abc"], "test"), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminated).toBe(true);
  });

  it("can upload after the warm-up constructor fails", async () => {
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("Worker creation failed");
        }
      },
    );
    expect(() => warmEncryptionWorker()).not.toThrow();
    vi.stubGlobal("Worker", FakeWorker);
    const pending = encryptInWorker(new File(["abc"], "test"), {});
    const result = { blob: new Blob(["cipher"]), key: "A".repeat(43) };
    FakeWorker.last.reply({ type: "complete", ...result });
    await expect(pending).resolves.toEqual(result);
  });

  it("keeps an idle worker available after a request was already cancelled", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    warmEncryptionWorker();
    const idle = FakeWorker.last;
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      encryptInWorker(new File(["abc"], "test"), {
        signal: controller.signal,
      }),
    ).toThrow();
    expect(idle.request).toBeUndefined();
    expect(idle.terminated).toBe(false);
    const pending = encryptInWorker(new File(["abc"], "test"), {});
    expect(FakeWorker.last).toBe(idle);
    const result = { blob: new Blob(["cipher"]), key: "A".repeat(43) };
    idle.reply({ type: "complete", ...result });
    await expect(pending).resolves.toEqual(result);
  });
});
