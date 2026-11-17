import { MAX_FILE_BYTES, MAX_MANIFEST_BYTES } from "../shared/constants";

export interface Manifest {
  version: 1;
  name: string;
  size: number;
  type: string;
}

const encoder = new TextEncoder();
const mimePattern =
  /^(?:[a-zA-Z0-9!#$%&'*+.^_`|~-]+\/[a-zA-Z0-9!#$%&'*+.^_`|~-]+)?$/;

export function safeFilename(input: string): string {
  let name = input.split(/[\\/]/).at(-1) ?? "";
  name = name
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g,
      "_",
    )
    .replace(/[. ]+$/g, "");
  // A round trip also removes lone UTF-16 surrogates.
  name = new TextDecoder().decode(encoder.encode(name));
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    name = `_${name}`;
  let bounded = "";
  let bytes = 0;
  for (const character of name) {
    const length = encoder.encode(character).length;
    if (bytes + length > 255) break;
    bounded += character;
    bytes += length;
  }
  return bounded.replace(/[. ]+$/g, "") || "download";
}

export function validateFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
    throw new Error("The file size must be 100 MB or less.");
  }
}

export function validateManifest(value: unknown): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid manifest.");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "name,size,type,version" ||
    record.version !== 1
  ) {
    throw new Error("Invalid manifest.");
  }
  if (
    typeof record.name !== "string" ||
    safeFilename(record.name) !== record.name
  ) {
    throw new Error("Invalid file name.");
  }
  if (typeof record.size !== "number") throw new Error("Invalid file size.");
  validateFileSize(record.size);
  if (
    typeof record.type !== "string" ||
    record.type.length > 255 ||
    !mimePattern.test(record.type)
  ) {
    throw new Error("Invalid file type.");
  }
  return record as unknown as Manifest;
}

export function encodeManifest(
  file: Blob & { name: string },
): Uint8Array<ArrayBuffer> {
  const manifest = validateManifest({
    version: 1,
    name: safeFilename(file.name),
    size: file.size,
    type: file.type,
  });
  const bytes = encoder.encode(JSON.stringify(manifest));
  if (bytes.length > MAX_MANIFEST_BYTES)
    throw new Error("The file details are too long.");
  return bytes;
}

export function decodeManifest(bytes: Uint8Array): Manifest {
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("Invalid manifest.");
  return validateManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}
