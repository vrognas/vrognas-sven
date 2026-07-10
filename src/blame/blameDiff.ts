// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { commands, TextDocumentShowOptions, Uri, window } from "vscode";
import { ISvnLogEntry } from "../common/types";
import { openDiffCompared } from "../historyView/common";
import { tempSvnFs } from "../temp_svn_fs";
import { showActionFeedback } from "../util/actionFeedback";

/** The slice of the SVN wrapper the blame diff needs. */
export interface IBlameDiffSource {
  log(
    rfrom: string,
    rto: string,
    limit: number,
    target?: string | Uri,
    pegRevision?: string
  ): Promise<ISvnLogEntry[]>;
  show(
    file: string | Uri,
    revision?: string,
    pegRevision?: string
  ): Promise<string>;
  getInfo(file: string): Promise<{ revision: string }>;
  patchRevision(revision: string, url: Uri): Promise<string>;
}

/**
 * "Diff with previous" from a blame hover: resolve the file's ACTUAL
 * previous change (a 2-entry log - the prior revision of the file is
 * rarely revision-1) and open the parallel-fetch diff. When the blamed
 * revision added the file there is no previous: open its content instead.
 *
 * Rename-safe: the log runs UNPEGGED on the working-copy path (default
 * BASE peg), and the content fetches peg at the BASE revision - both let
 * svn trace the file's lineage back through renames instead of failing
 * on a name that didn't exist at the older revision.
 */
export async function openBlameRevisionDiff(
  source: IBlameDiffSource,
  uri: Uri,
  revision: string
): Promise<void> {
  let revs: ISvnLogEntry[];
  try {
    revs = await source.log(revision, "1", 2, uri);
  } catch {
    window.showErrorMessage(
      `Unable to resolve the previous revision of this file before r${revision}.`
    );
    return;
  }

  // Lineage anchor for the content fetches (see doc comment)
  let peg: string | undefined;
  try {
    const info = await source.getInfo(uri.fsPath);
    if (/^\d+$/.test(info.revision)) {
      peg = info.revision;
    }
  } catch {
    // unpegged fallback - correct up to a rename boundary
  }

  if (revs.length < 2) {
    showActionFeedback(
      `r${revision} added this file — there is no previous revision to diff against.`
    );
    try {
      const content = await source.show(uri, revision, peg);
      const contentUri = tempSvnFs.createTempSvnRevisionFile(
        uri,
        revision,
        content
      );
      const opts: TextDocumentShowOptions = { preview: true };
      await commands.executeCommand<void>("vscode.open", contentUri, opts);
    } catch {
      // Content view is best-effort; the info message already explained
    }
    return;
  }

  return openDiffCompared(
    source,
    uri,
    revs[1]!.revision,
    revision,
    undefined,
    peg
  );
}
