// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

/**
 * Line mapping from BASE revision to working copy.
 * Key = 1-indexed BASE line number
 * Value = 1-indexed working copy line number (undefined if line deleted)
 */
export type LineMapping = Map<number, number | undefined>;

/**
 * Ceiling on the LCS DP matrix (base×working cells). The matrix is
 * allocated dense, so an ungated pair of large files (e.g. two 20k-line
 * revisions in a Line-History hop) tries to build ~400M cells and freezes
 * or OOMs the extension host. Above this we fall back to a positional
 * middle mapping - imperfect only for a pathological all-changed core,
 * which prefix/suffix stripping never leaves large in the common case.
 */
const MAX_LCS_PRODUCT = 4_000_000; // ~2000x2000; ~32MB transient matrix

/**
 * Compute line mapping from BASE content to working copy content.
 * Uses LCS (Longest Common Subsequence) to find matching lines,
 * then builds a mapping from BASE line numbers to working copy line numbers.
 *
 * Common identical prefix/suffix lines are stripped and mapped by identity
 * first, so the (quadratic) LCS runs only on the differing core - a huge
 * win for the typical "big file, small edit" case and the bound that keeps
 * the DP matrix from exploding.
 *
 * @param baseLines Lines from BASE revision (committed version)
 * @param workingLines Lines from working copy (current editor)
 * @returns Map from BASE line number (1-indexed) to working copy line number
 */
export function computeLineMapping(
  baseLines: string[],
  workingLines: string[]
): LineMapping {
  const mapping: LineMapping = new Map();

  const m = baseLines.length;
  const n = workingLines.length;
  if (m === 0) {
    return mapping;
  }

  // Strip identical leading lines (map by identity).
  let prefix = 0;
  while (
    prefix < m &&
    prefix < n &&
    baseLines[prefix] === workingLines[prefix]
  ) {
    mapping.set(prefix + 1, prefix + 1);
    prefix++;
  }

  // Strip identical trailing lines (map by identity), without overlapping
  // the stripped prefix.
  let suffix = 0;
  while (
    suffix < m - prefix &&
    suffix < n - prefix &&
    baseLines[m - 1 - suffix] === workingLines[n - 1 - suffix]
  ) {
    mapping.set(m - suffix, n - suffix);
    suffix++;
  }

  const baseMid = baseLines.slice(prefix, m - suffix);
  if (baseMid.length === 0) {
    return mapping; // pure insertion/deletion around a common core
  }
  const workMid = workingLines.slice(prefix, n - suffix);

  // A stripped prefix/suffix means the core is bracketed by matches - the
  // signal findModifiedLine's context anchoring needs to tell a modified
  // line apart from a deletion once its neighbours are no longer in view.
  const midMapping =
    baseMid.length * workMid.length > MAX_LCS_PRODUCT
      ? positionalMiddleMapping(baseMid, workMid)
      : computeCoreMapping(baseMid, workMid, prefix > 0, suffix > 0);

  // Re-offset the core mapping by the stripped prefix length.
  for (const [baseLineNum, workLineNum] of midMapping) {
    mapping.set(
      baseLineNum + prefix,
      workLineNum === undefined ? undefined : workLineNum + prefix
    );
  }

  return mapping;
}

/**
 * Precise LCS-based mapping of the differing core. `bracketBefore` /
 * `bracketAfter` record that the core is flanked by stripped identical
 * lines, so a core line with no LCS match but flanked context is a
 * modification (not a deletion).
 */
