// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import {
  commands,
  Location,
  Position,
  ProgressLocation,
  Range,
  Uri,
  window
} from "vscode";
import { ISvnBlameLine } from "../common/types";
import { tempSvnFs } from "../temp_svn_fs";
import { showActionFeedback } from "../util/actionFeedback";
import { computeLineMapping } from "../util/lineMapper";

/** The slice of the SVN wrapper the blame peek needs. */
export interface IBlamePeekSource {
  patchRevision(revision: string, url: Uri): Promise<string>;
}

/** The additional slice the line-history walk needs. */
export interface ILineHistorySource extends IBlamePeekSource {
  blame(
    file: string,
    revision?: string,
    skipCache?: boolean,
    pegRevision?: string
  ): Promise<ISvnBlameLine[]>;
  show(
    file: string | Uri,
    revision?: string,
    pegRevision?: string
  ): Promise<string>;
  getInfo(file: string): Promise<{ revision: string }>;
}

/** One revision in a line's change history. */
export interface ILineChange {
  revision: string;
  author?: string;
  date?: string;
  /** The tracked line's text AT this revision (hunk anchor needle). */
  lineText: string;
}

/**
 * Diff-document line to anchor the peek at: the `+` line whose content
 * matches the blamed line. Blame guarantees the line is unchanged since
 * that revision, so its text appears verbatim among the additions of
 * `svn diff -c REV`. Falls back to the first hunk header.
 */
