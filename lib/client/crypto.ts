import {
  CHUNK_BYTES,
  FORMAT_MAGIC,
  MAX_ENCRYPTED_BYTES,
  MAX_ENCRYPTION_OVERHEAD,
  MAX_MANIFEST_BYTES,
} from "../shared/constants";
import { abortable, checkAbort } from "./errors";
import { decodeKey, generateKey } from "./keys";
import { decodeManifest, encodeManifest, type Manifest } from "./manifest";
import { reportProgress, type ProgressHandler } from "./progress";
import sodium, { releaseState } from "./sodium";

const magic = new TextEncoder().encode(FORMAT_MAGIC);
const HEADER_BYTES = 24;
const AUTH_BYTES = 17;

function invalidContainer(): Error {
  return new Error(
    "The file could not be verified. Check the link and try again.",
  );
}

function prefix(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, length, false);
  return bytes;
}

export interface CryptoOptions {
  signal?: AbortSignal;
  onProgress?: ProgressHandler;
}

export async function encryptContainer(
  file: Blob & { name: string },
  options: CryptoOptions = {},
): Promise<{ blob: Blob; key: string }> {
  const { signal, onProgress } = options;
  checkAbort(signal);
  const manifest = encodeManifest(file);
  await abortable(sodium.ready, signal);
  checkAbort(signal);
  const key = generateKey();
  const keyBytes = decodeKey(key);
  let state: import("libsodium-wrappers").StateAddress | undefined;
  const parts: BlobPart[] = [];
  try {
    const stream =
      sodium.crypto_secretstream_xchacha20poly1305_init_push(keyBytes);
    state = stream.state;
    parts.push(new Blob([magic, new Uint8Array(stream.header)]));
    const addRecord = (plain: Uint8Array, tag: number) => {
      const cipher = sodium.crypto_secretstream_xchacha20poly1305_push(
        state!,
        plain,
        null,
        tag,
      );
      // Keep Blob parts so the final Blob can share their backing storage.
      parts.push(new Blob([prefix(cipher.length), new Uint8Array(cipher)]));
    };
    addRecord(
      manifest,
      sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    );
    reportProgress(onProgress, "encrypting", 0, file.size);
    let offset = 0;
    do {
      checkAbort(signal);
      const end = Math.min(offset + CHUNK_BYTES, file.size);
      const plain = new Uint8Array(
        await abortable(file.slice(offset, end).arrayBuffer(), signal),
      );
      try {
        checkAbort(signal);
        if (plain.length !== end - offset)
          throw new Error("The file could not be read.");
        addRecord(
          plain,
          end === file.size
            ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
            : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
        );
      } finally {
        plain.fill(0);
      }
      offset = end;
      reportProgress(onProgress, "encrypting", offset, file.size);
    } while (offset < file.size);
    checkAbort(signal);
    const blob = new Blob(parts, { type: "application/octet-stream" });
    if (
      blob.size > MAX_ENCRYPTED_BYTES ||
      blob.size > file.size + MAX_ENCRYPTION_OVERHEAD
    ) {
      throw new Error("The encrypted file is too large.");
    }
    return { blob, key };
  } finally {
    keyBytes.fill(0);
    manifest.fill(0);
    releaseState(state);
  }
}

/** Copies only the requested frame; it does not combine whole network buffers. */
class FrameReader {
  private chunk: Uint8Array = new Uint8Array();
  private offset = 0;
  private ended = false;
  received = 0;
  consumed = 0;
  limit: number;

  constructor(
    private reader: ReadableStreamDefaultReader<Uint8Array>,
    private options: DecodeOptions,
  ) {
    this.limit = options.encryptedSize ?? MAX_ENCRYPTED_BYTES;
  }

  private async next(): Promise<boolean> {
    while (this.offset === this.chunk.length && !this.ended) {
      checkAbort(this.options.signal);
      const result = await abortable(this.reader.read(), this.options.signal);
      checkAbort(this.options.signal);
      if (result.done) {
        this.ended = true;
      } else {
        if (!(result.value instanceof Uint8Array)) throw invalidContainer();
        this.received += result.value.length;
        if (this.received > this.limit) throw invalidContainer();
        this.chunk = result.value;
        this.offset = 0;
        reportProgress(
          this.options.onProgress,
          "downloading",
          this.received,
          this.options.encryptedSize ?? this.limit,
        );
      }
    }
    return this.offset < this.chunk.length;
  }

