// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import type { IBranchItem } from "../common/types";
import { configuration } from "./configuration";

export function getBranchName(folder: string): IBranchItem | undefined {
  const confs = [
    "layout.trunkRegex",
    "layout.branchesRegex",
    "layout.tagsRegex"
  ];

  for (const conf of confs) {
    const layout = configuration.get<string>(conf);
    if (!layout) {
      continue;
    }
    const group = configuration.get<number>(`${conf}Name`, 1) + 2;
    const matches = folder.match(new RegExp(`(^|/)(${layout})$`));

    if (matches && matches[2] && matches[group]) {
      return {
        name: matches[group],
        path: matches[2]
      };
    }
  }

  return;
}
