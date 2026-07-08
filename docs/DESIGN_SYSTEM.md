# Sven Design System

Visual and UX patterns for the Sven VS Code extension.

## Color Palette

### File Status Colors (gitDecoration mappings)

| Status                     | Color Variable                                | Visual |
| -------------------------- | --------------------------------------------- | ------ |
| Modified                   | `gitDecoration.modifiedResourceForeground`    | Orange |
| Deleted/Missing            | `gitDecoration.deletedResourceForeground`     | Red    |
| Added/Unversioned/Replaced | `gitDecoration.untrackedResourceForeground`   | Green  |
| Ignored                    | `gitDecoration.ignoredResourceForeground`     | Gray   |
| Conflicted                 | `gitDecoration.conflictingResourceForeground` | Red    |

### Lock Status Colors

| Status     | Color Variable    | Meaning                          |
| ---------- | ----------------- | -------------------------------- |
| K (mine)   | `charts.blue`     | Safe - you own the lock          |
| O (other)  | `charts.orange`   | Blocked - someone else owns lock |
| B (broken) | `errorForeground` | Error - your lock was removed    |
| T (stolen) | `errorForeground` | Error - lock stolen by another   |

### Repository Log Colors

| Badge      | Color Setting                    | Default        |
| ---------- | -------------------------------- | -------------- |
| B (BASE)   | `sven.decorator.baseColor`       | `charts.blue`  |
| S (Server) | `sven.decorator.serverOnlyColor` | `charts.green` |

## Badge System

### Single-Character Badges

| Badge | Status           | Meaning                                 |
| ----- | ---------------- | --------------------------------------- |
| `A`   | Added            | New file added to version control       |
| `M`   | Modified         | File has local changes                  |
| `D`   | Deleted          | File removed (deleted from disk)        |
| `U`   | Untracked        | File removed from SVN but kept locally  |
| `C`   | Conflicted       | Merge conflict needs resolution         |
| `?`   | Unversioned      | File not under version control          |
| `!`   | Missing/Replaced | File missing or replaced without rename |
| `I`   | Ignored          | File matches svn:ignore pattern         |
| `R`   | Renamed          | File was renamed                        |

### Dual-Character Badges (Revision Markers)

| Badge | Meaning                           |
| ----- | --------------------------------- |
| `B`   | BASE revision (your last update)  |
| `S`   | Server-only revision (not synced) |

### Lock Status Badges

| Badge | Meaning             |
| ----- | ------------------- |
| `K`   | Locked by you (Key) |
| `O`   | Locked by Other     |
| `B`   | Lock Broken         |
| `T`   | Lock sTolen         |

### Folder Prefix Convention

Folders use emoji prefix for clarity:

- `📁A` - Added folder
- `📁M` - Modified folder
- `📁D` - Deleted folder
- `📁R` - Renamed folder

## Icon Conventions (Codicons)

### When to Use Which Icon

| Context           | Icon               | Codicon           |
| ----------------- | ------------------ | ----------------- |
| File operations   | $(file)            | `file`            |
| Folder operations | $(folder)          | `folder`          |
| Check/confirm     | $(check)           | `check`           |
| Edit/modify       | $(edit)            | `edit`            |
| History/previous  | $(history)         | `history`         |
| Settings/config   | $(gear)            | `gear`            |
| Lock operations   | $(lock)            | `lock`            |
| Properties        | $(symbol-property) | `symbol-property` |
| Help/info         | $(book)            | `book`            |
| Warning           | $(warning)         | `warning`         |
| Error             | $(error)           | `error`           |

### Command Title Icons

```json
"icon": "$(git-commit)"  // Commit operations
"icon": "$(refresh)"     // Refresh/sync
"icon": "$(cloud-download)" // Download/checkout
"icon": "$(trash)"       // Delete operations
"icon": "$(discard)"     // Revert operations
```

## Dialog Patterns

### When to Use Modal Dialogs

Use `{ modal: true }` only for **destructive** or **irreversible** operations:

✅ **Use modal for:**

