import * as assert from "assert";
import { Uri } from "vscode";
import { Resource } from "../../resource";
import { LockStatus, PropertyChange } from "../../common/types";

suite("Resource.withLock", () => {
  test("overrides lock fields, preserves everything else incl propertyChanges", () => {
    const uri = Uri.file("/repo/a.txt");
    const propertyChanges: PropertyChange[] = [
      { name: "svn:executable", changeType: "added" }
    ];
    const base = new Resource(
      uri,
      "modified",
      undefined,
      "props",
      false,
      false,
      undefined,
      false,
      undefined,
      "mychangelist",
      "file",
      true,
      propertyChanges
    );

    const locked = base.withLock({
      locked: true,
      lockOwner: "bob",
      hasLockToken: true,
      lockStatus: LockStatus.O
    });

    // lock fields overridden
    assert.strictEqual(locked.locked, true);
    assert.strictEqual(locked.lockOwner, "bob");
    assert.strictEqual(locked.hasLockToken, true);
    assert.strictEqual(locked.lockStatus, LockStatus.O);

    // everything else preserved
    assert.strictEqual(locked.type, "modified");
    assert.strictEqual(locked.props, "props");
    assert.strictEqual(locked.changelist, "mychangelist");
    assert.strictEqual(locked.kind, "file");
    assert.strictEqual(locked.localFileExists, true);
    // the field the 12-arg positional clone used to drop:
    assert.strictEqual(locked.propertyChanges, propertyChanges);

    // original is untouched (immutable copy)
    assert.strictEqual(base.locked, false);
  });
});
