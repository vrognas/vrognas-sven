// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as cp from "child_process";
import { ChildProcess, SpawnOptions } from "child_process";
import * as fs from "original-fs";
import * as path from "path";
import * as tmp from "tmp";
import { commands, extensions, Uri, window } from "vscode";
import { timeout } from "../util";
import { logError } from "../util/errorLogger";

tmp.setGracefulCleanup();

const tempDirList: tmp.DirResult[] = [];

export function getSvnUrl(uri: Uri) {
  const url = uri.toString();

  return url.replace(/%3A/g, ":");
}

export function spawn(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {}
): ChildProcess {
  const proc = cp.spawn(command, args, options);
  return proc;
}

export function hasExecutable(
  command: string,
  args: string[] = ["--version"]
): boolean {
  const result = cp.spawnSync(command, args, { stdio: "ignore" });
  const error = result.error as NodeJS.ErrnoException | undefined;
  return error?.code !== "ENOENT";
}

export function getMissingSvnBinaries(
  required: string[] = ["svn", "svnadmin"]
): string[] {
  return required.filter(binary => !hasExecutable(binary));
}

export function newTempDir(prefix: string) {
  const dir = tmp.dirSync({
    prefix,
    unsafeCleanup: true
  });

  tempDirList.push(dir);

  return dir.name;
}

export async function createRepoServer() {
  const fullpath = newTempDir("svn_server_");
  const dirname = path.basename(fullpath);

  // Must complete before svnadmin creates into the same dir (was floating)
  if (fs.existsSync(fullpath)) {
    await destroyPath(fullpath);
  }

  return new Promise<Uri>((resolve, reject) => {
    const proc = spawn("svnadmin", ["create", dirname], {
      cwd: path.dirname(fullpath)
    });

    proc.once("error", err => {
      reject(err);
    });

    proc.once("exit", exitCode => {
      if (exitCode === 0) {
        resolve(Uri.file(fullpath));
        return;
      }
      reject(new Error(`svnadmin create failed with exit code: ${exitCode}`));
    });
  });
}

export function importToRepoServer(
  url: string,
  path: string,
  message = "imported",
  cwd?: string
) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("svn", ["import", path, url, "-m", message], {
      cwd
    });

    proc.once("error", err => {
      reject(err);
    });

    proc.once("exit", exitCode => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(new Error(`svn import failed with exit code: ${exitCode}`));
    });
  });
}

export async function createStandardLayout(
  url: string,
  trunk = "trunk",
  branches = "branches",
  tags = "tags"
) {
  const fullpath = newTempDir("svn_layout_");

  fs.mkdirSync(path.join(fullpath, trunk));
  fs.mkdirSync(path.join(fullpath, branches));
  fs.mkdirSync(path.join(fullpath, tags));

  await importToRepoServer(url, fullpath, "Created Standard Layout");

  await destroyPath(fullpath);
}

export function createRepoCheckout(url: string) {
  return new Promise<Uri>((resolve, reject) => {
    const fullpath = newTempDir("svn_checkout_");

    const proc = spawn("svn", ["checkout", url, fullpath], {
      cwd: path.dirname(fullpath)
    });

    proc.once("error", err => {
      reject(err);
    });

    proc.once("exit", exitCode => {
      if (exitCode === 0) {
        resolve(Uri.file(fullpath));
        return;
      }
      reject(new Error(`svn checkout failed with exit code: ${exitCode}`));
    });
  });
}

export async function destroyPath(fullPath: string) {
  fullPath = fullPath.replace(/^file\:\/\/\//, "");

  if (!fs.existsSync(fullPath)) {
    return false;
  }

  if (!fs.lstatSync(fullPath).isDirectory()) {
    fs.unlinkSync(fullPath);
    return true;
  }

  const files = fs.readdirSync(fullPath);
  for (const file of files) {
    // Children must be gone before the parent rmdir below (was floating -
    // the Windows retry loop was compensating for the race)
    await destroyPath(path.join(fullPath, file));
  }

  // Error in windows with anti-malware
  for (let i = 0; i < 3; i++) {
    try {
      fs.rmdirSync(fullPath);
      break;
    } catch (error) {
      await timeout(3000);
      logError("Failed to remove directory", error);
    }
  }
  return true;
}

export function destroyAllTempPaths() {
  let dir;
  while (true) {
    dir = tempDirList.shift();
    if (!dir) {
      break;
    }

    try {
      dir.removeCallback();
    } catch (error) {
      logError("Failed to remove temp directory", error);
    }
  }
}

export function activeExtension() {
  return new Promise<void>((resolve, reject) => {
    const extension = extensions.getExtension("vrognas.sven");
    if (!extension) {
      reject(new Error("Extension not found: vrognas.sven"));
      return;
    }

    const ensureCommands = async () => {
      const availableCommands = await commands.getCommands(true);
      if (!availableCommands.includes("sven.getSourceControlManager")) {
        throw new Error("Extension activated but commands not registered");
      }
    };

    const finish = () => {
      ensureCommands().then(resolve, reject);
    };

    if (extension.isActive) {
      finish();
      return;
    }

    extension.activate().then(finish, reject);
  });
}

const overridesShowInputBox: any[] = [];

export function overrideNextShowInputBox(value: any) {
  overridesShowInputBox.push(value);
}

const originalShowInputBox = window.showInputBox;

window.showInputBox = (...args: any[]) => {
  const next = overridesShowInputBox.shift();
  if (typeof next === "undefined") {
    return originalShowInputBox.call(null, args as any);
  }
  return new Promise((resolve, _reject) => {
    resolve(next);
  });
};

const overridesShowQuickPick: any[] = [];

export function overrideNextShowQuickPick(value: any) {
  overridesShowQuickPick.push(value);
}

const originalShowQuickPick = window.showQuickPick;

window.showQuickPick = (
  items: readonly any[] | Thenable<readonly any[]>,
  ...args: any[]
): Thenable<any | undefined> => {
  let next = overridesShowQuickPick.shift();
  if (typeof next === "undefined") {
    return originalShowQuickPick.call(null, [items, ...args]);
  }

  if (typeof next === "number" && Array.isArray(items)) {
    next = items[next];
  }

  return new Promise((resolve, _reject) => {
    resolve(next);
  });
};
