// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { Memento } from "vscode";
import { ISvnBlameLine } from "../common/types";

/**
 * workspaceState-backed store for revision-pinned blame results.
 *
 * `svn blame` is the slowest command the extension runs (it pulls the
 * file's entire revision history from the server) and its result is
 * IMMUTABLE once keyed to a pinned numeric revision - yet the in-memory
 * cache dies on every window reload and on every mutating operation's
 * conservative clearBlameCache. This layer survives both, so a file is
 * blamed over the network once per revision, not once per session.
 *
 * Keys are `<branch URL>|<relative path>@<numeric revision>` - the URL
 * disambiguates after `svn switch` (same path, different history).
 */

const STORAGE_KEY = "sven.blameCache.v1";
const MAX_ENTRIES = 40;
/** Huge files would bloat workspaceState for little hit-rate */
const MAX_LINES = 20_000;

interface IPersistedBlame {
  /** LRU order, oldest first */
  order: string[];
  entries: Record<string, ISvnBlameLine[]>;
}

let memento: Memento | undefined;
let store: IPersistedBlame | undefined;

const isRevisionPinned = (key: string) => /@\d+$/.test(key);

export function initBlamePersistence(target: Memento): void {
  memento = target;
  const raw = target.get<IPersistedBlame>(STORAGE_KEY);
  // Defensive: discard malformed persisted shapes from older versions
  store =
    raw &&
    Array.isArray(raw.order) &&
    typeof raw.entries === "object" &&
    raw.entries !== null
      ? raw
      : { order: [], entries: {} };
}

export function getPersistedBlame(key: string): ISvnBlameLine[] | undefined {
  if (!store || !isRevisionPinned(key)) {
    return undefined;
  }
  const hit = store.entries[key];
  if (hit) {
    // LRU touch in memory only; flushed with the next write
    const i = store.order.indexOf(key);
    if (i !== -1) {
      store.order.splice(i, 1);
      store.order.push(key);
    }
  }
  return hit;
}

export function persistBlame(key: string, lines: ISvnBlameLine[]): void {
  if (
    !store ||
    !memento ||
    !isRevisionPinned(key) ||
    lines.length > MAX_LINES
  ) {
    return;
  }
  const i = store.order.indexOf(key);
  if (i !== -1) {
    store.order.splice(i, 1);
  }
  store.order.push(key);
  store.entries[key] = lines;
  while (store.order.length > MAX_ENTRIES) {
    const evicted = store.order.shift()!;
    delete store.entries[evicted];
  }
  // Fire-and-forget: persistence is a best-effort accelerator
  void memento.update(STORAGE_KEY, store);
}
