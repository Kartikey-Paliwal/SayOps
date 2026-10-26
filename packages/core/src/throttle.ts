/**
 * Small in-memory guard for public endpoints that call a rate-limited model on a free tier.
 * Per instance only (serverless instances don't share memory); the model provider's own limits
 * are the hard ceiling. Injectable clock for tests.
 */
export interface ThrottleOptions {
  perMinute: number;
  perDay: number;
  now?: () => number;
}

export type ThrottleVerdict = { ok: true } | { ok: false; retryAfterS: number; reason: "minute" | "day" | "busy" };

export class Throttle {
  private hits = new Map<string, number[]>();
  private busyUntil = 0;
  private readonly now: () => number;

  constructor(private readonly opts: ThrottleOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Checks and, if allowed, records one call for `key` (e.g. a visitor's IP). */
  take(key: string): ThrottleVerdict {
    const t = this.now();
    if (t < this.busyUntil) return { ok: false, retryAfterS: Math.ceil((this.busyUntil - t) / 1000), reason: "busy" };
    const day = 86_400_000;
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < day);
    const lastMinute = list.filter((x) => t - x < 60_000);
    if (list.length >= this.opts.perDay) return { ok: false, retryAfterS: Math.ceil((list[0] + day - t) / 1000), reason: "day" };
    if (lastMinute.length >= this.opts.perMinute) {
      return { ok: false, retryAfterS: Math.ceil((lastMinute[0] + 60_000 - t) / 1000), reason: "minute" };
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 5000) this.hits.delete(this.hits.keys().next().value!); // bound memory
    return { ok: true };
  }

  /** The provider said "too many requests": stop calling it for everyone until then. */
  markBusy(seconds: number): void {
    this.busyUntil = Math.max(this.busyUntil, this.now() + Math.max(1, seconds) * 1000);
  }
}

/** Tiny bounded cache (insertion-ordered), e.g. identical reasons → same result. */
export class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private readonly max = 50) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}
