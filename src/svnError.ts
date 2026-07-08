// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { ISvnErrorData } from "./common/types";
import {
  sanitizeString,
  createSanitizedErrorLog
} from "./security/errorSanitizer";

export default class SvnError extends Error {
  public error?: Error;
  public stdout?: string;
  public stderr?: string;
  public stderrFormated?: string;
  public exitCode?: number;
  public svnErrorCode?: string;
  public svnCommand?: string;

  constructor(data: ISvnErrorData) {
    super(data.message || "SVN error");
    // Restore the prototype chain so `instanceof Error`/`SvnError` hold after
    // transpilation. Without this a genuine SVN failure reads as a non-Error
    // and callers fall through to "Unknown error".
    Object.setPrototypeOf(this, SvnError.prototype);
    this.name = "SvnError";

    this.error = data.error;
    this.stdout = data.stdout;
    this.stderr = data.stderr;
    this.stderrFormated = data.stderrFormated;
    this.exitCode = data.exitCode;
    this.svnErrorCode = data.svnErrorCode;
    this.svnCommand = data.svnCommand;
  }

  public override toString(): string {
    const errorLog = createSanitizedErrorLog(this);
    let result =
      sanitizeString(this.message) + " " + JSON.stringify(errorLog, null, 2);

    if (this.error && this.error.stack) {
      result += sanitizeString(this.error.stack);
    }

    return result;
  }
}

/** Type guard: true only for SvnError instances (not plain error-shaped objects). */
export function isSvnError(err: unknown): err is SvnError {
  return err instanceof SvnError;
}
