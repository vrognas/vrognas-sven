import { logError } from "./errorLogger";

export interface DisposableLike {
  dispose(): void;
}

export function runTeardown(message: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    logError(message, error);
  }
}

export function disposeBestEffort(
  disposables: Iterable<DisposableLike | undefined>,
  message = "Failed to dispose resource"
): void {
  for (const disposable of disposables) {
    if (disposable) {
      runTeardown(message, () => disposable.dispose());
    }
  }
}
