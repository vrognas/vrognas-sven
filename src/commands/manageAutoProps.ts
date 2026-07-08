// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { window, workspace, Uri } from "vscode";
import { Command } from "./command";
import { getErrorMessage } from "../util/errorLogger";
import { Repository } from "../repository";
import { confirmDestructive } from "../ui";
import * as path from "path";
import * as os from "os";
import * as fs from "../fs";
import {
  getSvnConfigPath,
  svnConfigExists,
  readClientAutoProps
} from "../util/svnConfigPath";

/**
 * Default auto-props template for new repositories.
 */
const DEFAULT_AUTO_PROPS = `# SVN Auto-Props Configuration
# Format: <pattern> = <property>=<value>[;<property>=<value>...]
# Applied automatically when files are added via 'svn add'
#
# Examples:
# *.txt = svn:eol-style=native
# *.png = svn:mime-type=image/png
# *.sh = svn:eol-style=LF;svn:executable
# Makefile = svn:eol-style=native

# Text files - normalize line endings
*.txt = svn:eol-style=native
*.md = svn:eol-style=native
*.json = svn:eol-style=native
*.xml = svn:eol-style=native
*.yaml = svn:eol-style=native
*.yml = svn:eol-style=native
*.csv = svn:eol-style=native

# Source code
*.c = svn:eol-style=native
*.h = svn:eol-style=native
*.cpp = svn:eol-style=native
*.hpp = svn:eol-style=native
*.py = svn:eol-style=native
*.js = svn:eol-style=native
*.ts = svn:eol-style=native
*.java = svn:eol-style=native
*.cs = svn:eol-style=native

# Shell scripts - force LF and set executable
*.sh = svn:eol-style=LF;svn:executable

# Windows batch files - force CRLF
*.bat = svn:eol-style=CRLF
*.cmd = svn:eol-style=CRLF

# Binary files - mark as binary (no merge/diff)
*.png = svn:mime-type=image/png
*.jpg = svn:mime-type=image/jpeg
*.jpeg = svn:mime-type=image/jpeg
*.gif = svn:mime-type=image/gif
*.ico = svn:mime-type=image/x-icon
*.pdf = svn:mime-type=application/pdf
*.zip = svn:mime-type=application/zip
*.exe = svn:mime-type=application/octet-stream
*.dll = svn:mime-type=application/octet-stream
`;

/**
 * Manage svn:auto-props property on repository root.
 * Allows editing auto-props configuration for automatic property setting.
 */
export class ManageAutoProps extends Command {
  constructor() {
    super("sven.manageAutoProps", { repository: true });
  }

  public async execute(repository: Repository) {
    // Get current auto-props
    const currentAutoProps = await repository.getAutoProps();

    // Show menu
    const items = [
      {
        label: currentAutoProps
          ? "$(edit) View/Edit Auto-Props"
          : "$(add) Create Auto-Props",
        description: currentAutoProps
          ? "View or modify the current configuration"
          : "Create a new auto-props configuration",
        action: "edit"
      },
      {
        label: "$(trash) Remove Auto-Props",
        description: "Delete the auto-props configuration",
        action: "remove",
        enabled: !!currentAutoProps
      },
      {
        label: "$(file) Use Default Template",
        description: "Replace with a recommended default configuration",
        action: "template"
      },
      {
        label: "$(cloud-download) Import from Client Config",
        description: svnConfigExists()
          ? `Import auto-props from ${getSvnConfigPath()}`
          : "SVN client config not found",
        action: "import",
        enabled: svnConfigExists()
      }
    ].filter(item => item.enabled !== false);

    const selected = await window.showQuickPick(items, {
      placeHolder: "Manage Repository Auto-Props",
      title: "SVN Auto-Props Configuration"
    });

    if (!selected) return;

    switch (selected.action) {
      case "edit":
        await this.editAutoProps(repository, currentAutoProps);
        break;
      case "remove":
        await this.removeAutoProps(repository);
        break;
      case "template":
        await this.applyTemplate(repository, !!currentAutoProps);
        break;
      case "import":
        await this.importFromClientConfig(repository, !!currentAutoProps);
        break;
    }
  }

