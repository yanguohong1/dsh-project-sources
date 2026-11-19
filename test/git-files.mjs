import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply } from '../index.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-ps-git-'))
const work = join(root, 'work')
const extra = join(root, 'repo', 'extra')
const plain = join(root, 'plain')
const nested = join(work, 'nested')
const provide = {}
const cleanups = []
const agent = {}
const signal = new AbortController().signal
let cwd = work
const fileReferences = { async list(a, query, s) {
  assert.equal(this, fileReferences)
  assert.equal(a, agent)
  assert.equal(s, signal)
  return [{ path: query, kind: 'file' }]
} }
const original = fileReferences.list
const ctx = {
  fs: {
    resolve: async p => p,
    processPath: p => p,
    readText: async () => JSON.stringify({ sources: [
      { path: extra, alias: 'extra' }, { path: plain, alias: 'plain' }, { path: nested, alias: 'nested' },
    ] }),
    async listDir(p) {
      return (await readdir(p, { withFileTypes: true })).map(x => ({ name: x.name, type: x.isDirectory() ? 'directory' : 'file' }))
    },
  },
  systemPrompt: { section() {} },
  fileReferences,
  workingDirectory: { ensure: async () => cwd },
  inject(keys, fn) { if (keys.includes('fileReferences')) fn(ctx) },
  effect(fn) { cleanups.push(fn()) },
  on() {},
  provide(name, value) { provide[name] = value },
  get() {},
}
const put = async (base, path, body = '') => {
  const file = join(base, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, body)
}
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, windowsHide: true })
try {
  for (const dir of [work, extra, plain]) await mkdir(dir, { recursive: true })
  git(work, 'init', '-q')
  git(dirname(extra), 'init', '-q')
  await put(work, 'src/Tracked.cs')
  await put(work, 'src/Deleted.cs')
  git(work, 'add', '--', 'src/Tracked.cs', 'src/Deleted.cs')
  await rm(join(work, 'src/Deleted.cs'))
  await put(work, '.gitignore', '/Generated/\n/src/Tracked.cs\n/nested/\n')
  await put(nested, 'NestedFile.cs')
  git(nested, 'init', '-q')
  await put(work, 'Generated/Ignored.cs')
  await put(work, 'src/New Script.cs')
  await put(dirname(extra), '.gitignore', '*.log\n')
  await put(extra, 'deep/.gitignore', '!Keep.log\n')
  await put(extra, 'deep/Keep.log')
  await put(extra, 'deep/Ignored.log')
  await put(plain, 'PlainFile.cs')
  apply(ctx)

  const native = async (q) => (await fileReferences.list(agent, q, signal)).map(x => x.path)
  const attached = async (q) => (await provide.projectSources.listFiles(work, q, signal)).candidates.map(x => x.rel)
  assert.deepEqual(await native('Tracked'), ['src/Tracked.cs'])
  assert.deepEqual(await native('New Script'), ['src/New Script.cs'])
  assert.deepEqual(await native('Ignored'), [])
  assert.deepEqual(await native('Deleted'), [])
  assert.deepEqual(await native('Generated/'), ['Generated/'])
  assert.deepEqual(await attached('Keep'), ['deep/Keep.log'])
  assert.deepEqual(await attached('Ignored'), [])
  assert.deepEqual(await attached('extra/deep/Ignored'), ['deep/Ignored.log'])
  assert.deepEqual(await attached('PlainFile'), ['PlainFile.cs'])
  assert.deepEqual(await native('NestedFile'), [])
  assert.deepEqual(await attached('NestedFile'), ['NestedFile.cs'])
  assert.deepEqual(await attached('New Script'), [])
  cwd = plain
  assert.deepEqual(await native('fallback'), ['fallback'])
  console.log('Git @ search: workspace, attached subdirectory, native fallback and path browsing passed')
} finally {
  for (const cleanup of cleanups.reverse()) cleanup()
  assert.equal(fileReferences.list, original)
  await rm(root, { recursive: true, force: true })
}
