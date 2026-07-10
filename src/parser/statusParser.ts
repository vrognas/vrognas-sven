// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { parseXml } from "./xmlParserAdapter";
import { IEntry, IFileStatus, IWcStatus, LockStatus } from "../common/types";

function processEntry(
  entry: IEntry | IEntry[],
  changelist?: string
): IFileStatus[] {
  if (Array.isArray(entry)) {
    const list: IFileStatus[] = [];
    entry.forEach((e: IEntry) => {
      const r = processEntry(e, changelist);
      if (r) {
        list.push(...r);
      }
    });
    return list;
  }

  // Validate entry structure before accessing properties
  if (
    !entry ||
    typeof entry !== "object" ||
    !entry.path ||
    !entry.wcStatus ||
    typeof entry.wcStatus !== "object" ||
    !entry.wcStatus.item
  ) {
    return [];
  }

  // Extract lock owner from repos-status if available (server lock info)
  let lockOwner: string | undefined;
  const serverChecked = !!entry.reposStatus;
  const serverHasLock = !!entry.reposStatus?.lock;

  let serverLockOwner: string | undefined;
  let serverLockToken: string | undefined;
  if (serverHasLock) {
    const lock = entry.reposStatus!.lock as Record<string, unknown>;
    if (lock.owner && typeof lock.owner === "string") {
      serverLockOwner = lock.owner;
    }
    if (lock.token && typeof lock.token === "string") {
      serverLockToken = lock.token;
    }
    // The server lock is the CURRENT one - its owner outranks our
    // (possibly stale) local token owner
    lockOwner = serverLockOwner;
  }

  // Check for local lock token:
  // 1. wcStatus.lock element = we have a lock token for this file
  // 2. wcStatus.wcLocked = working copy is administratively locked (different thing)
  // The presence of wcStatus.lock means WE have a lock token (K status)
  const hasLockToken = !!entry.wcStatus.lock;
  const wcLockOwner = entry.wcStatus.lock?.owner;
  const wcLockToken = entry.wcStatus.lock?.token;

  // Local token owner only when the server gave us nothing better
  if (hasLockToken && !lockOwner && wcLockOwner) {
    lockOwner = wcLockOwner;
  }

  // Compute lock status: K, O, B, T
  let lockStatus: LockStatus | undefined;
  if (hasLockToken) {
    if (serverChecked && !serverHasLock) {
      // We have token but server shows no lock - broken
      lockStatus = LockStatus.B;
    } else if (
      serverChecked &&
      serverHasLock &&
      ((serverLockToken && wcLockToken && serverLockToken !== wcLockToken) ||
        (serverLockOwner && wcLockOwner && serverLockOwner !== wcLockOwner))
    ) {
      // Our token is stale: the server lock belongs to someone else.
      // lockOwner already names the thief (server owner outranks ours).
      lockStatus = LockStatus.T;
    } else {
      // No server check, or the server confirms our lock
      lockStatus = LockStatus.K;
    }
  } else if (serverHasLock) {
    // We don't have token but server has lock - locked by other
    lockStatus = LockStatus.O;
  }

  // WC admin lock is from wc-locked="true" attribute (needs cleanup, different from user locks)
  const wcAdminLocked =
    !!entry.wcStatus.wcLocked && entry.wcStatus.wcLocked === "true";

  const wcStatus: IWcStatus = {
    locked: hasLockToken || serverHasLock,
    wcAdminLocked,
    switched: !!entry.wcStatus.switched && entry.wcStatus.switched === "true",
    lockOwner,
    hasLockToken,
    serverChecked,
    lockStatus
  };

  const r: IFileStatus = {
    changelist,
    path: entry.path,
    kind: entry.kind,
    status: entry.wcStatus.item,
    props: entry.wcStatus.props,
    wcStatus,
    reposStatus: entry.reposStatus
  };

  if (entry.wcStatus.movedTo && r.status === "deleted") {
    return [];
  }
  if (
    entry.wcStatus.movedFrom &&
    (r.status === "added" || r.status === "replaced")
  ) {
    r.rename = entry.wcStatus.movedFrom;
  }
  if (entry.wcStatus.commit) {
    r.commit = {
      revision: entry.wcStatus.commit.revision,
      author: entry.wcStatus.commit.author,
      date: entry.wcStatus.commit.date
    };
  }

  return [r];
}

function xmlToStatus(xml: Record<string, unknown>) {
  const statusList: IFileStatus[] = [];
  if (xml.target && typeof xml.target === "object") {
    const target = xml.target as Record<string, unknown>;
    if (target.entry) {
      statusList.push(...processEntry(target.entry as IEntry | IEntry[]));
    }
  }

  if (xml.changelist) {
    let changelists = xml.changelist;
    if (!Array.isArray(changelists)) {
      changelists = [changelists];
    }

    // Validate each changelist item has expected structure before processing
    for (const change of changelists as unknown[]) {
      if (
        change &&
        typeof change === "object" &&
        "entry" in change &&
        "name" in change &&
        typeof (change as { name: unknown }).name === "string"
      ) {
        const validChange = change as {
          entry: IEntry | IEntry[];
          name: string;
        };
        statusList.push(...processEntry(validChange.entry, validChange.name));
      }
    }
  }

  return statusList;
}

export function parseStatusXml(content: string): Promise<IFileStatus[]> {
  return parseXml(
    content,
    (parsed: unknown) => xmlToStatus(parsed as Record<string, unknown>),
    "status"
  );
}
