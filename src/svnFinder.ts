// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as cp from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as semver from "semver";
import { Readable } from "stream";
import { ExtensionContext } from "vscode";
import { cpErrorHandler } from "./svn";

export interface ISvn {
  path: string;
  version: string;
}

// Cache key for storing full ISvn object in globalState
export const SVN_CACHE_KEY = "svnCache";

export class SvnFinder {
  /**
   * Find SVN executable with optional caching.
   * Startup optimization: tries cached path first to avoid repeated discovery.
   * @param hint User-configured path hint
   * @param context Extension context for caching (optional)
   */
  public async findSvn(
    hint?: string,
    context?: ExtensionContext
  ): Promise<ISvn> {
    // 1. Try user hint first
    if (hint) {
      try {
        const svn = await this.findSpecificSvn(hint);
        return this.checkSvnVersion(svn);
      } catch {
        // Fall through to other methods
      }
    }

    // 2. Try cached ISvn (startup optimization - fs.access instead of spawning process)
    if (context) {
      const cached = context.globalState.get<ISvn>(SVN_CACHE_KEY);
      if (cached?.path && cached?.version) {
        try {
          // Quick file existence check - no process spawn needed
          await fs.access(cached.path, fs.constants.X_OK);
          // startup diagnostic; the svn binary path is the useful part
          // eslint-disable-next-line no-console
          console.log(
            `Sven: Using cached SVN: ${cached.path} v${cached.version}`
          );
          return cached;
        } catch {
          // Cache invalid (file moved/deleted), clear and continue discovery
          await context.globalState.update(SVN_CACHE_KEY, undefined);
        }
      }
    }

    // 3. Platform-specific discovery
    let svn: ISvn;
    try {
      switch (process.platform) {
        case "darwin":
          svn = await this.findSvnDarwin();
          break;
        case "win32":
          svn = await this.findSvnWin32();
          break;
        default:
          svn = await this.findSpecificSvn("svn");
      }
      svn = await this.checkSvnVersion(svn);
    } catch {
      throw new Error("Svn installation not found.");
    }

    // 4. Cache full ISvn object for next startup (avoids version check spawn)
    if (context) {
      await context.globalState.update(SVN_CACHE_KEY, svn);
    }

    return svn;
  }

  /**
   * Find SVN on Windows - uses parallel discovery for faster startup.
   * Startup optimization: tries all paths concurrently instead of sequentially.
   */
  public async findSvnWin32(): Promise<ISvn> {
    // Build list of potential paths
    const potentialPaths: string[] = [];

    const envBases = [
      process.env.ProgramW6432,
      process.env["ProgramFiles(x86)"],
      process.env.ProgramFiles
    ];

    for (const base of envBases) {
      if (base) {
        potentialPaths.push(path.join(base, "TortoiseSVN", "bin", "sven.exe"));
      }
    }

    // Also try PATH
    potentialPaths.push("svn");

    // Try all paths in parallel (startup optimization - saves ~1s)
    const results = await Promise.allSettled(
      potentialPaths.map(p => this.findSpecificSvn(p))
    );

    // Return first successful result
    for (const result of results) {
      if (result.status === "fulfilled") {
        return result.value;
      }
    }

    throw new Error("SVN not found in standard Windows locations");
  }

  public findSystemSvnWin32(base?: string): Promise<ISvn> {
    if (!base) {
      return Promise.reject<ISvn>("Not found");
    }

    return this.findSpecificSvn(
      path.join(base, "TortoiseSVN", "bin", "sven.exe")
    );
  }

  public findSvnDarwin(): Promise<ISvn> {
    return new Promise<ISvn>((c, e) => {
      cp.execFile("which", ["svn"], (err, svnPathBuffer) => {
        if (err) {
          return e("svn not found");
        }

        const path = svnPathBuffer.toString().replace(/^\s+|\s+$/g, "");

        function getVersion(path: string) {
          // make sure svn executes
          cp.execFile("svn", ["--version", "--quiet"], (err, stdout) => {
            if (err) {
              return e("svn not found");
            }

            return c({ path, version: stdout.trim() });
          });
        }

        if (path !== "/usr/bin/svn") {
          return getVersion(path);
        }

        // must check if XCode is installed
        cp.execFile("xcode-select", ["-p"], (err: unknown) => {
          if (
            err &&
            typeof err === "object" &&
            "code" in err &&
            err.code === 2
          ) {
            // svn is not installed, and launching /usr/bin/svn
            // will prompt the user to install it

            return e("svn not found");
          }

          getVersion(path);
        });
      });
    });
  }

  public findSpecificSvn(path: string): Promise<ISvn> {
    return new Promise<ISvn>((c, e) => {
      const buffers: Buffer[] = [];
      const child = cp.spawn(path, ["--version", "--quiet"]);
      (child.stdout as Readable).on("data", (b: Buffer) => buffers.push(b));
      child.on("error", cpErrorHandler(e));
      child.on("close", code =>
        code
          ? e(new Error("Not found"))
          : c({
              path,
              version: Buffer.concat(buffers).toString("utf8").trim()
            })
      );
    });
  }

  public checkSvnVersion(svn: ISvn): Promise<ISvn> {
    return new Promise<ISvn>((c, e) => {
      // fix compatibility with SlickSVN (like 1.6.17-SlikSvn-tag-1.6.17@1130898-X64)
      const version = svn.version.replace(/^(\d+\.\d+\.\d+).*/, "$1");
      if (!semver.valid(version)) {
        e(new Error("Invalid svn version"));
      } else if (!semver.gte(version, "1.6.0")) {
        e(new Error("Required svn version must be >= 1.6"));
      } else {
        c(svn);
      }
    });
  }
}
