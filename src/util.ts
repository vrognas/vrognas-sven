// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import { Event, commands } from "vscode";
import { exists, lstat, readdir, rmdir, unlink } from "./fs";

export {
  BLAME_INVALIDATING_OPERATIONS,
  FORCE_REFRESH_OPERATIONS,
  isReadOnly,
  shouldFetchLockStatus
} from "./operationPolicy";

export interface IDisposable {
  dispose(): void;
}

export function done<T>(promise: Promise<T>): Promise<void> {
  return promise.then<void>(() => void 0);
}

export function dispose(disposables: IDisposable[]): IDisposable[] {
  disposables.forEach(disposable => disposable.dispose());

  return [];
}

export function toDisposable(dispose: () => void): IDisposable {
  return { dispose };
}

export function combinedDisposable(disposables: IDisposable[]): IDisposable {
  return toDisposable(() => dispose(disposables));
}

export function anyEvent<T>(...events: Array<Event<T>>): Event<T> {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- VSCode Event API
    listener: (e: T) => any,
    thisArgs = null,
    disposables?: IDisposable[]
  ) => {
    const result = combinedDisposable(
      events.map(event => event((i: T) => listener.call(thisArgs, i)))
    );

    if (disposables) {
      disposables.push(result);
    }

    return result;
  };
}

export function filterEvent<T>(
  event: Event<T>,
  filter: (e: T) => boolean
): Event<T> {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- VSCode Event API
    listener: (e: T) => any,
    thisArgs = null,
    disposables?: IDisposable[]
  ) =>
    event((e: T) => filter(e) && listener.call(thisArgs, e), null, disposables);
}

/**
 * Throttle event firing to prevent flooding (Phase 8.3 perf fix)
 * Collects events and fires the latest after a delay
 */
export function throttleEvent<T>(event: Event<T>, delay: number): Event<T> {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- VSCode Event API
    listener: (e: T) => any,
    thisArgs = null,
    disposables?: IDisposable[]
  ) => {
    let timer: NodeJS.Timeout | undefined;
    let latestEvent: T | undefined;

    const result = event(
      (e: T) => {
        latestEvent = e;
        if (timer) {
          return; // Already scheduled
        }
        timer = setTimeout(() => {
          if (latestEvent !== undefined) {
            listener.call(thisArgs, latestEvent);
          }
          timer = undefined;
          latestEvent = undefined;
        }, delay);
      },
      null,
      disposables
    );

    // Cleanup timer on dispose
    const originalDispose = result.dispose.bind(result);
    result.dispose = () => {
      if (timer) {
        clearTimeout(timer);
      }
      originalDispose();
    };

    return result;
  };
}

export function onceEvent<T>(event: Event<T>): Event<T> {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- VSCode Event API
    listener: (e: T) => any,
    thisArgs = null,
    disposables?: IDisposable[]
  ) => {
    const result = event(
      (e: T) => {
        result.dispose();
        return listener.call(thisArgs, e);
      },
      null,
      disposables
    );

    return result;
  };
}

export function eventToPromise<T>(event: Event<T>): Promise<T> {
  return new Promise<T>(c => onceEvent(event)(c));
}

const regexNormalizePath = new RegExp(path.sep === "/" ? "\\\\" : "/", "g");
const regexNormalizeWindows = new RegExp("^\\\\(\\w:)", "g");
export function fixPathSeparator(file: string) {
  file = file.replace(regexNormalizePath, path.sep);
  file = file.replace(regexNormalizeWindows, "$1"); // "\t:\test" => "t:\test"

  if (path.sep === "\\") {
    file = file.charAt(0).toLowerCase() + file.slice(1);
  }

  return file;
}

export function normalizePath(file: string) {
  file = fixPathSeparator(file);

  // IF Windows
  if (path.sep === "\\") {
    file = file.toLowerCase();
  }

  return file;
}

export function isDescendant(parent: string, descendant: string): boolean {
  if (parent.trim() === "" || descendant.trim() === "") {
    return false;
  }

  parent = parent.replace(/[\\\/]/g, path.sep);
  descendant = descendant.replace(/[\\\/]/g, path.sep);

  // IF Windows
  if (path.sep === "\\") {
    parent = parent.replace(/^\\/, "").toLowerCase();
    descendant = descendant.replace(/^\\/, "").toLowerCase();
  }

  if (parent === descendant) {
    return true;
  }

  if (parent.charAt(parent.length - 1) !== path.sep) {
    parent += path.sep;
  }

  return descendant.startsWith(parent);
}

