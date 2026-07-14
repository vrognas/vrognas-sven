// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  commands,
  ProgressLocation,
  QuickPickItem,
  QuickPickItemKind,
  Uri,
  window,
  workspace
} from "vscode";
import { IAuth, ICpOptions, ISvnErrorData } from "../common/types";
import { getBranchName } from "../helpers/branch";
import { configuration } from "../helpers/configuration";
import { svnErrorCodes } from "../svn";
import { validateRepositoryUrl } from "../validation";
import { Command } from "./command";
import type { DepthQuickPickItem } from "../sparse/depthOptions";

/** Max number of URLs to remember */
const MAX_URL_HISTORY = 25;
const URL_HISTORY_KEY = "sven.checkoutUrlHistory";

/** Depth options for initial checkout — shallow first so user can deepen via Selective Download */
const initialCheckoutDepthOptions: DepthQuickPickItem[] = [
  {
    label: "$(list-tree) Shallow (recommended)",
    description: "Files + empty subfolders",
    detail:
      "Fast checkout. Shows repo structure, then use Selective Download to get what you need.",
    depth: "immediates"
  },
  {
    label: "$(folder) Folder Only",
    description: "Empty placeholder",
    detail: "Fastest checkout. Only creates the folder, no files downloaded.",
    depth: "empty"
  },
  {
    label: "$(file) Files Only",
    description: "Skip subfolders",
    detail: "Downloads root files but no subfolders.",
    depth: "files"
  },
  {
    label: "$(folder-opened) Full",
    description: "Download everything",
    detail:
      "Downloads all files and folders recursively. Can be slow for large repos.",
    depth: "infinity"
  }
];

export class Checkout extends Command {
  constructor() {
    super("sven.checkout");
  }

