import { describe, expect, it } from "vitest";
import {
  createShareUrl,
  decodeKey,
  encodeKey,
  generateKey,
  parseShareKey,
} from "./keys";

const id = "0123456789abcdef0123456789abcdef";
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("share keys", () => {
  it("creates canonical 32-byte keys", () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateKey()));
    expect(keys.size).toBe(100);
    for (const value of keys) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(decodeKey(value)).toHaveLength(32);
      expect(encodeKey(decodeKey(value))).toBe(value);
    }
  });

  it("reads a bare fragment or a hash fragment", () => {
    expect(parseShareKey(key)).toBe(key);
    expect(parseShareKey(`#${key}`)).toBe(key);
  });

  it.each([
    "",
    "#",
    "#key=" + key,
    key + "=",
    key.slice(1),
    key + "A",
    " " + key,
    key.slice(0, -1) + "B",
    key.replace(/A/g, "+"),
    "%41" + key.slice(1),
    "##" + key,
  ])("rejects missing, padded, noncanonical, or encoded key %j", (bad) => {
    expect(() => parseShareKey(bad)).toThrow();
  });

  it("puts only the encryption key in the share fragment", () => {
    const url = new URL(
      createShareUrl(id, key, "https://passing.cloud/path?ignored=1"),
    );
    expect(url.pathname).toBe(`/t/${id}`);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${key}`);
    expect(`${url.origin}${url.pathname}${url.search}`).not.toContain(key);
  });

  it("rejects unsafe origins and ids", () => {
    for (const origin of [
      "javascript:alert(1)",
      "file:///file",
      "https://user:password@host.test",
    ]) {
      expect(() => createShareUrl(id, key, origin)).toThrow();
    }
    expect(() =>
      createShareUrl("../other", key, "https://passing.cloud"),
    ).toThrow();
  });
});