function computeCoreMapping(
  baseLines: string[],
  workingLines: string[],
  bracketBefore: boolean,
  bracketAfter: boolean
): LineMapping {
  const mapping: LineMapping = new Map();

  // Compute LCS to find matching lines
  const lcs = computeLCS(baseLines, workingLines);

  // Build indexed structures for O(1) lookups (instead of O(n) array.find())
  const lcsIndex = buildLCSIndex(lcs);

  // Build mapping using LCS matches
  // For each BASE line, find where it appears in working copy
  let workingIdx = 0;

  for (let baseIdx = 0; baseIdx < baseLines.length; baseIdx++) {
    const baseLine = baseLines[baseIdx]!;
    const baseLineNum = baseIdx + 1; // 1-indexed

    // Check if this line is in LCS (unchanged) - O(1) lookup
    const lcsMatch = lcsIndex.byBaseIdx.get(baseIdx);

    if (lcsMatch && lcsMatch.workingIdx >= workingIdx) {
      // Line found in LCS - direct mapping
      mapping.set(baseLineNum, lcsMatch.workingIdx + 1);
      workingIdx = lcsMatch.workingIdx + 1;
    } else {
      // Line not in LCS - try to find modified version nearby
      // Look for the line in working copy starting from current position
      const foundIdx = findModifiedLine(
        baseLine,
        workingLines,
        workingIdx,
        baseIdx,
        baseLines,
        lcsIndex,
        bracketBefore,
        bracketAfter
      );

      if (foundIdx !== -1) {
        mapping.set(baseLineNum, foundIdx + 1);
        workingIdx = foundIdx + 1;
      } else {
        // Line was deleted or completely changed
        mapping.set(baseLineNum, undefined);
      }
    }
  }

  return mapping;
}

/**
 * Fallback for an oversized differing core: map each base line to the
 * working line at the same offset (undefined past the working end). Rough,
 * but bounded - only reached when the core exceeds MAX_LCS_PRODUCT.
 */
function positionalMiddleMapping(
  baseLines: string[],
  workingLines: string[]
): LineMapping {
  const mapping: LineMapping = new Map();
  for (let i = 0; i < baseLines.length; i++) {
    mapping.set(i + 1, i < workingLines.length ? i + 1 : undefined);
  }
  return mapping;
}

/**
 * Map a blame line number to working copy line number.
 * Returns undefined if line was deleted, or the 0-indexed line number.
 * Use this helper to avoid repeating the mapping logic.
 */
export function mapBlameLineNumber(
  blameLineNumber: number,
  lineMapping: LineMapping | undefined
): number | undefined {
  if (!lineMapping) {
    return blameLineNumber - 1; // Simple 1-indexed to 0-indexed
  }
  const mappedLine = lineMapping.get(blameLineNumber);
  if (mappedLine === undefined) {
    return undefined; // Line was deleted
  }
  return mappedLine - 1; // 1-indexed to 0-indexed
}

/**
 * LCS match entry
 */
interface LCSMatch {
  baseIdx: number;
  workingIdx: number;
}

/**
 * Indexed LCS for O(1) lookups instead of O(n) array.find()
 */
interface LCSIndex {
  byBaseIdx: Map<number, LCSMatch>;
  workingIdxInLCS: Set<number>;
  // For context anchoring: sorted arrays for binary search
  sortedBaseIndices: number[];
  sortedWorkingIndices: number[];
}

/**
 * Build indexed structures from LCS matches for O(1) lookups
 */
function buildLCSIndex(lcs: LCSMatch[]): LCSIndex {
  const byBaseIdx = new Map<number, LCSMatch>();
  const workingIdxInLCS = new Set<number>();
  const sortedBaseIndices: number[] = [];
  const sortedWorkingIndices: number[] = [];

  for (const match of lcs) {
    byBaseIdx.set(match.baseIdx, match);
    workingIdxInLCS.add(match.workingIdx);
    sortedBaseIndices.push(match.baseIdx);
    sortedWorkingIndices.push(match.workingIdx);
  }

  return {
    byBaseIdx,
    workingIdxInLCS,
    sortedBaseIndices,
    sortedWorkingIndices
  };
}

/**
 * Compute Longest Common Subsequence of lines.
 * Returns array of matching (baseIdx, workingIdx) pairs.
 */
