// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import type { SpawnOptions } from "child_process";
import type {
  CancellationToken,
  Disposable,
  SourceControlResourceGroup,
  Uri
} from "vscode";
import type { Repository } from "../repository";
import type { Resource } from "../resource";

export interface IBranchItem {
  name: string;
  path: string;
  isNew?: boolean;
}

export interface ICommandOptions {
  repository?: boolean;
  diff?: boolean;
}

export interface IConflictOption {
  label: string;
  description: string;
}

export interface ISvnInfo {
  kind: string;
  path: string;
  revision: string;
  url: string;
  relativeUrl: string;
  repository: {
    root: string;
    uuid: string;
  };
  wcInfo?: {
    wcrootAbspath?: string;
    uuid: string;
    depth?: string;
  };
  commit: {
    revision: string;
    author: string;
    date: string;
  };
}

export interface ISvnPath {
  props: PropStatus;
  kind: SvnKindType;
  item: Status;
  _: string;
}

export interface ISvnPathChange {
  oldPath: Uri;
  newPath: Uri;
  oldRevision: string;
  newRevision: string;
  props: PropStatus;
  kind: SvnKindType;
  item: Status;
  repo: Uri;
  localPath: Uri;
}

export interface ISvnListItem {
  kind: SvnKindType;
  name: string;
  size: string;
  commit: {
    revision: string;
    author: string;
    date: string;
  };
}

export enum SvnKindType {
  FILE = "file",
  DIR = "dir"
}

export interface RepositoryChangeEvent {
  repository: Repository;
  uri: Uri;
}

export interface IOpenRepository extends Disposable {
  repository: Repository;
}

export enum RepositoryState {
  Idle,
  Disposed
}

export enum Operation {
  Add = "Add",
  AddChangelist = "AddChangelist",
  Blame = "Blame",
  Changes = "Changes",
  CleanUp = "CleanUp",
  Commit = "Commit",
  CurrentBranch = "CurrentBranch",
  Info = "Info",
  Ignore = "Ignore",
  Lock = "Lock",
  Log = "Log",
  Merge = "Merge",
  NewBranch = "NewBranch",
  Patch = "Patch",
  PropertyChange = "PropertyChange",
  Remove = "Remove",
  RemoveChangelist = "RemoveChangelist",
  Rename = "Rename",
  Resolve = "Resolve",
  Resolved = "Resolved",
  Revert = "Revert",
  Show = "Show",
  Status = "Status",
  StatusRemote = "StatusRemote",
  SwitchBranch = "SwitchBranch",
  Unlock = "Unlock",
  Update = "Update",
  List = "List"
}

/**
 * Options for advanced cleanup operations.
 * Most options require SVN 1.9+; vacuumPristines requires SVN 1.10+.
 *
 * Note: Basic `svn cleanup` always fixes timestamps automatically
 * (hardcoded fix_timestamps=TRUE in CLI). No separate option needed.
 */
export interface ICleanupOptions {
  /** Remove unreferenced pristine copies (SVN 1.10+) */
  vacuumPristines?: boolean;
  /** Remove files matching svn:ignore patterns (SVN 1.9+) */
  removeIgnored?: boolean;
  /** Remove unversioned files (SVN 1.9+) */
  removeUnversioned?: boolean;
  /** Process svn:externals directories (SVN 1.9+) */
  includeExternals?: boolean;
}

export interface ISvnResourceGroup extends SourceControlResourceGroup {
  resourceStates: Resource[];
  repository?: Repository;
}

export interface IWcStatus {
  /** True if file has a user lock (K/O/B/T) */
  locked: boolean;
  /** True if WC is administratively locked (from wc-locked attribute, needs cleanup) */
  wcAdminLocked?: boolean;
  switched: boolean;
  /** Lock owner username (from repos-status) */
  lockOwner?: string;
  /** True if we hold the lock token locally (K), false if locked by others (O) */
  hasLockToken?: boolean;
  /** True if server was checked for lock status (via svn status -u) */
  serverChecked?: boolean;
  /** Lock status badge: K=mine, O=other, B=broken, T=stolen */
  lockStatus?: LockStatus;
}

/**
 * SVN lock status indicators per svn status --show-updates
 * K = Locked by this working copy
 * O = Locked by another working copy
 * B = Lock broken (our token is stale, server has no lock)
 * T = Lock stolen (our token is stale, someone else has lock)
 */
export enum LockStatus {
  K = "K", // Locked by us
  O = "O", // Locked by other
  B = "B", // Broken - our lock was broken
  T = "T" // Stolen - our lock was stolen
}

/** Describes a property change: which property and how it changed */
export interface PropertyChange {
  name: string;
  changeType: "added" | "deleted" | "modified";
}

export interface IFileStatus {
  status: string;
  props: string;
  path: string;
  kind?: "file" | "dir";
  changelist?: string;
  rename?: string;
  /** Property changes: which properties changed and how */
  propertyChanges?: PropertyChange[];
  wcStatus: IWcStatus;
  commit?: {
    revision: string;
    author: string;
    date: string;
  };
  repositoryUuid?: string;
  reposStatus?: {
    props: string;
    item: string;
    lock?: Record<string, unknown>;
  };
}

