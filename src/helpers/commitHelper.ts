// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import { window, workspace } from "vscode";
import { Status } from "../common/types";
import { configuration } from "./configuration";
import { inputCommitMessage } from "../messages";
import { Repository } from "../repository";
import { Resource } from "../resource";
import { CommitFlowService } from "../services/commitFlowService";
import { showActionFeedback } from "../util/actionFeedback";
import {
  CommitTypeConfig,
  ConventionalCommitService
} from "../services/conventionalCommitService";

/**
 * Check if there are staged files to commit.
 * Shows message if none staged.
 * @returns true if staged files exist, false otherwise
 */
export function requireStaged(staged: Resource[]): boolean {
  if (staged.length === 0) {
    showActionFeedback("No staged files to commit");
    return false;
  }
  return true;
}

/**
 * Ensure staged files exist, or offer to stage all changes.
 * Used by commit commands that support auto-staging.
 *
 * @returns true if files are staged (or just got staged), false if cancelled
 */
export async function ensureStagedOrOffer(
  staged: Resource[],
  changes: Resource[],
  repository: Repository,
  resourcesToPaths: (resources: Resource[]) => string[]
): Promise<boolean> {
  if (staged.length > 0) {
    return true;
  }

  if (changes.length === 0) {
    showActionFeedback("No changes to commit");
    return false;
  }

  const choice = await window.showInformationMessage(
    `${changes.length} file(s) not staged. Stage all and commit?`,
    "Stage All",
    "Cancel"
  );

  if (choice !== "Stage All") {
    return false;
  }

  const changePaths = resourcesToPaths(changes);
  await repository.stageOptimistic(changePaths);
  return true;
}

export interface CommitPaths {
  /** Paths to display in picker (new names only for renames) */
  displayPaths: string[];
  /** Map: new path → old path (for renamed files) */
  renameMap: Map<string, string>;
}

/**
 * Build commit paths from resources, handling:
 * - Renamed files (tracks old → new mapping)
 * - Parent directories (ADDED dirs need explicit commit)
 *
 * @param resources - Resources to commit
 * @param repository - Repository for parent directory lookup
 * @returns Display paths and rename map
 */
export function buildCommitPaths(
  resources: Resource[],
  repository: Pick<Repository, "getResourceFromFile">
): CommitPaths {
  const displayPathSet = new Set(resources.map(r => r.resourceUri.fsPath));
  const renameMap = new Map<string, string>();

  for (const resource of resources) {
    // Track renamed files (ADDED + renameResourceUri)
    if (resource.type === Status.ADDED && resource.renameResourceUri) {
      renameMap.set(
        resource.resourceUri.fsPath,
        resource.renameResourceUri.fsPath
      );
    }

    // Add parent directories if ADDED
    let dir = path.dirname(resource.resourceUri.fsPath);
    let parent = repository.getResourceFromFile(dir);
    while (parent) {
      if (parent.type === Status.ADDED) {
        displayPathSet.add(dir);
      }
      dir = path.dirname(dir);
      parent = repository.getResourceFromFile(dir);
    }
  }

  return {
    displayPaths: Array.from(displayPathSet),
    renameMap
  };
}

/**
 * Expand selected paths to include old paths for renamed files.
 * Required for SVN commit to work correctly with renames.
 *
 * @param selectedPaths - Paths selected for commit
 * @param renameMap - Map from new path to old path
 * @returns Expanded paths including old rename paths
 */
export function expandCommitPaths(
  selectedPaths: string[],
  renameMap: Map<string, string>
): string[] {
  const commitPaths = [...selectedPaths];
  for (const selectedPath of selectedPaths) {
    const oldPath = renameMap.get(selectedPath);
    if (oldPath) {
      commitPaths.push(oldPath);
    }
  }
  return commitPaths;
}

export interface ExpandedCommitPaths extends CommitPaths {
  commitPaths: string[];
}

/**
 * Build display/rename metadata and expanded commit paths in one step.
 */
export function buildExpandedCommitPaths(
  resources: Resource[],
  repository: Pick<Repository, "getResourceFromFile">
): ExpandedCommitPaths {
  const { displayPaths, renameMap } = buildCommitPaths(resources, repository);

  return {
    displayPaths,
    renameMap,
    commitPaths: expandCommitPaths(displayPaths, renameMap)
  };
}

export interface CommitMessageFlowResult {
  message?: string;
  commitPaths?: string[];
  cancelled: boolean;
}

// Creates a fresh CommitFlowService with provided types.
function getCommitFlowService(
  userTypes: CommitTypeConfig[]
): CommitFlowService {
  return new CommitFlowService(new ConventionalCommitService(userTypes));
}

