# Settings Reference

All configuration options for Sven. Open Settings (`Ctrl+,`) and search `sven`.

---

## Core

| Setting            | Default | Description                  |
| ------------------ | ------- | ---------------------------- |
| `sven.path`        | `null`  | Path to SVN executable       |
| `sven.autorefresh` | `true`  | Auto-refresh on file changes |
| `sven.showOutput`  | `false` | Show output panel on startup |

## Commit

| Setting                           | Default | Description                                      |
| --------------------------------- | ------- | ------------------------------------------------ |
| `sven.commit.useQuickPick`        | `true`  | Multi-step quick-pick commit dialog              |
| `sven.commit.types`               | `[]`    | Custom commit types (type picker when non-empty) |
| `sven.commit.autoUpdate`          | `both`  | Update timing: `both`, `before`, `after`, `none` |
| `sven.commit.checkEmptyMessage`   | `true`  | Warn on empty message                            |
| `sven.commit.changes.selectedAll` | `true`  | Select all by default                            |

## Source Control UI

| Setting                                          | Default                | Description                       |
| ------------------------------------------------ | ---------------------- | --------------------------------- |
| `sven.sourceControl.changesLeftClick`            | `open diff`            | Click action: `open`, `open diff` |
| `sven.sourceControl.countUnversioned`            | `true`                 | Include unversioned in badge      |
| `sven.sourceControl.hideUnversioned`             | `false`                | Hide unversioned files            |
| `sven.sourceControl.ignore`                      | `[]`                   | Glob patterns to hide             |
| `sven.sourceControl.ignoreOnCommit`              | `["ignore-on-commit"]` | Excluded changelists              |
| `sven.sourceControl.ignoreOnStatusCount`         | `["ignore-on-commit"]` | Changelists excluded from badge   |
| `sven.sourceControl.combineExternalIfSameServer` | `false`                | Combine externals                 |

## Blame

### Master Settings

| Setting                             | Default           | Description                         |
| ----------------------------------- | ----------------- | ----------------------------------- |
| `sven.blame.enabled`                | `true`            | Master toggle for blame             |
| `sven.blame.autoBlame`              | `true`            | Auto-show when opening files        |
| `sven.blame.enableLogs`             | `true`            | Fetch commit messages for tooltips  |
| `sven.blame.dateFormat`             | `relative`        | Date format: `relative`, `absolute` |
| `sven.blame.showWorkingCopyChanges` | `true`            | Highlight uncommitted changes       |
| `sven.blame.largeFileWarning`       | `true`            | Warn for large files                |
| `sven.blame.largeFileLimit`         | `3000`            | Line threshold for warning (0 off)  |
| `sven.blame.csvExtensions`          | `[".csv",".tsv"]` | Extensions treated as CSV-like      |
| `sven.blame.csvLineLimit`           | `500`             | Line limit for CSV-like files       |

### Gutter

| Setting                        | Default                             | Description            |
| ------------------------------ | ----------------------------------- | ---------------------- |
| `sven.blame.gutter.enabled`    | `true`                              | Show gutter indicators |
| `sven.blame.gutter.showIcons`  | `true`                              | Show colored icons     |
| `sven.blame.gutter.showText`   | `false`                             | Show author/date text  |
| `sven.blame.gutter.template`   | `"${author} (${revision}) ${date}"` | Gutter text template   |
| `sven.blame.gutter.dateFormat` | `relative`                          | Date format            |

### Inline Annotations

| Setting                             | Default                                              | Description                     |
| ----------------------------------- | ---------------------------------------------------- | ------------------------------- |
| `sven.blame.inline.enabled`         | `true`                                               | Show inline annotations         |
| `sven.blame.inline.currentLineOnly` | `true`                                               | Only on current line            |
| `sven.blame.inline.showMessage`     | `false`                                              | Include commit message (slower) |
| `sven.blame.inline.opacity`         | `0.5`                                                | Transparency (0.0-1.0)          |
| `sven.blame.inline.template`        | `"  ${author}, ${date} (r${revision}) • ${message}"` | Template                        |

### Status Bar

| Setting                         | Default                                                | Description              |
| ------------------------------- | ------------------------------------------------------ | ------------------------ |
| `sven.blame.statusBar.enabled`  | `true`                                                 | Show blame in status bar |
| `sven.blame.statusBar.template` | `"$(person) ${author}, $(clock) ${date} - ${message}"` | Template                 |

### Template Placeholders

Use in `template` settings: `${author}`, `${date}`, `${revision}`, `${message}`

## Sparse Checkout

| Setting                              | Default | Description                          |
| ------------------------------------ | ------- | ------------------------------------ |
| `sven.sparse.confirmExclude`         | `true`  | Confirm before excluding             |
| `sven.sparse.largeFileWarningMb`     | `10`    | Warn for large downloads (MB, 0 off) |
| `sven.sparse.downloadTimeoutMinutes` | `10`    | Timeout for downloads                |
| `sven.sparse.preScanTimeoutSeconds`  | `30`    | Timeout for size estimation          |

## Remote Changes

| Setting                             | Default | Description                            |
| ----------------------------------- | ------- | -------------------------------------- |
| `sven.remoteChanges.checkFrequency` | `300`   | Check interval (seconds, 0 to disable) |
| `sven.refresh.remoteChanges`        | `false` | Include remote in Refresh              |

