// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { TreeView, window } from "vscode";

/** How long transient action feedback stays visible. */
export const FEEDBACK_TIMEOUT_MS = 5000;

/**
 * Feedback policy - confirm outcomes WHERE the action took place:
 *
 * - View action (history jump, sparse download) -> `showViewFeedback`,
 *   a transient message inside that tree view.
 * - Commit-box action -> `showCommitBoxFeedback`, a transient flash of
 *   the SCM input placeholder.
 * - Status-bar-initiated action (update) -> `SyncStatusBar.flashResult`.
 * - Effect already visible (blame decorations, files moving lists,
 *   pickers reopening updated) -> NO message at all.
 * - No anchoring surface (clipboard copies, property tweaks) ->
 *   `showActionFeedback`, the transient status-bar channel.
 *
 * `showInformationMessage` toasts remain only for decisions (action
 * buttons), warnings/errors, partial-failure summaries, and messages
 * that teach a non-obvious consequence or next step.
 */
export function showActionFeedback(message: string): void {
  window.setStatusBarMessage(message, FEEDBACK_TIMEOUT_MS);
}

/**
 * Show a view-scoped outcome INSIDE that view (rendered above the tree
 * content), auto-clearing unless a newer message replaced it. Falls
 * back to the status bar when the view handle is unavailable (failed
 * createTreeView on a dev reload).
 */
export function showViewFeedback(
  view:
    | (Pick<TreeView<unknown>, "message"> & { visible?: boolean })
    | undefined,
  message: string
): void {
  // A message inside a HIDDEN view is invisible feedback - commands
  // reachable from outside the view (blame hover links) fall back to
  // the status bar instead
  if (!view || view.visible === false) {
    showActionFeedback(message);
    return;
  }
  view.message = message;
  setTimeout(() => {
    if (view.message === message) {
      view.message = undefined;
    }
  }, FEEDBACK_TIMEOUT_MS);
}

/** True original placeholders, so overlapping flashes can't adopt a
 *  flash text as the "original" to restore. */
const originalPlaceholders = new WeakMap<object, string>();

/**
 * Confirm a commit-box action IN the commit box: the box just cleared,
 * so flash the outcome as its placeholder, then restore the original.
 * Falls back to the status bar for input boxes without a placeholder
 * (plain `{ value }` stubs).
 */
export function showCommitBoxFeedback(
  inputBox: { value: string; placeholder?: string },
  message: string
): void {
  // Commits can be launched with the SCM view closed (palette,
  // keybinding, guided flow) - the status bar is the surface that is
  // always visible; the placeholder flash adds the in-place detail
  showActionFeedback(message);
  if (typeof inputBox.placeholder !== "string") {
    return;
  }
  const original = originalPlaceholders.get(inputBox) ?? inputBox.placeholder;
  originalPlaceholders.set(inputBox, original);
  inputBox.placeholder = message;
  setTimeout(() => {
    if (inputBox.placeholder === message) {
      inputBox.placeholder = original;
    }
  }, FEEDBACK_TIMEOUT_MS);
}
