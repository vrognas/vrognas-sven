// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as fs from "fs";
import * as path from "path";
import { logError } from "../../util/errorLogger";

/** Polling interval for file size monitoring (ms) */
export const FILE_POLL_INTERVAL_MS = 500;

/** Speed decay factor when no growth detected (0.5 = halve each poll) */
const SPEED_DECAY_FACTOR = 0.5;

/** Max recursion depth for folder counting (prevents stack overflow) */
const MAX_RECURSION_DEPTH = 100;

/** Folder statistics for progress tracking */
interface FolderStats {
  count: number;
  size: number;
}

/**
 * Get file count and total size in a single traversal.
 * Used for size-based progress tracking.
 *
 * Safety features:
 * - Symlink loop detection via visited inode tracking
 * - Max recursion depth limit
 * - Skips symbolic links entirely
 */
function getFolderStats(
  folderPath: string,
  visited = new Set<string>(),
  depth = 0
): FolderStats {
  if (depth > MAX_RECURSION_DEPTH) {
    return { count: 0, size: 0 };
  }

  let count = 0;
  let size = 0;
  try {
    const folderStat = fs.statSync(folderPath);
    const inode = `${folderStat.dev}:${folderStat.ino}`;
    if (visited.has(inode)) {
      return { count: 0, size: 0 };
    }
    visited.add(inode);

    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".svn") continue;
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(folderPath, entry.name);
      if (entry.isDirectory()) {
        const sub = getFolderStats(fullPath, visited, depth + 1);
        count += sub.count;
        size += sub.size;
      } else if (entry.isFile()) {
        try {
          size += fs.statSync(fullPath).size;
          count++;
        } catch {
          // File may have been deleted
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && !err.message.includes("ENOENT")) {
      logError("getFolderStats error", err);
    }
  }
  return { count, size };
}

/**
 * Monitor file size growth during download.
 * Returns cleanup function and getters for speed/size.
 *
 * NOTE: SVN may download to .svn/tmp/ first then rename, so real-time
 * monitoring may not show progress for all files. Works best when SVN
 * writes directly to the target path.
 */
export function createFileSizeMonitor(filePath: string): {
  stop: () => void;
  getSpeed: () => number;
  getSize: () => number;
  isStopped: () => boolean;
} {
  let lastSize = 0;
  let lastTime = Date.now();
  let currentSpeed = 0;
  let currentSize = 0;
  let isFirstPoll = true;
  let stopped = false;

  const poll = () => {
    // Race condition fix: don't poll after stop
    if (stopped) return;

    try {
      const stats = fs.statSync(filePath);
      const now = Date.now();
      const sizeDelta = stats.size - lastSize;
      const timeDelta = (now - lastTime) / 1000;

      if (isFirstPoll) {
        // Skip first measurement to avoid spike when file appears with data
        isFirstPoll = false;
        lastSize = stats.size;
        lastTime = now;
        currentSize = stats.size;
        return;
      }

      if (timeDelta > 0) {
        if (sizeDelta > 0) {
          // File is growing - calculate speed
          currentSpeed = sizeDelta / timeDelta;
        } else {
          // No growth - decay speed toward 0 (indicates stall)
          currentSpeed *= SPEED_DECAY_FACTOR;
          if (currentSpeed < 1024) currentSpeed = 0; // Below 1KB/s = 0
        }
      }

      currentSize = stats.size;
      lastSize = stats.size;
      lastTime = now;
    } catch {
      // File may not exist yet or be locked - ignore
    }
  };

  // Poll immediately (Bug fix: setInterval doesn't run immediately)
  poll();
  const interval = setInterval(poll, FILE_POLL_INTERVAL_MS);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
    getSpeed: () => currentSpeed,
    getSize: () => currentSize,
    isStopped: () => stopped
  };
}

/**
 * Monitor folder download progress by tracking file size.
 * Size-based tracking is more accurate than file count for progress/ETA.
 */
export function createFolderMonitor(
  folderPath: string,
  expectedTotalSize: number,
  expectedFileCount: number
): {
  stop: () => void;
  getProgress: () => number;
  getSize: () => number;
  getFileCount: () => number;
  getSpeed: () => number;
  isStopped: () => boolean;
} {
  let currentStats = { count: 0, size: 0 };
  let stopped = false;
  let lastSize = 0;
  let lastTime = Date.now();
  let smoothedSpeed = 0;

  const poll = () => {
    if (stopped) return;
    currentStats = getFolderStats(folderPath);

    // Calculate smoothed speed
    const now = Date.now();
    const deltaTime = (now - lastTime) / 1000;
    const deltaSize = currentStats.size - lastSize;
    if (deltaTime > 0 && deltaSize > 0) {
      const instantSpeed = deltaSize / deltaTime;
      smoothedSpeed =
        smoothedSpeed === 0
          ? instantSpeed
          : 0.3 * instantSpeed + 0.7 * smoothedSpeed;
    }
    lastSize = currentStats.size;
    lastTime = now;
  };

  // Poll immediately
  poll();
  const interval = setInterval(poll, FILE_POLL_INTERVAL_MS);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
    getProgress: () =>
      expectedTotalSize > 0
        ? Math.min(currentStats.size / expectedTotalSize, 1)
        : expectedFileCount > 0
          ? Math.min(currentStats.count / expectedFileCount, 1)
          : 0,
    getSize: () => currentStats.size,
    getFileCount: () => currentStats.count,
    getSpeed: () => smoothedSpeed,
    isStopped: () => stopped
  };
}
