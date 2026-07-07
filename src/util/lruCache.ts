// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

/**
 * Generic LRU cache with TTL expiration.
 * Automatically evicts least-recently-used entries when maxSize is reached.
 */
export class LRUCache<T> {
  private cache = new Map<
    string,
    { value: T; timeout: NodeJS.Timeout; lastAccessed: number }
  >();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number
  ) {}

  /**
   * Get cached value, updating access time on hit.
   * Returns undefined if key not found.
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastAccessed = Date.now();
      return entry.value;
    }
    return undefined;
  }

  /**
   * Check if key exists in cache.
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Get raw entry (for null value checks).
   * Updates access time on hit.
   */
  getEntry(key: string): { value: T; lastAccessed: number } | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastAccessed = Date.now();
      return { value: entry.value, lastAccessed: entry.lastAccessed };
    }
    return undefined;
  }

  /**
   * Set value with automatic TTL and LRU eviction.
   * @param ttlOverrideMs Per-entry TTL replacing the cache default - use
   *        for values that are immutable (e.g. revision-pinned SVN
   *        content) and can safely outlive the mutable-data TTL.
   */
  set(key: string, value: T, ttlOverrideMs?: number): void {
    // Evict existing entry if present (clear its timeout)
    this.delete(key);

    // Evict LRU if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    const timeout = setTimeout(() => {
      this.delete(key);
    }, ttlOverrideMs ?? this.ttlMs);

    this.cache.set(key, {
      value,
      timeout,
      lastAccessed: Date.now()
    });
  }

  /**
   * Delete entry, clearing its timeout.
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      clearTimeout(entry.timeout);
      this.cache.delete(key);
      return true;
    }
    return false;
  }

  /**
   * Clear all entries and their timeouts.
   */
  clear(): void {
    this.cache.forEach(entry => clearTimeout(entry.timeout));
    this.cache.clear();
  }

  /**
   * Current cache size.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Evict the least recently used entry.
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.delete(oldestKey);
    }
  }
}
