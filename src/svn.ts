// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require("child_process") as typeof import("child_process");
import { EventEmitter } from "events";
import * as proc from "process";
import { Readable } from "stream";
import * as semver from "semver";
import { env } from "vscode";
import {
  ICpOptions,
  IExecutionResult,
  ISvnInfo,
  ISvnOptions
} from "./common/types";
import * as encodeUtil from "./encoding";
import { configuration } from "./helpers/configuration";
import { parseInfoXml } from "./parser/infoParser";
import SvnError from "./svnError";
import { SvnAuthCache } from "./services/svnAuthCache";
import { Repository } from "./svnRepository";
import { dispose, IDisposable, toDisposable } from "./util";
import { logError, logWarning } from "./util/errorLogger";
import { showSystemKeyringAuthNotification } from "./util/nativeStoreAuthNotification";
import * as textCodec from "./util/textCodec";

import type { CredentialMode } from "./common/credentialMode";

// Auth config cache - avoids repeated config reads per command
let authConfigCache: {
  useSystemKeyring: boolean;
  modeDescription: string;
  expiry: number;
} | null = null;

const AUTH_CACHE_TTL = 5000; // 5 seconds

// Command-timeout cache - mirrors authConfigCache so repeated SVN spawns
// don't re-read the configuration on every call.
let commandTimeoutMsCache: { value: number; expiry: number } | null = null;

function getCommandTimeoutMs(): number {
  const now = Date.now();
  if (commandTimeoutMsCache && now < commandTimeoutMsCache.expiry) {
    return commandTimeoutMsCache.value;
  }
  const seconds = configuration.get<number>("auth.commandTimeout", 60);
  commandTimeoutMsCache = {
    value: seconds * 1000,
    expiry: now + AUTH_CACHE_TTL
  };
  return commandTimeoutMsCache.value;
}

// Track if auth mode has been logged (for "once" setting)
let authModeLoggedOnce = false;

/** Check if auth mode should be logged based on setting */
function shouldLogAuthMode(): boolean {
  const setting = configuration.get<string>("output.authLogging", "once");
  switch (setting) {
    case "never":
      return false;
    case "always":
      return true;
    case "once":
    default:
      if (authModeLoggedOnce) return false;
      authModeLoggedOnce = true;
      return true;
  }
}

function getAuthConfig(): {
  useSystemKeyring: boolean;
  modeDescription: string;
} {
  const now = Date.now();
  if (authConfigCache && now < authConfigCache.expiry) {
    return authConfigCache;
  }

  const mode = configuration.get<CredentialMode>("auth.credentialMode", "auto");
  const isRemote = !!env.remoteName;

  let useSystemKeyring: boolean;
  let modeDescription: string;

  switch (mode) {
    case "auto":
      useSystemKeyring = !isRemote;
      modeDescription = isRemote
        ? "extension storage (remote)"
        : "system keyring (local)";
      break;
    case "systemKeyring":
      useSystemKeyring = true;
      modeDescription = mode;
      break;
    case "extensionStorage":
    case "prompt":
      useSystemKeyring = false;
      modeDescription = mode;
      break;
    default:
      useSystemKeyring = !isRemote;
      modeDescription = "auto";
  }

  authConfigCache = {
    useSystemKeyring,
    modeDescription,
    expiry: now + AUTH_CACHE_TTL
  };
  return authConfigCache;
}

// Invalidate caches when relevant config changes
// Store disposable for cleanup on extension deactivation
export const authConfigDisposable = configuration.onDidChange(e => {
  if (e.affectsConfiguration("sven.auth.credentialMode")) {
    authConfigCache = null;
  }
  if (e.affectsConfiguration("sven.auth.commandTimeout")) {
    commandTimeoutMsCache = null;
  }
});

export const svnErrorCodes: { [key: string]: string } = {
  // Authentication errors
  AuthorizationFailed: "E170001",
  NoMoreCredentials: "E215004",

  // Network errors
  UnableToConnect: "E170013",
  NetworkTimeout: "E175002",

  // Repository/working copy errors
  RepositoryIsLocked: "E155004",
  NotASvnRepository: "E155007",
  NotShareCommonAncestry: "E195012",
  WorkingCopyIsTooOld: "E155036",

  // Cleanup-related errors
  WorkQueueFailed: "E155009",
  WorkingCopyCorrupt: "E155016",
  WorkingCopyDatabaseProblem: "E155032",
  PreviousOperationInterrupted: "E155037",
  SqliteDatabaseIssue: "E200030",
  SqliteDatabaseBusy: "E200033",
  SqliteRollbackReset: "E200034",

  // Conflict errors
  ConflictBlocking: "E155023",
  MergeConflict: "E200024",

  // Out-of-date errors
  NotUpToDate: "E155019",
  ItemOutOfDate: "E200042",

  // Lock errors
  PathAlreadyLocked: "E200035",
  PathNotLocked: "E200036",
  LockExpired: "E200041",

  // Permission errors
  AccessDenied: "E261001",
  PartialAccess: "E261002",

  // Version mismatch
  VersionMismatch: "E250006"
};

