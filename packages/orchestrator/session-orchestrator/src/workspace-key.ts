/**
 * Canonical workspace lock keys.
 *
 * The scheduler locks work per workspace, and the lock key is the identity of
 * that workspace, not whatever `cwd` string a task happens to carry. Two tasks
 * that name the same directory must produce the same key even when they spell it
 * differently, so this module is the single place that decides key equality:
 * case folding on case-insensitive platforms, separator normalization, `.`/`..`
 * resolution and trailing-separator removal.
 *
 * Resolution is pure string work. Symlinks are not resolved here: `fs.realpath`
 * needs IO and belongs to the launcher that creates the session, which reports
 * the key it actually ran under.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/workspace-key
 */

import { posix, win32 } from 'node:path'
import type { TaskSpec } from './types.ts'

/** Why a task cannot be given a canonical workspace key. */
export type WorkspaceKeyRejection =
  | { readonly kind: 'empty-workspace-id' }
  | { readonly kind: 'relative-cwd'; readonly cwd: string }

/** One task's workspace key, or the reason it has none. */
export type WorkspaceKeyResolution =
  | { readonly ok: true; readonly workspaceKey: string }
  | { readonly ok: false; readonly rejection: WorkspaceKeyRejection }

/** Supplies the canonical lock key for one task. */
export interface WorkspaceKeyResolver {
  /**
   * Resolve the canonical key for a task.
   * @param task - Task whose workspace identity to resolve.
   * @returns the canonical key, or the rejection that forbids locking.
   */
  resolve(task: TaskSpec): WorkspaceKeyResolution
}

/**
 * Check whether a path names one fixed host location.
 *
 * This mirrors the workspace package's canonicalization rule, which is not
 * importable from this tree; the rule itself is what matters here.
 * @param path - Candidate directory path.
 * @param platform - Host platform; injectable for deterministic tests.
 * @returns Whether the path is fully qualified on that platform.
 */
function isFullyQualified(path: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return posix.isAbsolute(path)
  const root = win32.parse(path).root
  return win32.isAbsolute(path) && root !== '\\' && root !== '/'
}

/**
 * Canonicalize one workspace directory path for lock-key comparison.
 *
 * A relative path has no fixed identity and therefore no key: it rejects rather
 * than falling back to the process cwd or current Windows drive.
 * @param cwd - Directory path as the task stored it.
 * @param platform - Host platform; injectable for deterministic tests.
 * @returns the canonical path, or `undefined` when the path is not fully qualified.
 */
export function normalizeWorkspacePath(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const trimmed = cwd.trim()
  if (trimmed === '' || !isFullyQualified(trimmed, platform)) return undefined
  const pathApi = platform === 'win32' ? win32 : posix
  const normalized = pathApi.normalize(trimmed)
  const trimmedTrailing = normalized.length > pathApi.parse(normalized).root.length
    ? normalized.replace(/[\\/]+$/, '')
    : normalized
  return platform === 'win32' ? trimmedTrailing.toLowerCase() : trimmedTrailing
}

/**
 * Build the canonical lock key from a workspace identity and a directory path.
 *
 * The key is stored verbatim on the run record, so every consumer that later
 * compares runs against a workspace uses the same spelling.
 * @param workspaceId - Stored workspace identity.
 * @param cwd - Directory path as the task stored it.
 * @param platform - Host platform; injectable for deterministic tests.
 * @returns the canonical key, or the rejection that forbids locking.
 */
export function resolveWorkspaceKey(
  workspaceId: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): WorkspaceKeyResolution {
  const id = workspaceId.trim()
  if (id === '') return { ok: false, rejection: { kind: 'empty-workspace-id' } }
  const path = normalizeWorkspacePath(cwd, platform)
  if (path === undefined) return { ok: false, rejection: { kind: 'relative-cwd', cwd } }
  return { ok: true, workspaceKey: `${id}:${path}` }
}

/**
 * Create the resolver the scheduler locks with.
 * @param platform - Host platform; injectable for deterministic tests.
 * @returns a resolver over that platform's path rules.
 */
export function createWorkspaceKeyResolver(
  platform: NodeJS.Platform = process.platform,
): WorkspaceKeyResolver {
  return {
    resolve(task: TaskSpec): WorkspaceKeyResolution {
      return resolveWorkspaceKey(task.workspaceId, task.cwd, platform)
    },
  }
}
