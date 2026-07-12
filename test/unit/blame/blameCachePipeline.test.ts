import { describe, it, expect, vi, beforeEach } from "vitest";
import { Uri } from "vscode";
import { Repository } from "../../../src/svnRepository";
import {
  initBlamePersistence,
  getPersistedBlame,
  persistBlame
} from "../../../src/blame/blamePersistence";
import { BlameProvider } from "../../../src/blame/blameProvider";
import { ISvnInfo } from "../../../src/common/types";

const BLAME_XML = `<?xml version="1.0"?>
<blame>
  <target path="f.R">
    <entry line-number="1">
      <commit revision="42">
        <author>alice</author>
        <date>2026-01-01T00:00:00.000000Z</date>
      </commit>
    </entry>
  </target>
</blame>`;

function makeMemento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      (store.get(key) as T) ?? defaultValue,
    update: async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    },
    keys: () => [...store.keys()]
  };
}

function makeRepo() {
  const exec = vi.fn(
    async (_cwd: string, _args: string[], _opts?: unknown) => ({
      exitCode: 0,
      stdout: BLAME_XML,
      stderr: ""
    })
  );
  const svn = { exec } as never;
  const info = { url: "http://srv/repo/trunk" } as unknown as ISvnInfo;
  const repo = new Repository(svn, "/ws", "/ws", info);
  return { repo, exec };
}

describe("blame persistent read/write-through", () => {
  beforeEach(() => {
    initBlamePersistence(makeMemento() as never);
  });

  it("persists a successful revision-pinned blame", async () => {
    const { repo } = makeRepo();

    await repo.blame("/ws/src/f.R", "42");

    await vi.waitFor(() => {
      expect(
        getPersistedBlame("http://srv/repo/trunk|src/f.R@42")
      ).toBeDefined();
    });
  });

  it("does NOT persist peg-qualified walk blames (they'd flood the store)", async () => {
    const { repo } = makeRepo();

    await repo.blame("/ws/src/f.R", "42", false, "3000");

    // in-memory cached, but kept out of the 40-entry persistent store
    await new Promise(r => setTimeout(r, 10));
    expect(
      getPersistedBlame("http://srv/repo/trunk|src/f.R@42@3000")
    ).toBeUndefined();
  });

  it("serves from persistence without spawning svn", async () => {
    const { repo, exec } = makeRepo();
    persistBlame("http://srv/repo/trunk|src/f.R@42", [
      { lineNumber: 1, revision: "42", author: "p", date: "d" } as never
    ]);

    const result = await repo.blame("/ws/src/f.R", "42");

    expect(exec).not.toHaveBeenCalled();
    expect(result[0]!.author).toBe("p");
  });
});

describe("updateDecorations pipeline", () => {
  function makeHarness() {
    const editor = {
      document: {
        uri: Uri.file("/ws/a.R"),
        lineCount: 10,
        version: 1,
        getText: () => ""
      },
      selection: { active: { line: 0 } },
      setDecorations: vi.fn()
    };
    let releaseMapping!: () => void;
    const mappingGate = new Promise<void>(r => (releaseMapping = r));
    const mockThis = {
      repository: {
        workspaceRoot: "/ws",
        // NEVER resolves: blame must not serialize behind the initial
        // full status crawl
        statusReady: new Promise<void>(() => {}),
        getResourceFromFile: () => undefined
      },
      decorationTypes: { gutter: {}, icon: {}, inline: {} },
      iconTypes: new Map(),
      shouldDecorate: () => true,
      getParentFolderStatus: () => undefined,
      clearDecorations: vi.fn(),
      // blame resolves only AFTER line mapping was requested: a serial
      // pipeline deadlocks here, a parallel one completes
      getBlameData: vi.fn(async () => {
        await mappingGate;
        return [
          { lineNumber: 1, revision: "42", author: "a", date: "d" } as never
        ];
      }),
      getLineMapping: vi.fn(async () => {
        releaseMapping();
        return undefined;
      }),
      ensureAddRevision: vi.fn(async () => false),
      renderCache: new Map(),
      messageScopeEpochs: new Map(),
      renderGenerations: new WeakMap(),
      addRevisionCache: new Map(),
      createAllDecorations: vi.fn(async () => ({
        gutter: [],
        icon: [],
        inline: []
      })),
      getRevisionRange: vi.fn(() => ({ oldest: 42, newest: 42 })),
      applyIconDecorations: vi.fn(),
      prefetchMessagesProgressively: vi.fn(async () => {}),
      claimOwner: () => ({ repository: mockThis.repository }),
      isCurrentOwner: () => true,
      canApplyRender: () => true
    };
    (mockThis as unknown as { repoFor: unknown }).repoFor = () =>
      mockThis.repository;
    (mockThis as unknown as { renderDecorations: unknown }).renderDecorations =
      (
        BlameProvider.prototype as unknown as Record<string, unknown>
      ).renderDecorations;
    const updateDecorations = (
      BlameProvider.prototype as unknown as Record<string, unknown>
    ).updateDecorations as (this: unknown, editor?: unknown) => Promise<void>;
    return { mockThis, editor, updateDecorations };
  }

  it("renders without waiting for statusReady, fetching blame and mapping in parallel", async () => {
    const { mockThis, editor, updateDecorations } = makeHarness();

    void updateDecorations.call(mockThis, editor);

    await vi.waitFor(
      () => {
        expect(editor.setDecorations).toHaveBeenCalled();
      },
      { timeout: 1000 }
    );
    expect(mockThis.getBlameData).toHaveBeenCalled();
    expect(mockThis.getLineMapping).toHaveBeenCalled();
  });
});
