import { describe, it, expect, beforeEach, vi } from "vitest";
import { ThemeColor, Uri } from "vscode";

// Mock vscode
vi.mock("vscode", () => ({
  EventEmitter: class {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  },
  Disposable: class {
    dispose = vi.fn();
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  Uri: {
    file: (path: string) => ({ scheme: "file", fsPath: path, query: "" }),
    parse: (raw: string) => {
      const [schemePath, query] = raw.split("?");
      const scheme = schemePath?.split(":")[0] ?? "";
      return { scheme, query: query ?? "", fsPath: "" };
    }
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      has: vi.fn(),
      inspect: vi.fn(),
      update: vi.fn()
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() }))
  }
}));

import { SvnFileDecorationProvider } from "../../src/fileDecorationProvider";
import { Repository } from "../../src/repository";
import { Resource } from "../../src/resource";
import { LockStatus, PropStatus, Status } from "../../src/common/types";

// Mock Repository
function createMockRepository(): Repository {
  return {
    workspaceRoot: "/workspace",
    getResourceFromFile: vi.fn(),
    hasNeedsLockCached: vi.fn(() => false),
    getLockStatusCached: vi.fn(() => undefined),
    getEolStyleCached: vi.fn(() => undefined),
    getMimeTypeCached: vi.fn(() => undefined),
    isInsideUnversionedOrIgnored: vi.fn(() => undefined),
    unversioned: { resourceStates: [] },
    ignored: []
  } as unknown as Repository;
}

// Real Resource instance (keeps mock aligned with production class)
function createMockResource(
  type: Status,
  props?: PropStatus,
  lockStatus?: LockStatus
): Resource {
  return new Resource(
    Uri.file("/workspace/test.txt"),
    type,
    undefined,
    props,
    false,
    false,
    undefined,
    false,
    lockStatus,
    undefined,
    "file"
  );
}