## Update

| Setting                       | Default | Description              |
| ----------------------------- | ------- | ------------------------ |
| `sven.update.ignoreExternals` | `true`  | Skip externals           |
| `sven.showUpdateMessage`      | `true`  | Show update notification |

## Diff

| Setting                    | Default           | Description                             |
| -------------------------- | ----------------- | --------------------------------------- |
| `sven.diff.withHead`       | `true`            | Compare with HEAD (vs BASE)             |
| `sven.diff.tool`           | `null`            | External diff tool path                 |
| `sven.diff.csvExtensions`  | `[".csv",".tsv"]` | Extensions treated as CSV-like          |
| `sven.diff.csvSizeLimitMB` | `1`               | Size limit (MB) before CSV diff prompts |

## History/Log

| Setting                    | Default | Description                       |
| -------------------------- | ------- | --------------------------------- |
| `sven.log.length`          | `50`    | Commits to show                   |
| `sven.log.authorColors`    | `true`  | Colored author dots               |
| `sven.previousCommitsUser` | `null`  | Filter history to user (SVN 1.8+) |

## Delete Handling

| Setting                                   | Default  | Description                        |
| ----------------------------------------- | -------- | ---------------------------------- |
| `sven.delete.actionForDeletedFiles`       | `remove` | Action: `none`, `prompt`, `remove` |
| `sven.delete.ignoredRulesForDeletedFiles` | `[]`     | Patterns to ignore                 |

## Conflicts

| Setting                      | Default | Description                     |
| ---------------------------- | ------- | ------------------------------- |
| `sven.conflicts.autoResolve` | `false` | Auto-mark resolved after fixing |

## Authentication

| Setting                    | Default | Description                                                    |
| -------------------------- | ------- | -------------------------------------------------------------- |
| `sven.auth.credentialMode` | `auto`  | Storage: `auto`, `systemKeyring`, `extensionStorage`, `prompt` |
| `sven.auth.commandTimeout` | `60`    | Command timeout (seconds)                                      |

## Repository Layout

| Setting                         | Default                  | Description              |
| ------------------------------- | ------------------------ | ------------------------ |
| `sven.layout.trunkRegex`        | `(trunk)(/.*)?`          | Trunk detection          |
| `sven.layout.branchesRegex`     | `branches/([^/]+)(/.*)?` | Branch detection         |
| `sven.layout.tagsRegex`         | `tags/([^/]+)(/.*)?`     | Tag detection            |
| `sven.layout.showFullName`      | `true`                   | Show full path in names  |
| `sven.layout.trunkRegexName`    | `1`                      | Capture group for trunk  |
| `sven.layout.branchesRegexName` | `1`                      | Capture group for branch |
| `sven.layout.tagRegexName`      | `1`                      | Capture group for tag    |

## Multi-Folder / Monorepo

| Setting                        | Default                                              | Description               |
| ------------------------------ | ---------------------------------------------------- | ------------------------- |
| `sven.multipleFolders.enabled` | `false`                                              | Scan subfolders for repos |
| `sven.multipleFolders.depth`   | `4`                                                  | Max scan depth            |
| `sven.multipleFolders.ignore`  | `["**/.git","**/.hg","**/vendor","**/node_modules"]` | Skip folders              |

## Performance

| Setting                       | Default  | Description                                        |
| ----------------------------- | -------- | -------------------------------------------------- |
| `sven.performance.maxXmlTags` | `500000` | Max XML tags to parse (raise for 100k+ file repos) |

## Detection

| Setting                | Default | Description          |
| ---------------------- | ------- | -------------------- |
| `sven.detectExternals` | `true`  | Detect svn:externals |
| `sven.detectIgnored`   | `true`  | Scan ignored folders |

## Checkout

| Setting                         | Default | Description               |
| ------------------------------- | ------- | ------------------------- |
| `sven.defaultCheckoutDirectory` | `null`  | Default checkout location |

## Encoding

| Setting                               | Default | Description                           |
| ------------------------------------- | ------- | ------------------------------------- |
| `sven.default.encoding`               | `null`  | Force encoding (e.g., `windows-1252`) |
| `sven.experimental.detect_encoding`   | `false` | Auto-detect encoding                  |
| `sven.experimental.encoding_priority` | `[]`    | Encoding detection priority           |

## Warnings

| Setting                          | Default | Description                  |
| -------------------------------- | ------- | ---------------------------- |
| `sven.ignoreMissingSvnWarning`   | `false` | Suppress missing SVN warning |
| `sven.ignoreWorkingCopyIsTooOld` | `false` | Suppress upgrade warning     |
| `sven.ignoreRepositories`        | `null`  | List of repos to ignore      |

## Debug

| Setting                          | Default | Description                             |
| -------------------------------- | ------- | --------------------------------------- |
| `sven.debug.disableSanitization` | `false` | ⚠️ Exposes credentials in logs          |
| `sven.output.authLogging`        | `once`  | Auth logging: `once`, `always`, `never` |

---

## Decorators

| Setting                          | Default        | Description                      |
| -------------------------------- | -------------- | -------------------------------- |
| `sven.decorator.baseColor`       | `charts.blue`  | Color for BASE badge (B) in log  |
| `sven.decorator.serverOnlyColor` | `charts.green` | Color for server-only badges (S) |
