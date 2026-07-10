// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { ThemeColor, window } from "vscode";
import { LockStatus, IExecutionResult } from "../common/types";
import { makeWritable, makeReadOnly } from "../fs";
import { showActionFeedback } from "./actionFeedback";

/**
 * Get human-readable tooltip for lock status.
 * @param status Lock status code (K/O/B/T)
 * @param owner Lock owner name (optional)
 * @param defaultText Text to return for unknown status (default: "")
 */
export function getLockTooltip(
  status?: LockStatus | null,
  owner?: string | null,
  defaultText = ""
): string {
  switch (status) {
    case LockStatus.K:
      return "Locked by you";
    case LockStatus.O:
      return owner ? `Locked by ${owner}` : "Locked by others";
    case LockStatus.B:
      return "Lock broken";
    case LockStatus.T:
      return owner ? `Lock stolen by ${owner}` : "Lock stolen";
    default:
      return defaultText;
  }
}

/**
 * Get color for lock status badge.
 * K=blue (safe), O=orange (blocked), B/T=red (error)
 */
export function getLockColor(lockStatus: LockStatus): ThemeColor {
  switch (lockStatus) {
    case LockStatus.K:
      return new ThemeColor("charts.blue");
    case LockStatus.O:
      return new ThemeColor("charts.orange");
    case LockStatus.B:
    case LockStatus.T:
      return new ThemeColor("errorForeground");
    default:
      return new ThemeColor("charts.orange");
  }
}

/**
 * Handle SVN command result with success/error messaging.
 * @returns true if operation succeeded, false otherwise
 */
export function handleSvnResult(
  result: IExecutionResult,
  successMessage: string,
  errorPrefix: string
): boolean {
  if (result.exitCode === 0) {
    showActionFeedback(successMessage);
    return true;
  } else {
    window.showErrorMessage(
      `${errorPrefix}: ${result.stderr || "Unknown error"}`
    );
    return false;
  }
}

/**
 * Make files writable after locking (ignore errors).
 */
export async function makeFilesWritable(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      await makeWritable(p);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Make files read-only after unlocking if they have svn:needs-lock.
 */
export async function makeFilesReadOnlyIfNeeded(
  paths: string[],
  hasNeedsLock: (path: string) => Promise<boolean>
): Promise<void> {
  for (const p of paths) {
    if (await hasNeedsLock(p)) {
      try {
        await makeReadOnly(p);
      } catch {
        /* ignore */
      }
    }
  }
}
