import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  HistoryFilterService,
  IHistoryFilter,
  buildSvnLogArgs,
  filterEntriesByAction,
  hasTextSearchFilter
} from "../../../src/historyView/historyFilter";
import { ISvnLogEntry, ISvnLogEntryPath } from "../../../src/common/types";

describe("HistoryFilterService", () => {
  let service: HistoryFilterService;

  beforeEach(() => {
    service = new HistoryFilterService();
  });

  describe("filter state management", () => {
    it("starts with no active filter", () => {
      expect(service.hasActiveFilter()).toBe(false);
      expect(service.getFilter()).toBeUndefined();
    });

    it("sets filter and emits change event", () => {
      const listener = vi.fn();
      service.onDidChangeFilter(listener);

      const filter: IHistoryFilter = { message: "bugfix" };
      service.setFilter(filter);

      expect(service.hasActiveFilter()).toBe(true);
      expect(service.getFilter()).toEqual(filter);
      expect(listener).toHaveBeenCalledWith(filter);
    });

    it("clears filter and emits change event", () => {
      const listener = vi.fn();
      service.setFilter({ message: "test" });

      service.onDidChangeFilter(listener);
      service.clearFilter();

      expect(service.hasActiveFilter()).toBe(false);
      expect(service.getFilter()).toBeUndefined();
      expect(listener).toHaveBeenCalledWith(undefined);
    });

    it("updates partial filter fields", () => {
      service.setFilter({ message: "test", author: "john" });
      service.updateFilter({ author: "jane" });

      expect(service.getFilter()).toEqual({ message: "test", author: "jane" });
    });
  });

  describe("filter description", () => {
    it("returns empty string for no filter", () => {
      expect(service.getFilterDescription()).toBe("");
    });

    it("describes single filter", () => {
      service.setFilter({ message: "bugfix" });
      expect(service.getFilterDescription()).toContain("message");
    });

    it("describes multiple filters", () => {
      service.setFilter({ message: "bugfix", author: "john" });
      const desc = service.getFilterDescription();
      expect(desc).toContain("message");
      expect(desc).toContain("author");
    });
  });

  describe("short filter description for tree view", () => {
    it("returns empty string for no filter", () => {
      expect(service.getShortDescription()).toBe("");
    });

    it("shows single filter concisely", () => {
      service.setFilter({ author: "john" });
      expect(service.getShortDescription()).toBe("author:john");
    });

    it("shows multiple filters with separator", () => {
      service.setFilter({ author: "john", message: "fix" });
      const desc = service.getShortDescription();
      expect(desc).toContain("author:john");
      expect(desc).toContain("msg:fix");
    });

    it("truncates long values", () => {
      service.setFilter({ message: "very long commit message text" });
      const desc = service.getShortDescription();
      expect(desc.length).toBeLessThan(35);
      expect(desc).toContain("...");
    });

    it("shows action types as letters", () => {
      service.setFilter({ actions: ["A", "M"] });
      expect(service.getShortDescription()).toBe("actions:A,M");
    });

    it("shows revision range compactly", () => {
      service.setFilter({ revisionFrom: 100, revisionTo: 200 });
      expect(service.getShortDescription()).toBe("rev:100-200");
    });
  });
});

describe("hasTextSearchFilter", () => {
  it("returns false for empty filter", () => {
    expect(hasTextSearchFilter({})).toBe(false);
  });

  it("returns false for undefined filter", () => {
    expect(hasTextSearchFilter(undefined)).toBe(false);
  });

  it("returns true for author filter", () => {
    expect(hasTextSearchFilter({ author: "john" })).toBe(true);
  });

  it("returns true for message filter", () => {
    expect(hasTextSearchFilter({ message: "bugfix" })).toBe(true);
  });

  it("returns true for path filter", () => {
    expect(hasTextSearchFilter({ path: "src/" })).toBe(true);
  });

  it("returns false for revision-only filter", () => {
    expect(hasTextSearchFilter({ revisionFrom: 100, revisionTo: 200 })).toBe(
      false
    );
  });

  it("returns false for date-only filter", () => {
    expect(
      hasTextSearchFilter({
        dateFrom: new Date("2024-01-01"),
        dateTo: new Date("2024-12-31")
      })
    ).toBe(false);
  });

  it("returns false for action-only filter (client-side)", () => {
    expect(hasTextSearchFilter({ actions: ["A", "M"] })).toBe(false);
  });

  it("returns true when mixed with revision filter", () => {
    expect(hasTextSearchFilter({ author: "john", revisionFrom: 100 })).toBe(
      true
    );
  });
});

