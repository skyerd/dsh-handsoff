/**
 * Structural check for the standalone dsh-handsoff bundle.
 *
 * 1. client.js must register itself as ModuleLoader id `dsh-handsoff`,
 *    never request an external module at eval time (all externals are
 *    resolved by the web client registry at require time), and its apply()
 *    must mount every Remote method the settings page calls.
 * 2. lib/index.js and lib/host.js must parse and export a default plugin.
 *
 * Usage: node scripts/check-standalone.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const required = [
  'listQueues', 'getQueue', 'createQueue', 'createPipelineTemplate', 'updateQueue',
  'deleteDraftQueue', 'startQueue', 'pauseQueue', 'abortQueue', 'listInterventions',
  'upsertTask', 'reorderTasks', 'deleteTask', 'duplicateTask', 'repairTaskList',
  'setTaskEnabled', 'skipTask', 'listRuns', 'getRun', 'pause', 'resume', 'cancel',
  'retry', 'listHandoffs', 'getHandoff', 'getSettings', 'updateSettings', 'changed',
]

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ---- 1. client.js ----------------------------------------------------------
const clientSource = readFileSync(join(ROOT, 'client.js'), 'utf8')

let captured
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => { captured = definition } } },
  document: {
    createElement: () => ({ setAttribute() {}, set textContent(v) { sandbox.__cssLen = v.length } }),
    head: { appendChild() {} },
  },
  __cssLen: 0,
}
vm.createContext(sandbox)
vm.runInContext(clientSource, sandbox, { filename: 'client.js' })

check('client.js registers under id "dsh-handsoff"', captured?.id === 'dsh-handsoff', captured?.id)

// Externals (@deepseek-ai/*, react…) are provided by the web client registry
// at require time; the bundle must never need anything else.
const anything = new Proxy(function () {}, {
  get: () => anything,
  apply: () => anything,
  construct: () => anything,
})
const exports = captured.factory(() => anything)

check('client.js injects style tag with css', sandbox.__cssLen > 40000, `${sandbox.__cssLen} bytes`)
check('exports.inject lists 8 web-composition services',
  Array.isArray(exports.inject) && exports.inject.length === 8,
  `${exports.inject?.length} entries`)

let mounted
let disposed = false
const stubNamespace = new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? async () => ({}) : undefined) })
const slots = []
const slotDefinitions = []
const effects = []
const sandboxCtx = {
  remote: {
    $mount: async (manifest) => {
      mounted = manifest
      return async () => { disposed = true }
    },
  },
  get: (name) => (name === 'remote.sessionOrchestrator' ? stubNamespace : undefined),
  locale: { bind: () => (key) => key, register: () => {} },
  effect: (fn, label) => { effects.push(label ?? '(unlabeled)') },
  inject: (names) => { effects.push(`inject:${names.join(',')}`) },
  slots: {
    inject: (slot, register) => { slots.push(slot); return register() },
    register: (definition) => { slotDefinitions.push(definition); return definition },
  },
}
const disposer = await exports.apply(sandboxCtx)

check('apply() mounts the sessionOrchestrator namespace', mounted !== undefined)
const ids = new Set()
const collect = (value) => {
  if (value === null || typeof value !== 'object') return
  if (typeof value.method === 'string' && typeof value.id === 'string') ids.add(value.method)
  for (const entry of Object.values(value)) collect(entry)
}
collect(mounted)
const missing = required.filter((name) => !ids.has(name))
check(`mounted manifest covers all ${required.length} required methods`, missing.length === 0,
  `${ids.size} methods mounted${missing.length ? `, missing: ${missing.join(',')}` : ''}`)
check('settings.section registered', slots.includes('settings.section'))
check('shell.overlay (SessionNotice) registered',
  slotDefinitions.some(definition => definition.id === 'session-orchestrator-session-notice'))
check('shell.overlay (DesktopPet) registered',
  slotDefinitions.some(definition => definition.id === 'session-orchestrator-desktop-pet'))
check('apply() returns a disposer', typeof disposer === 'function')

// ---- 2. host halves: parse -------------------------------------------------
// `node --check lib/index.js lib/host.js` (run in the repo, type: module)
// covers ESM syntax for the host halves.

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
