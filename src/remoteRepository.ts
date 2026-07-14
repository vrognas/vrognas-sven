// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { Uri } from "vscode";
import type { ISvnInfo, ISvnLogEntry } from "./common/types";
import type { IHistoryFilter } from "./historyView/historyFilter";
import { PathNormalizer } from "./pathNormalizer";
import type { Svn } from "./svn";
import type { Repository as BaseRepository } from "./svnRepository";

export interface IRemoteRepository {
  branchRoot: Uri;

  getPathNormalizer(): PathNormalizer;

  log(
    rfrom: string,
    rto: string,
    limit: number,
    target?: string | Uri,
    pegRevision?: string
  ): Promise<ISvnLogEntry[]>;

  logWithFilter(
    filter: IHistoryFilter,
    limit: number,
    target?: string | Uri
  ): Promise<ISvnLogEntry[]>;

  show(
    filePath: string | Uri,
    revision?: string,
    pegRevision?: string
  ): Promise<string>;

  clearLogCache(): void;

  rollbackToRevision(filePath: string, targetRevision: string): Promise<string>;

  patchRevision(revision: string, url: Uri): Promise<string>;

  revert(files: string[]): Promise<string>;
}

export class RemoteRepository implements IRemoteRepository {
  private info: ISvnInfo;
  private constructor(private repo: BaseRepository) {
    this.info = repo.info;
  }

  public static async open(svn: Svn, uri: Uri): Promise<RemoteRepository> {
    const repo = await svn.open(uri.toString(true), "");
    return new RemoteRepository(repo);
  }

  public getPathNormalizer(): PathNormalizer {
    return new PathNormalizer(this.info);
  }

  public get branchRoot(): Uri {
    return Uri.parse(this.info.url);
  }

  public async log(
    rfrom: string,
    rto: string,
    limit: number,
    target?: string | Uri,
    pegRevision?: string
  ): Promise<ISvnLogEntry[]> {
    return this.repo.log(rfrom, rto, limit, target, pegRevision);
  }

  public async logWithFilter(
    filter: IHistoryFilter,
    limit: number,
    target?: string | Uri
  ): Promise<ISvnLogEntry[]> {
    return this.repo.logWithFilter(filter, limit, target);
  }

  public async show(
    filePath: string | Uri,
    revision?: string,
    pegRevision?: string
  ): Promise<string> {
    return this.repo.show(filePath, revision, pegRevision);
  }

  public clearLogCache(): void {
    this.repo.clearLogCache();
  }

  public async rollbackToRevision(
    filePath: string,
    targetRevision: string
  ): Promise<string> {
    return this.repo.rollbackToRevision(filePath, targetRevision);
  }

  public async patchRevision(revision: string, url: Uri): Promise<string> {
    return this.repo.patchRevision(revision, url);
  }

  public async revert(files: string[]): Promise<string> {
    return this.repo.revert(files, "empty");
  }
}
