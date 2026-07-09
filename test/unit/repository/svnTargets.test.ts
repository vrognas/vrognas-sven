import { describe, it, expect, vi } from "vitest";
import { Uri } from "vscode";
import { Repository } from "../../../src/svnRepository";
import { ISvnInfo } from "../../../src/common/types";

/**
 * svn treats any scheme:// target as a REPOSITORY URL, so working-copy
 * file Uris must be passed as filesystem paths. And svn resolves the peg
 * at the LAST '@' in a target: an explicit peg must be appended unescaped
 * (name@2x.png@123); the trailing-@ escape is only for peg-less targets.
 */

const LOG_XML = `<?xml version="1.0"?><log><logentry revision="42"><author>a</author><date>2024-01-01T00:00:00.000000Z</date><msg>m</msg></logentry></log>`;

function makeRepo() {
  const exec = vi.fn(async () => ({
    exitCode: 0,
    stdout: LOG_XML,
    stderr: ""
  }));
  const svn = { exec } as never;
  const info = { url: "http://srv/repo/trunk" } as unknown as ISvnInfo;
  const repo = new Repository(svn, "/ws", "/ws", info);
  return { repo, exec };
}

const lastArg = (exec: ReturnType<typeof vi.fn>): string => {
  const args = exec.mock.calls[0]![1] as string[];
  return args[args.length - 1]!;
};

describe("svn CLI target handling", () => {
  it("log passes working-copy fsPath (not file:// URL) with peg", async () => {
    const { repo, exec } = makeRepo();
    const uri = Uri.file("/ws/src/model.R");

    await repo.log("100", "1", 2, uri, "100");

    const target = lastArg(exec);
    expect(target).toBe(`${uri.fsPath}@100`);
    expect(target).not.toContain("file://");
  });

  it("log appends explicit peg without trailing-@ escape for @-named files", async () => {
    const { repo, exec } = makeRepo();

    await repo.log("123", "1", 2, "http://srv/repo/icon@2x.png", "123");

    // double @@ would make svn read the path as literal 'icon@2x.png@'
    expect(lastArg(exec)).toBe("http://srv/repo/icon@2x.png@123");
  });

  it("log keeps the trailing-@ escape when no peg is given", async () => {
    const { repo, exec } = makeRepo();

    await repo.log("HEAD", "1", 50, "http://srv/repo/icon@2x.png");

    expect(lastArg(exec)).toBe("http://srv/repo/icon@2x.png@");
  });

  it("show resolves a working-copy file Uri at a pinned revision to its repo URL", async () => {
    const { repo } = makeRepo();
    const uri = Uri.file("/ws/src/model.R");

    const { args } = await (repo as any).prepareCatArgs(uri, "42");

    expect(args[args.length - 1]).toBe("http://srv/repo/trunk/src/model.R@42");
  });

  it("patchRevision uses the working-copy path for file Uris", async () => {
    const { repo, exec } = makeRepo();
    const uri = Uri.file("/ws/src/model.R");

    await repo.patchRevision("42", uri);

    expect(exec.mock.calls[0]![1]).toEqual(["diff", "-c", "42", uri.fsPath]);
  });
});
