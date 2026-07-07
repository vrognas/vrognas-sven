import { LRUCache } from "../../../../util/lruCache";

/** Minimal valid `svn blame --xml` output (1 line, r123 by john). */
export const BLAME_XML = `<?xml version="1.0"?>
<blame>
  <target path="file.txt">
    <entry line-number="1">
      <commit revision="123">
        <author>john</author>
        <date>2025-11-18T10:00:00.000000Z</date>
      </commit>
    </entry>
  </target>
</blame>`;

export interface FakeSvnRepo {
  /** Bare object carrying SvnRepository.prototype + mirrored private state. */
  repo: any;
  /** Number of exec() calls so far. */
  getCount: () => number;
  /** Replace the exec implementation (hang, reject, alternate stdout...). */
  setExec: (impl: () => Promise<{ stdout: string }>) => void;
}

/**
 * Shared fake for exercising SvnRepository cache logic without spawning svn.
 *
 * SINGLE source of truth for the mirrored private fields — if SvnRepository
 * gains a new cache field, add it HERE (a missing field silently degrades:
 * e.g. an absent _blameGeneration makes clearBlameCache do undefined++ →
 * NaN, and generation checks then skip cache writes for the wrong reason).
 */
export async function makeFakeSvnRepo(): Promise<FakeSvnRepo> {
  const { Repository: SvnRepository } = await import(
    "../../../../svnRepository"
  );

  let execCount = 0;
  let execImpl: () => Promise<{ stdout: string }> = async () => ({
    stdout: BLAME_XML
  });

  const repo: any = Object.create(SvnRepository.prototype);
  repo.removeAbsolutePath = (p: string) => p;
  repo.getRepoUrl = async () => "https://svn.example.com/repo";
  repo.exec = async (_args: string[]) => {
    execCount++;
    return execImpl();
  };
  repo._infoCache = new LRUCache(500, 2 * 60 * 1000);
  repo._logCache = new LRUCache(50, 60 * 1000);
  repo._listCache = new LRUCache(200, 30 * 1000);
  repo._catCache = new LRUCache(50, 30 * 1000);
  repo._blameCache = new LRUCache(100, 5 * 60 * 1000);
  repo._blameInFlight = new Map();
  repo._blameErrorCache = new LRUCache(50, 30 * 1000);
  repo._blameGeneration = 0;

  return {
    repo,
    getCount: () => execCount,
    setExec: impl => (execImpl = impl)
  };
}
