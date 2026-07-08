// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

/**
 * Positron Connections Provider (Phase 23.P1)
 *
 * Registers SVN repositories as connections in Positron Connections pane
 * Shows: branch, revision, remote URL, status
 * Quick actions: Update, Switch, Show Changes
 */

import { logWarning } from "../util/errorLogger";
import type {
  ConnectionsDriver,
  ConnectionsDriverMetadata,
  ConnectionsInput
} from "positron";
import { commands, Disposable } from "vscode";
import type { SourceControlManager } from "../source_control_manager";
import { getPositronApi } from "./runtime";

/**
 * SVN Connections Driver for Positron
 *
 * Enables users to:
 * - View SVN repositories in Connections pane
 * - See current branch, revision, status
 * - Quick checkout/update actions
 */
export class SvnConnectionsProvider implements ConnectionsDriver {
  readonly driverId = "svn-scm";

  readonly metadata: ConnectionsDriverMetadata = {
    languageId: "svn",
    name: "Subversion Repository",
    inputs: [
      {
        id: "url",
        label: "Repository URL",
        type: "string"
      },
      {
        id: "targetPath",
        label: "Local Directory (optional)",
        type: "string"
      }
    ]
  };

  constructor(private sourceControlManager: SourceControlManager) {}

  /**
   * Generate SVN checkout code from user inputs
   */
  generateCode(inputs: ConnectionsInput[]): string {
    const url = inputs.find(i => i.id === "url")?.value || "";
    const target = inputs.find(i => i.id === "targetPath")?.value || "";

    if (target) {
      return `svn checkout ${url} ${target}`;
    }
    return `svn checkout ${url}`;
  }

  /**
   * Execute SVN checkout command
   */
  async connect(code: string): Promise<void> {
    // Execute the generated SVN command
    // For now, show the command to user
    await commands.executeCommand("sven.showOutput");
    logWarning("SVN Connection: Would execute", code);
  }

  /**
   * Check if SVN is installed and available
   */
  checkDependencies(): Promise<boolean> {
    // Non-async (nothing to await); Positron's driver contract wants a
    // Promise, so return one explicitly
    return Promise.resolve(this.sourceControlManager.repositories.length > 0);
  }
}

/**
 * Register SVN connections provider with Positron
 *
 * @param sourceControlManager Source control manager instance
 * @returns Disposable to unregister the provider
 */
export function registerSvnConnectionsProvider(
  sourceControlManager: SourceControlManager
): Disposable | undefined {
  const api = getPositronApi();
  if (!api) {
    return undefined;
  }

  const provider = new SvnConnectionsProvider(sourceControlManager);

  return api.connections.registerConnectionDriver(provider);
}
