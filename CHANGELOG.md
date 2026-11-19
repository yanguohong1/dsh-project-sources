# Changelog

## 0.1.1 — 2026-11-19

- Apply Git ignore rules to `@` filename search in the workspace and attached sources, without a separate search-limit bundle.

## 0.1.0 — 2026-11-05

Initial release.

### Added

- Codex-style project sources: attach folders to a workspace, each with an
  editable alias; the workspace root stays the session `cwd`.
- Sandbox re-rooting for `write` / `edit` / `pwsh` / `bash`, so every source
  gets the session's current mode (read-only still denies, workspace-write
  allows).
- Project editor: session-header button + session-creation dock entry; native
  folder chooser on Windows (PowerShell) and macOS (osascript), falling back to
  the Host picker and then a manual path field.
- Alias → absolute path mapping injected into the system prompt.
- Companion `@` menu group: source folders by alias or folder name, nested
  levels by `alias/…` or absolute path.
- Source-folder skills: recursive discovery under `<source>/.dsh/skills`,
  `<source>/.agents/skills` and `<source>/skills`.
- Sessionless `projectSources/*` remote API (`get`, `set`, `listFiles`, `pick`).
- Mock-runtime tests for the Host half (`test/smoke.mjs`, `test/skills.mjs`).