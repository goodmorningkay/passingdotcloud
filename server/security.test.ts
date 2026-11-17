import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { RateCounters } from "./rates";
import { hashToken, tokenMatches } from "./store";

describe("production configuration", () => {
  it("requires a secure explicit origin and restricted explicit proxy trust", () => {
    for (const env of [
      { NODE_ENV: "production" },
      {
        NODE_ENV: "production",
        PASSING_PUBLIC_ORIGIN: "https://passing.cloud",
      },
      {
        NODE_ENV: "production",
        PASSING_PUBLIC_ORIGIN: "http://passing.cloud",
        PASSING_TRUST_PROXY: "none",
      },
      { PASSING_PUBLIC_ORIGIN: "https://passing.cloud/path" },
      { PASSING_TRUST_PROXY: "true" },
      { PASSING_TRUST_PROXY: "1" },
      { PASSING_TRUST_PROXY: "loopback" },
      { PASSING_TRUST_PROXY: "127.0.0.1,evil" },
      { PASSING_TRUST_PROXY: "0.0.0.0/0" },
      { PASSING_TRUST_PROXY: "::/0" },
      { PASSING_API_PORT: "65536" },
      { PASSING_STORAGE_BYTES: "NaN" },
    ])
      expect(() => loadConfig(env)).toThrow();
    expect(
      loadConfig({
        NODE_ENV: "production",
        PASSING_PUBLIC_ORIGIN: "https://passing.cloud",
        PASSING_TRUST_PROXY: "127.0.0.1,::1/128",
      }).trustProxy,
    ).toEqual(["127.0.0.1", "::1/128"]);
  });
});

describe("capabilities and temporary network counters", () => {
  it("keeps a live report budget when key rotation falls between map sweeps", () => {
    const hour = 3_600_000;
    let now = 0;
    const rates = new RateCounters(() => now, 10);
    now = hour - 1;
    rates.identify("192.0.2.1");
    now = hour + 1_000;
    rates.consume(rates.identify("192.0.2.1"), "reports", 3, hour, 3);
    now = 2 * hour + 1;
    expect(() =>
      rates.consume(rates.identify("192.0.2.1"), "reports", 3, hour),
    ).toThrow();
  });
  it("checks exact hashed capabilities", () => {
    const token = "A".repeat(43);
    expect(tokenMatches(token, hashToken(token))).toBe(true);
    expect(tokenMatches("B".repeat(43), hashToken(token))).toBe(false);
    expect(tokenMatches(undefined, null)).toBe(false);
    expect(tokenMatches(token + "=", hashToken(token))).toBe(false);
  });
  it("groups IPv6 /64 addresses and mapped IPv4 addresses", () => {
    const rates = new RateCounters(Date.now, 10);
    expect(rates.identify("2001:db8:1234:5678::1").current).toBe(
      rates.identify("2001:db8:1234:5678:abcd::1").current,
    );
    expect(rates.identify("::ffff:192.0.2.1").current).toBe(
      rates.identify("192.0.2.1").current,
    );
    expect(rates.identify("192.0.2.1").current).not.toContain("192.0.2.1");
  });
  it("bounds memory, expires counters, and carries live budgets across key rotation", () => {
    let now = 0;
    const rates = new RateCounters(() => now, 2);
    const first = rates.identify("192.0.2.1");
    now = 3_590_000;
    rates.consume(first, "bytes", 10, 3_600_000, 10);
    now = 3_600_001;
    const rotated = rates.identify("192.0.2.1");
    expect(rotated.current).not.toBe(first.current);
    expect(() => rates.consume(rotated, "bytes", 10, 3_600_000)).toThrow();
    rates.consume(rates.identify("192.0.2.2"), "request", 10, 60_000);
    expect(() =>
      rates.consume(rates.identify("192.0.2.3"), "request", 10, 60_000),
    ).toThrow();
    now += 3_600_000;
    rates.sweep();
    expect(() =>
      rates.consume(rates.identify("192.0.2.3"), "request", 10, 60_000),
    ).not.toThrow();
  });
});
