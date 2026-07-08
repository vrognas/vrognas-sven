# File Locking Guide

Prevent conflicts on binary files (CSVs, images, models) that can't be merged.

## How It Works

SVN file locking ensures only one person can edit a file at a time:

1. Mark files with `svn:needs-lock` property
2. Files start read-only
3. Lock before editing → file becomes writable
4. Commit and unlock → others can now lock

## Setup

Set the `svn:needs-lock` property on files that require locking:

```bash
# Single file
svn propset svn:needs-lock '*' path/to/file.xlsx

# All Excel files recursively
svn propset svn:needs-lock '*' -R --targets <(find . -name "*.xlsx")
```

Or in VS Code: right-click file → **SVN Properties** → **Toggle Require Lock (needs-lock)**

## Commands

| Command                                   | Use Case                       |
| ----------------------------------------- | ------------------------------ |
| **Lock**                                  | Claim exclusive edit rights    |
| **Unlock**                                | Release when done              |
| **Manage Locks** (lock status bar)        | View all locked files          |
| **Manage Needs-Lock** (unlock status bar) | View files requiring lock      |
| **Break Lock**                            | Admin override (use carefully) |
| **Steal Lock**                            | Take lock from someone else    |

## Visual Indicators

### File Badges

| Badge | Meaning                                 |
| ----- | --------------------------------------- |
| `K`   | Locked by you (you hold the lock token) |
| `O`   | Locked by someone else                  |
| `B`   | Lock broken                             |
| `T`   | Lock stolen                             |

Needs-lock files have no badge - shown in tooltip and status bar count instead.

### Status Bar

When locks exist, the status bar shows counts:

- Lock icon with number = files currently locked
- Unlock icon with number = files that need lock before editing

Click the status bar items to manage locks.

## Best Practices

1. **Lock just before editing** - Don't lock files you're not actively working on
2. **Unlock promptly** - Release locks when done to avoid blocking others
3. **Communicate** - If you need to break someone's lock, let them know
4. **Use for binary files** - Text files can be merged; binary files cannot

## Troubleshooting

**"File is locked by another user"**

- Check who has the lock: click the lock status bar item (**Manage Locks**)
- Contact the lock owner or use **Break Lock** (admin only)

**"File is read-only"**

- The file has `svn:needs-lock` - lock it before editing
- Right-click → **Lock**

**Lock not showing in status bar**

- Status bar only appears when count > 0
- Run **Refresh** to update lock status from server