/**
 * Warn when files about to be committed have unsaved editor changes -
 * worse in SVN than git since there's no amend to patch it up after.
 * Returns whether the commit should proceed (saving first if asked).
 */
export async function ensureNoUnsavedChanges(
  displayPaths: string[]
): Promise<boolean> {
  const normalize = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const committing = new Set(displayPaths.map(normalize));
  const dirty = workspace.textDocuments.filter(
    doc => doc.isDirty && committing.has(normalize(doc.uri.fsPath))
  );
  if (dirty.length === 0) {
    return true;
  }

  const names = dirty
    .slice(0, 3)
    .map(d => path.basename(d.uri.fsPath))
    .join(", ");
  const more = dirty.length > 3 ? ` (+${dirty.length - 3} more)` : "";
  const choice = await window.showWarningMessage(
    `${dirty.length} file(s) being committed have unsaved changes: ${names}${more}`,
    "Save All & Commit",
    "Commit Anyway"
  );
  if (choice === "Save All & Commit") {
    await Promise.all(dirty.map(doc => doc.save()));
    return true;
  }
  return choice === "Commit Anyway";
}

/**
 * Run a message-producing step under the pre-commit update gate: the
 * update starts before the input shows (concurrent with typing), a
 * cancelled input abandons the update but still surfaces conflicts it
 * produced, and a confirmed input settles the update before committing.
 * Returns the message, or undefined when cancelled/aborted.
 */
export async function withPreCommitUpdate(
  repository: Repository,
  displayPaths: string[],
  getMessage: () => Promise<string | undefined>
): Promise<string | undefined> {
  const autoUpdate = configuration.commitAutoUpdate();
  const updateBeforeCommit = autoUpdate === "both" || autoUpdate === "before";
  const userTypes = configuration.get<CommitTypeConfig[]>("commit.types", []);
  const flowService = getCommitFlowService(userTypes);
  const updatePromise = updateBeforeCommit
    ? flowService.startPreCommitUpdate(repository, displayPaths)
    : undefined;

  const message = await getMessage();

  if (updatePromise) {
    if (message === undefined) {
      void flowService.abandonPreCommitUpdate(updatePromise);
    } else if (
      !(await flowService.settlePreCommitUpdate(
        updatePromise,
        repository,
        message
      ))
    ) {
      return undefined;
    }
  }
  return message;
}

/**
 * Run the shared commit flow: get config, show UI, return message/paths.
 * Used by commitAll and commitStaged commands.
 */
export async function runCommitMessageFlow(
  repository: Repository,
  displayPaths: string[],
  renameMap: Map<string, string>
): Promise<CommitMessageFlowResult> {
  const useQuickPick = configuration.commitUseQuickPick();
  const userTypes = configuration.get<CommitTypeConfig[]>("commit.types", []);
  const conventionalCommits = userTypes.length > 0;
  const autoUpdate = configuration.commitAutoUpdate();
  const updateBeforeCommit = autoUpdate === "both" || autoUpdate === "before";

  let message: string | undefined;
  let selectedPaths: string[] | undefined;

  // Commit safety: surface unsaved editors BEFORE any message typing
  if (!(await ensureNoUnsavedChanges(displayPaths))) {
    return { cancelled: true };
  }

  if (useQuickPick) {
    const result = await getCommitFlowService(userTypes).runCommitFlow(
      repository,
      displayPaths,
      {
        conventionalCommits,
        updateBeforeCommit,
        // Badge files the server has newer versions of (cache lookup)
        hasRemoteChange: p => repository.hasRemoteChangeForFile(p)
      }
    );

    if (result.cancelled) {
      return { cancelled: true };
    }
    message = result.message;
    selectedPaths = result.selectedFiles;
  } else {
    // The plain input-box path used to SKIP the pre-commit update the
    // quickpick path runs - same gate now, started before typing so it
    // runs concurrently with message input.
    message = await withPreCommitUpdate(repository, displayPaths, () =>
      inputCommitMessage(repository.inputBox.value, true, displayPaths)
    );
    selectedPaths = displayPaths;
  }

  if (message === undefined || !selectedPaths) {
    return { cancelled: true };
  }

  const commitPaths = expandCommitPaths(selectedPaths, renameMap);
  return { message, commitPaths, cancelled: false };
}

/**
 * Execute the commit and show result.
 */
export async function executeCommit(
  repository: Repository,
  message: string,
  commitPaths: string[]
): Promise<void> {
  const result = await repository.commitFiles(message, commitPaths);
  showActionFeedback(result);
  repository.inputBox.value = "";
  repository.staging.clearOriginalChangelists(commitPaths);
}
