import { describe, it, expect, vi } from "vitest";
import { Uri } from "vscode";
import { Repository } from "../../../src/svnRepository";
import { BlameProvider } from "../../../src/blame/blameProvider";
import { ISvnInfo } from "../../../src/common/types";

/**
 * Revisiting a recently blamed file must be INSTANT. Two latency
 * sources hid behind the warm caches:
 * 1. blame()'s BASE->numeric key resolution awaited `svn info` BEFORE
 *    the cache lookup - after the 2-min info TTL every revisit paid a
 *    subprocess spawn for already-cached blame.
 * 2. updateDecorations rebuilt every hover/decoration object per render.
 */

const BLAME_XML = `<?xml version="1.0"?><blame><target path="f.R"><entry line-number="1"><commit revision="42"><author>a</author><date>2024-01-01T00:00:00.000000Z</date></commit></entry></target></blame>`;

const infoXml = (rev: string) =>
  `<?xml version="1.0"?><info><entry kind="dir" path="." revision="${rev}"><url>http://srv/repo/trunk</url><repository><root>http://srv/repo</root><uuid>u</uuid></repository></entry></info>`;

function makeRepo() {
  let infoRev = "3000";
  const exec = vi.fn(async (_cwd: string, args: string[], _opts?: unknown) => ({
    exitCode: 0,
    stdout: args[0] === "blame" ? BLAME_XML : infoXml(infoRev),
    stderr: ""
  }));
  const svn = { exec } as never;
  const info = { url: "http://srv/repo/trunk" } as unknown as ISvnInfo;
  const repo = new Repository(svn, "/ws", "/ws", info);
  return { repo, exec, setInfoRev: (r: string) => (infoRev = r) };
}

describe("blame revisit latency", () => {
  it("BASE revisits reuse the resolved key - no svn info spawn", async () => {
    const { repo, exec } = makeRepo();
    const getInfo = vi
      .spyOn(repo, "getInfo")
      .mockResolvedValue({ revision: "3000" } as never);

    await repo.blame("/ws/f.R"); // resolves + memoizes the BASE key
    await repo.blame("/ws/f.R"); // warm revisit

    expect(getInfo).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls.filter(c => c[1][0] === "blame")).toHaveLength(1);
  });

  it("clearBlameCache drops the key memo (mutating ops re-resolve)", async () => {
    const { repo } = makeRepo();
    const getInfo = vi
      .spyOn(repo, "getInfo")
      .mockResolvedValue({ revision: "3000" } as never);

    await repo.blame("/ws/f.R");
    repo.clearBlameCache();
    await repo.blame("/ws/f.R");

    expect(getInfo).toHaveBeenCalledTimes(2);
  });

  it("updateInfo clears blame caches when the revision changed externally", async () => {
    const { repo, setInfoRev } = makeRepo();
    const clear = vi.spyOn(repo, "clearBlameCache");

    await repo.updateInfo(true); // r3000
    expect(clear).not.toHaveBeenCalled();

    setInfoRev("3005"); // e.g. `svn update` ran in a terminal
    await repo.updateInfo(true);

    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("decoration render cache", () => {
  function harness() {
    const uri = Uri.file("/ws/a.R");
    const editor = {
      document: { uri, lineCount: 10, version: 7, getText: () => "" },
      setDecorations: vi.fn()
    };
    const blameData = [
      { lineNumber: 1, revision: "42", author: "a", date: "d" } as never
    ];
    const mockThis = {
      repository: {
        workspaceRoot: "/ws",
        statusReady: Promise.resolve(),
        getResourceFromFile: () => undefined
      },
      decorationTypes: { gutter: {}, icon: {}, inline: {} },
      iconTypes: new Map(),
      renderCache: new Map(),
      messageEpoch: 0,
      addRevisionCache: new Map(),
      shouldDecorate: () => true,
      getParentFolderStatus: () => undefined,
      clearDecorations: vi.fn(),
      getBlameData: vi.fn(async () => blameData),
      getLineMapping: vi.fn(async () => undefined),
      ensureAddRevision: vi.fn(async () => false),
      createAllDecorations: vi.fn(async () => ({
        gutter: [],
        icon: [],
        inline: []
      })),
      getRevisionRange: vi.fn(() => ({ oldest: 42, newest: 42 })),
      applyIconDecorations: vi.fn(),
      prefetchMessagesProgressively: vi.fn(async () => {}),
      claimOwner: () => ({ repository: mockThis.repository }),
      isCurrentOwner: () => true
    };
    (mockThis as unknown as { repoFor: unknown }).repoFor = () =>
      mockThis.repository;
    const updateDecorations = (
      BlameProvider.prototype as unknown as Record<string, unknown>
    ).updateDecorations as (this: unknown, editor?: unknown) => Promise<void>;
    return { mockThis, editor, updateDecorations };
  }

  it("revisits at the same document version skip the decoration rebuild", async () => {
    const { mockThis, editor, updateDecorations } = harness();

    await updateDecorations.call(mockThis, editor);
    await updateDecorations.call(mockThis, editor);

    expect(mockThis.createAllDecorations).toHaveBeenCalledTimes(1);
    // decorations still applied on the cached revisit
    expect(editor.setDecorations.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
