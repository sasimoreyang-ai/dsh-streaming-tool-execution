import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (!process.argv[2] || !process.env.npm_execpath) {
  throw Error('Use npm run check:install -- /absolute/path/to/@deepseek-ai/dsh/lib/bin.js')
}
const cli = resolve(process.argv[2])
const host = JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8'))
assert.equal(host.name, '@deepseek-ai/dsh')
assert.equal(host.version, '0.2.2-rc.1')
const home = mkdtempSync(join(tmpdir(), 'streaming-rc1-'))
const run = args => {
  const result = spawnSync(process.execPath, args, {
    cwd: root, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 180000, maxBuffer: 5000000,
  })
  if (result.error || result.status !== 0) throw Error(`${result.error ?? result.stderr.slice(-4000)}\nTest home: ${home}`)
  return result.stdout
}
const [pack] = JSON.parse(run([process.env.npm_execpath, 'pack', '--json', '--ignore-scripts', '--pack-destination', home]))
run([cli, 'plugin', '--profile', 'web', 'add', join(home, pack.filename)])
const profile = join(home, 'profiles', 'web')
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
assert.ok(manifest.dsh.profile.bundles.includes('mindagent-dsh-streaming-tool-execution'))
const config = run([cli, '--profile', 'web', '--dump-config'])
assert.match(config, /id: streaming-tool-execution/u)
assert.match(config, /streamingToolExecution: true/u)
const detached = join(home, 'detached.mjs')
copyFileSync(join(profile, 'node_modules', 'mindagent-dsh-streaming-tool-execution', 'index.js'), detached)
const plugin = await import(pathToFileURL(detached).href)
assert.equal(plugin.name, 'streaming-tool-execution')
assert.equal(typeof plugin.apply, 'function')
console.log(JSON.stringify({ home, version: host.version, installed: true, composed: true, detachedImport: true }, null, 2))
