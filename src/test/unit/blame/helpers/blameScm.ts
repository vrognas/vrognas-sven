import { Uri } from "vscode";
import { SourceControlManager } from "../../../../source_control_manager";
import { isDescendant } from "../../../../util";

/**
 * Wrap a (possibly stubbed) repository as the single SourceControlManager a
 * shared BlameProvider resolves through. getRepository mirrors the real
 * descendant match when a workspaceRoot is discoverable (so "file outside
 * repo" tests still see null), and otherwise returns the repo for any file.
 */
export function scmFor(repo: unknown): SourceControlManager {
  const rootOf = (): string | undefined => {
    const r = repo as {
      workspaceRoot?: unknown;
      repository?: { workspaceRoot?: unknown };
    };
    try {
      if (typeof r?.workspaceRoot === "string") return r.workspaceRoot;
    } catch {
      // getter delegates to an unset inner repo - ignore
    }
    try {
      if (typeof r?.repository?.workspaceRoot === "string") {
        return r.repository.workspaceRoot;
      }
    } catch {
      // ignore
    }
    return undefined;
  };

  return {
    getRepository: (hint: unknown) => {
      const root = rootOf();
      const fsPath =
        hint instanceof Uri
          ? hint.fsPath
          : typeof hint === "string"
            ? hint
            : undefined;
      if (root && fsPath && !isDescendant(root, fsPath)) {
        return null;
      }
      return repo;
    },
    get repositories() {
      return [repo];
    },
    onDidOpenRepository: () => ({ dispose() {} })
  } as unknown as SourceControlManager;
}
