import { describe, it, expect, vi } from "vitest";
import { Uri } from "vscode";
import { fetchMore, ICachedLog } from "../../../src/historyView/common";
import { buildSvnLogArgs } from "../../../src/historyView/historyFilter";
import { ISvnLogEntry } from "../../../src/common/types";
import { IRemoteRepository } from "../../../src/remoteRepository";

function entry(revision: string): ISvnLogEntry {
  return {
    revision,
    author: "a",
    msg: "m",
    date: "2026-01-01T00:00:00.000000Z",
    paths: []
  } as unknown as ISvnLogEntry;
}

function makeCached(
  repo: Partial<IRemoteRepository>,
  seed: ISvnLogEntry[],
  filter?: ICachedLog["filter"]
): ICachedLog {
  return {
    entries: [...seed],
    revisionSet: new Set(seed.map(e => e.revision)),
    svnTarget: Uri.parse("https://example.com/repo"),
    isComplete: false,
    repo: repo as IRemoteRepository,
    persisted: { commitFrom: "HEAD" },
    filter
  };
}

describe("fetchMore", () => {
  it("passes the chunk-size override to the log call (load-all path)", async () => {
    const log = vi.fn(async () => [entry("2999")]);
    const cached = makeCached({ log }, [entry("3000")]);

    await fetchMore(cached, 500);

    expect(log).toHaveBeenCalledWith(
      "2999",
      "1",
      500,
      expect.anything() // svnTarget
    );
    expect(cached.entries.map(e => e.revision)).toEqual(["3000", "2999"]);
  });

  it("paginates a date filter below the last revision with a single -r range", async () => {
    const logWithFilter = vi.fn<IRemoteRepository["logWithFilter"]>(
      async () => [entry("2999")]
    );
    const dateFrom = new Date("2024-01-01");
    const cached = makeCached({ logWithFilter }, [entry("3000")], {
      dateFrom
    });

    await fetchMore(cached, 50);

    // fetchMore must hand logWithFilter a filter whose upper bound is the
    // paginated revision while keeping the date lower bound
    const paginated = logWithFilter.mock.calls[0]![0];
    expect(paginated.revisionTo).toBe(2999);
    expect(paginated.dateFrom).toBe(dateFrom);

    // ...and that filter must compile to ONE combined -r range (two -r
    // args made SVN re-fetch the same page forever)
    const args = buildSvnLogArgs(paginated);
    expect(args.filter(a => a === "-r")).toHaveLength(1);
    expect(args[args.indexOf("-r") + 1]).toBe("2999:{2024-01-01}");
  });

  it("marks the cache complete when a page comes back short", async () => {
    const log = vi.fn(async () => [entry("2999"), entry("2998")]);
    const cached = makeCached({ log }, [entry("3000")]);

    await fetchMore(cached, 50);

    expect(cached.isComplete).toBe(true); // 2 < 50: history exhausted
    expect(cached.entries).toHaveLength(3);
  });

  it("flags fullHistory only for unfiltered completion", async () => {
    // Unfiltered + exhausted: entries are the complete history
    const log = vi.fn(async () => [entry("2999")]);
    const unfiltered = makeCached({ log }, [entry("3000")]);
    await fetchMore(unfiltered, 50);
    expect(unfiltered.fullHistory).toBe(true);

    // Filtered + exhausted: entries are a filtered subset, NOT full history
    const logWithFilter = vi.fn<IRemoteRepository["logWithFilter"]>(
      async () => [entry("2999")]
    );
    const filtered = makeCached({ logWithFilter }, [entry("3000")], {
      author: "alice"
    });
    await fetchMore(filtered, 50);
    expect(filtered.isComplete).toBe(true);
    expect(filtered.fullHistory).toBeFalsy();
  });
});