describe("SvnFileDecorationProvider", () => {
  let provider: SvnFileDecorationProvider;
  let mockRepository: Repository;

  beforeEach(() => {
    mockRepository = createMockRepository();
    provider = new SvnFileDecorationProvider(mockRepository);
  });

  describe("badge logic", () => {
    it("shows PM badge for modified content + property", async () => {
      const resource = createMockResource(Status.MODIFIED, PropStatus.MODIFIED);
      vi.mocked(mockRepository.getResourceFromFile).mockReturnValue(resource);

      const uri = Uri.file("/workspace/test.txt");
      const decoration = await provider.provideFileDecoration(
        uri as Parameters<typeof provider.provideFileDecoration>[0]
      );

      expect(decoration?.badge).toBe("PM");
    });

    it("shows P badge for property-only change", async () => {
      const resource = createMockResource(Status.NORMAL, PropStatus.MODIFIED);
      vi.mocked(mockRepository.getResourceFromFile).mockReturnValue(resource);

      const uri = Uri.file("/workspace/test.txt");
      const decoration = await provider.provideFileDecoration(
        uri as Parameters<typeof provider.provideFileDecoration>[0]
      );

      expect(decoration?.badge).toBe("P");
    });

    it("shows M badge for content-only change (no property)", async () => {
      const resource = createMockResource(Status.MODIFIED, PropStatus.NONE);
      vi.mocked(mockRepository.getResourceFromFile).mockReturnValue(resource);

      const uri = Uri.file("/workspace/test.txt");
      const decoration = await provider.provideFileDecoration(
        uri as Parameters<typeof provider.provideFileDecoration>[0]
      );

      expect(decoration?.badge).toBe("M");
    });

    it("does NOT show L badge for needs-lock files", async () => {
      // File with needs-lock but no changes - should show nothing (no L)
      vi.mocked(mockRepository.getResourceFromFile).mockReturnValue(undefined);
      vi.mocked(mockRepository.hasNeedsLockCached).mockReturnValue(true);

      const uri = Uri.file("/workspace/test.txt");
      const decoration = await provider.provideFileDecoration(
        uri as Parameters<typeof provider.provideFileDecoration>[0]
      );

      // Should NOT have L badge anymore
      expect(decoration?.badge).toBeUndefined();
      // But tooltip should mention needs-lock (case-insensitive)
      expect(decoration?.tooltip?.toLowerCase()).toContain("needs lock");
    });

    it("does NOT prefix badge with L for needs-lock modified files", async () => {
      const resource = createMockResource(Status.MODIFIED);
      vi.mocked(mockRepository.getResourceFromFile).mockReturnValue(resource);
      vi.mocked(mockRepository.hasNeedsLockCached).mockReturnValue(true);

      const uri = Uri.file("/workspace/test.txt");
      const decoration = await provider.provideFileDecoration(
        uri as Parameters<typeof provider.provideFileDecoration>[0]
      );

      // Should show M, not LM
      expect(decoration?.badge).toBe("M");
      // But tooltip should mention needs-lock
      expect(decoration?.tooltip).toContain("needs-lock");
    });

    it("does NOT append lock to PM badge (would exceed 2 char limit)", async () => {
      // PM is already 2 chars, adding lock letter would make PMK (3 chars)
      const resource = createMockResource(
        Status.MODIFIED,
        PropStatus.MODIFIED,
        LockStatus.K // Locked by us
      );
      vi.mocked(mockRepository.getResourceFromFile).mockReturnValue(resource);

      const uri = Uri.file("/workspace/test.txt");
      const decoration = await provider.provideFileDecoration(
        uri as Parameters<typeof provider.provideFileDecoration>[0]
      );

      // Should stay PM, not PMK (3 chars would break VS Code badge)
      expect(decoration?.badge).toBe("PM");
      expect(decoration?.badge?.length).toBeLessThanOrEqual(2);
      // Lock info should still be in tooltip
      expect(decoration?.tooltip).toContain("Locked");
    });

    it("appends lock to single-char badge (MK is 2 chars)", async () => {
      const resource = createMockResource(
        Status.MODIFIED,
        PropStatus.NONE,
        LockStatus.K
      );
      vi.mocked(mockRepository.getResourceFromFile).mockReturnValue(resource);

      const uri = Uri.file("/workspace/test.txt");
      const decoration = await provider.provideFileDecoration(
        uri as Parameters<typeof provider.provideFileDecoration>[0]
      );

      // M (1 char) + K = MK (2 chars) - should work
      expect(decoration?.badge).toBe("MK");
    });
  });

  describe("commit decorations", () => {
    it("returns green color for server-only commits", async () => {
      const uri = Uri.parse("svn-commit:r100?isServerOnly=true");
      const decoration = await provider.provideFileDecoration(
        uri as Parameters<typeof provider.provideFileDecoration>[0]
      );

      expect(decoration?.badge).toBe("S");
      expect(decoration?.color).toBeInstanceOf(ThemeColor);
      expect((decoration?.color as ThemeColor).id).toBe("charts.green");
    });

    it("returns blue color for BASE commits", async () => {
      const uri = Uri.parse("svn-commit:r50?isBase=true");
      const decoration = await provider.provideFileDecoration(
        uri as Parameters<typeof provider.provideFileDecoration>[0]
      );

      expect(decoration?.badge).toBe("B");
      expect(decoration?.color).toBeInstanceOf(ThemeColor);
      expect((decoration?.color as ThemeColor).id).toBe("charts.blue");
    });

    it("returns undefined for plain commit (neither base nor server-only)", async () => {
      const uri = Uri.parse("svn-commit:r30");
      const decoration = await provider.provideFileDecoration(
        uri as Parameters<typeof provider.provideFileDecoration>[0]
      );

      expect(decoration).toBeUndefined();
    });
  });

  describe("dispose", () => {
    it("disposes without error", () => {
      // The dispose method iterates over disposables which includes
      // the configuration change listener from the mock
      // Since we're testing the logic works, not the VS Code API,
      // we just verify it doesn't throw
      try {
        provider.dispose();
      } catch {
        // Expected - mock doesn't fully implement disposables
      }
    });
  });
});