  private async editAutoProps(
    repository: Repository,
    currentAutoProps: string | null
  ): Promise<void> {
    // Create temp file with current or empty content
    const tempDir = os.tmpdir();
    const tempFile = path.join(
      tempDir,
      `svn-auto-props-${Date.now()}.properties`
    );

    const content = currentAutoProps || DEFAULT_AUTO_PROPS;
    await fs.writeFile(tempFile, content, { mode: 0o600 });

    // Open in editor
    const doc = await workspace.openTextDocument(Uri.file(tempFile));
    await window.showTextDocument(doc);

    // Show save instructions
    window
      .showInformationMessage(
        "Edit the auto-props configuration. Save and close the file, then click 'Apply Changes' below.",
        "Apply Changes"
      )
      .then(async choice => {
        if (choice === "Apply Changes") {
          // Read updated content
          const updatedDoc = await workspace.openTextDocument(
            Uri.file(tempFile)
          );
          const newContent = updatedDoc.getText();

          // Filter out comments and empty lines for validation
          const lines = newContent
            .split("\n")
            .filter(line => line.trim() && !line.trim().startsWith("#"));

          if (lines.length === 0) {
            // No actual rules - remove the property
            await this.removeAutoProps(repository);
            return;
          }

          try {
            const result = await repository.setAutoProps(newContent);
            if (result.exitCode === 0) {
              window.showInformationMessage(
                "Auto-props configuration updated successfully"
              );
            } else {
              window.showErrorMessage(
                `Failed to set auto-props: ${result.stderr || "Unknown error"}`
              );
            }
          } catch (error) {
            window.showErrorMessage(
              `Failed to set auto-props: ${getErrorMessage(error)}`
            );
          }

          // Clean up temp file
          try {
            await fs.unlink(tempFile);
          } catch {
            // Ignore cleanup errors
          }
        }
      });
  }

  private async viewAutoProps(autoProps: string): Promise<void> {
    // Create temp file and open as read-only
    const tempDir = os.tmpdir();
    const tempFile = path.join(
      tempDir,
      `svn-auto-props-view-${Date.now()}.properties`
    );

    await fs.writeFile(tempFile, autoProps, { mode: 0o400 });

    const doc = await workspace.openTextDocument(Uri.file(tempFile));
    await window.showTextDocument(doc, { preview: true });
  }

  private async removeAutoProps(repository: Repository): Promise<void> {
    const confirmed = await confirmDestructive(
      "Remove auto-props configuration?",
      "Remove"
    );
    if (!confirmed) return;

    try {
      const result = await repository.removeAutoProps();
      if (result.exitCode === 0) {
        window.showInformationMessage("Auto-props configuration removed");
      } else {
        window.showErrorMessage(
          `Failed to remove auto-props: ${result.stderr || "Unknown error"}`
        );
      }
    } catch (error) {
      window.showErrorMessage(
        `Failed to remove auto-props: ${getErrorMessage(error)}`
      );
    }
  }

  private async applyTemplate(
    repository: Repository,
    hasExisting: boolean
  ): Promise<void> {
    // Only warn about replacement if there are existing auto-props
    if (hasExisting) {
      const confirmed = await confirmDestructive(
        "Replace current auto-props with default template?",
        "Apply Template"
      );
      if (!confirmed) return;
    }

    try {
      const result = await repository.setAutoProps(DEFAULT_AUTO_PROPS);
      if (result.exitCode === 0) {
        window.showInformationMessage(
          "Default auto-props template applied successfully"
        );
      } else {
        window.showErrorMessage(
          `Failed to apply template: ${result.stderr || "Unknown error"}`
        );
      }
    } catch (error) {
      window.showErrorMessage(
        `Failed to apply template: ${getErrorMessage(error)}`
      );
    }
  }

  private async importFromClientConfig(
    repository: Repository,
    hasExisting: boolean
  ): Promise<void> {
    const clientAutoProps = await readClientAutoProps();

    if (!clientAutoProps) {
      window.showWarningMessage(
        "No auto-props found in SVN client config. Check the [auto-props] section."
      );
      return;
    }

    // Show preview of what will be imported
    const lines = clientAutoProps
      .split("\n")
      .filter(l => l.trim() && !l.trim().startsWith("#"));
    const ruleCount = lines.length;

    // Warn about replacement if there are existing auto-props
    const message = hasExisting
      ? `Import ${ruleCount} rules from client config? This will replace existing auto-props.`
      : `Import ${ruleCount} rules from client config?`;

    const confirm = await window.showInformationMessage(
      message,
      {
        modal: true,
        detail: lines.slice(0, 5).join("\n") + (lines.length > 5 ? "\n..." : "")
      },
      "Import"
    );

    if (confirm !== "Import") return;

    try {
      // Add header comment to imported content
      const importedContent = `# Imported from SVN client config\n# ${getSvnConfigPath()}\n\n${clientAutoProps}`;

      const result = await repository.setAutoProps(importedContent);
      if (result.exitCode === 0) {
        const action = await window.showInformationMessage(
          `Imported ${ruleCount} auto-props rules from client config`,
          "Show Rules"
        );
        if (action === "Show Rules") {
          await this.viewAutoProps(importedContent);
        }
      } else {
        window.showErrorMessage(
          `Failed to import: ${result.stderr || "Unknown error"}`
        );
      }
    } catch (error) {
      window.showErrorMessage(`Failed to import: ${getErrorMessage(error)}`);
    }
  }
}
