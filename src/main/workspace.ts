import { isAbsolute, relative, resolve } from 'path'
import { homedir } from 'os'
import { getSetting } from './db'

export function workspaceRoot(): string {
  return getSetting('workspace_root') || homedir()
}

/** Confine a path to the workspace root (case-insensitive on Windows). */
export function resolveWorkspacePath(p: string): string {
  const root = resolve(workspaceRoot())
  const full = resolve(root, p)
  const rel = relative(root, full)
  if (rel && (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel))) {
    throw new Error(`Path is outside the workspace root (${root}). The user can change the root in Settings.`)
  }
  return full
}