export interface IEntry {
  path: string;
  kind?: "file" | "dir";
  wcStatus: {
    item: string;
    revision: string;
    props: string;
    movedTo?: string;
    movedFrom?: string;
    wcLocked?: string;
    switched?: string;
    /** Local lock token when you have locked this file */
    lock?: {
      token?: string;
      owner?: string;
      created?: string;
      expires?: string;
      comment?: string;
    };
    commit: {
      revision: string;
      author: string;
      date: string;
    };
  };
  reposStatus?: {
    props: string;
    item: string;
    lock?: Record<string, unknown>;
  };
}

export enum Status {
  ADDED = "added",
  CONFLICTED = "conflicted",
  DELETED = "deleted",
  EXTERNAL = "external",
  IGNORED = "ignored",
  INCOMPLETE = "incomplete",
  MERGED = "merged",
  MISSING = "missing",
  MODIFIED = "modified",
  NONE = "none",
  NORMAL = "normal",
  OBSTRUCTED = "obstructed",
  REPLACED = "replaced",
  UNVERSIONED = "unversioned"
}

export enum PropStatus {
  CONFLICTED = "conflicted",
  MODIFIED = "modified",
  NONE = "none",
  NORMAL = "normal"
}

export interface ICpOptions extends SpawnOptions {
  cwd?: string;
  encoding?: string | null;
  log?: boolean;
  username?: string;
  password?: string;
  timeout?: number; // Phase 12 perf fix - SVN command timeout in ms
  token?: CancellationToken; // Phase 18 perf fix - Allow cancelling long SVN operations
  realmUrl?: string; // Repository URL for credential cache (security fix)
}

export interface ISvnErrorData {
  error?: Error;
  message?: string;
  stdout?: string;
  stderr?: string;
  stderrFormated?: string;
  exitCode?: number;
  svnErrorCode?: string;
  svnCommand?: string;
}

export interface ISvnOptions {
  svnPath: string;
  version: string;
}

export interface IExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Result from SVN update operation
 */
export interface IUpdateResult {
  /** Final revision after update */
  revision: number | null;
  /** Conflicted file paths (lines starting with 'C ') */
  conflicts: string[];
  /** User-friendly message (last line of output) */
  message: string;
}

export interface ISvn {
  path: string;
  version: string;
}

export enum SvnUriAction {
  LOG = "LOG",
  PATCH = "PATCH",
  SHOW = "SHOW",
  LOG_REVISION = "LOG_REVISION",
  LOG_SEARCH = "LOG_SEARCH",
  BLAME = "BLAME"
}

export interface ISvnUriExtraParams {
  ref?: string;
  limit?: string;
  revision?: number;
  search?: string;
}

export interface ISvnUriParams {
  action: SvnUriAction;
  fsPath: string;
  extra: ISvnUriExtraParams;
}

/** Blame line info from svn blame --xml */
export interface ISvnBlameLine {
  lineNumber: number;
  revision?: string;
  author?: string;
  date?: string;
  merged?: {
    path: string;
    revision: string;
    author: string;
    date: string;
  };
}

export interface IOperations {
  isIdle(): boolean;
  isRunning(operation: Operation): boolean;
}

export interface IAuth {
  username: string;
  password: string;
}

export interface IStoredAuth {
  account: string;
  password: string;
}
export interface ISvnLogEntryPath {
  /** full path from repo root */
  _: string;
  /** A | D | M | R */
  action: string;
  /** "file" | "dir" e.g. */
  kind: string;
  copyfromPath?: string;
  copyfromRev?: string;
}

/** produced by svn log */
export interface ISvnLogEntry {
  revision: string;
  author: string;
  date: string;
  msg: string;
  paths: ISvnLogEntryPath[];
}

export enum SvnDepth {
  exclude = "exclude from working copy",
  empty = "only the target itself",
  files = "the target and any immediate file children thereof",
  immediates = "the target and any immediate children thereof",
  infinity = "the target and all of its descendants—full recursion"
}

export type SparseDepthKey = keyof typeof SvnDepth;

export interface ISparseItem {
  name: string;
  path: string;
  kind: "file" | "dir";
  depth?: SparseDepthKey;
  isGhost: boolean;
  /** True if folder contains excluded children (ghosts) */
  hasExcludedChildren?: boolean;
  /** Server revision: last committed revision (from svn list) */
  revision?: string;
  author?: string;
  date?: string;
  /** Local revision: working copy revision (from svn info) */
  localRevision?: string;
  /** File size in bytes (files only) */
  size?: string;
  /** Lock status for local items */
  lockStatus?: LockStatus;
  lockOwner?: string;
  lockComment?: string;
}

export interface LineChange {
  readonly originalStartLineNumber: number;
  readonly originalEndLineNumber: number;
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
}

/** SVN lock information from svn info --xml or svn status -u --xml */
export interface ISvnLockInfo {
  /** Lock owner username */
  owner: string;
  /** Opaque lock token (e.g., "opaquelocktoken:12345-67890") */
  token: string;
  /** Optional lock comment */
  comment?: string;
  /** ISO 8601 creation timestamp */
  created: string;
}

/** Options for svn lock command */
export interface ILockOptions {
  /** Lock comment (--message) */
  comment?: string;
  /** Force steal lock from another user (--force) */
  force?: boolean;
}

/** Options for svn unlock command */
export interface IUnlockOptions {
  /** Force break lock owned by another user (--force) */
  force?: boolean;
}