// Path separator pattern for cross-platform path splitting
const PATH_SEPARATOR_PATTERN = /[\\\/]+/;

// Default locale for SVN command execution
const DEFAULT_LOCALE = "en_US.UTF-8";

// Pre-compiled regex map for error code detection (avoids per-call RegExp construction)
const svnErrorCodeRegexMap: ReadonlyMap<string, RegExp> = new Map(
  Object.values(svnErrorCodes).map(code => [code, new RegExp(`svn: ${code}`)])
);

function getSvnErrorCode(stderr: string): string | undefined {
  // Priority: Check auth-related patterns FIRST
  // SVN may return E170013 (UnableToConnect) with E215004 (NoMoreCredentials)
  // We want to treat this as an auth error so retry logic triggers
  if (/No more credentials or we tried too many times/.test(stderr)) {
    return svnErrorCodes.AuthorizationFailed;
  }
  if (/E215004/.test(stderr)) {
    return svnErrorCodes.AuthorizationFailed;
  }

  for (const [code, regex] of svnErrorCodeRegexMap) {
    if (regex.test(stderr)) {
      return code;
    }
  }

  return stderr.match(/\b([EW]\d{6})\b/)?.[1];
}

export function cpErrorHandler(
  cb: (reason?: unknown) => void
): (reason?: unknown) => void {
  return err => {
    let error = err;
    if (err instanceof Error && /ENOENT/.test(err.message)) {
      error = new SvnError({
        error: err,
        message: "Failed to execute svn (ENOENT)",
        svnErrorCode: "NotASvnRepository"
      });
    }

    cb(error);
  };
}

export interface BufferResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

/** Raw process result before encoding detection */
interface RawProcessResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
  useSystemKeyring: boolean;
}

export class Svn {
  public version: string;

  private svnPath: string;
  private lastCwd: string = "";
  private authCache: SvnAuthCache;
  private readonly supportsStdinPassword: boolean;

  private _onOutput = new EventEmitter();
  get onOutput(): EventEmitter {
    return this._onOutput;
  }

  constructor(options: ISvnOptions) {
    this.svnPath = options.svnPath;
    this.version = options.version;
    const coerced = semver.coerce(this.version);
    this.supportsStdinPassword = coerced
      ? semver.gte(coerced, "1.10.0")
      : false;
    this.authCache = new SvnAuthCache();
    authModeLoggedOnce = false;
  }

  private throwOnFailure(
    args: string[],
    result: RawProcessResult,
    decodedStdout: string
  ): void {
    if (!result.exitCode) return;

    const svnErrorCode = getSvnErrorCode(result.stderr);
    if (
      result.useSystemKeyring &&
      svnErrorCode === svnErrorCodes.AuthorizationFailed
    ) {
      void showSystemKeyringAuthNotification();
    }

    throw new SvnError({
      message: "Failed to execute svn",
      stdout: decodedStdout,
      stderr: result.stderr,
      stderrFormated: result.stderr.replace(/^svn: E\d+: +/gm, ""),
      exitCode: result.exitCode,
      svnErrorCode,
      svnCommand: args[0]
    });
  }

  public logOutput(output: string): void {
    this._onOutput.emit("log", output);
  }

  public getAuthCache(): SvnAuthCache {
    return this.authCache;
  }

