// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import {
  commands,
  Disposable,
  env,
  ExtensionContext,
  OutputChannel,
  Uri,
  window
} from "vscode";
import { registerCommands } from "./commands";
import { CheckActiveEditor } from "./contexts/checkActiveEditor";
import { OpenRepositoryCount } from "./contexts/openRepositoryCount";
import { HasBranch } from "./contexts/hasBranch";
import { BlameIconState } from "./contexts/blameIconState";
import { configuration } from "./helpers/configuration";
import { ItemLogProvider } from "./historyView/itemLogProvider";
import { RepoLogProvider } from "./historyView/repoLogProvider";
import * as messages from "./messages";
import { SourceControlManager } from "./source_control_manager";
import { Svn, authConfigDisposable } from "./svn";
import { SvnFinder, SVN_CACHE_KEY } from "./svnFinder";
import SparseCheckoutProvider from "./treeView/dataProviders/sparseCheckoutProvider";
import { toDisposable } from "./util";
import { BranchChangesProvider } from "./historyView/branchChangesProvider";
import { IsSvn19orGreater } from "./contexts/isSvn19orGreater";
import { IsSvn18orGreater } from "./contexts/isSvn18orGreater";
import { tempSvnFs } from "./temp_svn_fs";
import { SvnFileSystemProvider } from "./svnFileSystemProvider";
import { isPositron, getEnvironmentName } from "./positron/runtime";
import { logError, logWarning } from "./util/errorLogger";
import { registerSvnConnectionsProvider } from "./positron/connectionsProvider";
import { BlameStatusBar } from "./blame/blameStatusBar";
import { initBlamePersistence } from "./blame/blamePersistence";
import { NeedsLockStatusBar } from "./statusbar/needsLockStatusBar";
import { LockStatusBar } from "./statusbar/lockStatusBar";

