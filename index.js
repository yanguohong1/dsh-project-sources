/**
 * dsh-project-sources — host half.
 *
 * Codex-style project sources for one DSH workspace:
 *
 * 1. A per-workspace project record (`<DSH_HOME>/storages/project-sources/
 *    <workspace-key>.json`) lists the workspace itself plus any number of
 *    extra source folders, each with a user-editable ALIAS. The store lives
 *    outside every agent sandbox root and is only written from user-driven
 *    flows (the project editor / the remote endpoints).
 * 2. Every source shares the session's sandbox mode through per-call policy
 *    re-rooting: `write`/`edit`/`pwsh`/`bash` calls whose target path (or
 *    resolved `workdir`) lands inside a source run with
 *    `{ ...standingPolicy, workspaceRoot: <source> }`, exactly like the
 *    primary workspace. `read`/`glob`/`grep` need no help (reads are not
 *    fenced). No new tools are added.
 * 3. One ordered system-prompt section maps every alias to its absolute
 *    path, so `@web/src/a.ts` in a message is unambiguous to the model.
 * 4. A sessionless `projectSources/*` remote API serves the editor from a
 *    session AND from the session-creation page (where no session exists):
 *    `get`, `set`, `listFiles`, `browse`.
 * 5. `listFiles` feeds the client's companion `@` menu group, which is the
 *    only way to discover files outside the single-rooted shipped `@`
 *    provider.
 *
 * The interception shape follows dsh-multi-folder (MIT, AngelosZou); this
 * bundle keeps the re-rooting idea and replaces its directory list with
 * aliased project sources.
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { gitFileSearch } from './lib/git-files.js'

export const name = 'dsh-project-sources'
export const inject = ['fs', 'sandboxPolicy', 'systemPrompt']

/** Host-owned store, outside every agent sandbox root. */
const configDir = () => join(process.env.DSH_HOME || join(os.homedir(), '.dsh'), 'storages', 'project-sources')
const configFileName = (ws) => String(ws).replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') + '.json'
const configPathFor = (ws) => join(configDir(), configFileName(ws))

const SECTION_NAME = 'project-sources'
/** Tool-guidance sections use 100–129; this one sits after them. */
const SECTION_ORDER = 161
const INTERCEPT_TOOLS = new Set(['write', 'edit', 'pwsh', 'bash'])
/** Aliases are labels the model reads: letters/digits/._-, no spaces, no separators. */
const ALIAS_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,47}$/u
const MAX_SOURCES = 32

/** Same stable key for paths spelled with either separator. */
const wsKey = (p) => String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
const slashed = (p) => String(p).replace(/\\/g, '/')
const isAbsolute = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
const pathInside = (p, root) => {
  const P = wsKey(p)
  const R = wsKey(root)
  return P === R || P.startsWith(R + '/')
}
const longestRootFirst = (roots) => [...roots].sort((a, b) => b.length - a.length)
const lastSegment = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'source'

/** Default alias for a folder: its basename, reduced to an acceptable label. */
const defaultAliasFor = (p) => {
  const cleaned = lastSegment(p)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 40)
  return ALIAS_RE.test(cleaned) ? cleaned : 'source'
}

const cleanAlias = (raw) => {
  const text = String(raw ?? '').trim().replace(/^@+/, '').trim()
  return ALIAS_RE.test(text) ? text : null
}

/** First free alias based on `desired` (case-insensitive), suffixing -2, -3 … */
const uniqueAlias = (desired, taken) => {
  const base = ALIAS_RE.test(desired) ? desired : 'source'
  let candidate = base
  let n = 1
  while (taken.has(candidate.toLowerCase())) {
    n += 1
    candidate = base.slice(0, 40) + '-' + n
  }
  taken.add(candidate.toLowerCase())
  return candidate
}

const cleanName = (raw) => {
  if (typeof raw !== 'string') return null
  const text = raw.trim().replace(/\s+/g, ' ')
  return text.length === 0 ? null : text.slice(0, 80)
}