  async read(length: number): Promise<Uint8Array<ArrayBuffer>> {
    if (this.consumed + length > this.limit) throw invalidContainer();
    const bytes = new Uint8Array(length);
    let copied = 0;
    while (copied < length) {
      if (!(await this.next())) throw invalidContainer();
      const count = Math.min(length - copied, this.chunk.length - this.offset);
      bytes.set(this.chunk.subarray(this.offset, this.offset + count), copied);
      this.offset += count;
      this.consumed += count;
      copied += count;
    }
    return bytes;
  }

  async record(maximum: number): Promise<Uint8Array<ArrayBuffer>> {
    const lengthBytes = await this.read(4);
    const length = new DataView(lengthBytes.buffer).getUint32(0, false);
    if (length < AUTH_BYTES || length > maximum + AUTH_BYTES)
      throw invalidContainer();
    return this.read(length);
  }

  async requireEnd(): Promise<void> {
    if (await this.next()) throw invalidContainer();
    if (
      this.options.encryptedSize !== undefined &&
      this.received !== this.options.encryptedSize
    ) {
      throw invalidContainer();
    }
  }
}

export interface DecodeOptions extends CryptoOptions {
  size?: number;
  encryptedSize?: number;
}

export async function decryptContainer(
  input: ReadableStream<Uint8Array>,
  key: string,
  options: DecodeOptions = {},
): Promise<{ blob: Blob; name: string }> {
  const reader = input.getReader();
  let keyBytes: Uint8Array<ArrayBuffer> | undefined;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  let state: import("libsodium-wrappers").StateAddress | undefined;
  let complete = false;
  try {
    checkAbort(options.signal);
    keyBytes = decodeKey(key);
    await abortable(sodium.ready, options.signal);
    checkAbort(options.signal);
    if (
      options.encryptedSize !== undefined &&
      (!Number.isSafeInteger(options.encryptedSize) ||
        options.encryptedSize < 74 ||
        options.encryptedSize > MAX_ENCRYPTED_BYTES)
    ) {
      throw invalidContainer();
    }
    const frames = new FrameReader(reader, options);
    const actualMagic = await frames.read(magic.length);
    if (!actualMagic.every((byte, i) => byte === magic[i]))
      throw invalidContainer();
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
      await frames.read(HEADER_BYTES),
      keyBytes,
    );
    const pull = async (max: number) => {
      checkAbort(options.signal);
      const record = await frames.record(max);
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
        state!,
        record,
      );
      if (!result) throw invalidContainer();
      return result;
    };
    const first = await pull(MAX_MANIFEST_BYTES);
    let manifest: Manifest;
    try {
      if (
        first.tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
      )
        throw invalidContainer();
      manifest = decodeManifest(first.message);
    } finally {
      first.message.fill(0);
    }
    if (options.size !== undefined && manifest.size !== options.size)
      throw invalidContainer();
    frames.limit = Math.min(
      frames.limit,
      manifest.size + MAX_ENCRYPTION_OVERHEAD,
    );
    if (frames.received > frames.limit) throw invalidContainer();
    const parts: Blob[] = [];
    let size = 0;
    let final = false;
    reportProgress(options.onProgress, "decrypting", 0, manifest.size);
    while (!final) {
      const record = await pull(Math.min(CHUNK_BYTES, manifest.size - size));
      try {
        if (
          record.tag !==
            sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE &&
          record.tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        )
          throw invalidContainer();
        final =
          record.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
        if (!final && record.message.length === 0) throw invalidContainer();
        size += record.message.length;
        if (size > manifest.size) throw invalidContainer();
        // Blob snapshots the bytes; decoded content is never inserted in a document.
        parts.push(new Blob([new Uint8Array(record.message)]));
      } finally {
        record.message.fill(0);
      }
      reportProgress(options.onProgress, "decrypting", size, manifest.size);
    }
    if (size !== manifest.size) throw invalidContainer();
    await frames.requireEnd();
    checkAbort(options.signal);
    const blob = new Blob(parts, { type: manifest.type });
    complete = true;
    return { blob, name: manifest.name };
  } catch (error) {
    checkAbort(options.signal);
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw invalidContainer();
  } finally {
    keyBytes?.fill(0);
    releaseState(state);
    options.signal?.removeEventListener("abort", cancel);
    if (!complete) {
      // Cancellation must not wait for a slow underlying network cancel hook.
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
