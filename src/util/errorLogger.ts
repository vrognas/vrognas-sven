// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

/**
 * Safe error logging utility (Phase 20.D)
 *
 * Wraps console.error/log with automatic credential sanitization
 * to prevent credential leaks in error logs
 */

import { sanitizeError, sanitizeString } from "../security/errorSanitizer";
import { isSvnError } from "../svnError";

/**
 * Safely log an error with automatic sanitization
 * Use this instead of console.error() in catch blocks
 *
 * @param message Context message for the error
 * @param error The error to log (optional)
 *
 * @example
 * ```typescript
 * try {
 *   await performOperation();
 * } catch (error) {
 *   logError("Operation failed", error); // Safe - credentials sanitized
 * }
 * ```
 */
export function logError(message: string, error?: unknown): void {
  const sanitizedMessage = sanitizeString(message);

  if (error) {
    const sanitizedError = sanitizeError(
      error instanceof Error ? error : new Error(String(error))
    );
    console.error(`${sanitizedMessage}:`, sanitizedError);
  } else {
    console.error(sanitizedMessage);
  }
}

/**
 * Safely log a warning with automatic sanitization
 * Use this instead of console.warn() when logging user/system data
 *
 * @param message Context message for the warning
 * @param data Optional data to log
 */
export function logWarning(message: string, data?: unknown): void {
  const sanitizedMessage = sanitizeString(message);

  if (data !== undefined) {
    const sanitizedData =
      typeof data === "string"
        ? sanitizeString(data)
        : sanitizeString(JSON.stringify(data, null, 2));
    console.warn(`${sanitizedMessage}:`, sanitizedData);
  } else {
    console.warn(sanitizedMessage);
  }
}

/**
 * Extract a user-safe error message from an unknown throwable.
 *
 * For SvnError the informative detail lives in stderr, not `.message`
 * ("Failed to execute svn"), so surface the (sanitized) stderr instead —
 * this is what fixes SVN failures previously shown as "Unknown error".
 * stderr is sanitized because it can contain URLs/paths/credentials.
 */
export function getErrorMessage(error: unknown): string {
  if (isSvnError(error)) {
    const detail = error.stderrFormated || error.stderr || error.message;
    return sanitizeString(detail).trim() || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Format SVN error message with error code if available
 * Extracts SVN error codes (E12345) from error string
 *
 * @param error The error to extract code from
 * @param defaultMsg Default message if no code found
 * @returns Formatted message with error code appended
 */
export function formatSvnError(error: unknown, defaultMsg: string): string {
  const errStr = String(error);
  const match = errStr.match(/svn: E(\d+)/);
  return match ? `${defaultMsg} (E${match[1]})` : defaultMsg;
}
