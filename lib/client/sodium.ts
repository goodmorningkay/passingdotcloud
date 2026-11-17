// 0.7.16 has a broken ESM entry (it imports a missing sibling libsodium.mjs).
// A static require selects its working, locally bundled CommonJS export in Next.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sodium: typeof import("libsodium-wrappers") = require("libsodium-wrappers");

export default sodium;

export function releaseState(
  state: import("libsodium-wrappers").StateAddress | undefined,
): void {
  if (state === undefined) return;
  // The wrappers allocate stream state in the WASM heap and do not free it.
  // These raw exports belong to the pinned 0.7.16 library, not a remote script.
  const raw = (
    sodium as unknown as {
      libsodium: {
        HEAPU8: Uint8Array;
        _crypto_secretstream_xchacha20poly1305_statebytes(): number;
        _free(address: number): void;
      };
    }
  ).libsodium;
  const address = state as unknown as number;
  raw.HEAPU8.fill(
    0,
    address,
    address + raw._crypto_secretstream_xchacha20poly1305_statebytes(),
  );
  raw._free(address);
}
