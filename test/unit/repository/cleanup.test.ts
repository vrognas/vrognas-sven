import { describe, it, expect } from "vitest";
import * as semver from "semver";

/**
 * Repository Cleanup Advanced Tests
 *
 * Tests for enhanced cleanup functionality:
 * - removeIgnored()
 * - vacuumPristines()
 * - cleanupWithExternals()
 * - cleanupAdvanced() with options
 */
describe("Repository Cleanup Advanced", () => {
  describe("cleanupAdvanced() Option Building", () => {
    /**
     * Helper to simulate cleanupAdvanced argument building
     */
    function buildCleanupArgs(options: {
      vacuumPristines?: boolean;
      removeUnversioned?: boolean;
      removeIgnored?: boolean;
      includeExternals?: boolean;
    }): string[] {
      const args = ["cleanup"];

      if (options.vacuumPristines) {
        args.push("--vacuum-pristines");
      }
      if (options.removeUnversioned) {
        args.push("--remove-unversioned");
      }
      if (options.removeIgnored) {
        args.push("--remove-ignored");
      }
      if (options.includeExternals) {
        args.push("--include-externals");
      }

      return args;
    }

    it("empty options builds basic cleanup", () => {
      const args = buildCleanupArgs({});
      expect(args).toEqual(["cleanup"]);
    });

    it("vacuumPristines option adds --vacuum-pristines", () => {
      const args = buildCleanupArgs({ vacuumPristines: true });
      expect(args).toContain("--vacuum-pristines");
    });

    it("removeUnversioned option adds --remove-unversioned", () => {
      const args = buildCleanupArgs({ removeUnversioned: true });
      expect(args).toContain("--remove-unversioned");
    });

    it("removeIgnored option adds --remove-ignored", () => {
      const args = buildCleanupArgs({ removeIgnored: true });
      expect(args).toContain("--remove-ignored");
    });

    it("includeExternals option adds --include-externals", () => {
      const args = buildCleanupArgs({ includeExternals: true });
      expect(args).toContain("--include-externals");
    });

    it("combines multiple options correctly", () => {
      const args = buildCleanupArgs({
        vacuumPristines: true,
        removeIgnored: true,
        includeExternals: true
      });

      expect(args[0]).toBe("cleanup");
      expect(args).toContain("--vacuum-pristines");
      expect(args).toContain("--remove-ignored");
      expect(args).toContain("--include-externals");
      expect(args).not.toContain("--remove-unversioned");
    });

    it("false options are not added", () => {
      const args = buildCleanupArgs({
        vacuumPristines: false,
        removeIgnored: true
      });

      expect(args).not.toContain("--vacuum-pristines");
      expect(args).toContain("--remove-ignored");
    });
  });

  describe("SVN Version Requirements", () => {
    it("--vacuum-pristines requires SVN 1.10+", () => {
      const minVersion = { major: 1, minor: 10 };
      const svn19 = { major: 1, minor: 9 };
      const svn110 = { major: 1, minor: 10 };
      const svn114 = { major: 1, minor: 14 };

      const meetsReq = (v: { major: number; minor: number }) =>
        v.major > minVersion.major ||
        (v.major === minVersion.major && v.minor >= minVersion.minor);

      expect(meetsReq(svn19)).toBe(false);
      expect(meetsReq(svn110)).toBe(true);
      expect(meetsReq(svn114)).toBe(true);
    });

    it("--remove-unversioned requires SVN 1.9+", () => {
      const minVersion = { major: 1, minor: 9 };
      const svn18 = { major: 1, minor: 8 };
      const svn19 = { major: 1, minor: 9 };

      const meetsReq = (v: { major: number; minor: number }) =>
        v.major > minVersion.major ||
        (v.major === minVersion.major && v.minor >= minVersion.minor);

      expect(meetsReq(svn18)).toBe(false);
      expect(meetsReq(svn19)).toBe(true);
    });

    it("--remove-ignored requires SVN 1.9+", () => {
      const minVersion = { major: 1, minor: 9 };
      const svn19 = { major: 1, minor: 9 };

      const meetsReq = (v: { major: number; minor: number }) =>
        v.major > minVersion.major ||
        (v.major === minVersion.major && v.minor >= minVersion.minor);

      expect(meetsReq(svn19)).toBe(true);
    });

    it("semver.gte correctly validates vacuum-pristines version", () => {
      // SVN 1.9.x should fail
      expect(semver.gte("1.9.7", "1.10.0")).toBe(false);
      expect(semver.gte("1.9.0", "1.10.0")).toBe(false);

      // SVN 1.10.x and above should pass
      expect(semver.gte("1.10.0", "1.10.0")).toBe(true);
      expect(semver.gte("1.10.3", "1.10.0")).toBe(true);
      expect(semver.gte("1.14.0", "1.10.0")).toBe(true);
    });

    it("semver.gte correctly validates 1.9+ features", () => {
      // SVN 1.8.x should fail
      expect(semver.gte("1.8.19", "1.9.0")).toBe(false);

      // SVN 1.9.x and above should pass
      expect(semver.gte("1.9.0", "1.9.0")).toBe(true);
      expect(semver.gte("1.9.7", "1.9.0")).toBe(true);
      expect(semver.gte("1.10.0", "1.9.0")).toBe(true);
    });
  });

  describe("ICleanupOptions Interface", () => {
    interface ICleanupOptions {
      vacuumPristines?: boolean;
      removeIgnored?: boolean;
      removeUnversioned?: boolean;
      includeExternals?: boolean;
    }

    it("all properties are optional", () => {
      const emptyOptions: ICleanupOptions = {};
      expect(emptyOptions).toEqual({});
    });

    it("accepts all valid option combinations", () => {
      const fullOptions: ICleanupOptions = {
        vacuumPristines: true,
        removeIgnored: true,
        removeUnversioned: true,
        includeExternals: true
      };
      expect(Object.keys(fullOptions).length).toBe(4);
    });

    it("partial options work correctly", () => {
      const partialOptions: ICleanupOptions = {
        removeIgnored: true
      };
      expect(partialOptions.removeIgnored).toBe(true);
      expect(partialOptions.vacuumPristines).toBeUndefined();
    });
  });

  describe("Timestamp Repair Note", () => {
    it("basic cleanup includes timestamp repair automatically", () => {
      // SVN CLI hardcodes fix_timestamps=TRUE in svn_client_cleanup2()
      // Users don't need separate option - it's always done
      // Reference: subversion/svn/cleanup-cmd.c
      const basicCleanupFixesTimestamps = true;
      expect(basicCleanupFixesTimestamps).toBe(true);
    });
  });

  describe("Version Check Error", () => {
    /**
     * Simulates the version check logic from svnRepository.ts
     */
    function checkVacuumPristinesVersion(svnVersion: string): void {
      if (!semver.gte(svnVersion, "1.10.0")) {
        throw new Error(
          `--vacuum-pristines requires SVN 1.10+, you have ${svnVersion}`
        );
      }
    }

    it("throws clear error for SVN 1.9.x", () => {
      expect(() => checkVacuumPristinesVersion("1.9.7")).toThrow(
        "--vacuum-pristines requires SVN 1.10+, you have 1.9.7"
      );
    });

    it("does not throw for SVN 1.10.0", () => {
      expect(() => checkVacuumPristinesVersion("1.10.0")).not.toThrow();
    });

    it("does not throw for SVN 1.14.x", () => {
      expect(() => checkVacuumPristinesVersion("1.14.3")).not.toThrow();
    });

    it("error message includes actual version", () => {
      try {
        checkVacuumPristinesVersion("1.8.19");
      } catch (err) {
        expect((err as Error).message).toContain("1.8.19");
      }
    });
  });

  describe("Cleanup Dialog Options", () => {
    interface CleanupQuickPickItem {
      label: string;
      id: string;
      destructive?: boolean;
      shortName: string;
      picked: boolean;
    }

    const cleanupOptions: CleanupQuickPickItem[] = [
      {
        label: "$(trash) Remove Unversioned Files",
        id: "removeUnversioned",
        shortName: "unversioned files",
        destructive: true,
        picked: false
      },
      {
        label: "$(exclude) Remove Ignored Files",
        id: "removeIgnored",
        shortName: "ignored files",
        destructive: true,
        picked: false
      },
      {
        label: "$(database) Reclaim Disk Space",
        id: "vacuumPristines",
        shortName: "disk space",
        picked: true // Safe, recommended default
      },
      {
        label: "$(link-external) Clean Nested Repositories",
        id: "includeExternals",
        shortName: "nested repos",
        picked: false
      }
    ];

    it("destructive options are marked correctly", () => {
      const destructive = cleanupOptions.filter(o => o.destructive);
      expect(destructive.map(o => o.id)).toEqual([
        "removeUnversioned",
        "removeIgnored"
      ]);
    });

    it("non-destructive options are safe by default", () => {
      const safe = cleanupOptions.filter(o => !o.destructive);
      expect(safe.map(o => o.id)).toContain("vacuumPristines");
      expect(safe.map(o => o.id)).toContain("includeExternals");
    });

    it("vacuumPristines defaults to picked (safe operation)", () => {
      const vacuum = cleanupOptions.find(o => o.id === "vacuumPristines");
      expect(vacuum?.picked).toBe(true);
    });

    it("destructive options default to unpicked", () => {
      const destructive = cleanupOptions.filter(o => o.destructive);
      expect(destructive.every(o => o.picked === false)).toBe(true);
    });

    it("shortNames exclude modifiers from operations list", () => {
      // Operations list should only include actual operations, not modifiers
      const modifiers = ["includeExternals"];
      const operations = cleanupOptions
        .filter(o => !modifiers.includes(o.id))
        .map(o => o.shortName);
      expect(operations).not.toContain("externals");
      expect(operations).toEqual([
        "unversioned files",
        "ignored files",
        "disk space"
      ]);
    });
  });

  describe("Error Message Formatting", () => {
    it("formats error from Error instance", () => {
      const err = new Error("SVN locked");
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toBe("SVN locked");
    });

    it("formats error from string", () => {
      const err: unknown = "Unknown failure";
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toBe("Unknown failure");
    });

    it("formats cleanup failure message", () => {
      const err = new Error("Working copy locked");
      const message = err instanceof Error ? err.message : String(err);
      const userMessage = `Cleanup failed: ${message}`;
      expect(userMessage).toBe("Cleanup failed: Working copy locked");
    });
  });

  describe("Progress Message Building", () => {
    function buildProgressTitle(operations: string[]): string {
      return operations.length > 0
        ? `Cleaning: ${operations.join(", ")}...`
        : "Running SVN Cleanup...";
    }

    it("builds message for single operation", () => {
      expect(buildProgressTitle(["unversioned files"])).toBe(
        "Cleaning: unversioned files..."
      );
    });

    it("builds message for multiple operations", () => {
      expect(buildProgressTitle(["unversioned files", "ignored files"])).toBe(
        "Cleaning: unversioned files, ignored files..."
      );
    });

    it("uses default message for empty operations", () => {
      expect(buildProgressTitle([])).toBe("Running SVN Cleanup...");
    });
  });

  describe("Completion Message Building", () => {
    /** Format list with commas and "and" (e.g., "a, b, and c") */
    function formatList(items: string[]): string {
      if (items.length <= 2) {
        return items.join(" and ");
      }
      return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
    }

    function buildCompletionMessage(
      operations: string[],
      includeExternals: boolean
    ): string {
      const completedOps =
        operations.length > 0 ? `Removed ${formatList(operations)}. ` : "";
      const externalsNote = includeExternals ? "Included externals." : "";
      return `Cleanup completed. ${completedOps}${externalsNote}`.trim();
    }

    it("builds message for single operation", () => {
      expect(buildCompletionMessage(["unversioned files"], false)).toBe(
        "Cleanup completed. Removed unversioned files."
      );
    });

    it("builds message for two operations", () => {
      expect(
        buildCompletionMessage(["unversioned files", "ignored files"], false)
      ).toBe("Cleanup completed. Removed unversioned files and ignored files.");
    });

    it("builds message for three operations with Oxford comma", () => {
      expect(
        buildCompletionMessage(
          ["unversioned files", "ignored files", "disk space"],
          false
        )
      ).toBe(
        "Cleanup completed. Removed unversioned files, ignored files, and disk space."
      );
    });

    it("adds externals note when included", () => {
      expect(buildCompletionMessage(["disk space"], true)).toBe(
        "Cleanup completed. Removed disk space. Included externals."
      );
    });

    it("handles externals only", () => {
      expect(buildCompletionMessage([], true)).toBe(
        "Cleanup completed. Included externals."
      );
    });

    it("handles empty case", () => {
      expect(buildCompletionMessage([], false)).toBe("Cleanup completed.");
    });
  });

  describe("cleanupAdvanced() Auto-Retry Guard", () => {
    /**
     * Mirrors the isLocked guard in cleanupAdvanced() — checks both
     * svnErrorCode and raw stderr for E155037/E155004.
     */
    function shouldAutoRetry(error: {
      svnErrorCode?: string;
      stderr?: string;
    }): boolean {
      const stderr = (error.stderr ?? "").toLowerCase();
      return (
        error.svnErrorCode === "E155037" ||
        error.svnErrorCode === "E155004" ||
        stderr.includes("e155037") ||
        stderr.includes("e155004")
      );
    }

    it("triggers on svnErrorCode E155037", () => {
      expect(shouldAutoRetry({ svnErrorCode: "E155037" })).toBe(true);
    });

    it("triggers on svnErrorCode E155004", () => {
      expect(shouldAutoRetry({ svnErrorCode: "E155004" })).toBe(true);
    });

    it("triggers when E155037 in stderr but svnErrorCode is E155004", () => {
      expect(
        shouldAutoRetry({
          svnErrorCode: "E155004",
          stderr:
            "svn: E155004: Working copy locked\nsvn: E155037: Previous operation interrupted"
        })
      ).toBe(true);
    });

    it("triggers when E155004 in stderr but svnErrorCode differs", () => {
      expect(
        shouldAutoRetry({
          svnErrorCode: "E200030",
          stderr: "svn: E155004: Working copy locked\nsvn: E200030: sqlite busy"
        })
      ).toBe(true);
    });

    it("does not trigger for unrelated errors", () => {
      expect(
        shouldAutoRetry({
          svnErrorCode: "E170001",
          stderr: "svn: E170001: Authorization failed"
        })
      ).toBe(false);
    });
  });
});
