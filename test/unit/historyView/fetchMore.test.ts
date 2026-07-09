import { describe, it, expect, vi } from "vitest";
import { Uri } from "vscode";
import {
  ensureRevisionLoaded,
  fetchMore,
  fetchNewer,
  ICachedLog
} from "../../../src/historyView/common";
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

describe("fetchMore failure handling", () => {
  it("never marks complete/fullHistory off a failed page", async () => {
    const log = vi.fn(async () => {
      throw new Error("svn: E175002: connection reset");
    });
    const cached = makeCached({ log }, [entry("3000")]);

    await fetchMore(cached, 50);

    // the old catch swallowed this, then needFetch([],...) claimed the
    // history was complete AND full - silently truncating it forever
    expect(cached.isComplete).toBe(false);
    expect(cached.fullHistory).toBeFalsy();
    expect(cached.lastFetchFailed).toBe(true);
  });

  it("clears the failure flag on the next successful page", async () => {
    let fail = true;
    const log = vi.fn(async () => {
      if (fail) throw new Error("svn: E175002: connection reset");
      return [entry("2999")];
    });
    const cached = makeCached({ log }, [entry("3000")]);

    await fetchMore(cached, 50);
    fail = false;
    await fetchMore(cached, 50);

    expect(cached.lastFetchFailed).toBe(false);
    expect(cached.entries.map(e => e.revision)).toEqual(["3000", "2999"]);
  });
});

describe("fetchMore pagination cursor", () => {
  function entryWithAction(revision: string, action: string): ISvnLogEntry {
    return {
      revision,
      author: "a",
      msg: "m",
      date: "2026-01-01T00:00:00.000000Z",
      paths: [{ _: "/f", action } as never]
    } as unknown as ISvnLogEntry;
  }

  it("advances past pages fully dropped by the action filter", async () => {
    // newest 50 commits contain no deletion; r2950 has one
    const log = vi.fn(async (rfrom: string) => {
      const start = rfrom === "HEAD" ? 3000 : parseInt(rfrom, 10);
      const out: ISvnLogEntry[] = [];
      for (let r = start; r > start - 50; r--) {
        out.push(entryWithAction(String(r), r === 2950 ? "D" : "M"));
      }
      return out;
    });
    const cached = makeCached({ log }, [], { actions: ["D"] });

    await fetchMore(cached, 50); // 3000..2951: all filtered out
    expect(cached.entries).toHaveLength(0);
    expect(cached.isComplete).toBe(false);

    await fetchMore(cached, 50); // MUST resume below 2951, not at HEAD

    expect(log).toHaveBeenLastCalledWith("2950", "1", 50, expect.anything());
    expect(cached.entries.map(e => e.revision)).toEqual(["2950"]);
  });

  it("stops instead of emitting an inverted range below revisionFrom", async () => {
    const logWithFilter = vi.fn<IRemoteRepository["logWithFilter"]>(
      async () => []
    );
    // page boundary landed exactly on the filter's lower bound
    const cached = makeCached({ logWithFilter }, [entry("100")], {
      revisionFrom: 100,
      revisionTo: 199
    });

    await fetchMore(cached, 100);

    // -r 99:100 would fetch r99 - OUTSIDE the user's range
    expect(logWithFilter).not.toHaveBeenCalled();
    expect(cached.isComplete).toBe(true);
  });
});

describe("ensureRevisionLoaded (goToRevision auto-fetch)", () => {
  /** repo.log mock serving contiguous descending pages of `pageSize`. */
  function pagedRepo(pageSize: number) {
    return {
      log: vi.fn(async (rfrom: string) => {
        const start = rfrom === "HEAD" ? 3000 : parseInt(rfrom, 10);
        const out: ISvnLogEntry[] = [];
        for (let r = start; r > Math.max(start - pageSize, 0); r--) {
          out.push(entry(String(r)));
        }
        return out;
      })
    };
  }

  it("pages older history until the target revision is loaded", async () => {
    const repo = pagedRepo(500);
    const cached = makeCached(repo, [entry("3000")]);
    cached.revisionSet.add("3000");

    const found = await ensureRevisionLoaded(cached, 1750, 500);

    expect(found).toBe(true);
    expect(cached.revisionSet.has("1750")).toBe(true);
    // 3000 -> needs to reach 1750: 3 pages of 500
    expect(repo.log).toHaveBeenCalledTimes(3);
  });

  it("stops as soon as paging passes the target (monotonic bound)", async () => {
    // Pages skip the target: 3000..2001 then 2000..1001 - but the repo's
    // log for this path never contains r1500 (sparse subtree history)
    const repo = {
      log: vi.fn(async (rfrom: string) => {
        const start = rfrom === "HEAD" ? 3000 : parseInt(rfrom, 10);
        const out: ISvnLogEntry[] = [];
        for (let r = start; r > start - 1000; r -= 2) {
          out.push(entry(String(r))); // even revisions only
        }
        return out;
      })
    };
    const cached = makeCached(repo, [entry("3000")]);
    cached.revisionSet.add("3000");

    const found = await ensureRevisionLoaded(cached, 1501, 1000);

    expect(found).toBe(false);
    // once lastRev <= 1501 the loop must stop - no scan to r1
    expect(repo.log.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("respects the shouldContinue cancellation hook", async () => {
    const repo = pagedRepo(500);
    const cached = makeCached(repo, [entry("3000")]);
    cached.revisionSet.add("3000");

    const found = await ensureRevisionLoaded(cached, 100, 500, () => false);

    expect(found).toBe(false);
    expect(repo.log).not.toHaveBeenCalled();
  });
});

describe("fetchNewer (incoming revisions preview)", () => {
  it("prepends server revisions newer than the cached head", async () => {
    const log = vi.fn(async () => [entry("3002"), entry("3001")]);
    const cached = makeCached({ log }, [entry("3000"), entry("2999")]);
    cached.entries.forEach(e => cached.revisionSet.add(e.revision));

    const added = await fetchNewer(cached);

    expect(log).toHaveBeenCalledWith(
      "HEAD",
      "3001",
      expect.any(Number),
      expect.anything()
    );
    expect(added).toBe(2);
    expect(cached.entries.map(e => e.revision)).toEqual([
      "3002",
      "3001",
      "3000",
      "2999"
    ]);
  });

  it("returns 0 when the server has nothing newer (range error)", async () => {
    const log = vi.fn(async () => {
      throw new Error("svn: E160006: No such revision 3001");
    });
    const cached = makeCached({ log }, [entry("3000")]);
    cached.revisionSet.add("3000");

    expect(await fetchNewer(cached)).toBe(0);
    expect(cached.entries).toHaveLength(1);
  });

  it("rethrows real errors instead of claiming 'nothing newer'", async () => {
    const log = vi.fn(async () => {
      throw new Error("svn: E170013: Unable to connect to a repository");
    });
    const cached = makeCached({ log }, [entry("3000")]);
    cached.revisionSet.add("3000");

    // a swallowed network error here became a false positive
    // "History already shows the latest server revisions"
    await expect(fetchNewer(cached)).rejects.toThrow(/E170013/);
  });

  it("dedupes overlap with already-cached revisions", async () => {
    const log = vi.fn(async () => [entry("3001"), entry("3000")]);
    const cached = makeCached({ log }, [entry("3000")]);
    cached.revisionSet.add("3000");

    expect(await fetchNewer(cached)).toBe(1);
    expect(cached.entries.map(e => e.revision)).toEqual(["3001", "3000"]);
  });
});
