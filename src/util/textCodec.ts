// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License
import { logWarning } from "./errorLogger";

/**
 * Lightweight encoding/decoding via Node's built-in TextDecoder + Buffer.
 * Replaces @vscode/iconv-lite-umd (~506 KB of bundled encoding tables) for
 * the common cases (UTF-8/16, ISO-8859-x, windows-12xx, CJK families).
 *
 * Trade-off: a handful of exotic encodings supported by iconv-lite are not
 * available here (e.g. VISCII, some Mac legacy codepages). Decoders for
 * those fall back to UTF-8 with a console warning rather than crashing.
 */

/**
 * Strip casing, whitespace, dashes, underscores. Used as a lookup key so
 * "windows-1252" / "windows1252" / "WINDOWS_1252" all hash to the same bucket.
 */
function normalizeKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Map of normalized labels to WHATWG canonical labels that `TextDecoder`
 * accepts. Covers (1) chardet output with spaces, (2) VS Code's no-dash
 * `files.encoding` values, (3) iconv-lite codepage aliases that survived
 * the migration via the old `CHARDET_TO_ICONV_ENCODINGS` map.
 *
 * Only entries here whose normalized form differs from a TextDecoder-
 * accepted label — e.g. `latin1`, `ascii`, `gbk` work as-is and are not
 * listed; the fallback in `canonicalLabel` returns the normalized form
 * for those.
 */
const DECODE_ALIASES: Record<string, string> = {
  utf8: "utf-8",
  utf8bom: "utf-8", // VS Code's UTF-8-with-BOM is decode-equivalent to utf-8
  utf16: "utf-16le",
  utf16le: "utf-16le",
  utf16be: "utf-16be",
  windows1250: "windows-1250",
  windows1251: "windows-1251",
  windows1252: "windows-1252",
  windows1253: "windows-1253",
  windows1254: "windows-1254",
  windows1255: "windows-1255",
  windows1256: "windows-1256",
  windows1257: "windows-1257",
  windows1258: "windows-1258",
  iso88591: "iso-8859-1",
  iso88592: "iso-8859-2",
  iso88593: "iso-8859-3",
  iso88594: "iso-8859-4",
  iso88595: "iso-8859-5",
  iso88596: "iso-8859-6",
  iso88597: "iso-8859-7",
  iso88598: "iso-8859-8",
  iso88599: "windows-1254", // WHATWG: ISO-8859-9 → windows-1254
  iso885910: "iso-8859-10",
  iso885913: "iso-8859-13",
  iso885914: "iso-8859-14",
  iso885915: "iso-8859-15",
  iso885916: "iso-8859-16",
  shiftjis: "shift_jis",
  eucjp: "euc-jp",
  euckr: "euc-kr",
  iso2022jp: "iso-2022-jp",
  koi8r: "koi8-r",
  koi8u: "koi8-u",
  cp866: "ibm866",
  cp874: "windows-874",
  cp932: "shift_jis",
  cp936: "gbk",
  cp949: "euc-kr",
  cp950: "big5",
  big5hkscs: "big5", // HK supplementary chars lost; closest WHATWG match
  macroman: "macintosh"
};

/**
 * Translate a user-supplied label into one TextDecoder will accept.
 * Returns `null` if no variant works.
 *
 * Tried in order:
 *   1. Known alias (e.g. "cp932" → "shift_jis").
 *   2. Original input — handles dashed forms TextDecoder accepts directly
 *      ("iso-2022-jp", "big5", "windows-1252") that would otherwise be
 *      mangled by normalization.
 *   3. Normalized form (no dashes/underscores) — handles "latin-1" → "latin1".
 */
function canonicalLabel(label: string): string | null {
  const key = normalizeKey(label);
  if (DECODE_ALIASES[key]) {
    return DECODE_ALIASES[key];
  }
  if (label.length > 0) {
    try {
      new TextDecoder(label);
      return label;
    } catch {
      // ignore — fall through to normalized form
    }
  }
  if (key.length > 0) {
    try {
      new TextDecoder(key);
      return key;
    } catch {
      // ignore — give up
    }
  }
  return null;
}

/** Maps normalized labels to Node's BufferEncoding for the write path. */
const ENCODE_TO_BUFFER: Record<string, BufferEncoding> = {
  utf8: "utf-8",
  utf16le: "utf-16le",
  latin1: "latin1",
  iso88591: "latin1", // byte-equivalent
  binary: "latin1", // deprecated Node alias
  ascii: "ascii"
};

/** True iff some variant of the label resolves to a usable TextDecoder. */
export function encodingSupported(encoding: string): boolean {
  return canonicalLabel(encoding) !== null;
}

/**
 * Decode bytes to string. Throws `RangeError` if the encoding label
 * resolves to nothing TextDecoder accepts. Callers should fall back to
 * UTF-8 (via `encodingSupported` check) if they want to be defensive.
 */
export function decode(buffer: Buffer | Uint8Array, encoding: string): string {
  const label = canonicalLabel(encoding);
  if (label === null) {
    throw new RangeError(`Unsupported encoding: "${encoding}"`);
  }
  return new TextDecoder(label).decode(buffer);
}

/**
 * Encode string to bytes. Supports the encodings Node's Buffer.from handles
 * natively (UTF-8/16-LE, latin1/ISO-8859-1, ASCII). Legacy multibyte
 * codepages (windows-12xx, Shift_JIS, etc.) fall back to UTF-8 with a
 * one-line warning — iconv-lite handled these but the tables it shipped
 * cost ~500 KB. Affected users should configure UTF-8 in their workspace.
 */
export function encode(text: string, encoding: string): Buffer {
  const key = normalizeKey(encoding);
  const bufEnc = ENCODE_TO_BUFFER[key];
  if (bufEnc) {
    return Buffer.from(text, bufEnc);
  }
  logWarning(
    `textCodec: cannot encode in "${encoding}" (no Node Buffer support); ` +
      `writing UTF-8 instead. Set the file's encoding to utf-8/utf-16le/latin1 to avoid this.`
  );
  return Buffer.from(text, "utf-8");
}