- Deleting files from disk (`deleteUnversioned`)
- Breaking/stealing locks (`breakLock`, `stealLock`)
- Removing unversioned files (`removeUnversioned`)
- Rollback to previous revision (`itemlog.rollbackToRevision`)
- Revert changes (`revert`)
- Cleanup operations (`cleanup`)
- Changing checkout depth (`setDepth`)

❌ **Don't use modal for:**

- Empty commit message warning → Use non-modal `showWarningMessage`
- Conflict detection → Use non-modal warning with action buttons
- Pre-commit update prompts → Use settings instead
- Information messages → Use `showInformationMessage`

### Non-Modal Patterns

```typescript
// Good: Non-modal with action buttons
const choice = await window.showWarningMessage(
  "Conflicts detected. Resolve before committing?",
  "Resolve First",
  "Commit Anyway"
);

// Good: Inline validation in InputBox
validateInput: value => {
  if (!value.trim()) {
    return {
      message: "Message required",
      severity: InputBoxValidationSeverity.Error
    };
  }
  return undefined;
};
```

### QuickPick Step Patterns

Multi-step flows should show step indicators:

```typescript
// Good: Step numbers in title
title: "Commit (1/2): Select files";
title: "Commit (2/2): Enter message";
title: "Commit (1/3): Select type";
```

## Error Message Format

### Standard Error Format

```
[Error Code] Brief description. Action suggestion.
```

### With Action Buttons

```typescript
// Pattern: Error message with actionable button
const action = await window.showErrorMessage(
  "Authentication failed (E170001). Clear saved credentials?",
  "Clear Credentials"
);
if (action === "Clear Credentials") {
  await commands.executeCommand("sven.clearCredentials");
}
```

### Error Categories and Actions

| Error Code       | Category      | Action Button       |
| ---------------- | ------------- | ------------------- |
| E170001, E215004 | Auth          | "Clear Credentials" |
| E170013, E175002 | Network       | "Retry"             |
| E200035          | Lock conflict | "Steal Lock"        |
| E200036, E200041 | Lock missing  | "Lock File"         |
| E155004          | Locked file   | "Break Lock"        |
| E195012, E200016 | Conflicts     | "Resolve Conflicts" |

## Terminology Conventions

### SVN Jargon → User-Friendly Names

Always show user-friendly name with SVN term in parentheses:

| SVN Term   | User-Friendly Display         |
| ---------- | ----------------------------- |
| BASE       | "Your Version (BASE)"         |
| HEAD       | "Server Latest (HEAD)"        |
| PREV       | "Previous Revision (PREV)"    |
| EOL        | "Line Ending (EOL)"           |
| MIME       | "File Type (MIME)"            |
| blame      | "Annotations (Blame)"         |
| changelist | "Change Group (Changelist)"   |
| sparse     | "Selective Download (Sparse)" |
| needs-lock | "Require Lock (needs-lock)"   |

### Command Naming Conventions

1. **Ellipsis for dialogs**: Commands opening pickers/dialogs end with `...`
   - ✅ `Merge...`, `Switch Branch...`, `Search History...`
   - ❌ `Merge`, `Switch Branch`, `Search History`

2. **Action verbs**: Use imperative mood
   - ✅ `Show`, `Set`, `Toggle`, `Apply`
   - ❌ `Showing`, `Setting`, `Toggling`

3. **Consistency**: Similar commands use same patterns
   - `Set Line Ending Style (EOL)...`
   - `Set File Type (MIME)...`

## Settings Organization

### Setting Tags

| Tag             | Purpose                       |
| --------------- | ----------------------------- |
| `essential`     | Core functionality settings   |
| `commit`        | Commit-related settings       |
| `workflow`      | Development workflow settings |
| `sourceControl` | Source control view settings  |
| `ui`            | User interface settings       |
| `blame`         | Blame annotation settings     |
| `performance`   | Performance tuning            |
| `advanced`      | Power user settings           |

### Setting Order

Settings are ordered by importance (lower = more important):

- `order: 2-10` - Essential settings
- `order: 10-20` - Commit settings
- `order: 20-30` - Source control settings
- `order: 30-40` - Blame settings
- `order: 100+` - Advanced/decorator settings
