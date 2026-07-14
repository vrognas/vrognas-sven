// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { ProgressLocation, window } from "vscode";
import { SvnKindType } from "../common/types";
import type { IBranchItem } from "../common/types";
import FolderItem from "../quickPickItems/folderItem";
import NewFolderItem from "../quickPickItems/newFolderItem";
import ParentFolderItem from "../quickPickItems/parentFolderItem";
import type { Repository } from "../repository";
import { getBranchName } from "./branchName";
import { configuration } from "./configuration";

export { getBranchName };

export async function selectBranch(
  repository: Repository,
  allowNew = false,
  folder?: string
): Promise<IBranchItem | undefined> {
  const promise = repository.repository.list(folder);

  window.withProgress(
    { location: ProgressLocation.Window, title: "Checking remote branches" },
    () => promise
  );

  const list = await promise;

  const dirs = list.filter(item => item.kind === SvnKindType.DIR);

  const picks = [];

  if (folder) {
    const parts = folder.split("/");
    parts.pop();
    const parent = parts.join("/");
    picks.push(new ParentFolderItem(parent));
  }

  if (allowNew && folder && !!getBranchName(`${folder}/test`)) {
    picks.push(new NewFolderItem(folder));
  }

  picks.push(...dirs.map(dir => new FolderItem(dir, folder)));

  const choice = await window.showQuickPick(picks);

  if (!choice) {
    return;
  }

  if (choice instanceof ParentFolderItem) {
    return selectBranch(repository, allowNew, choice.path);
  }
  if (choice instanceof FolderItem) {
    if (choice.branch) {
      return choice.branch;
    }

    return selectBranch(repository, allowNew, choice.path);
  }

  if (choice instanceof NewFolderItem) {
    const result = await window.showInputBox({
      prompt: "Please provide a branch name",
      ignoreFocusOut: true
    });

    if (!result) {
      return;
    }

    const name = result.replace(
      /^\.|\/\.|\.\.|~|\^|:|\/$|\.lock$|\.lock\/|\\|\*|\s|^\s*$|\.$/g,
      "-"
    );

    const newBranch = getBranchName(`${folder}/${name}`);
    if (newBranch) {
      newBranch.isNew = true;
    }

    return newBranch;
  }

  return;
}

// Memoize the compiled regex so repeated isTrunk() calls (e.g.,
// HasBranch.checkHasBranch on every repo change) don't recompile it.
// Keyed by config values so test mocks of configuration.get still take effect.
let trunkRegexCache:
  | { layout: string; group: number; regex: RegExp }
  | undefined;

export function isTrunk(folder: string): boolean {
  const conf = "layout.trunkRegex";
  const layout = configuration.get<string>(conf);
  if (!layout) {
    return false;
  }
  const group = configuration.get<number>(`${conf}Name`, 1) + 2;

  if (
    !trunkRegexCache ||
    trunkRegexCache.layout !== layout ||
    trunkRegexCache.group !== group
  ) {
    trunkRegexCache = {
      layout,
      group,
      regex: new RegExp(`(^|/)(${layout})$`)
    };
  }

  const matches = folder.match(trunkRegexCache.regex);
  return !!(matches && matches[2] && matches[group]);
}
