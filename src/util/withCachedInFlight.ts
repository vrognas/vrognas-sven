// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { LRUCache } from "./lruCache";

/**
 * Run an async factory with cache + in-flight dedup keyed by `key`.
 *
 * Lookup order:
 *   1. Cache hit  → return immediately, no work.
 *   2. In-flight  → return the pending promise (concurrent dedup).
 *   3. Otherwise  → invoke `factory`, cache on success, always clean up
 *                   the in-flight entry.
 *
 * Use when the same async call may be issued repeatedly for the same key
 * by independent code paths and you want both concurrent and short-window
 * sequential callers to share one execution.
 */
export function withCachedInFlight<V>(
  key: string,
  cache: LRUCache<V>,
  inFlight: Map<string, Promise<V>>,
  factory: () => Promise<V>,
  ttlOverrideMs?: number
): Promise<V> {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }
  const promise = (async () => {
    try {
      const result = await factory();
      cache.set(key, result, ttlOverrideMs);
      return result;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}
