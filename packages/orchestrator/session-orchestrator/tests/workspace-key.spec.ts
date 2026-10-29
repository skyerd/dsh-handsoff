/** Canonical workspace lock keys: equivalence, rejection and platform rules. */
import { describe, expect, it } from 'vitest'
import { QueueId, TaskId } from '../src/brand.ts'
import type { TaskSpec } from '../src/types.ts'
import {
  createWorkspaceKeyResolver,
  normalizeWorkspacePath,
  resolveWorkspaceKey,
} from '../src/workspace-key.ts'

/** A task with the required fields, overridable per case. */
function task(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: TaskId('task-1'),
    queueId: QueueId('queue-1'),
    title: 'Task',
    prompt: 'Do the thing',
    workspaceId: 'workspace-1',
    cwd: '/work/one',
    preset: { kind: 'inherit' },
    model: { kind: 'inherit' },
    skills: { kind: 'inherit-preset' },
    dependsOn: [],
    priority: 0,
    handoff: {
      enabled: true,
      ratio: 0.88,
      mode: 'structured-brief',
      boundary: 'completed-turn',
      maxGenerations: 20,
      maxHandoffTokens: 4096,
    },
    enabled: true,
    revision: 0,
    ...overrides,
  }
}

describe('normalizeWorkspacePath', () => {
  it('collapses dot segments and trailing separators on POSIX', () => {
    expect(normalizeWorkspacePath('/work/./one', 'linux')).toBe('/work/one')
    expect(normalizeWorkspacePath('/work/one/', 'linux')).toBe('/work/one')
    expect(normalizeWorkspacePath('/work/one///', 'linux')).toBe('/work/one')
    expect(normalizeWorkspacePath('/work/../work/one', 'linux')).toBe('/work/one')
  })

  it('keeps POSIX case significant', () => {
    expect(normalizeWorkspacePath('/Work/One', 'linux')).toBe('/Work/One')
  })

  it('folds Windows case and unifies separators', () => {
    expect(normalizeWorkspacePath('C:\\Work\\One', 'win32')).toBe('c:\\work\\one')
    expect(normalizeWorkspacePath('c:/work/one/', 'win32')).toBe('c:\\work\\one')
  })

  it('keeps a drive root as a root', () => {
    expect(normalizeWorkspacePath('C:\\', 'win32')).toBe('c:\\')
    expect(normalizeWorkspacePath('/', 'linux')).toBe('/')
  })

  it('rejects a relative path on either platform', () => {
    expect(normalizeWorkspacePath('work/one', 'linux')).toBeUndefined()
    expect(normalizeWorkspacePath('work\\one', 'win32')).toBeUndefined()
    expect(normalizeWorkspacePath('', 'linux')).toBeUndefined()
    expect(normalizeWorkspacePath('   ', 'linux')).toBeUndefined()
  })

  it('rejects a Windows path with no drive', () => {
    expect(normalizeWorkspacePath('\\work\\one', 'win32')).toBeUndefined()
  })
})

describe('resolveWorkspaceKey', () => {
  it('combines the workspace identity with the canonical path', () => {
    expect(resolveWorkspaceKey('workspace-1', '/work/one', 'linux')).toEqual({
      ok: true,
      workspaceKey: 'workspace-1:/work/one',
    })
  })

  it('rejects an empty workspace identity', () => {
    expect(resolveWorkspaceKey('   ', '/work/one', 'linux')).toEqual({
      ok: false,
      rejection: { kind: 'empty-workspace-id' },
    })
  })

  it('reports the offending cwd for a relative path', () => {
    expect(resolveWorkspaceKey('workspace-1', 'work/one', 'linux')).toEqual({
      ok: false,
      rejection: { kind: 'relative-cwd', cwd: 'work/one' },
    })
  })
})

describe('createWorkspaceKeyResolver', () => {
  it('resolves a task through the injected platform', () => {
    const resolver = createWorkspaceKeyResolver('win32')
    expect(resolver.resolve(task({ workspaceId: 'workspace-1', cwd: 'C:\\Work\\One' }))).toEqual({
      ok: true,
      workspaceKey: 'workspace-1:c:\\work\\one',
    })
  })

  it('produces one key for two spellings of the same directory', () => {
    const resolver = createWorkspaceKeyResolver('win32')
    const first = resolver.resolve(task({ cwd: 'C:\\Work\\One' }))
    const second = resolver.resolve(task({ cwd: 'c:/work/one/' }))
    expect(first).toEqual(second)
  })
})