export function findHunkAnchor(patch: string, lineText: string): number {
  const lines = patch.split(/\r?\n/);
  // Whitespace-insensitive: blame runs with -x "-w --ignore-eol-style",
  // so the blamed line may differ from the diff's + line in internal
  // whitespace even though blame calls it unchanged
  const collapse = (s: string) => s.replace(/\s+/g, "");
  const needle = collapse(lineText);
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
      collapse(line.slice(1)) === needle
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

/**
 * Every revision that changed one line, newest first, via blame
 * chaining: SVN has no line-log, but blame pegged at BASE names the
 * line's latest change; LCS line mapping carries the line's position
 * into the revision just before that change, where a pegged blame
 * names the previous one - repeat until the line's first appearance.
 * Each step is a pinned (immutable) blame/cat, so a walk is slow once
 * and cache-instant afterwards.
 */
export async function walkLineHistory(
  source: ILineHistorySource,
  filePath: string,
  baseLine: number,
  opts: { maxSteps?: number; shouldContinue?: () => boolean } = {}
): Promise<ILineChange[]> {
  const maxSteps = opts.maxSteps ?? 20;
  const shouldContinue = opts.shouldContinue ?? (() => true);
  const changes: ILineChange[] = [];

  let curRev: string | undefined; // undefined = BASE
  let curLine = baseLine; // 1-indexed in curRev's coordinates
  let curLines: string[];
  try {
    curLines = (await source.show(filePath, "BASE")).split(/\r?\n/);
  } catch {
    return changes;
  }
  let lastRevNum = Infinity;

  // Peg all historical lookups at the BASE revision - the one revision
  // where the file's CURRENT name is guaranteed valid - so svn traces
  // the lineage back THROUGH renames instead of failing on old names
  let peg: string | undefined;
  try {
    const info = await source.getInfo(filePath);
    if (/^\d+$/.test(info.revision)) {
      peg = info.revision;
    }
  } catch {
    // unpegged fallback: the walk still works up to a rename boundary
  }

  while (changes.length < maxSteps && shouldContinue()) {
    let blame: ISvnBlameLine[];
    try {
      blame =
        curRev === undefined
          ? await source.blame(filePath, "BASE")
          : await source.blame(filePath, curRev, false, peg);
    } catch {
      break;
    }
    const entry = blame.find(l => l.lineNumber === curLine);
    const revNum = entry?.revision ? parseInt(entry.revision, 10) : NaN;
    if (!entry?.revision || isNaN(revNum) || revNum >= lastRevNum) {
      break; // unannotated line, or not strictly decreasing (safety)
    }
    lastRevNum = revNum;
    changes.push({
      revision: entry.revision,
      author: entry.author,
      date: entry.date,
      lineText: curLines[curLine - 1] ?? ""
    });

    const prevRev = revNum - 1;
    if (prevRev < 1) {
      break;
    }
    let prevLines: string[];
    try {
      prevLines = (await source.show(filePath, String(prevRev), peg)).split(
        /\r?\n/
      );
    } catch {
      break; // file didn't exist before this change - reached the add
    }
    if (prevLines.length > MAX_WALK_LINES) {
      break; // O(n^2) mapping gate - stop rather than freeze
    }
    const mapped = computeLineMapping(curLines, prevLines).get(curLine);
    if (mapped === undefined) {
      break; // no ancestor line - it first appeared in this change
    }
    curLine = mapped;
    curLines = prevLines;
    curRev = String(prevRev);
  }
  return changes;
}

/**
 * "Scroll through the changes" of one line: walk its history and open
 * a MULTI-location peek - the references-style list holds one entry
 * per revision that changed the line, each previewing that revision's
 * diff hunk. The count and revision list also land in the status bar.
 */
/** LCS line mapping is O(n^2) per hop - gate huge files like the other
 *  blame surfaces do. */
const MAX_WALK_LINES = 20_000;
const MAX_WALK_STEPS = 20;

export async function peekLineHistory(
  source: ILineHistorySource,
  uri: Uri,
  baseLine: number,
  workingLine: number
): Promise<void> {
  let baseLineCount = 0;
  try {
    baseLineCount = (await source.show(uri.fsPath, "BASE")).split(
      /\r?\n/
    ).length;
  } catch {
    // walk handles the unversioned/offline case itself
  }
  if (baseLineCount > MAX_WALK_LINES) {
    showActionFeedback(
      `File too large for line history (${baseLineCount} lines).`
    );
    return;
  }

  const state = await window.withProgress(
    {
      location: ProgressLocation.Notification,
      title: "SVN: Collecting line history",
      cancellable: true
    },
    async (_progress, token) => {
      const walked = await walkLineHistory(source, uri.fsPath, baseLine, {
        maxSteps: MAX_WALK_STEPS,
        shouldContinue: () => !token?.isCancellationRequested
      });
      const locations: Location[] = [];
      const shownRevisions: string[] = [];
      let unavailable = 0;
      for (const change of walked) {
        if (token?.isCancellationRequested) {
          break;
        }
        try {
          const patch = await source.patchRevision(change.revision, uri);
          if (!patch.trim()) {
            unavailable++;
            continue;
          }
          const diffUri = tempSvnFs.createTempSvnRevisionFile(
            uri.with({ path: `${uri.path}.diff` }),
            change.revision,
            patch
          );
          const anchor = findHunkAnchor(patch, change.lineText);
          locations.push(
            new Location(diffUri, new Range(anchor, 0, anchor, 0))
          );
          shownRevisions.push(change.revision);
        } catch {
          unavailable++;
        }
      }
      return {
        walked,
        locations,
        shownRevisions,
        unavailable,
        cancelled: token?.isCancellationRequested === true
      };
    }
  );

  if (state.cancelled) {
    return; // the user backed out - no feedback, no peek
  }
  if (state.walked.length === 0) {
    showActionFeedback("No line history found for this line.");
    return;
  }
  if (state.locations.length === 0) {
    showActionFeedback(
      `Found ${state.walked.length} change${
        state.walked.length === 1 ? "" : "s"
      } but could not load their diffs (offline?).`
    );
    return;
  }

  // Report exactly what the peek shows - not what the walk found
  const truncated =
    state.walked.length >= MAX_WALK_STEPS ? " · older changes not walked" : "";
  const dropped =
    state.unavailable > 0 ? ` · ${state.unavailable} diff(s) unavailable` : "";
  showActionFeedback(
    `Line changed in ${state.shownRevisions.length} revision${
      state.shownRevisions.length === 1 ? "" : "s"
    }: ${state.shownRevisions.map(r => `r${r}`).join(", ")}${truncated}${dropped}`
  );
  await commands.executeCommand(
    "editor.action.peekLocations",
    uri,
    new Position(workingLine, 0),
    state.locations,
    "peek"
  );
}