async function init(
  extensionContext: ExtensionContext,
  outputChannel: OutputChannel,
  disposables: Disposable[]
) {
  const pathHint = configuration.get<string>("path");
  const svnFinder = new SvnFinder();

  // Pass context for caching - startup optimization saves ~1-2s on subsequent launches
  const info = await svnFinder.findSvn(pathHint, extensionContext);
  // eslint-disable-next-line no-console -- lifecycle diagnostic, no user data
  console.log(`Sven: Found SVN ${info.version} at ${info.path}`);

  const svn = new Svn({ svnPath: info.path, version: info.version });

  // Revision-pinned blame survives reloads (workspaceState-backed)
  initBlamePersistence(extensionContext.workspaceState);

  // Register process exit handlers for credential cleanup
  const cleanup = () => {
    // eslint-disable-next-line no-console -- lifecycle diagnostic, no user data
    console.log("Sven: Cleaning up credentials on process exit");
    svn.getAuthCache().dispose();
  };

  // Store handler references for cleanup on extension deactivation
  const sigintHandler = () => {
    cleanup();
    process.exit();
  };
  const sigtermHandler = () => {
    cleanup();
    process.exit();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  // Remove handlers on extension dispose to prevent accumulation during dev reloads
  disposables.push(
    toDisposable(() => {
      process.removeListener("exit", cleanup);
      process.removeListener("SIGINT", sigintHandler);
      process.removeListener("SIGTERM", sigtermHandler);
    })
  );

  const sourceControlManager = await SourceControlManager.create(
    svn,
    extensionContext
  );

  registerCommands(sourceControlManager, disposables);

  try {
    tempSvnFs.activate();
  } catch (err) {
    // Handle dev reload / double activation race condition
    logWarning("TempSvnFs already registered", (err as Error).message);
  }
  disposables.push(
    sourceControlManager,
    tempSvnFs,
    new SvnFileSystemProvider(sourceControlManager),
    new RepoLogProvider(sourceControlManager),
    new ItemLogProvider(sourceControlManager),
    new BranchChangesProvider(sourceControlManager),
    new SparseCheckoutProvider(sourceControlManager),
    new CheckActiveEditor(sourceControlManager),
    new OpenRepositoryCount(sourceControlManager),
    new HasBranch(sourceControlManager),
    new IsSvn18orGreater(info.version),
    new IsSvn19orGreater(info.version),
    new BlameIconState(sourceControlManager)
  );

  outputChannel.appendLine(`Using svn "${info.version}" from "${info.path}"`);
  outputChannel.appendLine(`Running in ${getEnvironmentName()}`);

  // Initialize blame status bar (singleton)
  const blameStatusBar = new BlameStatusBar(sourceControlManager);
  disposables.push(blameStatusBar);

  // Register blame commands
  disposables.push(
    commands.registerCommand(
      "sven.blame.showDiff",
      async (uriStr: string, rev: string) => {
        const uri = Uri.parse(uriStr);
        const repository = sourceControlManager.getRepository(uri);
        if (!repository) {
          window.showErrorMessage("No SVN repository found for this file");
          return;
        }
        const { openBlameRevisionDiff } = await import("./blame/blameDiff");
        await openBlameRevisionDiff(repository.repository, uri, rev);
      }
    ),
    commands.registerCommand(
      "sven.blame.peekChange",
      async (uriStr: string, rev: string, line: number) => {
        const uri = Uri.parse(uriStr);
        const repository = sourceControlManager.getRepository(uri);
        if (!repository) {
          window.showErrorMessage("No SVN repository found for this file");
          return;
        }
        // The hover lives on this document; its line text locates the
        // matching hunk inside the revision's diff
        const editor = window.visibleTextEditors.find(
          e => e.document.uri.toString() === uri.toString()
        );
        const lineText =
          editor && line < editor.document.lineCount
            ? editor.document.lineAt(line).text
            : "";
        const { peekBlameChange } = await import("./blame/blamePeek");
        await peekBlameChange(repository.repository, uri, rev, line, lineText);
      }
    ),
    commands.registerCommand(
      "sven.blame.peekLineHistory",
      async (uriStr: string, baseLine: number, workingLine: number) => {
        const uri = Uri.parse(uriStr);
        const repository = sourceControlManager.getRepository(uri);
        if (!repository) {
          window.showErrorMessage("No SVN repository found for this file");
          return;
        }
        const { peekLineHistory } = await import("./blame/blamePeek");
        await peekLineHistory(
          repository.repository,
          uri,
          baseLine,
          workingLine
        );
      }
    ),
    commands.registerCommand("sven.blame.copyRevision", async (rev: string) => {
      await env.clipboard.writeText(rev);
      window.setStatusBarMessage(`Copied r${rev} to clipboard`, 3000);
    }),
    commands.registerCommand("sven.showBlameCommit", () => {
      void blameStatusBar.showCommitDetails();
    })
  );

  // Initialize needs-lock status bar
  const needsLockStatusBar = new NeedsLockStatusBar(sourceControlManager);
  disposables.push(needsLockStatusBar);

  // Initialize lock status bar
  const lockStatusBar = new LockStatusBar(sourceControlManager);
  disposables.push(lockStatusBar);

  // Register cache management command
  disposables.push(
    commands.registerCommand("sven.clearCache", async () => {
      await extensionContext.globalState.update(SVN_CACHE_KEY, undefined);
      window.showInformationMessage(
        "SVN path cache cleared. Restart to re-detect."
      );
    })
  );

  // Register Positron-specific providers
  if (isPositron()) {
    const connectionsDisposable =
      registerSvnConnectionsProvider(sourceControlManager);
    if (connectionsDisposable) {
      disposables.push(connectionsDisposable);
      outputChannel.appendLine("Positron: SVN Connections provider registered");
    }
  }

  const onOutput = (str: string) => outputChannel.append(str);
  svn.onOutput.addListener("log", onOutput);
  disposables.push(
    toDisposable(() => svn.onOutput.removeListener("log", onOutput))
  );
  disposables.push(toDisposable(messages.dispose));
  disposables.push(authConfigDisposable);
}

async function _activate(context: ExtensionContext, disposables: Disposable[]) {
  const outputChannel = window.createOutputChannel("Sven");
  commands.registerCommand("sven.showOutput", () => outputChannel.show());
  disposables.push(outputChannel);

  const showOutput = configuration.get<boolean>("showOutput");

  if (showOutput) {
    outputChannel.show();
  }

  const tryInit = async () => {
    try {
      await init(context, outputChannel, disposables);
    } catch (err) {
      const error = err as Error;
      if (!/Svn installation not found/.test(error.message || "")) {
        throw err;
      }

      const shouldIgnore =
        configuration.get<boolean>("ignoreMissingSvnWarning") === true;

      if (shouldIgnore) {
        return;
      }

      logWarning("SVN not found", error.message);
      outputChannel.appendLine(error.message);
      outputChannel.show();

      const findSvnExecutable = "Find SVN executable";
      const download = "Download SVN";
      const neverShowAgain = "Don't Show Again";
      const choice = await window.showWarningMessage(
        "SVN not found. Install it or configure it using the 'sven.path' setting.",
        findSvnExecutable,
        download,
        neverShowAgain
      );

      if (choice === findSvnExecutable) {
        let filters: { [name: string]: string[] } | undefined;

        // For windows, limit to executable files
        if (path.sep === "\\") {
          filters = {
            svn: ["exe", "bat"]
          };
        }

        const executable = await window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters
        });

        if (executable && executable[0]) {
          const file = executable[0].fsPath;

          outputChannel.appendLine(`Updated "sven.path" with "${file}"`);

          await configuration.update("path", file);

          // Try Re-init after select the executable
          await tryInit();
        }
      } else if (choice === download) {
        commands.executeCommand(
          "vscode.open",
          Uri.parse("https://subversion.apache.org/packages.html")
        );
      } else if (choice === neverShowAgain) {
        await configuration.update("ignoreMissingSvnWarning", true);
      }
    }
  };

  await tryInit();
}

export async function activate(context: ExtensionContext) {
  // eslint-disable-next-line no-console -- lifecycle diagnostic, no user data
  console.log(`Sven: activating (${getEnvironmentName()})`);

  const disposables: Disposable[] = [];
  context.subscriptions.push(
    new Disposable(() => Disposable.from(...disposables).dispose())
  );

  await _activate(context, disposables).catch(err => {
    logError("Sven: Activation failed", err);
    window.showErrorMessage(`Sven activation failed: ${err.message || err}`);
  });

  // eslint-disable-next-line no-console -- lifecycle diagnostic, no user data
  console.log("Sven: ready");
}

export function deactivate() {
  // Cleanup handled by context.subscriptions
}
