import { HttpError } from "./errors";

/**
 * Small in-memory rate limiter: at most `max` hits per `windowMs` per key.
 * One API process only — a multi-server deployment moves this to Redis/Postgres.
 */
export function limiter(max: number, windowMs: number, message = "Too many attempts — please wait a few minutes and try again") {
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();
  const check = (key: string) => {
    const now = Date.now();
    // Drop expired keys now and then, instead of forgetting everyone at once.
    if (now - lastSweep > windowMs || hits.size > 50_000) {
      for (const [k, list] of hits) if (!list.length || now - list[list.length - 1] >= windowMs) hits.delete(k);
      lastSweep = now;
    }
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      const retry = Math.ceil((windowMs - (now - list[0])) / 1000);
      throw new HttpError(429, message, { "retry-after": String(retry) });
    }
    list.push(now);
    hits.set(key, list);
  };
  /** Forget a key (e.g. after a successful login). */
  check.reset = (key: string) => void hits.delete(key);
  return check;
}
