import * as assert from "assert";
import { SourceControl, SourceControlResourceGroup, Disposable } from "vscode";
import { Resource } from "../../../resource";
import { Status } from "../../../common/types";
import { StatusResult } from "../../../services/StatusService";
import { ResourceGroupManager } from "../../../services/ResourceGroupManager";

// Mock interfaces for testing
interface MockResourceGroup extends SourceControlResourceGroup {
  resourceStates: Resource[];
}

suite("ResourceGroupManager Tests", () => {
  let mockSourceControl: Partial<SourceControl>;
  let mockGroups: Map<string, MockResourceGroup>;
  let disposables: Disposable[];

  const createMockResource = (path: string, status: Status): Resource => {
    return new Resource(
      { fsPath: `/workspace/${path}`, path } as any,
      status,
      undefined,
      Status.NONE
    );
  };

  setup(() => {
    mockGroups = new Map();
    disposables = [];

    // Mock SourceControl.createResourceGroup
    mockSourceControl = {
      createResourceGroup: (id: string, label: string) => {
        const group: MockResourceGroup = {
          id,
          label,
          resourceStates: [],
          hideWhenEmpty: false,
          dispose: () => {
            mockGroups.delete(id);
          }
        };
        mockGroups.set(id, group);
        return group;
      }
    };
  });

  teardown(() => {
    disposables.forEach(d => d.dispose());
    disposables = [];
    mockGroups.clear();
  });

  test("Group creation - static groups created on construction", () => {
    // Arrange & Act
    void new ResourceGroupManager(
      mockSourceControl as SourceControl,
      disposables
    );

    // Assert - verify static groups created
    assert.ok(mockGroups.has("changes"), "Changes group created");
    assert.ok(mockGroups.has("conflicts"), "Conflicts group created");
    assert.ok(mockGroups.has("unversioned"), "Unversioned group created");

    assert.strictEqual(mockGroups.get("changes")?.label, "Changes");
    assert.strictEqual(mockGroups.get("conflicts")?.label, "Conflicts");
    assert.strictEqual(mockGroups.get("unversioned")?.label, "Unversioned");

    assert.ok(mockGroups.size >= 3, "Static groups created");
  });

  test("Group updates - updateGroups correctly updates all groups from StatusResult", () => {
    // Arrange
    const manager = new ResourceGroupManager(
      mockSourceControl as SourceControl,
      disposables
    );

    const statusResult: StatusResult = {
      changes: [
        createMockResource("file1.txt", Status.MODIFIED),
        createMockResource("file2.txt", Status.ADDED)
      ],
      conflicts: [createMockResource("file3.txt", Status.CONFLICTED)],
      unversioned: [createMockResource("file4.txt", Status.UNVERSIONED)],
      changelists: new Map(),
      remoteChanges: [],
      statusExternal: [],
      externalWorkingCopyPaths: [],
      ignored: [],
      isIncomplete: false,
      needCleanUp: false,
      lockStatuses: new Map()
    };

    // Act
    const config = {
      ignoreOnStatusCountList: [],
      countUnversioned: false,
      hideUnversioned: false,
      ignoreList: [],
      workspaceRoot: "/workspace"
    };
    manager.updateGroups({ result: statusResult, config });

    // Assert - verify groups updated with correct resources
    const changesGroup = mockGroups.get("changes");
    assert.strictEqual(changesGroup?.resourceStates.length, 2, "2 changes");
    assert.strictEqual(
      changesGroup?.resourceStates[0]!.resourceUri.fsPath,
      "/workspace/file1.txt"
    );
    assert.strictEqual(
      changesGroup?.resourceStates[1]!.resourceUri.fsPath,
      "/workspace/file2.txt"
    );

    const conflictsGroup = mockGroups.get("conflicts");
    assert.strictEqual(conflictsGroup?.resourceStates.length, 1, "1 conflict");
    assert.strictEqual(
      conflictsGroup?.resourceStates[0]!.resourceUri.fsPath,
      "/workspace/file3.txt"
    );

    const unversionedGroup = mockGroups.get("unversioned");
    assert.strictEqual(
      unversionedGroup?.resourceStates.length,
      1,
      "1 unversioned"
    );
    assert.strictEqual(
      unversionedGroup?.resourceStates[0]!.resourceUri.fsPath,
      "/workspace/file4.txt"
    );
  });

  test("Changelist management - dynamic changelist groups created and disposed", () => {
    // Arrange
    const manager = new ResourceGroupManager(
      mockSourceControl as SourceControl,
      disposables
    );

    // Act 1 - Create changelists
    const changelists1 = new Map<string, Resource[]>();
    changelists1.set("feature-x", [
      createMockResource("file1.txt", Status.MODIFIED),
      createMockResource("file2.txt", Status.ADDED)
    ]);
    changelists1.set("bugfix-y", [
      createMockResource("file3.txt", Status.MODIFIED)
    ]);

    const result1: StatusResult = {
      changes: [],
      conflicts: [],
      unversioned: [],
      changelists: changelists1,
      remoteChanges: [],
      statusExternal: [],
      externalWorkingCopyPaths: [],
      ignored: [],
      isIncomplete: false,
      needCleanUp: false,
      lockStatuses: new Map()
    };

    const testConfig = {
      ignoreOnStatusCountList: [],
      countUnversioned: false,
      hideUnversioned: false,
      ignoreList: [],
      workspaceRoot: "/workspace"
    };
    manager.updateGroups({ result: result1, config: testConfig });

    // Assert 1 - verify changelist groups created
    assert.ok(
      mockGroups.has("changelist-feature-x"),
      "feature-x group created"
    );
    assert.ok(mockGroups.has("changelist-bugfix-y"), "bugfix-y group created");

    assert.strictEqual(
      mockGroups.get("changelist-feature-x")?.label,
      'Changelist "feature-x"'
    );
    assert.strictEqual(
      mockGroups.get("changelist-feature-x")?.resourceStates.length,
      2,
      "feature-x has 2 files"
    );
    assert.strictEqual(
      mockGroups.get("changelist-bugfix-y")?.resourceStates.length,
      1,
      "bugfix-y has 1 file"
    );

    // Act 2 - Update with removed changelist
    const changelists2 = new Map<string, Resource[]>();
    changelists2.set("feature-x", [
      createMockResource("file1.txt", Status.MODIFIED)
    ]);
    // bugfix-y removed

    const result2: StatusResult = {
      changes: [],
      conflicts: [],
      unversioned: [],
      changelists: changelists2,
      remoteChanges: [],
      statusExternal: [],
      externalWorkingCopyPaths: [],
      ignored: [],
      isIncomplete: false,
      needCleanUp: false,
      lockStatuses: new Map()
    };

    manager.updateGroups({ result: result2, config: testConfig });

    // Assert 2 - verify bugfix-y disposed, feature-x updated
    assert.ok(mockGroups.has("changelist-feature-x"), "feature-x still exists");
    assert.ok(!mockGroups.has("changelist-bugfix-y"), "bugfix-y disposed");
    assert.strictEqual(
      mockGroups.get("changelist-feature-x")?.resourceStates.length,
      1,
      "feature-x updated to 1 file"
    );
  });

  test("Index rebuild - skipped when resources unchanged (Phase 16)", () => {
    // Arrange
    const manager = new ResourceGroupManager(
      mockSourceControl as SourceControl,
      disposables
    );

    const statusResult: StatusResult = {
      changes: [createMockResource("file1.txt", Status.MODIFIED)],
      conflicts: [],
      unversioned: [],
      changelists: new Map(),
      remoteChanges: [],
      statusExternal: [],
      externalWorkingCopyPaths: [],
      ignored: [],
      isIncomplete: false,
      needCleanUp: false,
      lockStatuses: new Map()
    };

    const config = {
      ignoreOnStatusCountList: [],
      countUnversioned: false,
      hideUnversioned: false,
      ignoreList: [],
      workspaceRoot: "/workspace"
    };

    // Act - first call should rebuild
    manager.updateGroups({ result: statusResult, config });
    const resource1 = manager.getResourceFromFile("/workspace/file1.txt");
    assert.ok(resource1, "Resource found after first update");

    // Act - second call with identical data should skip rebuild
    manager.updateGroups({ result: statusResult, config });
    const resource2 = manager.getResourceFromFile("/workspace/file1.txt");
    assert.ok(resource2, "Resource still found after second update");

    // Assert - index still works (proves rebuild was either done or skipped correctly)
    assert.strictEqual(resource1, resource2, "Same resource instance");
  });

  test("Index rebuild - triggered when resources change (Phase 16)", () => {
    // Arrange
    const manager = new ResourceGroupManager(
      mockSourceControl as SourceControl,
      disposables
    );

    const result1: StatusResult = {
      changes: [createMockResource("file1.txt", Status.MODIFIED)],
      conflicts: [],
      unversioned: [],
      changelists: new Map(),
      remoteChanges: [],
      statusExternal: [],
      externalWorkingCopyPaths: [],
      ignored: [],
      isIncomplete: false,
      needCleanUp: false,
      lockStatuses: new Map()
    };

    const result2: StatusResult = {
      changes: [
        createMockResource("file1.txt", Status.MODIFIED),
        createMockResource("file2.txt", Status.ADDED)
      ],
      conflicts: [],
      unversioned: [],
      changelists: new Map(),
      remoteChanges: [],
      statusExternal: [],
      externalWorkingCopyPaths: [],
      ignored: [],
      isIncomplete: false,
      needCleanUp: false,
      lockStatuses: new Map()
    };

    const config = {
      ignoreOnStatusCountList: [],
      countUnversioned: false,
      hideUnversioned: false,
      ignoreList: [],
      workspaceRoot: "/workspace"
    };

    // Act
    manager.updateGroups({ result: result1, config });
    const resource1 = manager.getResourceFromFile("/workspace/file1.txt");
    assert.ok(resource1, "file1.txt found");
    assert.ok(
      !manager.getResourceFromFile("/workspace/file2.txt"),
      "file2.txt not found yet"
    );

    manager.updateGroups({ result: result2, config });
    const resource2 = manager.getResourceFromFile("/workspace/file2.txt");
    assert.ok(resource2, "file2.txt found after change");

    // Assert - both resources findable (proves rebuild happened)
    assert.ok(
      manager.getResourceFromFile("/workspace/file1.txt"),
      "file1.txt still found"
    );
    assert.ok(
      manager.getResourceFromFile("/workspace/file2.txt"),
      "file2.txt found"
    );
  });

  test("Index rebuild - triggered when changelist count changes (Phase 16)", () => {
    // Arrange
    const manager = new ResourceGroupManager(
      mockSourceControl as SourceControl,
      disposables
    );

    const result1: StatusResult = {
      changes: [createMockResource("file1.txt", Status.MODIFIED)],
      conflicts: [],
      unversioned: [],
      changelists: new Map(),
      remoteChanges: [],
      statusExternal: [],
      externalWorkingCopyPaths: [],
      ignored: [],
      isIncomplete: false,
      needCleanUp: false,
      lockStatuses: new Map()
    };

    const changelists = new Map<string, Resource[]>();
    changelists.set("feature-x", [
      createMockResource("file2.txt", Status.MODIFIED)
    ]);

    const result2: StatusResult = {
      changes: [createMockResource("file1.txt", Status.MODIFIED)],
      conflicts: [],
      unversioned: [],
      changelists,
      remoteChanges: [],
      statusExternal: [],
      externalWorkingCopyPaths: [],
      ignored: [],
      isIncomplete: false,
      needCleanUp: false,
      lockStatuses: new Map()
    };

    const config = {
      ignoreOnStatusCountList: [],
      countUnversioned: false,
      hideUnversioned: false,
      ignoreList: [],
      workspaceRoot: "/workspace"
    };

    // Act
    manager.updateGroups({ result: result1, config });
    assert.ok(
      !manager.getResourceFromFile("/workspace/file2.txt"),
      "file2.txt not in index yet"
    );

    manager.updateGroups({ result: result2, config });
    const resource = manager.getResourceFromFile("/workspace/file2.txt");

    // Assert - changelist resource findable (proves rebuild happened)
    assert.ok(resource, "file2.txt from changelist found in index");
  });
});
