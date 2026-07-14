import { Uri } from "vscode";
import { IOpenRepository } from "./common/types";
import { Repository } from "./repository";
import { isDescendant } from "./util";

export class RepositoryRegistry {
  private entries: IOpenRepository[] = [];
  private exclusions = new Map<string, Set<string>>();

  get openRepositories(): readonly IOpenRepository[] {
    return this.entries;
  }

  get repositories(): Repository[] {
    return this.entries.map(entry => entry.repository);
  }

  add(entry: IOpenRepository): void {
    this.entries.push(entry);
  }

  remove(entry: IOpenRepository): void {
    this.entries = this.entries.filter(candidate => candidate !== entry);
    this.exclusions.delete(entry.repository.workspaceRoot);
  }

  clear(): void {
    this.entries = [];
    this.exclusions.clear();
  }

  setExclusions(repository: Repository, exclusions: Set<string>): void {
    this.exclusions.set(repository.workspaceRoot, exclusions);
  }

  private deepestFirst(): IOpenRepository[] {
    return [...this.entries].sort(
      (a, b) =>
        b.repository.workspaceRoot.length - a.repository.workspaceRoot.length
    );
  }

  resolveHint(hint: unknown): IOpenRepository | undefined {
    if (!hint) return undefined;

    if (hint instanceof Repository) {
      return this.entries.find(entry => entry.repository === hint);
    }

    if (
      typeof hint === "object" &&
      hint !== null &&
      "repository" in hint &&
      hint.repository instanceof Repository
    ) {
      return this.entries.find(entry => entry.repository === hint.repository);
    }

    const uri = typeof hint === "string" ? Uri.file(hint) : hint;
    if (uri instanceof Uri) return this.resolveStatusUri(uri);

    return this.entries.find(
      entry =>
        hint === entry.repository.sourceControl ||
        hint === entry.repository.changes
    );
  }

  resolveStatusUri(uri: Uri): IOpenRepository | undefined {
    return this.deepestFirst().find(entry => {
      if (!isDescendant(entry.repository.workspaceRoot, uri.fsPath)) {
        return false;
      }

      for (const excluded of this.exclusions.get(
        entry.repository.workspaceRoot
      ) ?? []) {
        if (isDescendant(excluded, uri.fsPath)) return false;
      }
      return true;
    });
  }

  resolveDescendantUri(uri: Uri): Repository | null {
    return (
      this.deepestFirst().find(entry =>
        isDescendant(entry.repository.workspaceRoot, uri.fsPath)
      )?.repository ?? null
    );
  }
}