  public async execute(url?: string) {
    // Get SCM early for globalState access (URL history)
    const sourceControlManager = await this.getSourceControlManager();
    const globalState = sourceControlManager.context.globalState;

    // Step 1: Repository URL (with MRU history)
    if (!url) {
      url = await this.promptUrl(globalState);
    }

    if (!url) {
      return;
    }

    // Validate URL to prevent SSRF and command injection
    if (!validateRepositoryUrl(url)) {
      window.showErrorMessage(
        `Invalid repository URL. Only http://, https://, svn://, and svn+ssh:// protocols are allowed.`
      );
      return;
    }

    // Step 2: Select parent directory
    let defaultCheckoutDirectory =
      configuration.get<string>("defaultCheckoutDirectory") || os.homedir();
    defaultCheckoutDirectory = defaultCheckoutDirectory.replace(
      /^~/,
      os.homedir()
    );

    const uris = await window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: Uri.file(defaultCheckoutDirectory),
      openLabel: "Select Repository Location"
    });

    if (!uris || uris.length === 0) {
      return;
    }

    const uri = uris[0]!;
    const parentPath = uri.fsPath;

    // Step 3: Folder name (defaults to repo name from URL)
    let folderName: string | undefined;
    const branch = getBranchName(url);
    if (branch) {
      const baseUrl = url.replace(/\//g, "/").replace(branch.path, "");
      folderName = path.basename(baseUrl);
    }
    if (!folderName) {
      const cleanUrl = url.replace(/[?#].*$/, "").replace(/\/+$/, "");
      folderName = path.basename(cleanUrl) || undefined;
    }

    folderName = await window.showInputBox({
      prompt: "Folder name",
      title: "Checkout (3/4): Folder Name",
      value: folderName,
      ignoreFocusOut: true
    });

    if (!folderName) {
      return;
    }

    const repositoryPath = path.join(parentPath, folderName);

    // Warn if target folder exists and is non-empty
    try {
      const entries = fs.readdirSync(repositoryPath);
      if (entries.length > 0) {
        const choice = await window.showWarningMessage(
          `"${folderName}" already exists and contains ${entries.length} item(s). Checkout into this folder?`,
          { modal: true },
          "Continue"
        );
        if (choice !== "Continue") return;
      }
    } catch {
      // Folder doesn't exist — that's fine
    }

    // Step 4: Depth + externals picker
    const depthPick = (await window.showQuickPick(
      [
        ...initialCheckoutDepthOptions,
        { label: "", kind: QuickPickItemKind.Separator } as DepthQuickPickItem,
        {
          label: "$(exclude) Omit Externals",
          description: "Skip svn:externals",
          detail:
            "Don't download external references. Useful if externals are large or need separate credentials.",
          depth: "_omitExternals"
        } as DepthQuickPickItem
      ],
      {
        placeHolder:
          "How much to download? (use Selective Download to add more later)",
        title: "Checkout (4/4): Download Depth",
        canPickMany: true
      }
    )) as DepthQuickPickItem[] | undefined;

    if (!depthPick || depthPick.length === 0) {
      return;
    }

    // Extract depth and externals flag from multi-select
    const omitExternals = depthPick.some(p => p.depth === "_omitExternals");
    const selectedDepth = depthPick.find(p => p.depth !== "_omitExternals");
    if (!selectedDepth) {
      window.showErrorMessage("Please select a download depth.");
      return;
    }

    // Save URL to history (after all validation passed)
    this.saveUrlHistory(globalState, url);

    // Use Notification location if supported
    let location: ProgressLocation = ProgressLocation.Window;
    if ((ProgressLocation as unknown as Record<string, unknown>).Notification) {
      location = (
        ProgressLocation as unknown as Record<string, ProgressLocation>
      ).Notification!;
    }

    const depthLabel =
      selectedDepth.depth === "infinity"
        ? ""
        : ` (${selectedDepth.description})`;
    const progressOptions = {
      location,
      title: `Checkout svn repository${depthLabel}...`,
      cancellable: true
    };

    let attempt = 0;

    const opt: ICpOptions = {};

    while (true) {
      attempt++;
      try {
        await window.withProgress(progressOptions, async () => {
          const args = [
            "checkout",
            "--depth",
            selectedDepth.depth,
            url,
            repositoryPath
          ];
          if (omitExternals) {
            args.push("--ignore-externals");
          }
          await sourceControlManager.svn.exec(parentPath, args, opt);
        });
        break;
      } catch (err) {
        const svnError = err as ISvnErrorData;
        if (
          svnError.svnErrorCode === svnErrorCodes.AuthorizationFailed &&
          attempt <= 3
        ) {
          const auth = (await commands.executeCommand(
            "sven.promptAuth",
            opt.username,
            undefined,
            url
          )) as IAuth;
          if (auth) {
            opt.username = auth.username;
            opt.password = auth.password;
            continue;
          }
        }
        throw err;
      }
    }

    const choices = [];
    let message = "Would you like to open the checked out repository?";
    const open = "Open Repository";
    choices.push(open);

    const addToWorkspace = "Add to Workspace";
    if (
      workspace.workspaceFolders &&
      (workspace as unknown as Record<string, unknown>).updateWorkspaceFolders // For VSCode >= 1.21
    ) {
      message =
        "Would you like to open the checked out repository, or add it to the current workspace?";
      choices.push(addToWorkspace);
    }

    const result = await window.showInformationMessage(message, ...choices);

    const openFolder = result === open;

    if (openFolder) {
      commands.executeCommand("vscode.openFolder", Uri.file(repositoryPath));
    } else if (result === addToWorkspace) {
      // For VSCode >= 1.21
      (
        workspace as unknown as {
          updateWorkspaceFolders: (
            start: number,
            deleteCount: number,
            folder: { uri: Uri }
          ) => void;
        }
      ).updateWorkspaceFolders(workspace.workspaceFolders!.length, 0, {
        uri: Uri.file(repositoryPath)
      });
    }
  }

  /** Show URL picker with history + option to enter new URL */
  private async promptUrl(globalState: {
    get<T>(key: string): T | undefined;
  }): Promise<string | undefined> {
    const history = globalState.get<string[]>(URL_HISTORY_KEY) || [];

    if (history.length === 0) {
      // No history — just show input box
      return window.showInputBox({
        prompt: "Repository URL",
        title: "Checkout (1/4): Repository URL",
        ignoreFocusOut: true
      });
    }

    // Show history with "Enter new URL" option
    interface UrlPickItem extends QuickPickItem {
      url?: string;
      isNew?: boolean;
    }

    const items: UrlPickItem[] = [
      {
        label: "$(add) Enter new URL...",
        isNew: true
      },
      { label: "Recent", kind: QuickPickItemKind.Separator },
      ...history.map(u => ({
        label: u,
        url: u
      }))
    ];

    const pick = await window.showQuickPick(items, {
      placeHolder: "Select a recent repository or enter a new URL",
      title: "Checkout (1/4): Repository URL"
    });

    if (!pick) return undefined;

    if (pick.isNew) {
      return window.showInputBox({
        prompt: "Repository URL",
        title: "Checkout (1/4): Repository URL",
        ignoreFocusOut: true
      });
    }

    return pick.url;
  }

  /** Save URL to MRU history */
  private saveUrlHistory(
    globalState: {
      get<T>(key: string): T | undefined;
      update(key: string, value: unknown): Thenable<void>;
    },
    url: string
  ): void {
    const history = globalState.get<string[]>(URL_HISTORY_KEY) || [];
    // Move to front, deduplicate
    const updated = [url, ...history.filter(u => u !== url)].slice(
      0,
      MAX_URL_HISTORY
    );
    globalState.update(URL_HISTORY_KEY, updated);
  }
}
