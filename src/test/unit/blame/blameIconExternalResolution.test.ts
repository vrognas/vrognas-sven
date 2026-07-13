import * as assert from "assert";
import { Disposable, Uri, window } from "vscode";
import { vi } from "vitest";
import { BlameIconState } from "../../../contexts/blameIconState";

suite("BlameIconState external ownership", () => {
  test("uses descendant ownership for an external file", async () => {
    const event = () => new Disposable(() => undefined);
    const owner = { getResourceFromFile: vi.fn(() => undefined) };
    const getRepository = vi.fn(() => null);
    const getRepositoryFromUri = vi.fn(() => owner);
    const previousEditor = window.activeTextEditor;
    const uri = Uri.file("/workspace/external/file.ts");
    (window as any).activeTextEditor = { document: { uri } };

    const state = new BlameIconState({
      getRepository,
      getRepositoryFromUri,
      onDidOpenRepository: event,
      onDidChangeStatusRepository: event
    } as never);
    try {
      await Promise.resolve();
      await Promise.resolve();
      assert.strictEqual(getRepository.mock.calls.length, 0);
      assert.strictEqual(getRepositoryFromUri.mock.calls.length, 1);
    } finally {
      state.dispose();
      (window as any).activeTextEditor = previousEditor;
    }
  });
});
