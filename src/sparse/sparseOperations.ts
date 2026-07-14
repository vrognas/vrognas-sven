// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import type { Repository } from "../repository";

type SparseStatusSource = Pick<
  Repository,
  "workspaceRoot" | "changes" | "unversioned"
>;
type SparseStatusController = Pick<
  Repository,
  "beginSparseDownload" | "endSparseDownload"
>;

/** Return changed/unversioned paths at or below one sparse-depth target. */
export function collectUnsafeSparsePaths(
  repository: SparseStatusSource,
  targetPath: string
): string[] {
  const prefix = targetPath.replace(/\\/g, "/").toLowerCase();
  const unsafe: string[] = [];
  for (const group of [repository.changes, repository.unversioned]) {
    for (const { resourceUri } of group.resourceStates) {
      const resourcePath = resourceUri.fsPath.replace(/\\/g, "/").toLowerCase();
      if (resourcePath === prefix || resourcePath.startsWith(`${prefix}/`)) {
        unsafe.push(
          path.relative(repository.workspaceRoot, resourceUri.fsPath)
        );
      }
    }
  }
  return unsafe;
}

/** Suppress repository status work once per repository for the whole action. */
export async function withSparseStatusSuppressed<T>(
  repositories: Iterable<SparseStatusController>,
  action: () => Promise<T>
): Promise<T> {
  const unique = new Set(repositories);
  for (const repository of unique) repository.beginSparseDownload();
  try {
    return await action();
  } finally {
    for (const repository of unique) repository.endSparseDownload();
  }
}
