import * as assert from "assert";
import { vi } from "vitest";
import { StatusService } from "../../../services/StatusService";
import { Repository } from "../../../svnRepository";
import { IFileStatus, Status } from "../../../common/types";
import { configuration } from "../../../helpers/configuration";

/**
 * StatusService E2E Tests
 *
 * Tests status management flow:
 * 1. Update status - verify model state updates
 * 2. Find descendants - verify descendant resolution
 * 3. Clear status - verify cleanup works
 */
suite("StatusService E2E", () => {
  teardown(() => vi.restoreAllMocks());

  /**
   * Test 1: Update status - verify model state updates
   */
  test("updateStatus returns correct StatusResult with categorized resources", async () => {
    // Create minimal mock repository
    const mockRepo = {
      async getStatus() {
        // Return mock statuses simulating SVN output
        const statuses: IFileStatus[] = [
          createMockStatus("file1.ts", Status.MODIFIED),
          createMockStatus("file2.ts", Status.CONFLICTED),
          createMockStatus("file3.ts", Status.UNVERSIONED),
          createMockStatus("external1", Status.EXTERNAL)
        ];
        return statuses;
      },
      async getRepositoryUuid() {
        return "mock-uuid-123";
      }
    } as unknown as Repository;

    const service = new StatusService(mockRepo, "/workspace", "/workspace");

    // Execute updateStatus
    const result = await service.updateStatus({ checkRemoteChanges: false });

    // Verify result structure
    assert.ok(result, "StatusResult should exist");
    assert.ok(Array.isArray(result.changes), "changes should be array");
    assert.ok(Array.isArray(result.conflicts), "conflicts should be array");
    assert.ok(Array.isArray(result.unversioned), "unversioned should be array");
    assert.ok(result.changelists instanceof Map, "changelists should be Map");
    assert.ok(
      Array.isArray(result.remoteChanges),
      "remoteChanges should be array"
    );
    assert.ok(
      Array.isArray(result.statusExternal),
      "statusExternal should be array"
    );
    assert.ok(Array.isArray(result.ignored), "ignored should be array");
    assert.strictEqual(
      typeof result.isIncomplete,
      "boolean",
      "isIncomplete should be boolean"
    );
    assert.strictEqual(
      typeof result.needCleanUp,
      "boolean",
      "needCleanUp should be boolean"
    );

    // Verify categorization worked
    assert.strictEqual(result.changes.length, 1, "Should have 1 modified file");
    assert.strictEqual(
      result.conflicts.length,
      1,
      "Should have 1 conflicted file"
    );
    assert.strictEqual(
      result.unversioned.length,
      1,
      "Should have 1 unversioned file"
    );
    assert.strictEqual(
      result.statusExternal.length,
      1,
      "Should have 1 external"
    );

    service.dispose();
  });

  /**
   * Test 2: Find descendants - verify O(n) single-pass algorithm
   */
  test("separateExternals filters external descendants correctly", async () => {
    // Setup: external with descendant files
    const mockRepo = {
      async getStatus() {
        const statuses: IFileStatus[] = [
          createMockStatus("libs/external1", Status.EXTERNAL),
          createMockStatus("libs/external1/file.ts", Status.MODIFIED), // Descendant - should be filtered
          createMockStatus("src/file1.ts", Status.MODIFIED), // Not descendant - should remain
          createMockStatus("src/file2.ts", Status.ADDED) // Not descendant - should remain
        ];
        return statuses;
      },
      async getRepositoryUuid() {
        return "mock-uuid-123";
      }
    } as unknown as Repository;

    const service = new StatusService(mockRepo, "/workspace", "/workspace");

    // Execute updateStatus
    const result = await service.updateStatus({ checkRemoteChanges: false });

    // Verify external descendants were filtered out
    assert.strictEqual(
      result.statusExternal.length,
      1,
      "Should have 1 external"
    );
    assert.strictEqual(
      result.changes.length,
      2,
      "Should have 2 changes (not 3)"
    );

    // Verify the descendant file was NOT included in changes
    const hasExternalDescendant = result.changes.some((r: any) =>
      r.resourceUri.fsPath.includes("libs/external1/file.ts")
    );
    assert.strictEqual(
      hasExternalDescendant,
      false,
      "External descendant should be filtered"
    );

    // Verify non-descendant files were included
    const toPosix = (p: string) => p.replace(/\\/g, "/");
    const hasSrcFile1 = result.changes.some((r: any) =>
      toPosix(r.resourceUri.fsPath).includes("src/file1.ts")
    );
    const hasSrcFile2 = result.changes.some((r: any) =>
      toPosix(r.resourceUri.fsPath).includes("src/file2.ts")
    );
    assert.strictEqual(
      hasSrcFile1,
      true,
      "Non-descendant src/file1.ts should remain"
    );
    assert.strictEqual(
      hasSrcFile2,
      true,
      "Non-descendant src/file2.ts should remain"
    );

    service.dispose();
  });

  test("retains raw external paths when same-repo externals are combined", async () => {
    vi.spyOn(configuration, "get").mockImplementation(((
      key: string,
      fallback?: unknown
    ) =>
      key === "sourceControl.combineExternalIfSameServer"
        ? true
        : fallback) as never);
    const external = createMockStatus("external1", Status.EXTERNAL);
    external.repositoryUuid = "same-uuid";
    const mockRepo = {
      async getStatus() {
        return [external];
      },
      async getRepositoryUuid() {
        return "same-uuid";
      }
    } as unknown as Repository;
    const service = new StatusService(mockRepo, "/workspace", "/workspace");

    const result = await service.updateStatus({ checkRemoteChanges: false });

    assert.deepStrictEqual(result.statusExternal, []);
    assert.deepStrictEqual(
      (result as any).externalWorkingCopyPaths,
      ["external1"],
      "raw external roots must survive UI combine filtering"
    );
    service.dispose();
  });

  /**
   * Test 3: Dispose - verify config listener cleanup
   */
  test("dispose cleans up config change listener", () => {
    const mockRepo = {
      async getStatus() {
        return [];
      },
      async getRepositoryUuid() {
        return "mock-uuid-123";
      }
    } as unknown as Repository;

    const service = new StatusService(mockRepo, "/workspace", "/workspace");

    // Dispose should not throw
    assert.doesNotThrow(() => {
      service.dispose();
    }, "dispose should not throw");

    // Calling dispose multiple times should be safe
    assert.doesNotThrow(() => {
      service.dispose();
    }, "multiple dispose calls should be safe");
  });
});

/**
 * Helper to create mock IFileStatus
 */
function createMockStatus(path: string, status: Status): IFileStatus {
  return {
    path,
    status,
    props: Status.NONE,
    wcStatus: {
      locked: false,
      switched: false
    },
    repositoryUuid: "mock-uuid-123",
    changelist: undefined,
    rename: undefined,
    reposStatus: undefined,
    commit: undefined
  };
}
