// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { MarkdownString, Uri } from "vscode";
import { ISvnBlameLine } from "../common/types";
import { formatBlameDate } from "../util/formatting";

/**
 * Rich hover for blame decorations: commit metadata plus command links
 * into the neighboring features. The hover was previously a plain string
 * dead-end ("SVN: rN by author") while the history machinery to answer
 * "show me that commit" sat one command away.
 *
 * Only the two commands below may run from this hover (least privilege via
 * MarkdownString.isTrusted.enabledCommands).
 */
export function buildBlameHover(
  blameLine: ISvnBlameLine,
  message?: string,
  fileUri?: Uri,
  addRevision?: string,
  workingLine?: number
): MarkdownString {
  const rev = blameLine.revision ?? "";
  // The blamed revision IS the file's add revision: say so, and skip
  // the diff link - there is no previous revision of this file to
  // diff against
  const isAddRevision = !!rev && rev === addRevision;
  const md = new MarkdownString(undefined, true);
  md.isTrusted = {
    enabledCommands: [
      "sven.repolog.goToRevision",
      "sven.blame.copyRevision",
      "sven.blame.showDiff",
      "sven.blame.peekChange",
      "sven.blame.peekLineHistory"
    ]
  };

  const date = blameLine.date
    ? formatBlameDate(blameLine.date, "absolute")
    : "";
  const addedNote = isAddRevision ? " · $(diff-added) added this file" : "";
  md.appendMarkdown(
    `**r${rev}** · ${blameLine.author ?? "unknown"}${date ? ` · ${date}` : ""}${addedNote}\n\n`
  );
  if (message) {
    md.appendMarkdown(`${message}\n\n`);
  }
  // Inline peek of the hunk this revision changed around the line -
  // works for add-revision lines too (the hunk is the file's addition)
  const peekLink =
    fileUri && workingLine !== undefined
      ? ` · [$(eye) Peek Change](command:sven.blame.peekChange?${encodeURIComponent(
          JSON.stringify([fileUri.toString(), rev, workingLine])
        )} "Peek the r${rev} change around this line")`
      : "";
  // Walk EVERY revision that changed this line and peek them as a
  // scrollable list (one entry per change)
  const historyLink =
    fileUri && workingLine !== undefined
      ? ` · [$(versions) Line History](command:sven.blame.peekLineHistory?${encodeURIComponent(
          JSON.stringify([
            fileUri.toString(),
            blameLine.lineNumber,
            workingLine
          ])
        )} "Peek every revision that changed this line")`
      : "";
  const diffLink =
    fileUri && !isAddRevision
      ? ` · [$(git-compare) Diff with Previous](command:sven.blame.showDiff?${encodeURIComponent(
          JSON.stringify([fileUri.toString(), rev])
        )} "Diff this file: previous revision vs r${rev}")`
      : "";
  md.appendMarkdown(
    `[$(history) Show in History](command:sven.repolog.goToRevision?${encodeURIComponent(
      JSON.stringify([parseInt(rev, 10)])
    )} "Reveal r${rev} in the Repo History view") · ` +
      `[$(copy) Copy Revision](command:sven.blame.copyRevision?${encodeURIComponent(
        JSON.stringify([rev])
      )} "Copy r${rev} to the clipboard")` +
      peekLink +
      historyLink +
      diffLink
  );
  return md;
}
