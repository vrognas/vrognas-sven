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
  addRevision?: string
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
      "sven.blame.showDiff"
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
      diffLink
  );
  return md;
}
