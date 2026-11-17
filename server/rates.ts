import { createHmac, randomBytes } from "node:crypto";
import ipaddr from "ipaddr.js";
import { limited } from "./errors";

const HOUR = 3_600_000;
type Bucket = { count: number; until: number };
type Generation = { secret: Buffer; born: number };
export type Network = { current: string; ids: string[] };

// No raw address is stored. Keep two hourly HMAC generations so a rotation
// cannot reset live counters. Each bucket has its own short lifetime.
export class RateCounters {
  private generations: Generation[];
  private entries = new Map<string, Map<string, Bucket>>();
  private global = new Map<string, Bucket>();
  private lastSweep = -Infinity;
  constructor(
    private now: () => number,
    private maxEntries: number,
  ) {
    this.generations = [{ secret: randomBytes(32), born: now() }];
  }

  sweep() {
    const now = this.now();
    // Rotation cannot wait for the map sweep. Otherwise a late old-generation
    // charge could outlive its secret and disappear from the next rate check.
    this.generations = this.generations.filter((g) => {
      if (now - g.born < HOUR * 2) return true;
      g.secret.fill(0);
      return false;
    });
    if (!this.generations.length || now - this.generations[0]!.born >= HOUR)
      this.generations.unshift({ secret: randomBytes(32), born: now });
    if (now - this.lastSweep < 5_000) return;
    this.lastSweep = now;
    for (const [key, buckets] of this.entries) {
      for (const [kind, bucket] of buckets)
        if (bucket.until <= now) buckets.delete(kind);
      if (!buckets.size) this.entries.delete(key);
    }
    for (const [key, bucket] of this.global)
      if (bucket.until <= now) this.global.delete(key);
  }

  identify(address: string): Network {
    this.sweep();
    // IPv4-mapped IPv6 is IPv4. Group IPv6 privacy addresses by /64.
    const parsed = ipaddr.process(address);
    const bytes = parsed.toByteArray();
    if (parsed.kind() === "ipv6") bytes.fill(0, 8);
    const value = Buffer.from(bytes);
    const ids = this.generations.map((g) =>
      createHmac("sha256", g.secret).update(value).digest("hex"),
    );
    return { current: ids[0]!, ids };
  }

  consume(
    network: Network,
    kind: string,
    limit: number,
    window: number,
    cost = 1,
  ) {
    const now = this.now();
    let total = 0;
    let until = now;
    for (const id of network.ids) {
      const bucket = this.entries.get(id)?.get(kind);
      if (bucket && bucket.until > now) {
        total += bucket.count;
        until = Math.max(until, bucket.until);
      }
    }
    if (total + cost > limit)
      throw limited(Math.max(1, Math.ceil((until - now) / 1_000)));
    let buckets = this.entries.get(network.current);
    if (!buckets) {
      if (this.entries.size >= this.maxEntries) throw limited();
      buckets = new Map();
      this.entries.set(network.current, buckets);
    }
    const bucket = buckets.get(kind);
    if (bucket && bucket.until > now) bucket.count += cost;
    else buckets.set(kind, { count: cost, until: now + window });
  }

  consumeGlobal(kind: string, limit: number, window: number, cost = 1) {
    const now = this.now();
    let bucket = this.global.get(kind);
    if (!bucket || bucket.until <= now) {
      bucket = { count: 0, until: now + window };
      this.global.set(kind, bucket);
    }
    if (bucket.count + cost > limit)
      throw limited(Math.max(1, Math.ceil((bucket.until - now) / 1_000)));
    bucket.count += cost;
  }

  // Check both byte budgets before a synchronous claim. A rejected claim or
  // budget check changes neither counter. Accepted attempts keep their full
  // charge even if the stream fails or the transfer is deleted.
  admitTransfer(
    network: Network,
    direction: "upload" | "download",
    networkLimit: number,
    globalLimit: number,
    cost: number,
    claim: () => void,
  ) {
    const now = this.now();
    const kind = direction === "upload" ? "bytes" : "downloadBytes";
    let total = 0;
    let until = now;
    for (const id of network.ids) {
      const bucket = this.entries.get(id)?.get(kind);
      if (bucket && bucket.until > now) {
        total += bucket.count;
        until = Math.max(until, bucket.until);
      }
    }
    if (total + cost > networkLimit)
      throw limited(Math.max(1, Math.ceil((until - now) / 1_000)));
    let buckets = this.entries.get(network.current);
    if (!buckets && this.entries.size >= this.maxEntries) throw limited();
    const global = this.global.get("bytes");
    const globalCount = global && global.until > now ? global.count : 0;
    if (globalCount + cost > globalLimit)
      throw limited(
        Math.max(1, Math.ceil(((global?.until ?? now) - now) / 1_000)),
      );

    // No await may separate these checks, the claim, and the counter updates.
    claim();
    if (!buckets) {
      buckets = new Map();
      this.entries.set(network.current, buckets);
    }
    const bucket = buckets.get(kind);
    if (bucket && bucket.until > now) bucket.count += cost;
    else buckets.set(kind, { count: cost, until: now + HOUR });
    if (global && global.until > now) global.count += cost;
    else this.global.set("bytes", { count: cost, until: now + HOUR });
  }

  clear() {
    this.entries.clear();
    this.global.clear();
    for (const generation of this.generations) generation.secret.fill(0);
    this.generations = [];
  }
}
