# Sven - Subversion for VS Code & Positron

![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/vrognas/vrognas-sven/main.yml)
![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/vrognas.sven)
![GitHub License](https://img.shields.io/github/license/vrognas/vrognas-sven)

Git-like SVN experience with staging, inline blame, file locking, and sparse checkout. Zero telemetry.

**Note:** This extension is in active development. Stable for daily use, but expect occasional breaking changes — please [report issues](https://github.com/vrognas/vrognas-sven/issues).

> **Requires:** [SVN](https://subversion.apache.org) installed. Windows users: enable **Command Line Tools** when installing [TortoiseSVN](https://tortoisesvn.net/).

## Why Sven?

| Pain Point | Sven Solution |
|------------|---------------|
| SVN has no staging | Git-like stage → commit workflow |
| "Who wrote this line?" | Inline blame annotations (GitLens-style) |
| Binary file conflicts | File locking with visual indicators |
| Giant repos are slow | Sparse checkout - download only what you need |
| Clunky diff tools | Beyond Compare, Meld, any external tool |

## Quick Start

**Install:** search **Sven** (publisher `vrognas`) in the Extensions view — available on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vrognas.sven) and [Open VSX](https://open-vsx.org/extension/vrognas/sven) (Positron installs from Open VSX).

**Open existing repo:** File → Open Folder → select folder with `.svn`

**Checkout new repo:** `Ctrl+Shift+P` → **SVN: Checkout** → enter URL → choose folder

**Guided tour:** `Ctrl+Shift+P` → **Welcome: Open Walkthrough** → *Getting Started with SVN* (4 more walkthroughs cover the daily workflow, history, large repos, and locking)

**Daily workflow:**
```
1. Make changes        → Files appear in "Changes"
2. Click + to stage    → Files move to "Staged for Commit"
3. Ctrl+Enter          → Commit staged files
```

> In Positron, commit via `Ctrl+Shift+P` → **SVN: Commit Staged** (the commit-box `Ctrl+Enter` shortcut is VS Code-only — see [Positron notes](docs/POSITRON_SCM_LIMITATIONS.md)).

## Features

### Staging

Stage files before commit - no more accidental commits.

| Action | How |
|--------|-----|
| Stage | `+` button or right-click |
| Unstage | `-` button |
| Commit | `Ctrl+Enter` |

### Blame Annotations

See who changed each line, when, and why.

- **Gutter**: Colored revision indicators
- **Inline**: Author + date at line end
- **Hover**: Revision and author details

Toggle: `Ctrl+Shift+P` → **SVN Blame: Toggle Annotations (Blame)**

### Repository History

Browse commits with file changes and diffs.

- **Repo History** view: Full commit log with filtering (author, date, text)
- **File History** view: per-file revisions, follows the active editor automatically
- **B badge**: Your BASE revision
- Explorer rename/delete auto-converts to `svn move`/`svn delete` (preserves history)

### File Locking

Prevent conflicts on binary files (CSVs, images, models).

| Badge | Meaning |
|-------|---------|
| `K` | Locked by you |
| `O` | Locked by someone else |

Status bar shows `$(unlock) N` when N files need locking.

Setup: right-click file → **SVN Properties** → **Toggle Require Lock (needs-lock)**

Commands: **Lock**, **Unlock**, **Steal Lock**, **Break Lock**

[Full locking guide →](docs/FILE_LOCKING.md)

### Sparse Checkout

Download only specific folders from large repos.

1. Open **Selective Download** panel in SCM sidebar
2. Click ghost folders to download
3. Choose depth: Full, Shallow, Files Only, Folder Only

## How To

| Task | How |
|------|-----|
| Compare with server | Right-click → **Open Changes with HEAD (Server Latest)** |
| Resolve conflicts | Fix markers in file → right-click file in Source Control → **Resolve conflicts for selected** |
| Switch branches | `Ctrl+Shift+P` → **SVN: Switch Branch** |
| Create patch | Right-click files → **Show Changes (Patch) for Selected** |
| Set line endings | Right-click → **SVN Properties** → **Set Line Ending Style (EOL)** |
| Ignore files | Right-click → **Add to Ignore List (svn:ignore)** |
| External diff | Set `sven.diff.tool` to tool path |
| Merge branches | `Ctrl+Shift+P` → **SVN: Merge** |
| Cleanup | `Ctrl+Shift+P` → **SVN: Cleanup** |

## Configuration

### Settings

Open Settings (`Ctrl+,`) and search `sven`.

| Setting | Default | What it does |
|---------|---------|--------------|
| `sven.blame.autoBlame` | `true` | Show blame when opening files |
| `sven.blame.csvLineLimit` | `500` | Skip blame for CSV-like files over this line count |
| `sven.commit.types` | `[]` | Custom commit types for guided flow |
| `sven.commit.autoUpdate` | `both` | Run update before/after commit (`both`/`before`/`after`/`none`) |
| `sven.diff.tool` | `null` | External diff tool path |
| `sven.diff.csvSizeLimitMB` | `1` | Prompt before diffing CSV-like files over this size |
| `sven.remoteChanges.checkFrequency` | `300` | Remote check interval (seconds) |
| `sven.sourceControl.hideUnversioned` | `false` | Hide unversioned files |
| `sven.log.length` | `50` | Commits shown in history |

[All 80 settings →](docs/SETTINGS.md)

### Troubleshooting

**"SVN not found"** → Set `sven.path` to full SVN path (e.g., `/usr/bin/svn`)

**Password prompts loop** → Set `sven.auth.credentialMode` to `extensionStorage`, restart

**Slow on large repos** → Enable sparse checkout, reduce `sven.log.length`

Still stuck? [Open an issue →](https://github.com/vrognas/vrognas-sven/issues)

## More Info

**Positron IDE:** Fully supported — SCM views, blame, history, and the Connections pane (repositories appear with branch/revision/quick actions) work out of the box. Known platform limitations are documented in [Positron notes](docs/POSITRON_SCM_LIMITATIONS.md); integration details in [Positron guide](docs/POSITRON_INTEGRATION.md).

**Links:**
[Settings](docs/SETTINGS.md) ·
[Security](.github/SECURITY.md) ·
[File Locking](docs/FILE_LOCKING.md) ·
[Contributing](CONTRIBUTING.md) ·
[Changelog](CHANGELOG.md) ·
[Issues](https://github.com/vrognas/vrognas-sven/issues)

---

Forked from [JohnstonCode/svn-scm](https://github.com/JohnstonCode/svn-scm)
