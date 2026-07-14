import * as assert from "assert";
import { Operation } from "../../common/types";
import {
  BLAME_INVALIDATING_OPERATIONS,
  FORCE_REFRESH_OPERATIONS,
  OPERATION_POLICY,
  WATCHER_SUPPRESSING_OPERATIONS,
  getOperationPolicy,
  isReadOnly,
  shouldFetchLockStatus,
  type OperationPolicy,
  type OperationRefresh
} from "../../operationPolicy";

type PolicyRow = readonly [
  refresh: OperationRefresh,
  showProgress: boolean,
  invalidatesBase: boolean,
  fetchLockStatus: boolean,
  suppressWatcherWhileRunning: boolean,
  refreshOnFailure: boolean
];

const EXPECTED = {
  [Operation.Add]: ["force", true, true, false, false, false],
  [Operation.AddChangelist]: ["force", true, true, false, false, false],
  [Operation.Blame]: ["none", false, false, false, false, false],
  [Operation.Changes]: ["none", true, false, false, false, false],
  [Operation.CleanUp]: ["force", true, true, false, false, false],
  [Operation.Commit]: ["force", true, true, false, false, false],
  [Operation.CurrentBranch]: ["none", false, false, false, false, false],
  [Operation.Info]: ["none", false, false, false, false, false],
  [Operation.Ignore]: ["force", true, true, false, false, false],
  [Operation.Lock]: ["force", true, true, true, false, true],
  [Operation.Log]: ["none", true, false, false, false, false],
  [Operation.Merge]: ["normal", true, true, false, true, false],
  [Operation.NewBranch]: ["normal", true, true, false, false, false],
  [Operation.Patch]: ["none", true, false, false, false, false],
  [Operation.PropertyChange]: ["force", true, true, false, false, false],
  [Operation.Remove]: ["force", true, true, false, false, false],
  [Operation.RemoveChangelist]: ["force", true, true, false, false, false],
  [Operation.Rename]: ["normal", true, false, false, false, false],
  [Operation.Resolve]: ["force", true, true, false, false, false],
  [Operation.Resolved]: ["normal", true, false, false, false, false],
  [Operation.Revert]: ["force", true, true, false, false, false],
  [Operation.Show]: ["none", false, false, false, false, false],
  [Operation.Status]: ["normal", true, false, false, false, false],
  [Operation.StatusRemote]: ["remote", true, false, true, false, false],
  [Operation.SwitchBranch]: ["normal", true, true, false, true, false],
  [Operation.Unlock]: ["force", true, true, true, false, true],
  [Operation.Update]: ["force", true, true, false, true, false],
  [Operation.List]: ["none", false, false, false, false, false]
} as const satisfies Record<Operation, PolicyRow>;

function row(policy: OperationPolicy): PolicyRow {
  return [
    policy.refresh,
    policy.showProgress,
    policy.invalidatesBase,
    policy.fetchLockStatus,
    policy.suppressWatcherWhileRunning,
    policy.refreshOnFailure
  ];
}

suite("Operation policy", () => {
  test("preserves the exact exhaustive 28-operation matrix", () => {
    const operations = Object.values(Operation);

    assert.strictEqual(operations.length, 28);
    assert.deepStrictEqual(
      Object.keys(OPERATION_POLICY).sort(),
      operations.sort()
    );

    for (const operation of operations) {
      assert.deepStrictEqual(
        row(getOperationPolicy(operation)),
        EXPECTED[operation]
      );
    }
  });

  test("projects compatibility helpers and sets from the same policy", () => {
    for (const operation of Object.values(Operation)) {
      const [refresh, progress, invalidation, locks, watcher, failure] =
        EXPECTED[operation];

      assert.strictEqual(isReadOnly(operation), refresh === "none");
      assert.strictEqual(getOperationPolicy(operation).showProgress, progress);
      assert.strictEqual(shouldFetchLockStatus(operation), locks);
      assert.strictEqual(
        getOperationPolicy(operation).refreshOnFailure,
        failure
      );
      assert.strictEqual(
        FORCE_REFRESH_OPERATIONS.has(operation),
        refresh === "force"
      );
      assert.strictEqual(
        BLAME_INVALIDATING_OPERATIONS.has(operation),
        invalidation
      );
      assert.strictEqual(
        WATCHER_SUPPRESSING_OPERATIONS.has(operation),
        watcher
      );
    }

    assert.strictEqual(shouldFetchLockStatus("unknown"), false);
  });

  test("preserves deliberate refresh asymmetries", () => {
    assert.strictEqual(
      getOperationPolicy(Operation.StatusRemote).refresh,
      "remote"
    );
    assert.strictEqual(
      FORCE_REFRESH_OPERATIONS.has(Operation.StatusRemote),
      false
    );
    assert.strictEqual(
      getOperationPolicy(Operation.Merge).invalidatesBase,
      true
    );
    assert.strictEqual(
      getOperationPolicy(Operation.Merge).suppressWatcherWhileRunning,
      true
    );
    assert.strictEqual(
      getOperationPolicy(Operation.NewBranch).invalidatesBase,
      true
    );
    assert.strictEqual(
      getOperationPolicy(Operation.NewBranch).suppressWatcherWhileRunning,
      false
    );
    assert.strictEqual(
      getOperationPolicy(Operation.Rename).invalidatesBase,
      false
    );
  });
});
