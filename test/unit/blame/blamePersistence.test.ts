import { describe, it, expect, beforeEach } from "vitest";
import {
  initBlamePersistence,
  getPersistedBlame,
  persistBlame
} from "../../../src/blame/blamePersistence";
import { ISvnBlameLine } from "../../../src/common/types";

/**
 * svn blame is the slowest command the extension runs (full file history
 * over the network) and its result is IMMUTABLE once keyed to a pinned
 * revision. The in-memory cache dies on every window reload and on every
 * mutating operation's clearBlameCache - this workspaceState-backed layer
 * makes revision-pinned blame survive both.
 */

function makeMemento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      (store.get(key) as T) ?? defaultValue,
    update: async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    },
    keys: () => [...store.keys()],
    store
  };
}

const lines = (rev: string): ISvnBlameLine[] => [
  { lineNumber: 1, revision: rev, author: "a", date: "2026-01-01" } as never
];

describe("blamePersistence", () => {
  let memento: ReturnType<typeof makeMemento>;

  beforeEach(() => {
    memento = makeMemento();
    initBlamePersistence(memento as never);
  });

  it("round-trips revision-pinned blame across a 'restart'", () => {
    persistBlame("http://srv/repo/trunk|src/f.R@42", lines("42"));

    // Simulate window reload: fresh init over the same memento
    initBlamePersistence(memento as never);

    expect(getPersistedBlame("http://srv/repo/trunk|src/f.R@42")).toEqual(
      lines("42")
    );
  });

  it("refuses keys not pinned to a numeric revision (mutable data)", () => {
    persistBlame("http://srv/repo/trunk|src/f.R@BASE", lines("42"));

    expect(
      getPersistedBlame("http://srv/repo/trunk|src/f.R@BASE")
    ).toBeUndefined();
  });

  it("evicts the least recently used entry at capacity", () => {
    for (let i = 0; i < 41; i++) {
      persistBlame(`http://srv/repo|f${i}.R@${100 + i}`, lines(String(i)));
    }

    // 40-entry cap: the first key is gone, the newest survives
    expect(getPersistedBlame("http://srv/repo|f0.R@100")).toBeUndefined();
    expect(getPersistedBlame("http://srv/repo|f40.R@140")).toBeDefined();
  });
});