export function apply(ctx) {
  const { fs, sandboxPolicy, systemPrompt } = ctx
  // `shell`, `shellEnv` and `jobs` are resolved per call on purpose: loader
  // rows activate in dependency order, and this row declares no hard
  // dependency on them.

  /** wsKey(workspace) -> project record */
  const projects = new Map()
  /** wsKey(workspace) -> { at, rootKey, entries } */
  const indexCache = new Map()
  const gitFiles = gitFileSearch()
  ctx.effect(() => gitFiles.dispose, 'project-sources: Git file index')

  ctx.inject(['fileReferences', 'workingDirectory'], (scope) => {
    const service = scope.fileReferences
    const original = service.list
    const own = Object.getOwnPropertyDescriptor(service, 'list')
    // The Host RPC reads this method on each call. Leave its service, session
    // candidates and path browsing intact; restore the method on unload.
    async function list(agent, query, signal) {
      if (query && !/[/\\]/.test(query)) {
        const root = await scope.workingDirectory.ensure(agent, signal)
        const hits = await gitFiles.list(root, query, 20, signal)
        if (hits !== null) return hits
      }
      return Reflect.apply(original, this, [agent, query, signal])
    }
    scope.effect(() => {
      Object.defineProperty(service, 'list', { value: list, configurable: true, writable: true })
      return () => {
        if (Object.getOwnPropertyDescriptor(service, 'list')?.value !== list) return
        if (own) Object.defineProperty(service, 'list', own)
        else delete service.list
      }
    }, 'project-sources: Git file references')
  })

  // ----------------------------------------------------------- normalizing
  /**
   * Turn whatever is on disk into a valid project: absolute sources only,
   * workspace always present and first, unique aliases, primary among the
   * sources. Tolerant on purpose — a half-written or hand-edited file must
   * never make the plugin unusable.
   */
  function normalizeProject(ws, raw) {
    const sources = []
    const seen = new Set()
    const push = (path, alias) => {
      if (typeof path !== 'string' || !isAbsolute(path)) return
      const key = wsKey(path)
      if (seen.has(key)) return
      seen.add(key)
      sources.push({ path, alias })
    }
    if (raw && Array.isArray(raw.sources)) {
      for (const item of raw.sources) {
        if (typeof item === 'string') push(item, '')
        else if (item && typeof item.path === 'string') push(item.path, item.alias)
      }
    }
    if (!seen.has(wsKey(ws))) sources.unshift({ path: ws, alias: defaultAliasFor(ws) })

    const taken = new Set()
    for (const source of sources) {
      const wanted = cleanAlias(source.alias) ?? defaultAliasFor(source.path)
      source.alias = uniqueAlias(wanted, taken)
    }

    // The primary source is always the workspace itself: a session's cwd is
    // fixed, so a "main folder" picked among the extras would claim a meaning
    // this plugin cannot honor.
    const workspaceSource = sources.find((source) => wsKey(source.path) === wsKey(ws))

    return {
      workspace: ws,
      name: cleanName(raw?.name) ?? defaultAliasFor(ws),
      primary: workspaceSource === undefined ? ws : workspaceSource.path,
      sources,
    }
  }

  async function loadProject(ws) {
    if (typeof ws !== 'string' || ws.length === 0) return null
    const key = wsKey(ws)
    const cached = projects.get(key)
    if (cached !== undefined) return cached
    let raw = null
    try {
      const target = await fs.resolve(configPathFor(ws))
      raw = JSON.parse(await fs.readText(target))
    } catch {
      // absent or unreadable config -> the workspace alone
    }
    const project = normalizeProject(ws, raw)
    projects.set(key, project)
    return project
  }

  function hydrate(ws) {
    if (typeof ws === 'string' && ws.length > 0) void loadProject(ws)
  }

  function projectForSync(ws) {
    if (typeof ws !== 'string' || ws.length === 0) return null
    return projects.get(wsKey(ws)) ?? null
  }

  async function saveProject(project) {
    const body = {
      name: project.name,
      primary: project.primary,
      sources: project.sources.map((source) => ({ path: source.path, alias: source.alias })),
    }
    const content = JSON.stringify(body, null, 2) + '\n'
    const target = await fs.resolve(configPathFor(project.workspace))
    // The store lives outside every agent sandbox root, so the explicit
    // policy is rooted at the config directory itself.
    await fs.writeText(target, content, undefined, undefined, {
      mode: 'workspace-write',
      workspaceRoot: configDir(),
    })
    projects.set(wsKey(project.workspace), project)
    invalidateSkills()
  }

  /** The client-facing view: workspace first, flags materialized. */
  const viewOf = (project) => ({
    workspace: project.workspace,
    name: project.name,
    primary: project.primary,
    sources: project.sources.map((source) => ({
      path: source.path,
      alias: source.alias,
      isWorkspace: wsKey(source.path) === wsKey(project.workspace),
      isPrimary: wsKey(source.path) === wsKey(project.primary),
    })),
  })

  const coreGet = async (ws) => {
    const project = await loadProject(ws)
    if (project === null) throw new Error('get requires an absolute workspace path')
    return viewOf(project)
  }

  /**
   * Replace one workspace's project record. Every path is canonicalized and
   * must name an existing directory; the workspace itself can never be
   * dropped. This is the only write path, shared by the editor.
   */
  const coreSet = async (ws, payload) => {
    if (typeof ws !== 'string' || ws.length === 0 || !isAbsolute(ws)) {
      throw new Error('set requires an absolute workspace path')
    }
    const requested = payload && Array.isArray(payload.sources) ? payload.sources : []
    if (requested.length > MAX_SOURCES) throw new Error('too many source folders (max ' + MAX_SOURCES + ')')

    const canonical = []
    const seen = new Set()
    for (const item of requested) {
      const path = typeof item === 'string' ? item : item && typeof item.path === 'string' ? item.path : null
      if (path === null || path.trim().length === 0) continue
      if (!isAbsolute(path)) throw new Error('source folder must be an absolute path: ' + path)
      let target
      try {
        target = await fs.resolve(path.trim())
      } catch (error) {
        throw new Error('cannot resolve source folder "' + path + '": ' + String(error?.message ?? error))
      }
      const abs = fs.processPath(target)
      const key = wsKey(abs)
      if (seen.has(key)) continue
      const info = await fs.stat(target)
      if (info === undefined) throw new Error('source folder does not exist: ' + abs)
      if (info.type !== 'directory') throw new Error('source is not a folder: ' + abs)
      seen.add(key)
      canonical.push({ path: abs, alias: typeof item.alias === 'string' ? item.alias : '' })
    }

    if (!seen.has(wsKey(ws))) {
      let workspaceAbs = ws
      try {
        workspaceAbs = fs.processPath(await fs.resolve(ws))
      } catch {
        // keep the spelling we were handed
      }
      canonical.unshift({ path: workspaceAbs, alias: defaultAliasFor(workspaceAbs) })
    }

    const taken = new Set()
    for (const source of canonical) {
      const wanted = cleanAlias(source.alias) ?? defaultAliasFor(source.path)
      source.alias = uniqueAlias(wanted, taken)
    }

    const workspacePath = canonical.find((source) => wsKey(source.path) === wsKey(ws))?.path ?? ws

    const project = {
      workspace: workspacePath,
      name: cleanName(payload?.name) ?? defaultAliasFor(ws),
      primary: workspacePath,
      sources: canonical,
    }
    await saveProject(project)
    indexCache.delete(wsKey(project.workspace))
    return viewOf(project)
  }

  // ------------------------------------------------ @ discovery (listFiles)
  // The native group owns workspace-relative matches. The companion group
  // adds source aliases, absolute paths and bare matches in attached folders.

  const MAX_LEVEL_ENTRIES = 400
  const MAX_INDEX_ENTRIES = 4000
  const INDEX_TTL_MS = 4000
  const INDEX_EXCLUDED = new Set([
    '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt',
    '.cache', '.venv', 'venv', '__pycache__', '.pytest_cache', '.gradle', 'target',
    'bin', 'obj', '.idea', '.vscode', 'coverage', '.turbo',
  ])

  /** Breadth-first bounded index for attached folders without Git. */
  async function indexFor(project, sources) {
    const key = wsKey(project.workspace)
    const rootKey = JSON.stringify(sources.map(({ path, alias }) => [path, alias]))
    const cached = indexCache.get(key)
    const now = Date.now()
    if (cached !== undefined && cached.rootKey === rootKey && now - cached.at < INDEX_TTL_MS) {
      return cached.entries
    }
    const entries = []
    const seen = new Set()
    const queue = sources.map((source) => ({ source, dir: source.path, rel: '' }))
    while (queue.length > 0 && entries.length < MAX_INDEX_ENTRIES) {
      const level = queue.shift()
      let dirTarget
      try {
        dirTarget = await fs.resolve(level.dir)
      } catch {
        continue
      }
      const canonicalDir = wsKey(fs.processPath(dirTarget))
      if (seen.has(canonicalDir)) continue
      seen.add(canonicalDir)
      let children
      try {
        children = await fs.listDir(dirTarget)
      } catch {
        continue
      }
      for (const child of children ?? []) {
        if (child === null || child === undefined) continue
        const childName = String(child.name)
        const kind = child.type === 'directory' ? 'directory' : child.type === 'file' ? 'file' : null
        if (kind === null) continue
        if (kind === 'directory' && INDEX_EXCLUDED.has(childName)) continue
        const rel = level.rel === '' ? childName : level.rel + '/' + childName
        entries.push({
          alias: level.source.alias,
          dir: level.source.path,
          rel,
          kind,
          path: slashed(level.source.path.replace(/[\\/]+$/, '') + '/' + rel),
          hidden: childName.startsWith('.'),
        })
        if (entries.length >= MAX_INDEX_ENTRIES) break
        if (kind === 'directory') {
          queue.push({ source: level.source, dir: slashed(level.source.path.replace(/[\\/]+$/, '') + '/' + rel), rel })
        }
      }
    }
    indexCache.set(key, { at: now, rootKey, entries })
    return entries
  }

  /** Directory children of one level inside one source, filtered by fragment. */
  async function listLevel(project, source, rest) {
    const normalized = rest.replace(/^\/+/, '')
    // `..` would escape the source while still claiming its alias.
    if (normalized.split('/').some((segment) => segment === '..')) return { candidates: [], truncated: false }
    const slash = normalized.lastIndexOf('/')
    const level = slash < 0 ? '' : normalized.slice(0, slash + 1)
    const fragment = slash < 0 ? normalized : normalized.slice(slash + 1)
    const dirPath = slashed(source.path.replace(/[\\/]+$/, '') + (level === '' ? '' : '/' + level.replace(/\/+$/, '')))
    let target
    try {
      target = await fs.resolve(dirPath)
    } catch {
      return { candidates: [], truncated: false }
    }
    let children
    try {
      children = await fs.listDir(target)
    } catch {
      return { candidates: [], truncated: false }
    }
    const shown = []
    for (const child of children ?? []) {
      const childName = String(child.name)
      if (fragment !== '' && !childName.toLowerCase().includes(fragment.toLowerCase())) continue
      const kind = child.type === 'directory' ? 'directory' : child.type === 'file' ? 'file' : null
      if (kind === null) continue
      if (kind === 'directory' && INDEX_EXCLUDED.has(childName)) continue
      if (childName.startsWith('.') && !fragment.startsWith('.')) continue
      const rel = level + childName
      shown.push({
        alias: source.alias,
        dir: source.path,
        rel,
        kind,
        path: slashed(source.path.replace(/[\\/]+$/, '') + '/' + rel),
      })
    }
    shown.sort((a, b) => (a.kind === b.kind ? a.rel.localeCompare(b.rel) : a.kind === 'directory' ? -1 : 1))
    const truncated = shown.length > MAX_LEVEL_ENTRIES
    return { candidates: truncated ? shown.slice(0, MAX_LEVEL_ENTRIES) : shown, truncated }
  }

  const rankEntries = (entries, fragment) => {
    const needle = fragment.toLowerCase()
    const scored = []
    for (const entry of entries) {
      const rel = String(entry.rel)
      const name = lastSegment(rel)
      const nameHit = name.toLowerCase().indexOf(needle)
      const relHit = rel.toLowerCase().indexOf(needle)
      if (nameHit < 0 && relHit < 0) continue
      // Name beats path; directories win ties; then shallower, then alphabetical.
      const score = (nameHit >= 0 ? 0 : 1000) + (entry.kind === 'directory' ? 0 : 10) + (nameHit >= 0 ? nameHit : relHit) + rel.length / 1000
      scored.push({ entry, score })
    }
    scored.sort((a, b) => a.score - b.score)
    return scored.map((item) => item.entry)
  }

  /**
   * Candidates for one `@` query. Accepts three spellings: an empty query
   * (the sources themselves — the menu's entry points), `alias/relative`
   * (alias-keyed, what the panel shows), and an absolute path inside a
   * source (what a directory drill inserts). A bare fragment fuzzy-ranks the
   * whole index.
   */
  const coreListFiles = async (ws, query, signal) => {
    if (typeof ws !== 'string' || !isAbsolute(ws)) throw new Error('listFiles requires an absolute workspace path')
    signal?.throwIfAborted()
    const project = await loadProject(ws)
    if (project === null) throw new Error('listFiles requires an absolute workspace path')
    const sources = project.sources
    const out = {
      workspace: project.workspace,
      sources: sources.map((source) => ({
        path: source.path,
        alias: source.alias,
        isWorkspace: wsKey(source.path) === wsKey(project.workspace),
      })),
      candidates: [],
      truncated: false,
    }
    const q = String(query ?? '').replace(/\\/g, '/').trim()
    if (q === '') {
      out.candidates = sources.map((source) => ({
        alias: source.alias,
        dir: source.path,
        rel: '',
        kind: 'directory',
        path: slashed(source.path),
      }))
      return out
    }

    // Absolute spelling: a drill inserted one, or the user typed it.
    if (isAbsolute(q)) {
      const hit = longestRootFirst(sources.map((source) => source.path)).find((root) => pathInside(q, root))
      if (hit !== undefined) {
        const source = sources.find((candidate) => wsKey(candidate.path) === wsKey(hit))
        const rest = slashed(q).slice(slashed(hit).length)
        const level = await listLevel(project, source, rest)
        out.candidates = level.candidates
        out.truncated = level.truncated
        return out
      }
      return out
    }

    // A source answers to its alias AND to its folder name, so a query typed
    // from the real directory (`@koa-…`) works beside the alias (`@数据表1`).
    const sourceKeys = (source) => [String(source.alias).toLowerCase(), lastSegment(source.path).toLowerCase()]
    const firstSlash = q.indexOf('/')
    const first = firstSlash < 0 ? q : q.slice(0, firstSlash)
    const needle = first.toLowerCase()
    let source = sources.find((candidate) => sourceKeys(candidate).includes(needle))
    let ambiguous = null
    if (source === undefined) {
      const near = sources.filter((candidate) => sourceKeys(candidate).some((key) => key.startsWith(needle)))
      if (near.length === 1) source = near[0]
      else if (near.length > 1) ambiguous = near
    }
    if (ambiguous !== null) {
      // The prefix names several sources: offer them instead of guessing.
      out.candidates = ambiguous.map((candidate) => ({
        alias: candidate.alias,
        dir: candidate.path,
        rel: '',
        kind: 'directory',
        path: slashed(candidate.path),
      }))
      return out
    }
    if (source !== undefined) {
      // Bare alias (`@ws`) offers the folder itself so the row can drill into
      // it; `@ws/…` is already inside it and lists that level.
      if (firstSlash < 0) {
        out.candidates = [{ alias: source.alias, dir: source.path, rel: '', kind: 'directory', path: slashed(source.path) }]
        return out
      }
      const level = await listLevel(project, source, q.slice(firstSlash + 1))
      out.candidates = level.candidates
      out.truncated = level.truncated
      return out
    }

    // Bare fragment: the source folders the query names come first as entry
    // points, then the files inside every source that match.
    const fragment = q.toLowerCase()
    const folderRows =
      firstSlash < 0
        ? sources
            .filter((candidate) => wsKey(candidate.path) !== wsKey(project.workspace))
            .filter(
              (candidate) =>
                sourceKeys(candidate).some((key) => key.includes(fragment)) ||
                slashed(candidate.path).toLowerCase().includes(fragment),
            )
            .map((candidate) => ({
              alias: candidate.alias,
              dir: candidate.path,
              rel: '',
              kind: 'directory',
              path: slashed(candidate.path),
            }))
        : []

    const attached = sources.filter((source) => wsKey(source.path) !== wsKey(project.workspace))
    const matching = await Promise.all(attached.map((source) =>
      gitFiles.list(source.path, q, MAX_LEVEL_ENTRIES, signal).catch((error) => {
        signal?.throwIfAborted()
        ctx.logger?.warn('project-sources: Git file search failed: %s', error.message)
        return []
      }),
    ))
    const plain = attached.filter((source, i) => matching[i] === null && !pathInside(source.path, project.workspace))
    const gitRows = attached.flatMap(({ alias, path: dir }, i) => (matching[i] ?? []).map(({ path: rel, kind }) =>
      ({ alias, dir, rel, kind, path: slashed(join(dir, rel)) }),
    ))
    const index = plain.length === 0 ? [] : await indexFor(project, plain)
    const visible = q.startsWith('.') ? index : index.filter((entry) => !entry.rel.split('/').some((segment) => segment.startsWith('.')))
    const workspacePath = slashed(project.workspace).replace(/\/+$/, '')
    const overlap = gitRows.some(({ path }) => pathInside(path, workspacePath))
    const nativePaths = overlap ? await gitFiles.paths(project.workspace, signal).catch(() => null) : null
    signal?.throwIfAborted()
    const seen = new Set()
    const rows = folderRows.concat(rankEntries(visible.concat(gitRows), q)).filter(({ path, rel }) => {
      const key = wsKey(path)
      if (seen.has(key) || (rel !== '' && pathInside(path, workspacePath) && nativePaths?.has(path.slice(workspacePath.length + 1)))) return false
      seen.add(key)
      return true
    })
    out.truncated = rows.length > MAX_LEVEL_ENTRIES
    out.candidates = rows.slice(0, MAX_LEVEL_ENTRIES)
    return out
  }

  // ----------------------------------------------- sessionless remote API
  // `projectSources/*` endpoints over the Typert gateway, keyed by workspace
  // PATH (not session id), so the project editor works on the
  // session-creation page where no session exists yet.

  const remoteErrorMessage = (e) => 'project-sources: ' + String(e?.message ?? e).replace(/^project-sources:\s*/, '')

  /** The bundled Windows folder chooser. */
  const pickerScript = () => join(dirname(fileURLToPath(import.meta.url)), 'lib', 'native-picker.ps1')

  /**
   * Run one chooser process to completion. Resolves `{ code, stdout, stderr }`
   * and rejects on spawn failure, caller cancellation, or the 10-minute
   * deadline, so a dead chooser can never hang the editor.
   */
  const runChooser = (command, args, signal) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let settled = false
      let timer = null
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        if (signal !== undefined && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort)
        }
        fn(value)
      }
      const onAbort = () => {
        try {
          child.kill()
        } catch {
          // already gone
        }
        finish(reject, new Error('the folder chooser was cancelled'))
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort)
      }
      timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // already gone
        }
        finish(reject, new Error('the folder chooser timed out'))
      }, 10 * 60 * 1000)
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.on('error', (error) => finish(reject, error))
      child.on('close', (code) => finish(resolve, { code, stdout, stderr }))
    })

  /** Windows: FolderBrowserDialog on an STA thread (lib/native-picker.ps1). */
  const pickViaWindowsDialog = async (signal) => {
    const result = await runChooser(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', pickerScript()],
      signal,
    )
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'the folder chooser exited with code ' + result.code)
    const picked = result.stdout.trim()
    return picked.length > 0 ? picked : null
  }

  /** macOS: Standard Additions `choose folder`, printed as a POSIX path. */
  const pickViaMacDialog = async (signal) => {
    const result = await runChooser(
      'osascript',
      ['-e', 'POSIX path of (choose folder with prompt "选择一个文件夹作为项目源")'],
      signal,
    )
    if (result.code === 0) {
      const picked = result.stdout.trim()
      return picked.length > 0 ? picked : null
    }
    // AppleScript reports a dismissed dialog as -128 ("User canceled").
    if (/-128|user canceled/i.test(result.stderr)) return null
    throw new Error(result.stderr.trim() || 'the folder chooser exited with code ' + result.code)
  }

  /**
   * Open the host's own folder chooser for the editor's "添加文件夹" row.
   * `via` tells the client which interaction it may offer next:
   * - `native`    — an OS dialog answered; `path` is the selection or null on cancel.
   * - `browse`    — the composition only provides browse primitives, so the
   *                 client should fall back to its manual path field.
   * - `unavailable` — neither is composed.
   */
  const corePick = async (signal) => {
    signal?.throwIfAborted?.()
    const dialogDisabled = process.env.DSH_PROJECT_SOURCES_NO_DIALOG === '1'
    if (!dialogDisabled && (process.platform === 'win32' || process.platform === 'darwin')) {
      try {
        const path =
          process.platform === 'win32' ? await pickViaWindowsDialog(signal) : await pickViaMacDialog(signal)
        return { path, via: 'native' }
      } catch (error) {
        if (signal?.aborted) throw new Error('the folder chooser was cancelled')
        // No usable window session or no chooser binary: fall through to the
        // composition's own chooser below.
      }
    }
    const picker = ctx.get('directoryPicker')
    if (picker !== undefined && typeof picker.capability === 'function') {
      let capability = null
      try {
        capability = picker.capability()
      } catch {
        capability = null
      }
      if (capability !== null && capability.kind === 'native' && typeof capability.pick === 'function') {
        const path = await capability.pick(signal)
        return { path: typeof path === 'string' && path.length > 0 ? path : null, via: 'native' }
      }
      if (capability !== null && capability.kind === 'browse') return { path: null, via: 'browse' }
    }
    const controller = ctx.get('directoryPickerController')
    if (controller !== undefined && typeof controller.pick === 'function') {
      try {
        const path = await controller.pick(signal)
        return { path: typeof path === 'string' && path.length > 0 ? path : null, via: 'native' }
      } catch {
        return { path: null, via: 'unavailable' }
      }
    }
    return { path: null, via: 'unavailable' }
  }

  const api = {
    async get(workspace) {
      try {
        return await coreGet(workspace)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async set(workspace, payload) {
      try {
        return await coreSet(workspace, payload)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async listFiles(workspace, query, signal) {
      try {
        return await coreListFiles(workspace, query, signal)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async pick(signal) {
      try {
        return await corePick(signal)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
  }

  Object.defineProperty(api, 'typertRemote', {
    value: Object.freeze({ service: api, serviceKey: 'projectSources', namespace: 'projectSources' }),
  })

  const remoteParam = (paramName) => ({ name: paramName, wire: paramName, source: 'json', codec: { mode: 'src-json' } })
  const remoteInvocation = (method, params) => ({
    id: 'dsh-project-sources#projectSources/' + method,
    service: 'projectSources',
    namespace: 'projectSources',
    method,
    invocation: { kind: 'direct' },
    parameters: params.map(remoteParam),
    result: { mode: 'src-json' },
  })
  const REMOTE_CONTRIBUTION = {
    package: name,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      remoteInvocation('get', ['workspace']),
      remoteInvocation('set', ['workspace', 'payload']),
      { ...remoteInvocation('listFiles', ['workspace', 'query']), cancellation: { parameter: 'signal' } },
      { ...remoteInvocation('pick', []), cancellation: { parameter: 'signal' } },
    ],
  }

  // ------------------------------------------------------- prompt section
  systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      const ws = context?.agent?.session?.header?.cwd
      const project = projectForSync(typeof ws === 'string' ? ws : null)
      if (project === null) return ''
      const extra = project.sources.filter((source) => wsKey(source.path) !== wsKey(project.workspace))
      if (extra.length === 0) return ''
      const lines = [
        'Project "' + project.name + '" has source folders beyond the workspace root (dsh-project-sources).',
        'Sources and their aliases:',
        ...project.sources.map(
          (source) =>
            '- ' +
            source.alias +
            ' = ' +
            source.path +
            (wsKey(source.path) === wsKey(project.workspace) ? ' (the workspace root)' : ''),
        ),
        'Aliases are shortcuts in this conversation: `@' + extra[0].alias + '/some/file` means `' + extra[0].path + '/some/file`.',
        'Every source has the same read/write/edit and command-execution permissions as the workspace root under the current sandbox mode. Reads (read/glob/grep) work with absolute paths.',
        'Shell rule: each command can write inside only ONE root — the directory its `workdir` resolves to. Pass an ABSOLUTE `workdir` inside the source folder. A relative `workdir` resolves against the workspace root, never against a source, and `git -C <source>` / `cd <source>` inside the command does NOT widen the writable root: such writes fail with an OS-level access denial instead of a sandbox marker.',
        'The workspace root remains the default working directory.',
      ]
      return lines.join('\n')
    },
  })

  // ------------------------------------------------------------ interception
  const shellUsesExecute = (shell) => shell !== undefined && typeof shell.execute === 'function'

  const shellRender = (value) => {
    let text = value.stdout && typeof value.stdout.text === 'string' ? value.stdout.text : ''
    if (value.stderr && typeof value.stderr.text === 'string' && value.stderr.text.length > 0) {
      text += text.endsWith('\n') ? '' : '\n'
      text += value.stderr.text
    }
    if (value.exitCode !== 0) {
      text += text.endsWith('\n') ? '' : '\n'
      text += '[exit code: ' + value.exitCode + ']'
    }
    if (value.sandbox && value.sandbox.denied) {
      text += '\n[sandbox: file access denied under ' + value.sandbox.mode + ' mode]'
    }
    return text
  }

  const processOutcome = (proc) => {
    if (proc.status === 'killed') {
      return {
        status: 'killed',
        detail: proc.signal !== null && proc.signal !== undefined ? 'signal: ' + proc.signal : 'killed before exit',
      }
    }
    return {
      status: 'completed',
      detail: 'exit code: ' + (proc.exitCode === undefined || proc.exitCode === null ? 0 : proc.exitCode),
    }
  }

  /** One consuming background read shaped for `job_output`. */
  const renderProcessRead = (read, sandbox) => {
    const notices = []
    if (read.lossy) {
      const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path) => path !== undefined)
      notices.push(
        '[some output was dropped from memory; full output: ' +
          (paths.length > 0 ? paths.join(', ') : '(unavailable)') +
          ']',
      )
    }
    if (sandbox && sandbox.runnerFailed) {
      notices.push(
        '[sandbox: the sandbox runner itself failed under ' + sandbox.mode +
          ' mode — the command did not run; this is a sandbox problem, not a command failure]',
      )
    } else if (sandbox && sandbox.denied) {
      notices.push('[sandbox: file access denied under ' + sandbox.mode + ' mode]')
    }
    if (notices.length === 0) return read.delta
    return read.delta + (read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : '') + notices.join('\n')
  }

  /**
   * Adapt one asynchronous background launch to the jobs runtime's
   * synchronous hooks contract, exactly like the shipped pwsh/bash tools.
   */
  const startBackgroundJob = (shell, request) => {
    const controller = new AbortController()
    const modern = shellUsesExecute(shell)
    let proc
    const done = (async () => {
      try {
        const spec = shell.resolve({
          ...request,
          signal: controller.signal,
          ...(modern ? { onExpiry: 'none' } : {}),
        })
        proc = modern ? await shell.execute(spec) : await shell.start(spec)
        try {
          if (controller.signal.aborted) proc.kill()
        } finally {
          await proc.done
        }
        return processOutcome(proc)
      } catch (error) {
        return {
          status: controller.signal.aborted && proc === undefined ? 'killed' : 'failed',
          detail: error && error.message !== undefined ? String(error.message) : String(error),
        }
      }
    })()
    return {
      cancel: (reason) => {
        if (controller.signal.aborted) return
        controller.abort(reason)
        if (proc !== undefined) proc.kill()
      },
      done,
      readOutput: () => (proc === undefined ? '' : renderProcessRead(proc.readOutput(), proc.sandbox)),
    }
  }

  /**
   * Error envelope for a call the interception OWNS: never handed back to the
   * default pipeline, which fences against the PRIMARY workspace root and
   * would turn any ordinary failure into a spurious sandbox denial.
   */
  const ownedFailure = (error, policy) => {
    const code = error && typeof error.code === 'string' && error.code.length > 0 ? error.code : undefined
    const message =
      code === 'FS_SANDBOX_DENIED'
        ? '[sandbox: file access denied under ' + policy.mode + ' mode]\n' +
          '[sandbox: escalation available — retry this exact operation once with sandbox_permissions ' +
          '(the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'
        : String(error?.message ?? error)
    return {
      isError: true,
      error: { message, ...(code === undefined ? {} : { info: { code } }) },
      content: [{ type: 'text', text: 'Error: ' + message }],
    }
  }

  ctx.on('tools/execute', async (exec, next) => {
    const headerCwd = exec?.agent?.session?.header?.cwd
    // AWAITED, not fire-and-forget: a call that arrives before the config
    // read resolves would see an empty cache, fall through, and be fenced
    // against the primary workspace root.
    if (typeof headerCwd === 'string' && headerCwd.length > 0) await loadProject(headerCwd)
    if (!INTERCEPT_TOOLS.has(exec.name)) return next()

    let owned = null
    try {
      const args = exec.arguments
      const standing = sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
      const primary = standing.workspaceRoot
      // An explicit escalation request belongs to the default pipeline, which
      // owns the approval flow.
      if (args && typeof args.sandbox_permissions === 'string' && args.sandbox_permissions.length > 0) return next()

      const project = projectForSync(primary) ?? projectForSync(headerCwd)
      if (project === null) return next()
      const extraRoots = project.sources
        .map((source) => source.path)
        .filter((path) => wsKey(path) !== wsKey(primary))
      if (extraRoots.length === 0) return next()

      const hitFor = (abs) => longestRootFirst(extraRoots).find((root) => pathInside(abs, root))

      if (exec.name === 'write' || exec.name === 'edit') {
        const filePath = args && typeof args.file_path === 'string' ? args.file_path : null
        if (filePath === null) return next()
        let target
        try {
          target = await fs.resolve(filePath, { cwd: primary })
        } catch (error) {
          if (isAbsolute(filePath)) {
            const rawHit = hitFor(filePath)
            if (rawHit !== undefined) return ownedFailure(error, { ...standing, workspaceRoot: rawHit })
          }
          return next()
        }
        const abs = fs.processPath(target)
        const hit = hitFor(abs)
        if (hit === undefined) return next()
        const policy = { ...standing, workspaceRoot: hit }

        if (exec.name === 'write') {
          owned = { policy }
          const content = String(args.content)
          const outcome = await fs.writeText(target, content, undefined, exec.signal, policy)
          if (typeof ctx.emit === 'function') {
            ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
          }
          const displayPath =
            target.displayPath !== undefined && target.displayPath !== null ? String(target.displayPath) : filePath
          const value = {
            path: displayPath,
            operation: outcome.operation === 'create' ? 'create' : 'update',
            before: outcome.before === undefined || outcome.before === null ? null : outcome.before,
            after: outcome.after === undefined ? null : outcome.after,
          }
          const text =
            '<path>' + displayPath + '</path>\n<type>file</type>\n<content>\n' +
            (outcome.operation === 'create' ? 'Created' : 'Updated') +
            ' file\n</content>'
          return { isError: false, value, content: [{ type: 'text', text }] }
        }

        const oldString = args && typeof args.old_string === 'string' ? args.old_string : null
        const newString = args && typeof args.new_string === 'string' ? args.new_string : null
        if (oldString === null || newString === null) return next()
        const replaceAll = args.replace_all === true
        owned = { policy }
        const outcome = await fs.editText(target, { oldString, newString, replaceAll }, undefined, exec.signal, policy)
        if (typeof ctx.emit === 'function') {
          ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        }
        const displayPath =
          target.displayPath !== undefined && target.displayPath !== null ? String(target.displayPath) : filePath
        const value = { path: displayPath, before: outcome.before, after: outcome.after }
        const text = replaceAll
          ? 'The file ' + displayPath + ' has been updated. All occurrences were successfully replaced.'
          : 'The file ' + displayPath + ' has been updated successfully.'
        return { isError: false, value, content: [{ type: 'text', text }] }
      }

      // pwsh / bash
      const shell = ctx.get('shell')
      if (shell === undefined) return next()
      const modernShell = shellUsesExecute(shell)
      const rawWorkdir = args && typeof args.workdir === 'string' ? args.workdir : null
      const joined =
        rawWorkdir === null
          ? String(primary)
          : isAbsolute(rawWorkdir)
            ? rawWorkdir
            : String(primary).replace(/[\\/]+$/, '') + '/' + rawWorkdir
      const workdirTarget = await fs.resolve(joined, { cwd: primary })
      const absWorkdir = fs.processPath(workdirTarget)
      const hit = hitFor(absWorkdir)
      if (hit === undefined) return next()
      const policy = { ...standing, workspaceRoot: hit }
      const shellEnv = ctx.get('shellEnv')
      const request = {
        command: String(args.command),
        workdir: absWorkdir,
        ...(args && args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(shellEnv !== undefined ? { dshEnv: shellEnv.collect(exec) } : {}),
        sandboxPolicy: policy,
      }

      if (args && args.run_in_background === true) {
        if (exec.signal && exec.signal.aborted) return next()
        const jobs = ctx.get('jobs')
        if (jobs === undefined) return next()
        owned = { policy }
        const jobId = jobs.start({
          kind: exec.name,
          label: String(args.command),
          ...(exec.agent ? { owner: modernShell ? exec.agent.id : exec.agent } : {}),
          run: () => startBackgroundJob(shell, request),
        })
        return {
          isError: false,
          value: { kind: 'background', jobId },
          content: [{ type: 'text', text: 'started background job ' + jobId }],
        }
      }

      owned = { policy }
      const result = modernShell
        ? await (await shell.execute(shell.resolve({ ...request, signal: exec.signal }))).result()
        : await shell.run(shell.resolve({ ...request, signal: exec.signal }))
      if (result.aborted) {
        return { isError: true, error: { message: 'tool call aborted' }, content: [{ type: 'text', text: '[aborted]' }] }
      }
      const stream = (s) => ({
        text: s && typeof s.text === 'string' ? s.text : '',
        truncated: !!(s && s.truncated),
        ...(s && s.spillPath !== undefined ? { spillPath: s.spillPath } : {}),
      })
      const value = {
        kind: 'foreground',
        exitCode: result.exitCode === undefined ? null : result.exitCode,
        signal: result.signal === undefined ? null : result.signal,
        timedOut: !!result.timedOut,
        aborted: false,
        timeoutMs: result.timeoutMs === undefined ? null : result.timeoutMs,
        stdout: stream(result.stdout),
        stderr: stream(result.stderr),
        ...(result.sandbox !== undefined
          ? {
              sandbox: {
                mode: String(result.sandbox.mode),
                denied: !!result.sandbox.denied,
                ...(result.sandbox.enforcement !== undefined
                  ? { enforcement: String(result.sandbox.enforcement) }
                  : {}),
                ...(result.sandbox.runnerFailed !== undefined
                  ? { runnerFailed: !!result.sandbox.runnerFailed }
                  : {}),
              },
            }
          : {}),
      }
      return { isError: false, value, content: [{ type: 'text', text: shellRender(value) }] }
    } catch (error) {
      return owned === null ? next() : ownedFailure(error, owned.policy)
    }
  })

  // ------------------------------------------------------ hydration on start
  ctx.on('agent/created', (payload) => {
    const cwd = payload?.agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) hydrate(cwd)
  })

  // ------------------------------------------------- source-folder skills
  // The shipped filesystem provider reads the skill roots of the SESSION's
  // own cwd (its git root), so a skill that lives in an attached source
  // folder is invisible to `/`. This provider mirrors that discovery for
  // every configured source — recursively, so nested folders work too — and
  // registers its candidates into the same catalog.

  const SKILL_ROOTS = ['.dsh/skills', '.agents/skills', 'skills']
  const SKILL_MAX_DEPTH = 6
  const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  /** wsKey -> { at, dirsKey, list } */
  const skillCandidates = new Map()
  const skillControls = new Set()
  let lastSkillInvalidate = 0

  /** Minimal frontmatter reader: `name` and `description` are required. */
  function parseSkillText(raw) {
    const text = String(raw)
    if (!text.startsWith('---')) return null
    const end = text.indexOf('\n---', 3)
    if (end < 0) return null
    const header = text.slice(3, end).replace(/\r/g, '')
    const fields = {}
    for (const line of header.split('\n')) {
      const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim())
      if (match === null) continue
      fields[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
    }
    const name = fields.name
    const description = fields.description
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) return null
    if (typeof description !== 'string' || description.length === 0) return null
    const truthy = (value) => value === 'true' || value === 'yes' || value === 'on'
    const falsy = (value) => value === 'false' || value === 'no' || value === 'off'
    const whenToUse = fields.whenToUse
    return {
      name,
      description,
      whenToUse: typeof whenToUse === 'string' && whenToUse.length > 0 ? whenToUse : undefined,
      invocation: {
        modelInvocable: !truthy(fields['disable-model-invocation']),
        userInvocable: !falsy(fields['user-invocable']),
      },
      body: text.slice(end + 4).replace(/^\r?\n/, '').trim(),
    }
  }

  /** Depth-bounded walk: every directory carrying a SKILL.md is a skill. */
  async function scanSkillDir(dir, depth, out) {
    if (depth > SKILL_MAX_DEPTH) return
    let target
    try {
      target = await fs.resolve(dir)
    } catch {
      return
    }
    let entries
    try {
      entries = await fs.listDir(target)
    } catch {
      return
    }
    for (const entry of entries ?? []) {
      if (entry === null || entry === undefined || entry.type !== 'directory') continue
      const name = String(entry.name)
      if (name === 'node_modules' || name === '.git') continue
      const child = slashed(dir).replace(/\/+$/, '') + '/' + name
      const skillFile = child + '/SKILL.md'
      let raw = null
      try {
        raw = await fs.readText(await fs.resolve(skillFile))
      } catch {
        raw = null
      }
      if (raw !== null) {
        const parsed = parseSkillText(raw)
        if (parsed !== null) {
          out.push({
            name: parsed.name,
            description: parsed.description,
            ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
            invocation: parsed.invocation,
            source: 'project-sources',
            provider: 'project-sources',
            rank: 150,
            locator: { path: skillFile, directory: child },
            resourceBase: { kind: 'directory', path: child },
            path: skillFile,
          })
          continue
        }
      }
      await scanSkillDir(child, depth + 1, out)
    }
  }

  async function sourceSkills(project) {
    const key = wsKey(project.workspace)
    const dirsKey = project.sources.map((source) => wsKey(source.path)).join('|')
    const cached = skillCandidates.get(key)
    const now = Date.now()
    if (cached !== undefined && cached.dirsKey === dirsKey && now - cached.at < 2000) return cached.list
    const list = []
    const seen = new Set()
    for (const source of project.sources) {
      if (wsKey(source.path) === wsKey(project.workspace)) continue
      for (const rel of SKILL_ROOTS) {
        const found = []
        await scanSkillDir(slashed(join(source.path, rel)), 0, found)
        for (const item of found) {
          // First source in configuration order wins a duplicate name.
          if (seen.has(item.name)) continue
          seen.add(item.name)
          list.push(item)
        }
      }
    }
    skillCandidates.set(key, { at: now, dirsKey, list })
    return list
  }

  function invalidateSkills() {
    skillCandidates.clear()
    for (const control of skillControls) control.invalidate()
  }

  ctx.inject(['skills'], (scope) => {
    scope.effect(
      () =>
        scope.skills.registerProvider((control) => {
          skillControls.add(control)
          control.signal.addEventListener('abort', () => skillControls.delete(control), { once: true })
          return {
            name: 'project-sources',
            async list(options) {
              const project = await loadProject(options?.cwd)
              if (project === null) return []
              return await sourceSkills(project)
            },
            async get(candidate, options) {
              const locator = candidate?.locator
              if (locator === undefined || locator === null || typeof locator.path !== 'string') return undefined
              try {
                const target = await fs.resolve(locator.path, { signal: options?.signal })
                const raw = await fs.readText(target, options?.signal)
                const parsed = parseSkillText(raw)
                if (parsed === null) return undefined
                return {
                  name: parsed.name,
                  description: parsed.description,
                  ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
                  invocation: parsed.invocation,
                  source: 'project-sources',
                  provider: 'project-sources',
                  resourceBase: { kind: 'directory', path: locator.directory },
                  path: fs.processPath(target),
                  content: parsed.body,
                }
              } catch {
                return undefined
              }
            },
          }
        }),
      'dsh-project-sources: source-folder skills',
    )
  })

  // A write into a source may have created a skill: refresh the catalog, but
  // never more than once per window (the catalog read is shared by every
  // consumer).
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec !== undefined && (exec.name === 'write' || exec.name === 'edit' || exec.name === 'pwsh' || exec.name === 'bash')) {
      const now = Date.now()
      if (now - lastSkillInvalidate > 1500) {
        lastSkillInvalidate = now
        invalidateSkills()
      }
    }
    return decision
  })

  // ------------------------------------------------------- remote mounts
  ctx.provide('projectSources', api)
  ctx.inject(['typert'], (scope) => scope.typert.register(REMOTE_CONTRIBUTION))
}