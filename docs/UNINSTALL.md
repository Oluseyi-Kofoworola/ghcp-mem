<div align="center">

# 🗑️ Uninstalling Baton

### A complete clean-removal guide — extension, data, and injected files

</div>

---

## 1. Export your memory (optional but recommended)

Before removing anything, preserve your sessions if you want to re-import them later or share them as a Memory Pack.

**Full backup:**
```
Ctrl+Shift+P → Baton: Export Memory to JSON...
```
Save the file somewhere outside the VS Code extensions folder.

**Selective pack:**
```
Ctrl+Shift+P → Baton: Export Memory Pack...
```
Filter by tag, type, or date to keep only what matters.

---

## 2. Clear stored data from VS Code global state

Baton stores all sessions in VS Code's `globalState`. Run this before uninstalling so the storage is cleanly released:

```
Ctrl+Shift+P → Baton: Clear All Stored Context
```

Confirm when prompted. The Sessions sidebar will empty immediately.

> [!TIP]
> If you skip this step the `globalState` entries will remain as orphaned keys. They are harmless, but clearing first is cleaner.

---

## 3. Remove the extension from VS Code

### Via the Extensions sidebar

1. Open the Extensions sidebar (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Search for **Baton**
3. Click the gear icon → **Uninstall**
4. Reload VS Code when prompted

### Via the Command Palette

```
Ctrl+Shift+P → Extensions: Show Installed Extensions
```
Find Baton → gear → Uninstall.

### Via the terminal

```bash
code --uninstall-extension ITcredibl.baton-mem
```

---

## 4. Delete the mirror file

Baton mirrors sessions to a local JSON file for MCP client access:

| OS | Path |
|---|---|
| macOS / Linux | `~/.baton-mem/sessions.json` |
| Windows | `%USERPROFILE%\.baton-mem\sessions.json` |

Delete it and the directory:

```bash
# macOS / Linux
rm -rf ~/.baton-mem

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:USERPROFILE\.baton-mem"
```

---

## 5. Remove the workspace instruction file

Baton writes a context-injection file to your workspace:

```
.github/instructions/session-memory.instructions.md
```

It is automatically excluded from git by an entry Baton adds to `.gitignore`. To fully clean up:

```bash
# From the workspace root
rm .github/instructions/session-memory.instructions.md
```

If the `.github/instructions/` directory is now empty, you can remove it too:

```bash
rmdir .github/instructions   # macOS / Linux
```

Also remove the `.gitignore` entry Baton added (look for a block beginning with `# baton-mem`).

---

## 6. Remove cross-editor injection files (if present)

If Baton injected context into Claude or Cursor, remove those files:

```bash
# Claude Code
rm CLAUDE.md            # or just remove the baton-mem block inside it

# Cursor
rm .cursor/rules/baton-mem.md
```

Both files are hash-guarded so Baton will not re-create them after uninstall.

---

## 7. Remove MCP client config entries (if configured)

If you wired Baton into an external MCP client (Cursor, Cline, Windsurf, Claude Desktop), remove the entry from your client's `mcp.json`:

```json
// Remove the block that looks like this:
{
  "baton-mem": {
    "command": "node",
    "args": ["<path-to-extension>/out/mcpServer.js"]
  }
}
```

Run **`Baton: Show External MCP Client Config`** before uninstalling to see which files were configured on your machine.

---

## 8. Verify clean removal

After completing the steps above:

- ✅ Sessions sidebar is gone from the Activity Bar
- ✅ `~/.baton-mem/` directory no longer exists
- ✅ `.github/instructions/session-memory.instructions.md` is removed
- ✅ No `Baton` entries in `Ctrl+Shift+P` autocomplete

---

## Reinstalling

If you want to reinstall and start fresh:

```bash
code --install-extension ITcredibl.baton-mem
```

To restore a previous backup:

```
Ctrl+Shift+P → Baton: Import Memory from JSON...
```

Or to share a curated set with your team:

```
Ctrl+Shift+P → Baton: Import Memory Pack...
```

---

<div align="center">

[← Back to README](../README.md) · [Demo walkthrough](DEMO.md) · [Report an issue](https://github.com/ITcredibl/baton-mem/issues)

</div>
