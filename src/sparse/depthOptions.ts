// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import type { QuickPickItem } from "vscode";
import type { SparseDepthKey } from "../common/types";

export interface SvnDepthQuickPickItem extends QuickPickItem {
  depth: SparseDepthKey;
}

export interface DepthQuickPickItem extends QuickPickItem {
  depth: SparseDepthKey | "_omitExternals";
}

export const checkoutDepthOptions: SvnDepthQuickPickItem[] = [
  {
    label: "$(folder-opened) Full",
    description: "Download everything",
    detail: "Downloads the folder and all its contents recursively.",
    depth: "infinity"
  },
  {
    label: "$(list-tree) Shallow",
    description: "Files + empty subfolders",
    detail:
      "Downloads files and shows subfolders as empty. Good for exploring structure.",
    depth: "immediates"
  },
  {
    label: "$(file) Files Only",
    description: "Skip subfolders",
    detail: "Downloads files in this folder, but skips all subfolders.",
    depth: "files"
  },
  {
    label: "$(folder) Folder Only",
    description: "Empty placeholder",
    detail: "Keeps the folder as a placeholder but downloads no files.",
    depth: "empty"
  }
];

export const depthPickerOptions: SvnDepthQuickPickItem[] = [
  {
    label: "$(eye-closed) Exclude",
    description: "Don't download this folder",
    detail:
      "Removes the folder and all contents locally. Use for large folders you don't need.",
    depth: "exclude"
  },
  ...checkoutDepthOptions
];
