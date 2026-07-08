// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

/**
 * Classification of a `svn blame` failure, shared by BlameProvider and
 * BlameStatusBar so the error-code lists don't drift between them.
 *
 * - `untracked`: file not under version control — expected, skip silently
 * - `auth`: authentication required
 * - `network`: cannot reach the server
 * - `other`: anything else (log it)
 */
export type BlameErrorKind = "untracked" | "auth" | "network" | "other";

/**
 * Build the searchable text from a throwable: message + raw stderr +
 * svnErrorCode. Uses the raw (unsanitized) fields because this is internal
 * classification, never shown to the user, and error codes must survive.
 */
function errorText(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
  } else if (err !== undefined && err !== null) {
    parts.push(String(err));
  }
  if (err && typeof err === "object") {
    const o = err as { stderr?: unknown; svnErrorCode?: unknown };
    if (o.stderr) parts.push(String(o.stderr));
    if (o.svnErrorCode) parts.push(String(o.svnErrorCode));
  }
  return parts.join(" ");
}

export function classifyBlameError(err: unknown): BlameErrorKind {
  const text = errorText(err);

  // Unversioned/non-WC files (W155010: not found, E200009: op on targets,
  // E155007: not a working copy). Expected for the shallow-checkout edge.
  if (/W155010|E200009|E155007/.test(text)) {
    return "untracked";
  }
  if (/Authentication failed|No more credentials|E170001|E215004/.test(text)) {
    return "auth";
  }
  if (/E170013|No such host|Unable to connect/.test(text)) {
    return "network";
  }
  return "other";
}
