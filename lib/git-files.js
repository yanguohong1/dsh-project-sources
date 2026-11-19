import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

async function waitForIndex(promise, signal) {
  if (!signal) return promise
  signal.throwIfAborted()
  let abort
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
const windows = process.platform === 'win32'
// Use the host's Git, not an executable in the workspace or a relative PATH entry.
const git = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(isAbsolute)
  .map(dir => join(dir, windows ? 'git.exe' : 'git'))
  .find(path => {
    try { accessSync(path, constants.X_OK); return true } catch { return false }
  })

async function gitPaths(root, signal) {
  if (!git || !isAbsolute(root)) return null
  const env = { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key]
  let stdout
  try {
    const result = await exec(git, [
      '-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate', '--',
    ], { cwd: root, env, signal, windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024 })
    stdout = result.stdout
  } catch (error) {
    signal.throwIfAborted()
    if (error.code === 'ENOENT' || (error.code === 128 && error.stderr?.includes('not a git repository'))) return null
    throw error
  }
  const paths = new Map()
  for (const name of stdout.split('\0')) {
    const directory = name.endsWith('/')
    const path = directory ? name.slice(0, -1) : name
    if (!path || isAbsolute(path) || /(^|\/)\.\.?($|\/)/.test(path) || (windows && /[\\:]/.test(path))) continue
    if (directory || !paths.has(path)) paths.set(path, directory ? 'directory' : 'file')
    for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
      const dir = path.slice(0, i)
      if (paths.get(dir) === 'directory') break
      paths.set(dir, 'directory')
    }
  }
  return paths
}

export function gitFileSearch() {
  // ponytail: bounded in-memory path cache; stream Git output if a repo exceeds 64 MiB.
  const indexes = new Map()
  const controller = new AbortController()
  function index(root) {
    const cached = indexes.get(root)
    if (cached && Date.now() < cached.expires) return cached.promise
    const entry = { expires: Infinity }
    entry.promise = gitPaths(root, controller.signal).finally(() => { entry.expires = Date.now() + 30000 })
    indexes.delete(root)
    indexes.set(root, entry)
    // One project can attach up to 32 folders; do not evict its own index while typing.
    if (indexes.size > 40) {
      const settled = [...indexes].find(([key, value]) => key !== root && value.expires !== Infinity)
      if (settled) indexes.delete(settled[0])
    }
    return entry.promise
  }

  return {
    dispose() { controller.abort(); indexes.clear() },
    paths: (root, signal) => waitForIndex(index(root), signal),
    async list(root, query, limit, signal) {
      signal?.throwIfAborted()
      const paths = await waitForIndex(index(root), signal)
      signal?.throwIfAborted()
      if (paths === null) return null
      const needle = query.toLowerCase()
      const matches = []
      for (const [path, kind] of paths) {
        const text = path.toLowerCase()
        if (!text.includes(needle) || (!needle.startsWith('.') && (path.startsWith('.') || path.includes('/.')))) continue
        const name = text.slice(text.lastIndexOf('/') + 1)
        const score = name === needle ? 0 : name.startsWith(needle + '.') ? 1 : name.startsWith(needle) ? 2 : name.includes(needle) ? 3 : 4
        matches.push({ path, kind, score })
      }
      matches.sort((a, b) => a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      const checked = new Map()
      function kindOf(path) {
        if (!checked.has(path)) checked.set(path, (async () => {
          const slash = path.lastIndexOf('/')
          if (slash >= 0 && await kindOf(path.slice(0, slash)) !== 'directory') return null
          const stat = await lstat(join(root, path)).catch(() => null)
          return stat?.isFile() ? 'file' : stat?.isDirectory() ? 'directory' : null
        })())
        return checked.get(path)
      }
      const results = []
      for (let i = 0; results.length < limit && i < matches.length; i += limit) {
        const batch = matches.slice(i, i + limit)
        const kinds = await Promise.all(batch.map(({ path }) => kindOf(path)))
        signal?.throwIfAborted()
        for (const { path, kind } of batch.filter(({ kind }, j) => kind === kinds[j])) results.push({ path, kind })
      }
      return results.slice(0, limit)
    },
  }
}
