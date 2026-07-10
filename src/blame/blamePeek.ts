// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { commands, Location, Position, Range, Uri } from "vscode";
import { tempSvnFs } from "../temp_svn_fs";
import { showActionFeedback } from "../util/actionFeedback";

/** The slice of the SVN wrapper the blame peek needs. */
export interface IBlamePeekSource {
  patchRevision(revision: string, url: Uri): Promise<string>;
}

/**
 * Diff-document line to anchor the peek at: the `+` line whose content
 * matches the blamed line. Blame guarantees the line is unchanged since
 * that revision, so its text appears verbatim among the additions of
 * `svn diff -c REV`. Falls back to the first hunk header.
 */
export function findHunkAnchor(patch: string, lineText: string): number {
  const lines = patch.split(/\r?\n/);
  const needle = lineText.trim();
  let firstHunk = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("@@")) {
      if (firstHunk === -1) {
        firstHunk = i;
      }
      continue;
    }
    if (
      needle &&
      firstHunk !== -1 &&
      line.startsWith("+") &&
      !line.startsWith("+++") &&
      line.slice(1).trim() === needle
    ) {
      return i;
    }
  }
  return firstHunk === -1 ? 0 : firstHunk;
}

/**
 * Peek the CHANGE the blamed revision made to this file - the diff hunk
 * around the hovered line, inline, without leaving the editor. The
 * `svn diff -c REV` patch is immutable and served from the pinned-
 * revision cache after the first fetch.
 */
export async function peekBlameChange(
  source: IBlamePeekSource,
  uri: Uri,
  revision: string,
  workingLine: number,
  lineText: string
): Promise<void> {
  let patch: string;
  try {
    patch = await source.patchRevision(revision, uri);
  } catch {
    showActionFeedback(`Unable to load the r${revision} change for this file.`);
    return;
  }
  if (!patch.trim()) {
    showActionFeedback(
      `No text change recorded for r${revision} in this file.`
    );
    return;
  }

  // .diff basename so the peek editor gets diff syntax highlighting
  const diffUri = tempSvnFs.createTempSvnRevisionFile(
    uri.with({ path: `${uri.path}.diff` }),
    revision,
    patch
  );
  const anchor = findHunkAnchor(patch, lineText);
  await commands.executeCommand(
    "editor.action.peekLocations",
    uri,
    new Position(workingLine, 0),
    [new Location(diffUri, new Range(anchor, 0, anchor, 0))],
    "peek"
  );
}
