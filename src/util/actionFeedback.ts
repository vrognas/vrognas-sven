// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { window } from "vscode";

/** How long transient action feedback stays in the status bar. */
const FEEDBACK_TIMEOUT_MS = 5000;

/**
 * Confirm the outcome of a user-initiated action inline (status bar)
 * instead of a disconnected corner toast that must be dismissed.
 *
 * Policy: use this for pure outcome confirmations ("Committed revision
 * 42", "2 files staged") and benign nothing-to-do outcomes ("No changes
 * to commit"). Keep `showInformationMessage` for messages that offer a
 * decision (action buttons), report partial/failed state, or teach a
 * non-obvious consequence or next step.
 */
export function showActionFeedback(message: string): void {
  window.setStatusBarMessage(message, FEEDBACK_TIMEOUT_MS);
}