export function camelcase(name: string) {
  // Security: Reject overly long tag names (ReDoS protection)
  if (name.length > 1000) {
    throw new Error("Tag name too long");
  }

  // Security: Validate character set (allow @, #, . for XML parser compatibility)
  // @ for attribute prefix (@_), _ for text nodes (underscore), . for XML tag names
  if (!/^[a-zA-Z0-9_\-\s@#.:]+$/.test(name)) {
    throw new Error("Invalid characters in tag name");
  }

  return name
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (letter, index) => {
      return index === 0 ? letter.toLowerCase() : letter.toUpperCase();
    })
    .replace(/[\s\-]+/g, "");
}

/**
 * Validate SVN file path for security
 * Prevents path traversal and other path-based attacks
 *
 * @param filePath Path from SVN XML output
 * @returns Normalized safe path
 * @throws Error if path is unsafe
 */
export function validateSvnPath(filePath: string): string {
  // Reject empty/null paths
  if (!filePath || filePath.trim().length === 0) {
    throw new Error("Path is empty");
  }

  // Reject null bytes
  if (filePath.includes("\0")) {
    throw new Error("Path contains null bytes");
  }

  // Reject absolute paths (Windows drive letters or Unix root)
  if (/^([a-zA-Z]:|\/)/.test(filePath)) {
    throw new Error("Absolute paths not allowed");
  }

  // Reject path traversal
  const normalized = path.normalize(filePath);
  if (normalized.includes("..")) {
    throw new Error("Path traversal not allowed");
  }

  return normalized;
}

export function timeout(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Remove directory recursively
 * @param {string} dirPath
 * @see https://stackoverflow.com/a/42505874/3027390
 */
export async function deleteDirectory(dirPath: string): Promise<void> {
  if ((await exists(dirPath)) && (await lstat(dirPath)).isDirectory()) {
    await Promise.all(
      (await readdir(dirPath)).map(async (entry: string) => {
        const entryPath = path.join(dirPath, entry);
        if ((await lstat(entryPath)).isDirectory()) {
          await deleteDirectory(entryPath);
        } else {
          await unlink(entryPath);
        }
      })
    );
    await rmdir(dirPath);
  }
}

export function unwrap<T>(maybeT?: T): T {
  if (maybeT === undefined) {
    throw new Error("undefined unwrap");
  }
  return maybeT;
}

export function fixPegRevision(file: string, pegRevision?: string) {
  // Peg Revision Algorithm (http://svnbook.red-bean.com/en/1.8/svn.advanced.pegrevs.html)
  // svn resolves the peg at the LAST '@' of a target. With an explicit peg
  // the path must be appended UNESCAPED (name@2x.png@123); pre-escaping
  // would make svn read the literal path 'name@2x.png@'. The trailing-@
  // escape only applies to peg-less targets containing '@'.
  if (pegRevision) {
    return `${file}@${pegRevision}`;
  }
  if (/@/.test(file)) {
    file += "@";
  }

  return file;
}

export function getSvnDir(): string {
  return process.env.SVN_ASP_DOT_NET_HACK ? "_svn" : ".svn";
}

export async function isSvnFolder(
  dir: string,
  checkParent: boolean = true
): Promise<boolean> {
  const svnDir = getSvnDir();
  const result = await exists(`${dir}/${svnDir}`);

  if (result || !checkParent) {
    return result;
  }

  const parent = path.dirname(dir);

  // For windows: the `path.dirname("c:")` return `c:`
  // For empty or doted dir, return "."
  if (parent === dir || parent === ".") {
    return false;
  }

  return isSvnFolder(parent, true);
}

export function setVscodeContext(key: string, value: unknown) {
  return commands.executeCommand("setContext", key, value);
}

function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:\\/.test(path);
}

export function pathEquals(a: string, b: string): boolean {
  // Windows is case insensitive
  if (isWindowsPath(a)) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }

  return a === b;
}

export const EmptyDisposable = toDisposable(() => null);

/**
 * Phase 9.1 perf fix - process array items with concurrency limit
 * Prevents file descriptor exhaustion and system load spikes
 * @param items Array of items to process
 * @param fn Async function to apply to each item
 * @param concurrency Max concurrent operations (default: 16)
 * @returns Promise resolving to array of results
 */
export async function processConcurrently<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number = 16
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}
