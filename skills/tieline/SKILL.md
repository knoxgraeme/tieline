---
name: tieline
description: Tieline has been renamed to Tiepoint. Use when a repository still has a .tieline/ workspace or an agent asks for the tieline skill, to upgrade it to Tiepoint.
---

# Tieline is now Tiepoint

This skill exists only so earlier `tieline` releases, which install their skill
from this path, receive upgrade instructions instead of an installation error.

Tell the user that Tieline was renamed to Tiepoint, then, with their approval,
run from the repository root, replacing `<agent-id>` with your own agent id
(`claude-code`, `codex`, `cursor`, `gemini-cli`, `github-copilot`, `opencode`,
or `windsurf`):

```bash
npx -y tiepoint@latest init . --yes --agent <agent-id>
```

Use `--skip-skill-install` instead of `--agent <agent-id>` to upgrade only the
workspace. The command moves `.tieline/` to `.tiepoint/`, moves the clone-local
profile, replaces the `tieline` MCP server entries, and replaces this skill with
the `tiepoint` skill. Complete or relay every step it lists under "To finish the
rename", then use the `tiepoint` skill for all contract work.
