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
  // Owner guard: if the in-flight registry was cleared or superseded
  // while fetching (e.g. repository disposal cleared the caches), the
  // result must not repopulate the cleared cache. Boxed so the closure
  // can reference the promise created below.
  const owner: { promise?: Promise<V> } = {};
  const stillOwner = () =>
    owner.promise !== undefined && inFlight.get(key) === owner.promise;
  const promise = (async () => {
    try {
      const result = await factory();
      if (stillOwner()) {
        cache.set(key, result, ttlOverrideMs);
      }
      return result;
    } finally {
      if (stillOwner()) {
        inFlight.delete(key);
      }
    }
  })();
  owner.promise = promise;
  inFlight.set(key, promise);
  return promise;
}
