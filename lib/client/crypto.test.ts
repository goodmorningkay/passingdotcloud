import { describe, expect, it } from "vitest";
import {
  CHUNK_BYTES,
  MAX_FILE_BYTES,
  MAX_MANIFEST_BYTES,
} from "../shared/constants";
import { decryptContainer, encryptContainer } from "./crypto";
import { safeFilename } from "./manifest";
import sodium, { releaseState } from "./sodium";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const encoder = new TextEncoder();
const validManifest = {
  version: 1,
  name: "résumé 日本語.txt",
  size: 3,
  type: "text/plain",
};

function network(
  bytes: Uint8Array,
  boundaries = [bytes.length || 1],
): ReadableStream<Uint8Array> {
  let offset = 0;
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(
        bytes.length,
        offset + boundaries[index++ % boundaries.length]!,
      );
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

/** Independent writer: test invalid authenticated content, not only bit damage. */
async function fixture(
  manifest: unknown = validManifest,
  records: { bytes: Uint8Array; tag: number }[] = [
    { bytes: new Uint8Array([4, 5, 6]), tag: 3 },
  ],
  manifestTag = 0,
): Promise<Uint8Array<ArrayBuffer>> {
  await sodium.ready;
  const stream = sodium.crypto_secretstream_xchacha20poly1305_init_push(
    new Uint8Array(32),
  );
  const parts: Uint8Array[] = [encoder.encode("PASSCLD1"), stream.header];
  try {
    const first =
      manifest instanceof Uint8Array
        ? manifest
        : encoder.encode(JSON.stringify(manifest));
    for (const record of [{ bytes: first, tag: manifestTag }, ...records]) {
      const encrypted = sodium.crypto_secretstream_xchacha20poly1305_push(
        stream.state,
        record.bytes,
        null,
        record.tag,
      );
      const prefix = new Uint8Array(4);
      new DataView(prefix.buffer).setUint32(0, encrypted.length, false);
      parts.push(prefix, encrypted);
    }
    const result = new Uint8Array(
      parts.reduce((sum, part) => sum + part.length, 0),
    );
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  } finally {
    releaseState(stream.state);
  }
}

describe("container", () => {
  it.each([0, 1, CHUNK_BYTES, CHUNK_BYTES + 1, CHUNK_BYTES * 2 + 19])(
    "encrypts and streams %i bytes across irregular transport boundaries",
    async (size) => {
      const data = Uint8Array.from({ length: size }, (_, i) => (i * 31) % 251);
      const file = new File([data], "été 日本語.txt", { type: "text/plain" });
      const encrypted = await encryptContainer(file);
      const bytes = new Uint8Array(await encrypted.blob.arrayBuffer());
      expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("PASSCLD1");
      expect(encrypted.blob.type).toBe("application/octet-stream");
      expect(encrypted.blob.size - size).toBeLessThan(65_536);
      expect(new TextDecoder().decode(bytes)).not.toContain("été 日本語.txt");
      const decoded = await decryptContainer(
        network(bytes, [1, 3, 31, 65_537, 7, 524_287]),
        encrypted.key,
        {
          size,
          encryptedSize: bytes.length,
        },
      );
      expect(decoded.name).toBe(file.name);
      expect(decoded.blob.type).toBe("text/plain");
      expect(new Uint8Array(await decoded.blob.arrayBuffer())).toEqual(data);
    },
  );

  it("accepts an independent container with small records and one-byte network chunks", async () => {
    const bytes = await fixture(validManifest, [
      { bytes: new Uint8Array([4]), tag: 0 },
      { bytes: new Uint8Array([5, 6]), tag: 3 },
    ]);
    const result = await decryptContainer(network(bytes, [1]), key);
    expect([...new Uint8Array(await result.blob.arrayBuffer())]).toEqual([
      4, 5, 6,
    ]);
  });

  it("uses independent random keys and headers", async () => {
    const file = new File(["same file"], "same.txt");
    const a = await encryptContainer(file);
    const b = await encryptContainer(file);
    expect(a.key).not.toBe(b.key);
    expect(new Uint8Array(await a.blob.arrayBuffer()).slice(8, 32)).not.toEqual(
      new Uint8Array(await b.blob.arrayBuffer()).slice(8, 32),
    );
  });

  it("writes the specified framing and tags for an independent sodium reader", async () => {
    const file = new File(
      [new Uint8Array(CHUNK_BYTES + 9).fill(83)],
      "source.txt",
      { type: "text/plain" },
    );
    const encrypted = await encryptContainer(file);
    const bytes = new Uint8Array(await encrypted.blob.arrayBuffer());
    const rawKey = Uint8Array.from(
      atob(encrypted.key.replace(/-/g, "+").replace(/_/g, "/") + "="),
      (c) => c.charCodeAt(0),
    );
    const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
      bytes.slice(8, 32),
      rawKey,
    );
    rawKey.fill(0);
    try {
      let offset = 32;
      const records: { message: Uint8Array; tag: number }[] = [];
      while (offset < bytes.length) {
        const length = new DataView(bytes.buffer).getUint32(offset, false);
        const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
          state,
          bytes.slice(offset + 4, offset + 4 + length),
        );
        if (!result) throw new Error("Independent authentication failed");
        records.push(result);
        offset += 4 + length;
      }
      expect(offset).toBe(bytes.length);
      expect(records.map((record) => record.tag)).toEqual([0, 0, 3]);
      expect(JSON.parse(new TextDecoder().decode(records[0]!.message))).toEqual(
        { version: 1, name: file.name, size: file.size, type: file.type },
      );
      expect(records[1]!.message.length).toBe(CHUNK_BYTES);
      expect(records[2]!.message).toEqual(new Uint8Array(9).fill(83));
    } finally {
      releaseState(state);
    }
  });

  it("rejects each truncated prefix of a complete independent container", async () => {
    const bytes = await fixture();
    for (let length = 0; length < bytes.length; length++) {
      await expect(
        decryptContainer(network(bytes.slice(0, length)), key),
      ).rejects.toThrow();
    }
  });

  it("rejects corruption of magic, header, manifest, ciphertext, and tags", async () => {
    const bytes = await fixture();
    for (const offset of [
      0,
      7,
      8,
      20,
      31,
      36,
      58,
      bytes.length - 18,
      bytes.length - 1,
    ]) {
      const bad = bytes.slice();
      bad[offset] = bad[offset]! ^ 1;
      await expect(
        decryptContainer(network(bad, [3, 17, 2]), key),
      ).rejects.toThrow();
    }
    await expect(
      decryptContainer(
        network(bytes),
        "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ),
    ).rejects.toThrow();
  });

  it("rejects record reordering, duplication, and trailing bytes", async () => {
    const bytes = await fixture(validManifest, [
      { bytes: new Uint8Array([4]), tag: 0 },
      { bytes: new Uint8Array([5, 6]), tag: 3 },
    ]);
    const manifestEnd = 36 + new DataView(bytes.buffer).getUint32(32, false);
    const secondEnd =
      manifestEnd +
      4 +
      new DataView(bytes.buffer).getUint32(manifestEnd, false);
    for (const parts of [
      [
        bytes.slice(0, manifestEnd),
        bytes.slice(secondEnd),
        bytes.slice(manifestEnd, secondEnd),
      ],
      [
        bytes.slice(0, secondEnd),
        bytes.slice(manifestEnd, secondEnd),
        bytes.slice(secondEnd),
      ],
      [bytes, new Uint8Array([0])],
      [bytes, bytes.slice(secondEnd)],
    ]) {
      const bad = new Uint8Array(await new Blob(parts).arrayBuffer());
      await expect(decryptContainer(network(bad), key)).rejects.toThrow();
    }
  });

  it.each([0, 1, 16, 0x7fffffff, 0xffffffff])(
    "rejects invalid frame length %i",
    async (length) => {
      const bytes = await fixture();
      new DataView(bytes.buffer).setUint32(32, length, false);
      await expect(decryptContainer(network(bytes), key)).rejects.toThrow();
    },
  );

  it.each([
    { version: 2 },
    { name: "../secret.txt" },
    { name: "C:\\secret.txt" },
    { name: "CON.txt" },
    { name: "." },
    { name: "bad\u202ename.txt" },
    { name: "a".repeat(256) },
    { size: -1 },
    { size: 3.5 },
    { size: "3" },
    { size: MAX_FILE_BYTES + 1 },
    { type: "text/html\r\nX: y" },
    { type: "<script>" },
    { type: "x/" + "a".repeat(255) },
    { extra: true },
  ])("rejects authenticated invalid manifest %j", async (change) => {
    const bytes = await fixture({ ...validManifest, ...change });
    await expect(decryptContainer(network(bytes), key)).rejects.toThrow();
  });

  it("rejects invalid UTF-8, JSON, manifest type, and overlong manifest", async () => {
    for (const manifest of [
      new Uint8Array([0xff]),
      encoder.encode("{"),
      null,
      [],
      "text",
      new Uint8Array(MAX_MANIFEST_BYTES + 1),
    ]) {
      await expect(
        decryptContainer(network(await fixture(manifest)), key),
      ).rejects.toThrow();
    }
  });

  it("requires message tag on the manifest and final tag on file data", async () => {
    await expect(
      decryptContainer(
        network(await fixture(validManifest, undefined, 3)),
        key,
      ),
    ).rejects.toThrow();
    for (const tag of [0, 1, 2]) {
      const bytes = await fixture(validManifest, [
        { bytes: new Uint8Array([4, 5, 6]), tag },
      ]);
      await expect(decryptContainer(network(bytes), key)).rejects.toThrow();
    }
  });

  it("rejects short and excess authenticated plaintext, and empty intermediate records", async () => {
    for (const records of [
      [{ bytes: new Uint8Array([4, 5]), tag: 3 }],
      [{ bytes: new Uint8Array([4, 5, 6, 7]), tag: 3 }],
      [
        { bytes: new Uint8Array(), tag: 0 },
        { bytes: new Uint8Array([4, 5, 6]), tag: 3 },
      ],
    ])
      await expect(
        decryptContainer(network(await fixture(validManifest, records)), key),
      ).rejects.toThrow();
  });

  it("rejects oversized authenticated data frames and wrong API size declarations", async () => {
    const bytes = await fixture({ ...validManifest, size: CHUNK_BYTES + 1 }, [
      { bytes: new Uint8Array(CHUNK_BYTES + 1), tag: 3 },
    ]);
    await expect(decryptContainer(network(bytes), key)).rejects.toThrow();
    const small = await fixture();
    await expect(
      decryptContainer(network(small), key, { size: 4 }),
    ).rejects.toThrow();
    await expect(
      decryptContainer(network(small), key, {
        encryptedSize: small.length + 1,
      }),
    ).rejects.toThrow();
    await expect(
      decryptContainer(network(small), key, {
        encryptedSize: small.length - 1,
      }),
    ).rejects.toThrow();
  });

  it("limits encrypted overhead even for authenticated tiny data records", async () => {
    const count = 3_200;
    const bytes = await fixture(
      { ...validManifest, size: count },
      Array.from({ length: count }, (_, i) => ({
        bytes: new Uint8Array([1]),
        tag: i === count - 1 ? 3 : 0,
      })),
    );
    await expect(
      decryptContainer(network(bytes, [128]), key),
    ).rejects.toThrow();
  });

  it("aborts encryption between chunks and cancels a waiting download reader", async () => {
    const encryptAbort = new AbortController();
    await expect(
      encryptContainer(new File([new Uint8Array(CHUNK_BYTES + 1)], "file"), {
        signal: encryptAbort.signal,
        onProgress: (p) => {
          if (p.loaded > 0) encryptAbort.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const downloadAbort = new AbortController();
    let cancelled = false;
    const hanging = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const pending = decryptContainer(hanging, key, {
      signal: downloadAbort.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    downloadAbort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });

  it("returns active file types only as a Blob", async () => {
    const result = await decryptContainer(
      network(
        await fixture({ ...validManifest, size: 9, type: "text/html" }, [
          { bytes: encoder.encode("<script>!"), tag: 3 },
        ]),
      ),
      key,
    );
    expect(result.blob).toBeInstanceOf(Blob);
    expect(await result.blob.text()).toBe("<script>!");
  });

  it("does not wait for a stalled network cancellation hook", async () => {
    const controller = new AbortController();
    const input = new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(() => {}),
    });
    const pending = decryptContainer(input, key, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(input.locked).toBe(false);
  });

  it("cancels its input when the signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      decryptContainer(input, key, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(input.locked).toBe(false);
  });
});

describe("safe file names", () => {
  it.each([
    ["résumé 日本語 🐈.txt", "résumé 日本語 🐈.txt"],
    ["folder/name.txt", "name.txt"],
    ["C:\\folder\\name.txt", "name.txt"],
    ["..", "download"],
    ["", "download"],
    ["CON", "_CON"],
    ["nul.txt", "_nul.txt"],
    ["file. ", "file"],
    ["a\u0000b.txt", "a_b.txt"],
    ["a\u202eb.txt", "a_b.txt"],
  ])("maps %j to one safe leaf", (input, expected) =>
    expect(safeFilename(input)).toBe(expected),
  );

  it("bounds names by UTF-8 bytes without breaking characters", () => {
    const name = safeFilename("語".repeat(100));
    expect(encoder.encode(name).length).toBe(255);
    expect(name).not.toContain("�");
    expect(safeFilename(name)).toBe(name);
  });
});
