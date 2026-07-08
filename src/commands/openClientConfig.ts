// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { window, workspace, Uri } from "vscode";
import { Command } from "./command";
import { getSvnConfigPath, svnConfigExists } from "../util/svnConfigPath";
import { getErrorMessage } from "../util/errorLogger";

/**
 * Open the SVN client configuration file in the editor.
 * Location: %APPDATA%\Subversion\config (Windows) or ~/.subversion/config (Unix)
 */
export class OpenClientConfig extends Command {
  constructor() {
    super("sven.openClientConfig", { repository: false });
  }

  public async execute() {
    const configPath = getSvnConfigPath();

    if (!svnConfigExists()) {
      window.showWarningMessage(
        `SVN client config not found at: ${configPath}`
      );
      return;
    }

    try {
      const doc = await workspace.openTextDocument(Uri.file(configPath));
      await window.showTextDocument(doc);
    } catch (error) {
      window.showErrorMessage(
        `Failed to open config: ${getErrorMessage(error)}`
      );
    }
  }
}