describe("buildSvnLogArgs", () => {
  it("returns empty array for no filter", () => {
    expect(buildSvnLogArgs({})).toEqual([]);
  });

  it("builds --search arg for message filter", () => {
    const args = buildSvnLogArgs({ message: "bugfix" });
    expect(args).toContain("--search");
    expect(args).toContain("bugfix");
  });

  it("builds --search arg for author filter", () => {
    const args = buildSvnLogArgs({ author: "john" });
    expect(args).toContain("--search");
    expect(args).toContain("john");
  });

  it("builds --search arg for path filter", () => {
    const args = buildSvnLogArgs({ path: "src/utils" });
    expect(args).toContain("--search");
    expect(args).toContain("src/utils");
  });

  it("builds -r arg for revision range", () => {
    const args = buildSvnLogArgs({ revisionFrom: 100, revisionTo: 200 });
    expect(args).toContain("-r");
    expect(args).toContain("200:100");
  });

  it("builds -r arg for date range", () => {
    const dateFrom = new Date("2024-01-01");
    const dateTo = new Date("2024-12-31");
    const args = buildSvnLogArgs({ dateFrom, dateTo });
    expect(args).toContain("-r");
    expect(args[args.indexOf("-r") + 1]).toMatch(/\{.*\}:\{.*\}/);
  });

  it("combines multiple --search args", () => {
    const args = buildSvnLogArgs({ message: "fix", author: "john" });
    const searchCount = args.filter(a => a === "--search").length;
    expect(searchCount).toBe(2);
  });

  it("does not include action filter in args (client-side only)", () => {
    const args = buildSvnLogArgs({ actions: ["A", "M"] });
    expect(args).toEqual([]);
  });

  it("emits a SINGLE -r range when both revision and date bounds set", () => {
    // The load-more pagination adds revisionTo to a date filter; two -r
    // args would make SVN treat them as separate ranges and the page
    // never advances within the date window
    const args = buildSvnLogArgs({
      revisionTo: 2999,
      dateFrom: new Date("2024-01-01")
    });
    expect(args.filter(a => a === "-r").length).toBe(1);
    // upper bound = paginated revision, lower bound = date window start
    expect(args[args.indexOf("-r") + 1]).toBe("2999:{2024-01-01}");
  });

  it("date-only range still spans dateTo down to dateFrom", () => {
    const args = buildSvnLogArgs({
      dateFrom: new Date("2024-01-01"),
      dateTo: new Date("2024-12-31")
    });
    expect(args.filter(a => a === "-r").length).toBe(1);
    expect(args[args.indexOf("-r") + 1]).toBe("{2024-12-31}:{2024-01-01}");
  });
});

describe("filterEntriesByAction", () => {
  const entries: ISvnLogEntry[] = [
    createEntryWithPaths("1", "john", "add files", [
      { _: "/trunk/new.txt", action: "A", kind: "file" }
    ]),
    createEntryWithPaths("2", "jane", "modify files", [
      { _: "/trunk/old.txt", action: "M", kind: "file" }
    ]),
    createEntryWithPaths("3", "john", "delete files", [
      { _: "/trunk/obsolete.txt", action: "D", kind: "file" }
    ]),
    createEntryWithPaths("4", "jane", "mixed changes", [
      { _: "/trunk/a.txt", action: "A", kind: "file" },
      { _: "/trunk/b.txt", action: "M", kind: "file" }
    ]),
    createEntryWithPaths("5", "john", "rename file", [
      {
        _: "/trunk/renamed.txt",
        action: "A",
        kind: "file",
        copyfromPath: "/trunk/original.txt",
        copyfromRev: "100"
      }
    ]),
    createEntryWithPaths("6", "jane", "replace file", [
      { _: "/trunk/replaced.txt", action: "R", kind: "file" }
    ])
  ];

  it("returns all entries when no action filter", () => {
    const result = filterEntriesByAction(entries, undefined);
    expect(result).toHaveLength(6);
  });

  it("filters by single action type", () => {
    const result = filterEntriesByAction(entries, ["A"]);
    expect(result).toHaveLength(2); // entries 1 and 4 have plain "A" actions
    expect(result.map(e => e.revision)).toEqual(["1", "4"]);
  });

  it("filters by multiple action types", () => {
    const result = filterEntriesByAction(entries, ["A", "D"]);
    expect(result).toHaveLength(3); // entries 1, 3, and 4
  });

  it("filters renamed files (A with copyfromPath) with R action", () => {
    const result = filterEntriesByAction(entries, ["R"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.revision).toBe("5");
  });

  it("filters replaced files (SVN R action) with ! action", () => {
    const result = filterEntriesByAction(entries, ["!"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.revision).toBe("6");
  });

  it("returns empty array when no matches", () => {
    // Only entry 6 has replaced action
    expect(
      filterEntriesByAction(
        entries.filter(e => e.revision !== "6"),
        ["!"]
      )
    ).toHaveLength(0);
  });
});

// Helper functions
function createEntryWithPaths(
  revision: string,
  author: string,
  msg: string,
  paths: ISvnLogEntryPath[]
): ISvnLogEntry {
  return {
    revision,
    author,
    msg,
    date: new Date().toISOString(),
    paths
  };
}
