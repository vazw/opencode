# Custom Permission Fix (Maintained in Fork)

This fork maintains a fix for the "absolute glob rows inert" bug in the permission system.
The fix is in `packages/core/src/permission.ts` and `packages/core/src/instructions/builtins.ts`.

### Permission Relativization Fix (`packages/core/src/permission.ts`)

**Problem:** Agent frontmatter absolute globs (e.g., `/home/user/.config/opencode/**`) never matched in-cwd targets because `FileAccess.resolve` relativizes internal paths before the anchored-regex matcher runs.

**Fix:** Canonicalize both target and rule resources to absolute form inside `Permission.Service` evaluation:
- Added `absolutizeResource` helper in `Permission.Service` layer
- Applies to both `denied()` and `evaluateInput()` before `evaluate(findLast)`
- Universal `"*"` stays universal; absolute paths pass through; relatives join against `location.directory`
- Free `Permission.evaluate` unchanged (pure, location-free)
- `relevant()`, `BlockedError.rules`, and hook payloads keep authored forms

**Test Coverage:** 7 new service-level tests in `packages/core/test/permission.test.ts` covering:
- Internal target + absolute allow → allow
- Internal target unmatched → floor deny
- External target + absolute allow → allow (regression)
- Global floor absolute rule + internal target → allow
- Plan agent inside/outside plan dir
- Universal `"*"` still matches absolutized external target
- Relative rule absolutized consistently

### Environment Instruction Fix (`packages/core/src/instructions/builtins.ts`)

**Problem:** The `core/environment` instruction told agents to prefer `${global.tmp}` (`/tmp/opencode/`) over `/tmp/`, but:
- This conflicts with fleet SOP which uses `<project-root>/.tmp/` as primary scratch
- Config denies `/tmp/*` (including `/tmp/opencode/`)
- Agent grids with absolute allow rows couldn't match in-cwd targets

**Fix:** Updated `core/environment` instruction in `packages/core/src/instructions/builtins.ts`:
- **Before:** `Prefer ${global.tmp} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`
- **After:** `Prefer ${location.directory}/.tmp/ over generic system temporary directories such as /tmp/; it is the project-local scratch root, pre-created and approved for external access.`

Test updated in `packages/core/test/instructions/builtins.test.ts`.

### Test Commands
```bash
# Run permission tests
cd packages/core && bun test test/permission.test.ts

# Run instruction tests
cd packages/core && bun test test/instructions/builtins.test.ts

# Full test suite
cd packages/core && bun test test/permission.test.ts test/plugin/plan.test.ts test/agent.test.ts test/config/agent.test.ts test/instructions/

# Repo-wide check
bun run check
```

### Build
```bash
cd packages/cli && bun run script/build.ts --target=opencode-linux-x64 --outdir=dist
```
