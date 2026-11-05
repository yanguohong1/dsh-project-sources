/**
 * Source-folder skill discovery against mock services.
 *
 * Covers: recursive scan under `.dsh/skills`, `.agents/skills` and `skills/`,
 * nested folders, invalid/disable frontmatter, the workspace source being
 * skipped, duplicate names, and `get()` returning the body.
 */
import { join } from 'node:path'
import os from 'node:os'

process.env.DSH_HOME = join(os.tmpdir(), 'dsh-ps-skills-' + process.pid)
process.env.DSH_PROJECT_SOURCES_NO_DIALOG = '1'

const WORKSPACE = 'E:\\work\\file'
const SOURCE = 'E:\\work\\workSpace'
const CONFIG = join(process.env.DSH_HOME, 'storages', 'project-sources', 'e-work-file.json')

const norm = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
const dirs = new Map()
const files = new Map()

function dir(path, children) {
  dirs.set(norm(path), children)
}
function file(path, content) {
  files.set(norm(path), content)
}

file(CONFIG, JSON.stringify({
  name: 'demo',
  sources: [
    { path: WORKSPACE, alias: 'file' },
    { path: SOURCE, alias: 'ws' },
  ],
}))

const skill = (name, description, extra = '') =>
  '---\nname: ' + name + '\ndescription: ' + description + '\n' + extra + '---\n\nBody of ' + name + '.\n'

dir(SOURCE + '\\.dsh\\skills', [
  { name: 'alpha', type: 'directory' },
  { name: 'group', type: 'directory' },
  { name: 'invalid', type: 'directory' },
  { name: 'tool-only', type: 'directory' },
])
file(SOURCE + '\\.dsh\\skills\\alpha\\SKILL.md', skill('alpha', 'First skill'))
dir(SOURCE + '\\.dsh\\skills\\group', [{ name: 'beta', type: 'directory' }])
file(SOURCE + '\\.dsh\\skills\\group\\beta\\SKILL.md', skill('beta', 'Nested skill'))
file(SOURCE + '\\.dsh\\skills\\invalid\\SKILL.md', '---\ndescription: no name\n---\nbody')
file(SOURCE + '\\.dsh\\skills\\tool-only\\SKILL.md', skill('tool-only', 'Hidden from users', 'user-invocable: false\n'))
dir(SOURCE + '\\.agents\\skills', [{ name: 'gamma', type: 'directory' }])
file(SOURCE + '\\.agents\\skills\\gamma\\SKILL.md', skill('gamma', 'Agents skill'))
// A plain `skills/` folder in the source also works.
dir(SOURCE + '\\skills', [{ name: 'delta', type: 'directory' }])
file(SOURCE + '\\skills\\delta\\SKILL.md', skill('delta', 'Loose skills folder'))
// The workspace itself is the shipped provider's business: never scanned here.
dir(WORKSPACE + '\\.dsh\\skills', [{ name: 'workspace-only', type: 'directory' }])
file(WORKSPACE + '\\.dsh\\skills\\workspace-only\\SKILL.md', skill('workspace-only', 'From workspace'))

const targetOf = (p) => ({ targetKey: 'k:' + norm(p), displayPath: String(p) })
const fs = {
  async resolve(p) {
    const key = norm(p)
    if (!files.has(key) && !dirs.has(key)) throw Object.assign(new Error('FS_NOT_FOUND'), { code: 'FS_NOT_FOUND' })
    return targetOf(p)
  },
  processPath(t) {
    return t.displayPath
  },
  async readText(t) {
    const value = files.get(norm(t.displayPath))
    if (value === undefined) throw Object.assign(new Error('FS_NOT_FOUND'), { code: 'FS_NOT_FOUND' })
    return value
  },
  async listDir(t) {
    const entries = dirs.get(norm(t.displayPath))
    if (entries === undefined) throw Object.assign(new Error('FS_NOT_FOUND'), { code: 'FS_NOT_FOUND' })
    return entries.map((entry) => ({ ...entry, target: targetOf(entry.name) }))
  },
  async stat() {
    return { type: 'directory', version: 'v1' }
  },
}

let provider = null
const controls = []
const ctx = {
  fs,
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: WORKSPACE }) },
  systemPrompt: { section: () => {} },
  on: () => {},
  get: () => undefined,
  emit: () => {},
  provide: () => {},
  effect: () => {},
  inject: (deps, callback) => {
    if (!deps.includes('skills')) return
    callback({
      effect: (fn) => { fn() },
      skills: {
        registerProvider: (create) => {
          const control = { signal: new AbortController().signal, invalidate: () => {} }
          controls.push(control)
          provider = create(control)
          return () => {}
        },
      },
    })
  },
}

const mod = await import('file:///E:/work/dsh-project-sources/index.js')
mod.apply(ctx)

function assert(condition, label) {
  if (!condition) {
    console.error('FAIL ' + label)
    process.exitCode = 1
  } else {
    console.log('ok   ' + label)
  }
}

assert(provider !== null, 'a skill provider is registered')

const listed = await provider.list({ cwd: WORKSPACE })
const names = listed.map((c) => c.name).sort()
assert(JSON.stringify(names) === JSON.stringify(['alpha', 'beta', 'delta', 'gamma', 'tool-only']), 'all nested skills are discovered: ' + names.join(','))
assert(!names.includes('workspace-only'), 'the workspace source is left to the shipped provider')
assert(!names.includes('invalid'), 'a SKILL.md without a name is skipped')
const toolOnly = listed.find((c) => c.name === 'tool-only')
assert(toolOnly.invocation.userInvocable === false, 'user-invocable: false is honored')
const beta = listed.find((c) => c.name === 'beta')
assert(beta.source === 'project-sources', 'candidates carry their source')
assert(String(beta.path).includes('.dsh/skills/group/beta/SKILL.md'), 'nested locator points at the file')

const loaded = await provider.get(beta, {})
assert(loaded && loaded.name === 'beta' && loaded.content.includes('Body of beta'), 'get() loads the body')
assert(loaded.resourceBase.kind === 'directory', 'get() exposes the skill directory as resource base')

console.log(process.exitCode === 1 ? '\nSKILLS FAILED' : '\nSKILLS PASSED')