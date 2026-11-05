# dsh-project-sources

[![npm version](https://img.shields.io/npm/v/dsh-project-sources.svg)](https://www.npmjs.com/package/dsh-project-sources)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文](README.zh.md) | **English**

> Codex-style project sources for DeepSeek Harness: one workspace, many folders, each with an alias the agent can use.

A DeepSeek Harness plugin bundle that attaches extra folders to a workspace. The session keeps the workspace as its `cwd`; every attached folder gets the **same read / write / edit / command permissions** under the session's current sandbox mode, and each one carries a short **alias** the model can refer to.

- **Project editor** — “编辑项目” dialog from the session header, or the “📁 项目源文件夹” pill on the session-creation page. Add folders, rename aliases, remove them.
- **Aliases in the conversation** — one system-prompt section maps every alias to its absolute path, so `@web/src/a.ts` is unambiguous to the model.
- **`@` menu coverage** — the shipped `@` provider is single-root; this plugin contributes a companion group that searches every source (by alias, by folder name, or by absolute path).
- **Source-folder skills** — `/` finds skills under `<source>/.dsh/skills`, `<source>/.agents/skills` and `<source>/skills`, recursively.
- **No new tools** — `read`/`glob`/`grep` already work anywhere; `write`/`edit`/`pwsh`/`bash` are intercepted and re-rooted at the matching source.

## Requirements

- DeepSeek Harness **0.2.1-rc.5 … 0.2.x** (`engines.dsh: ^0.2.1-rc.5`)
- Node.js ≥ 20

## Install

From the Web UI: **Settings → Plugins → Add**, then paste `dsh-project-sources`.

From the CLI:

```bash
dsh plugin --profile <profile> add dsh-project-sources@0.1.0
```

Or from a local checkout (the agent tool `plugin_manager` accepts a directory):

```text
plugin_manager install_bundle   target: D:\work\dsh-project-sources
```

Restart the Host after a source change (the Host module is imported at boot); the browser bundle reloads on a page refresh.

## Usage

| Action | Where |
| --- | --- |
| Edit the project | “项目” button in the session header |
| Edit before the first message | “📁 项目源文件夹” above the composer on the session-creation page |
| Add a folder | Click “添加文件夹” → the OS folder chooser opens |
| Rename | Type in the alias field of a row |
| Remove | `×` on the row (the workspace itself cannot be removed) |

Aliases must be letters/digits/`.`/`_`/`-`, at most 48 characters; duplicates get a `-2` suffix.

## Where it stores data

`<DSH_HOME>/storages/project-sources/<workspace-key>.json` — one record per workspace, outside every agent sandbox root. Only user-driven flows write it; the agent cannot add folders to itself.

## Platforms

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Folder chooser | `powershell -STA` + `FolderBrowserDialog` | `osascript … choose folder` | falls back to the Host picker, then the manual path field |

The sandbox re-rooting, `@` menu and skill discovery are platform-neutral. macOS support is implemented but not yet tested on a Mac.

## Limitations

- **One writable root per command.** A shell run writes inside only the directory its `workdir` resolves to. Pass an **absolute** `workdir` inside the source; a relative one resolves against the workspace, and `git -C <source>` / `cd <source>` inside the command does not widen the root.
- The session `cwd` is fixed: there is no “primary folder” concept, and the workspace root stays the default working directory.
- Cannot run beside another plugin that intercepts the same tool pipeline (e.g. `dsh-multi-folder`).
- Background shell runs are supported through the jobs runtime, but a denial that happens after the call returns is only visible in `job_output`.

## Development

No build step. `npm test` runs both suites without the DSH runtime:

```bash
node test/smoke.mjs   # config store, interception, prompt, remote API
node test/skills.mjs  # source-folder skill discovery
```

## Acknowledgements

The tool-interception and sandbox re-rooting approach follows
[dsh-multi-folder](https://github.com/AngelosZou/dsh-multi-folder) by Yutong Zou
(MIT). See `NOTICE`.

## License

MIT