  /**
   * Core process execution - shared by exec() and execBuffer().
   * Handles auth setup, spawning, timeout, and result collection.
   */
  private async executeProcess(
    cwd: string,
    args: string[],
    options: ICpOptions = {}
  ): Promise<RawProcessResult> {
    if (cwd) {
      this.lastCwd = cwd;
      options.cwd = cwd;
    }

    // Determine credential mode based on setting and environment (cached)
    const authConfig = getAuthConfig();
    const useSystemKeyring = authConfig.useSystemKeyring;
    const useLegacyAuth =
      (this as { useLegacyAuth?: boolean }).useLegacyAuth === true;

    const envPassword = proc.env.SVN_PASSWORD;
    const effectivePassword = options.password || envPassword;

    let authMethod = "none";
    if (options.password) {
      authMethod = "password provided";
    } else if (envPassword) {
      authMethod = "SVN_PASSWORD environment variable";
    } else if (options.username) {
      authMethod = "username only";
    }

    if (options.username && effectivePassword && !useLegacyAuth) {
      try {
        const realmUrl = cwd;
        await this.authCache.writeCredential(
          options.username,
          effectivePassword,
          realmUrl
        );
        authMethod += " + credential cache";
      } catch (err) {
        logError("Failed to write auth cache", err);
      }
    }

    if (options.username) {
      args.push("--username", options.username);
    }

    let passwordForStdin: string | undefined;

    // Add password if provided
    // SECURITY: Only use --password-from-stdin (SVN 1.10+) to avoid exposing password in process list
    // For older SVN versions, password is not passed - user must use system keyring
    if (effectivePassword) {
      if (useLegacyAuth) {
        args.push("--password", effectivePassword);
      } else if (!this.supportsStdinPassword) {
        // SVN < 1.10: Don't pass password via --password (visible in ps/top)
        // Log warning - auth will fail if system keyring doesn't have credentials
        this.logOutput(
          `[SECURITY] SVN ${this.version} < 1.10 does not support --password-from-stdin. ` +
            `Password not passed to avoid process list exposure. Use system keyring or upgrade SVN.\n`
        );
      } else {
        // SVN >= 1.10: pass password via stdin (hidden from process list)
        passwordForStdin = effectivePassword;
        args.push("--password-from-stdin");
      }
    }

    // Disable native credential stores when not using system keyring
    if (!useSystemKeyring) {
      args.push("--config-option", "config:auth:password-stores=");
      args.push("--config-option", "servers:global:store-auth-creds=no");
    }

    // Force non interactive environment
    args.push("--non-interactive");

    if (options.log !== false) {
      const safeArgs = [...args];
      for (let i = 0; i < safeArgs.length; i++) {
        if (safeArgs[i] === "--password" && i + 1 < safeArgs.length) {
          safeArgs[i + 1] = "[REDACTED]";
        }
      }
      const argsOut = safeArgs.map(arg =>
        / |^$/.test(arg) ? `'${arg}'` : arg
      );
      this.logOutput(
        `[${this.lastCwd.split(PATH_SEPARATOR_PATTERN).pop()}]$ svn ${argsOut.join(" ")}\n`
      );
    }

    // Read configurable timeout (cached, refreshed on config change)
    const configuredTimeoutMs = getCommandTimeoutMs();

    // Log auth mode (controlled by svn.output.authLogging setting)
    if (options.log !== false && shouldLogAuthMode()) {
      this.logOutput(
        `[auth: ${authMethod}; mode: ${authConfig.modeDescription}]\n`
      );
    }

    const defaults: import("child_process").SpawnOptions = {
      env: proc.env
    };
    if (cwd) {
      defaults.cwd = cwd;
    }

    defaults.env = Object.assign({}, proc.env, options.env || {}, {
      LC_ALL: DEFAULT_LOCALE,
      LANG: DEFAULT_LOCALE
    });
    delete defaults.env?.SVN_PASSWORD;
    delete defaults.env?.PASSWORD;

    const spawnedProcess = cp.spawn(this.svnPath, args, defaults);

    // Write password via stdin if using --password-from-stdin (SVN 1.10+)
    // This hides password from process list (ps aux)
    if (passwordForStdin && spawnedProcess.stdin) {
      try {
        spawnedProcess.stdin.write(passwordForStdin);
        spawnedProcess.stdin.end();
      } catch (err) {
        // stdin write can fail if process exits early (EPIPE)
        // SVN will fail with auth error, retry logic will handle it
        logError("stdin write failed", err);
      }
    }

    const disposables: IDisposable[] = [];

    const removeEventListener = (
      ee: NodeJS.EventEmitter,
      name: string,
      fn: (...args: unknown[]) => void
    ) => {
      const target = ee as unknown as {
        removeListener?: (
          event: string,
          listener: (...args: unknown[]) => void
        ) => void;
        off?: (event: string, listener: (...args: unknown[]) => void) => void;
      };
      if (typeof target.removeListener === "function") {
        target.removeListener(name, fn);
        return;
      }
      if (typeof target.off === "function") {
        target.off(name, fn);
      }
    };

    const once = <T extends unknown[]>(
      ee: NodeJS.EventEmitter,
      name: string,
      fn: (...args: T) => void
    ) => {
      const listener = fn as (...args: unknown[]) => void;
      ee.once(name, listener);
      disposables.push(
        toDisposable(() => removeEventListener(ee, name, listener))
      );
    };

    const on = <T extends unknown[]>(
      ee: NodeJS.EventEmitter,
      name: string,
      fn: (...args: T) => void
    ) => {
      const listener = fn as (...args: unknown[]) => void;
      ee.on(name, listener);
      disposables.push(
        toDisposable(() => removeEventListener(ee, name, listener))
      );
    };

    // Phase 12 perf fix - Add timeout to prevent hanging SVN commands
    // Use configured timeout from settings, or explicit option, or default
    const timeoutMs = options.timeout || configuredTimeoutMs;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<[number, Buffer, string]>(
      (_, reject) => {
        timeoutHandle = setTimeout(() => {
          spawnedProcess.kill();
          reject(
            new SvnError({
              message: `SVN command timeout after ${timeoutMs}ms`,
              svnCommand: args[0],
              exitCode: 124
            })
          );
        }, timeoutMs);
      }
    );

    // Phase 18 perf fix - Add cancellation token support
    const cancellationPromise = new Promise<[number, Buffer, string]>(
      (_, reject) => {
        if (options.token) {
          const cancel = () => {
            spawnedProcess.kill();
            reject(
              new SvnError({
                message: `SVN command cancelled`,
                svnCommand: args[0],
                exitCode: 130
              })
            );
          };
          if (options.token.isCancellationRequested) {
            cancel();
          } else {
            disposables.push(options.token.onCancellationRequested(cancel));
          }
        }
      }
    );

    let result: [number, Buffer, string];
    try {
      result = await Promise.race([
        Promise.all([
          new Promise<number>((resolve, reject) => {
            once(spawnedProcess, "error", reject);
            once(spawnedProcess, "exit", resolve);
          }),
          new Promise<Buffer>(resolve => {
            const buffers: Buffer[] = [];
            on(spawnedProcess.stdout as Readable, "data", (b: Buffer) =>
              buffers.push(b)
            );
            once(spawnedProcess.stdout as Readable, "close", () =>
              resolve(Buffer.concat(buffers))
            );
          }),
          new Promise<string>(resolve => {
            const buffers: Buffer[] = [];
            on(spawnedProcess.stderr as Readable, "data", (b: Buffer) =>
              buffers.push(b)
            );
            once(spawnedProcess.stderr as Readable, "close", () =>
              resolve(Buffer.concat(buffers).toString())
            );
          })
        ]),
        timeoutPromise,
        ...(options.token ? [cancellationPromise] : [])
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      dispose(disposables);
    }

    const [exitCode, stdout, stderr] = result;

    // Log stderr if present
    if (options.log !== false && stderr.length > 0) {
      const name = this.lastCwd.split(PATH_SEPARATOR_PATTERN).pop();
      const err = stderr
        .split("\n")
        .filter((line: string) => line)
        .map((line: string) => `[${name}]$ ${line}`)
        .join("\n");
      this.logOutput(err);
    }

    return { exitCode, stdout, stderr, useSystemKeyring };
  }

  public async exec(
    cwd: string,
    args: string[],
    options: ICpOptions = {}
  ): Promise<IExecutionResult> {
    // Determine encoding before executeProcess modifies args
    let encoding: string | undefined | null = options.encoding;
    delete options.encoding;

    // SVN with '--xml' always return 'UTF-8', and jschardet detects this encoding: 'TIS-620'
    if (args.includes("--xml")) {
      encoding = "utf8";
    }

    // Execute the process using shared method
    const result = await this.executeProcess(cwd, args, options);
    const { exitCode, stdout, stderr } = result;

    // Detect encoding if not specified
    if (!encoding) {
      encoding = encodeUtil.detectEncoding(stdout);
    }

    // if not detected
    if (!encoding) {
      encoding = configuration.defaultEncoding() || "utf8";
    }

    if (!textCodec.encodingSupported(encoding)) {
      logWarning(`SVN: The encoding "${encoding}" is invalid`);
      encoding = "utf8";
    }

    const decodedStdout = textCodec.decode(stdout, encoding);

    this.throwOnFailure(args, result, decodedStdout);

    return { exitCode, stdout: decodedStdout, stderr };
  }

  public async execBuffer(
    cwd: string,
    args: string[],
    options: ICpOptions = {}
  ): Promise<BufferResult> {
    // Execute the process using shared method (returns raw Buffer)
    const result = await this.executeProcess(cwd, args, options);
    const { exitCode, stdout, stderr } = result;
    if (exitCode) {
      this.throwOnFailure(args, result, stdout.toString());
    }
    return { exitCode, stdout, stderr };
  }

  public async getRepositoryRoot(path: string) {
    try {
      const result = await this.exec(path, ["info", "--xml"]);

      const info = await parseInfoXml(result.stdout);

      if (info && info.wcInfo && info.wcInfo.wcrootAbspath) {
        return { root: info.wcInfo.wcrootAbspath, info };
      }

      // SVN 1.6 not has "wcroot-abspath"
      return { root: path, info };
    } catch (error) {
      if (error instanceof SvnError) {
        throw error;
      }
      logError("Find repository root failed", error);
      throw new Error("Unable to find repository root path");
    }
  }

  public async open(
    repositoryRoot: string,
    workspaceRoot: string,
    info?: ISvnInfo
  ): Promise<Repository> {
    return Repository.create(this, repositoryRoot, workspaceRoot, info);
  }

  public dispose(): void {
    this.authCache.dispose();
  }
}
