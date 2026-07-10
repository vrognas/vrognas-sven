// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import picomatch from "picomatch";
import { window } from "vscode";
import { Repository } from "../repository";
import { formatSvnError, logError } from "../util/errorLogger";
import { showActionFeedback } from "../util/actionFeedback";

export interface RemoveFromIgnoreOptions {
  /** Show confirmation for single pattern match (default: false) */
  confirmSingleMatch?: boolean;
}

/**
 * Find and remove ignore pattern(s) matching a filename.
 * Handles: no matches (show all), single match, multiple matches (pick one).
 *
 * @param repository SVN repository
 * @param dirName Directory containing svn:ignore
 * @param fileName File name to match against patterns
 * @param options Configuration options
 * @returns true if pattern was removed, false if cancelled
 */
export async function removeMatchingIgnorePattern(
  repository: Repository,
  dirName: string,
  fileName: string,
  options: RemoveFromIgnoreOptions = {}
): Promise<boolean> {
  const { confirmSingleMatch = false } = options;

  // Get current ignore patterns for this directory
  const patterns = (await repository.getCurrentIgnore(dirName)).filter(
    p => p.trim() !== ""
  );

  if (patterns.length === 0) {
    showActionFeedback("No ignore patterns found in this directory");
    return false;
  }

  // Find patterns that match this file
  const matchingPatterns = patterns.filter(p => {
    if (p === fileName) return true;
    return picomatch.isMatch(fileName, p, { dot: true });
  });

  let patternToRemove: string | undefined;

  if (matchingPatterns.length === 0) {
    // No matches - show all patterns for user to pick
    const pick = await window.showQuickPick(
      patterns.map(p => ({
        label: p,
        description: `Remove '${p}' from svn:ignore`
      })),
      { placeHolder: "Select pattern to remove" }
    );
    if (!pick) return false;
    patternToRemove = pick.label;
  } else if (matchingPatterns.length === 1) {
    const pattern = matchingPatterns[0]!;

    if (confirmSingleMatch) {
      // Confirm before removing
      const confirm = await window.showQuickPick(
        [
          { label: "Yes", description: `Remove '${pattern}' from svn:ignore` },
          { label: "No", description: "Cancel" }
        ],
        { placeHolder: `Remove pattern '${pattern}'?` }
      );
      if (confirm?.label !== "Yes") return false;
    }

    patternToRemove = pattern;
  } else {
    // Multiple matches - let user pick
    const pick = await window.showQuickPick(
      matchingPatterns.map(p => ({
        label: p,
        description: `Remove '${p}' from svn:ignore`
      })),
      { placeHolder: "Multiple patterns match - select one to remove" }
    );
    if (!pick) return false;
    patternToRemove = pick.label;
  }

  // Remove the selected pattern
  try {
    await repository.removeFromIgnore(patternToRemove, dirName);
    showActionFeedback(`Removed '${patternToRemove}' from svn:ignore`);
    return true;
  } catch (error) {
    logError("Failed to remove pattern", error);
    window.showErrorMessage(
      formatSvnError(error, "Failed to remove ignore pattern")
    );
    return false;
  }
}
