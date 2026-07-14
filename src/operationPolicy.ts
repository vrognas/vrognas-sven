// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { Operation } from "./common/types";

export type OperationRefresh = "none" | "normal" | "force" | "remote";
export type OperationPolicy = Readonly<{
  refresh: OperationRefresh;
  showProgress: boolean;
  invalidatesBase: boolean;
  fetchLockStatus: boolean;
  suppressWatcherWhileRunning: boolean;
  refreshOnFailure: boolean;
}>;
const policy = (
  refresh: OperationRefresh,
  overrides: Partial<Omit<OperationPolicy, "refresh">> = {}
): OperationPolicy => ({
  refresh,
  showProgress: true,
  invalidatesBase: false,
  fetchLockStatus: false,
  suppressWatcherWhileRunning: false,
  refreshOnFailure: false,
  ...overrides
});

const BACKGROUND_READ = policy("none", { showProgress: false });
const READ = policy("none");
const NORMAL = policy("normal");
const BASE = { invalidatesBase: true } as const;
const BULK_BASE = { ...BASE, suppressWatcherWhileRunning: true } as const;
const BASE_MUTATION = policy("normal", BASE);
const BULK_BASE_MUTATION = policy("normal", BULK_BASE);
const FORCE = policy("force", BASE);
const UPDATE = policy("force", BULK_BASE);
const LOCK_MUTATION = policy("force", {
  invalidatesBase: true,
  fetchLockStatus: true,
  refreshOnFailure: true
});
const REMOTE_STATUS = policy("remote", { fetchLockStatus: true });
export const OPERATION_POLICY = {
  [Operation.Add]: FORCE,
  [Operation.AddChangelist]: FORCE,
  [Operation.Blame]: BACKGROUND_READ,
  [Operation.Changes]: READ,
  [Operation.CleanUp]: FORCE,
  [Operation.Commit]: FORCE,
  [Operation.CurrentBranch]: BACKGROUND_READ,
  [Operation.Info]: BACKGROUND_READ,
  [Operation.Ignore]: FORCE,
  [Operation.Lock]: LOCK_MUTATION,
  [Operation.Log]: READ,
  [Operation.Merge]: BULK_BASE_MUTATION,
  [Operation.NewBranch]: BASE_MUTATION,
  [Operation.Patch]: READ,
  [Operation.PropertyChange]: FORCE,
  [Operation.Remove]: FORCE,
  [Operation.RemoveChangelist]: FORCE,
  [Operation.Rename]: NORMAL,
  [Operation.Resolve]: FORCE,
  [Operation.Resolved]: NORMAL,
  [Operation.Revert]: FORCE,
  [Operation.Show]: BACKGROUND_READ,
  [Operation.Status]: NORMAL,
  [Operation.StatusRemote]: REMOTE_STATUS,
  [Operation.SwitchBranch]: BULK_BASE_MUTATION,
  [Operation.Unlock]: LOCK_MUTATION,
  [Operation.Update]: UPDATE,
  [Operation.List]: BACKGROUND_READ
} as const satisfies Record<Operation, OperationPolicy>;

export const getOperationPolicy = (operation: Operation): OperationPolicy =>
  OPERATION_POLICY[operation];
export const isReadOnly = (operation: Operation): boolean =>
  getOperationPolicy(operation).refresh === "none";
export const shouldFetchLockStatus = (operation: Operation | string): boolean =>
  Object.hasOwn(OPERATION_POLICY, operation) &&
  OPERATION_POLICY[operation as Operation].fetchLockStatus;

const operationSet = (test: (policy: OperationPolicy) => boolean) =>
  new Set(Object.values(Operation).filter(op => test(OPERATION_POLICY[op])));
export const FORCE_REFRESH_OPERATIONS: ReadonlySet<Operation> = operationSet(
  policy => policy.refresh === "force"
);
export const BLAME_INVALIDATING_OPERATIONS: ReadonlySet<Operation> =
  operationSet(policy => policy.invalidatesBase);
export const WATCHER_SUPPRESSING_OPERATIONS: ReadonlySet<Operation> =
  operationSet(policy => policy.suppressWatcherWhileRunning);
