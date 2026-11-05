/**
 * Host-half smoke test against mock services — no DSH runtime required.
 * Covers: config load, re-rooted write interception, fall-through, the prompt
 * section, and the sessionless remote view.
 */
import { join } from 'node:path'
import os from 'node:os'

const HOME = join(os.tmpdir(), 'dsh-ps-smoke-' + process.pid)
process.env.DSH_HOME = HOME
// Never open a real folder dialog from the test run: the Host proxy then
// falls through to the mocked `directoryPicker` capability below.
process.env.DSH_PROJECT_SOURCES_NO_DIALOG = '1'

const WORKSPACE = 'E:\\work\\file'
const SOURCE = 'E:\\work\\workSpace'
const CONFIG = join(HOME, 'storages', 'project-sources', 'e-work-file.json')

const config = {
  name: 'demo-project',
  primary: SOURCE,
  sources: [
    { path: WORKSPACE, alias: 'file' },
    { path: SOURCE, alias: 'ws' },
  ],
}

const calls = []
const nextCalls = []
const provided = {}
const sections = []
const handlers = {}

const targetOf = (p) => ({ targetKey: 'k:' + String(p), displayPath: String(p) })

const fs = {
  async resolve(p) {
    return targetOf(String(p).replace(/\//g, '\\'))
  },
  processPath(t) {
    return t.displayPath
  },
  async readText(t) {
    if (String(t.displayPath).toLowerCase() === CONFIG.toLowerCase()) return JSON.stringify(config)
    throw new Error('FS_NOT_FOUND')
  },
  async writeText(target, content, expected, signal, policy) {
    calls.push({ op: 'write', target: target.displayPath, policy })
    return { operation: 'create', version: 'v1', before: null, after: content }
  },
  async editText(target, edit, expected, signal, policy) {
    calls.push({ op: 'edit', target: target.displayPath, policy, edit })
    return { version: 'v2', before: 'a', after: 'b' }
  },
  async stat() {
    return { type: 'directory', version: 'v1' }
  },
  async listDir() {
    return [
      { name: 'src', type: 'directory', target: targetOf('src') },
      { name: 'a.txt', type: 'file', target: targetOf('a.txt') },
    ]
  },
}

const ctx = {
  fs,
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: WORKSPACE }) },
  systemPrompt: { section: (def) => sections.push(def) },
  on: (event, handler) => { handlers[event] = handler },
  get: (key) => (key === 'directoryPicker' ? { capability: () => pickerCapability } : undefined),
  emit: () => {},
  provide: (key, value) => { provided[key] = value },
  inject: () => {},
  effect: () => {},
}

let pickerCapability = { kind: 'native', pick: async () => SOURCE }

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

const next = () => { nextCalls.push(1); return Promise.resolve({ from: 'default' }) }

// 1. write into a secondary source is intercepted and re-rooted
const exec = {
  name: 'write',
  arguments: { file_path: SOURCE + '\\out.txt', content: 'hello' },
  agent: { id: 'session-1', session: { header: { cwd: WORKSPACE } } },
}
const result = await handlers['tools/execute'](exec, next)
assert(result && result.isError === false, 'write in source returns a success envelope')
assert(calls.length === 1 && calls[0].op === 'write', 'the FS write ran through the interception')
assert(calls[0].policy.workspaceRoot === SOURCE, 'the write policy is re-rooted at the source')
assert(calls[0].policy.mode === 'workspace-write', 'the mode is untouched')

// 2. write inside the workspace falls through to the shipped pipeline
nextCalls.length = 0
const inside = {
  name: 'write',
  arguments: { file_path: WORKSPACE + '\\x.txt', content: 'x' },
  agent: exec.agent,
}
await handlers['tools/execute'](inside, next)
assert(nextCalls.length === 1, 'a workspace path falls through to the default pipeline')

// 3. the prompt section maps aliases to absolute paths
const text = sections[0].text({ agent: { session: { header: { cwd: WORKSPACE } } } })
assert(text.includes('ws') && text.includes(SOURCE), 'prompt maps the alias to its absolute path')
assert(text.includes('(the workspace root)'), 'prompt marks the workspace source')
assert(!text.includes('(primary)'), 'prompt no longer carries a primary-source concept')
assert(text.includes('@ws/'), 'prompt explains the alias mention form')

// 4. the remote view
const view = await provided.projectSources.get(WORKSPACE)
assert(view.sources.length === 2, 'get returns the workspace plus one source')
assert(view.sources.some((s) => s.alias === 'ws' && s.isWorkspace === false), 'get marks the workspace source')

// 5. @ candidates
const empty = await provided.projectSources.listFiles(WORKSPACE, '')
assert(empty.candidates.length === 2, 'an empty query yields the source folders')
const byAlias = await provided.projectSources.listFiles(WORKSPACE, 'ws/')
assert(byAlias.candidates.length === 2, 'alias/ lists the source level')
assert(byAlias.candidates.every((c) => c.alias === 'ws'), 'candidates carry their alias')
const byAbs = await provided.projectSources.listFiles(WORKSPACE, SOURCE + '\\')
assert(byAbs.candidates.length === 2, 'an absolute drill path lists the same level')

// A folder-name fragment and an alias prefix both reach the source itself.
const flat = (p) => String(p).replace(/\\/g, '/').toLowerCase()
const byFolderName = await provided.projectSources.listFiles(WORKSPACE, 'worksp')
assert(
  byFolderName.candidates.some((c) => flat(c.path) === flat(SOURCE) && c.rel === ''),
  'a folder-name fragment offers the source folder',
)
const byFolderPrefixLevel = await provided.projectSources.listFiles(WORKSPACE, 'workspace/')
assert(byFolderPrefixLevel.candidates.length === 2, 'a folder-name prefix with / lists its level')

// 6. `..` cannot escape a source
const escape = await provided.projectSources.listFiles(WORKSPACE, 'ws/../../')
assert(escape.candidates.length === 0, 'a .. segment is refused')

// 7. the host folder chooser is proxied with an explicit capability answer
const picked = await provided.projectSources.pick()
assert(picked.via === 'native' && picked.path === SOURCE, 'pick returns the native selection')
pickerCapability = { kind: 'browse', list: async () => ({}) }
const browsed = await provided.projectSources.pick()
assert(browsed.via === 'browse' && browsed.path === null, 'pick reports a browse-only composition')
pickerCapability = { kind: 'native', pick: async () => null }
const cancelled = await provided.projectSources.pick()
assert(cancelled.via === 'native' && cancelled.path === null, 'pick reports a cancelled dialog')

// 7. set() validates and normalizes aliases
const saved = await provided.projectSources.set(WORKSPACE, {
  name: 'renamed',
  primary: SOURCE,
  sources: [
    { path: WORKSPACE, alias: 'file' },
    { path: SOURCE, alias: 'web' },
    { path: SOURCE, alias: 'web' },
  ],
})
assert(saved.name === 'renamed', 'set persists the project name')
assert(saved.sources.length === 2, 'duplicate paths collapse')
assert(saved.sources.some((s) => s.alias === 'web'), 'aliases are kept')

console.log(process.exitCode === 1 ? '\nSMOKE FAILED' : '\nSMOKE PASSED')