function computeLCS(base: string[], working: string[]): LCSMatch[] {
  const m = base.length;
  const n = working.length;

  // DP table for LCS length
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  // Fill DP table
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (base[i - 1] === working[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to find LCS matches
  const matches: LCSMatch[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (base[i - 1] === working[j - 1]) {
      matches.unshift({ baseIdx: i - 1, workingIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1]![j]! > dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }

  return matches;
}

/**
 * Try to find a modified version of a line in working copy.
 * Handles cases where line content changed but is still "the same line".
 * Uses heuristics: same position or nearby with similar content.
 */
function findModifiedLine(
  baseLine: string,
  working: string[],
  startIdx: number,
  baseIdx: number,
  base: string[],
  lcsIndex: LCSIndex,
  bracketBefore = false,
  bracketAfter = false
): number {
  // Strategy 1: Check if line at same relative position exists and isn't in LCS
  // (meaning it's a modification, not an insertion)
  if (startIdx < working.length) {
    const workingLine = working[startIdx]!;

    // Check if this working line is claimed by LCS - O(1) lookup
    const isInLCS = lcsIndex.workingIdxInLCS.has(startIdx);

    if (!isInLCS) {
      // This working line isn't an exact match with any base line
      // Check similarity - if lines share significant content, treat as modified
      if (isSimilarLine(baseLine, workingLine)) {
        return startIdx;
      }

      // Strategy 2: Context anchoring - if surrounding lines match, this is likely a modification
      // Check if there are LCS matches before and after that bracket this position.
      // A stripped identical prefix/suffix is itself a bracketing match, so
      // it counts even though those lines are no longer in this core's LCS.
      const hasPrevMatch =
        bracketBefore ||
        hasMatchBefore(
          lcsIndex.sortedBaseIndices,
          lcsIndex.sortedWorkingIndices,
          baseIdx,
          startIdx
        );
      const hasNextMatch =
        bracketAfter ||
        hasMatchAfter(
          lcsIndex.sortedBaseIndices,
          lcsIndex.sortedWorkingIndices,
          baseIdx,
          startIdx
        );

      // If we're between two anchored matches, treat as modified line
      if (hasPrevMatch && hasNextMatch) {
        return startIdx;
      }

      // Also handle edge cases: first/last line with context
      if (baseIdx === 0 && hasNextMatch && startIdx === 0) {
        return startIdx;
      }
      if (
        baseIdx === base.length - 1 &&
        hasPrevMatch &&
        startIdx === working.length - 1
      ) {
        return startIdx;
      }
    }
  }

  return -1;
}

/**
 * Check if there's an LCS match before the given indices.
 * LCS matches increase strictly in BOTH coordinates, so the first
 * (smallest) pair is the only candidate - O(1), no scan.
 */
function hasMatchBefore(
  sortedBaseIndices: number[],
  sortedWorkingIndices: number[],
  baseIdx: number,
  workingIdx: number
): boolean {
  return (
    sortedBaseIndices.length > 0 &&
    sortedBaseIndices[0]! < baseIdx &&
    sortedWorkingIndices[0]! < workingIdx
  );
}

/**
 * Check if there's an LCS match after the given indices.
 * By the same monotonicity, only the last (largest) pair can qualify.
 */
function hasMatchAfter(
  sortedBaseIndices: number[],
  sortedWorkingIndices: number[],
  baseIdx: number,
  workingIdx: number
): boolean {
  const last = sortedBaseIndices.length - 1;
  return (
    last >= 0 &&
    sortedBaseIndices[last]! > baseIdx &&
    sortedWorkingIndices[last]! > workingIdx
  );
}

/**
 * Check if two lines are similar enough to be considered "the same line modified".
 * Uses simple heuristic: shared words or similar length with some overlap.
 */
function isSimilarLine(line1: string, line2: string): boolean {
  // Exact match (shouldn't happen if called correctly, but safety check)
  if (line1 === line2) return true;

  // Empty lines
  if (line1.trim() === "" || line2.trim() === "") {
    return line1.trim() === line2.trim();
  }

  // Structural check first: shared prefix/suffix is the common in-line-edit
  // signal and needs no allocation - short-circuit before the word Sets.
  const prefix = commonPrefix(line1, line2);
  const suffix = commonSuffix(line1, line2);
  const minLen = Math.min(line1.length, line2.length);

  if (minLen > 0 && (prefix.length + suffix.length) / minLen > 0.5) {
    return true;
  }

  // Check word overlap (allocates two Sets - only reached when the cheap
  // affix check didn't already decide)
  const words1 = new Set(line1.toLowerCase().split(/\s+/));
  const words2 = new Set(line2.toLowerCase().split(/\s+/));

  let overlap = 0;
  for (const word of words1) {
    if (words2.has(word) && word.length > 2) {
      overlap++;
    }
  }

  // Consider similar if >40% word overlap
  const minWords = Math.min(words1.size, words2.size);
  return minWords > 0 && overlap / minWords > 0.4;
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return a.slice(0, i);
}

function commonSuffix(a: string, b: string): string {
  let i = 0;
  while (
    i < a.length &&
    i < b.length &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  ) {
    i++;
  }
  return a.slice(a.length - i);
}
