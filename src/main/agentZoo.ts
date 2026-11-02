import { promises as fsp } from 'fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'path'
import { resolveWorkspacePath, workspaceRoot } from './workspace'

export type AgentZooKind = 'agent' | 'skill' | 'tool' | 'runtime' | 'config'

export interface AgentZooEntry {
  id: string
  name: string
  kind: AgentZooKind
  path: string
  origin: string
  description: string
  editable: boolean
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'release', 'dist', 'build', 'bin', 'obj', '.vs'])
const TEXT_EXTS = new Set(['.md', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.cs'])
const MAX_RESULTS = 500
const MAX_DEPTH = 7

function workspaceRel(abs: string): string {
  return relative(resolve(workspaceRoot()), abs).replace(/\\/g, '/') || '.'
}

function prettyName(path: string): string {
  const base = basename(path)
  return base.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

function inferKind(path: string): AgentZooKind {
  const p = path.toLowerCase().replace(/\\/g, '/')
  if (p.endsWith('src/main/agent/runner.ts')) return 'runtime'
  if (p.includes('/tools/') || p.includes('/tool/') || p.endsWith('/tools.ts') || p.includes('src/main/agent/tools.ts')) return 'tool'
  if (p.includes('/skills/') || p.includes('/skill/')) return 'skill'
  if (p.includes('/agents/') || p.includes('/agent/') || basename(p).startsWith('agent')) return 'agent'
  return 'config'
}

function inferOrigin(path: string): string {
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === '.claude') return 'Claude workspace config'
  if (parts.includes('src') && parts.includes('main') && parts.includes('agent')) return 'ATLIS runtime'
  if (basename(path).toLowerCase() === 'claude.md') return 'Claude instructions'
  return parts[0] ?? 'workspace'
}

function isZooCandidate(path: string): boolean {
  const p = path.toLowerCase().replace(/\\/g, '/')
  const ext = extname(p)
  if (!TEXT_EXTS.has(ext)) return false
  if (basename(p) === 'claude.md') return true
  return (
    p.includes('/.claude/') ||
    p.includes('/agents/') ||
    p.includes('/agent/') ||
    p.includes('/skills/') ||
    p.includes('/skill/') ||
    p.includes('/tools/') ||
    p.includes('/tool/') ||
    p.endsWith('/tools.ts') ||
    p.endsWith('/runner.ts')
  )
}

async function firstDescription(abs: string): Promise<string> {
  try {
    const text = await fsp.readFile(abs, 'utf8')
    const lines = text.split(/\r?\n/).slice(0, 80)
    const descriptionLine = lines.find((l) => /^description\s*[:=]/i.test(l.trim()))
    if (descriptionLine) return descriptionLine.replace(/^description\s*[:=]\s*/i, '').replace(/^['"]|['"],?$/g, '').trim().slice(0, 220)
    const mdLine = lines.find((l) => l.trim() && !l.trim().startsWith('---') && !l.trim().startsWith('#!'))
    return (mdLine ?? '').replace(/^#+\s*/, '').replace(/^\/\/\s*/, '').trim().slice(0, 220)
  } catch {
    return ''
  }
}

async function addIfCandidate(abs: string, seen: Set<string>, entries: AgentZooEntry[]): Promise<void> {
  if (entries.length >= MAX_RESULTS) return
  const rel = workspaceRel(abs)
  if (seen.has(rel) || !isZooCandidate(rel)) return
  seen.add(rel)
  entries.push({
    id: rel,
    name: prettyName(rel),
    kind: inferKind(rel),
    path: rel,
    origin: inferOrigin(rel),
    description: await firstDescription(abs),
    editable: true
  })
}

async function walk(absDir: string, depth: number, seen: Set<string>, entries: AgentZooEntry[]): Promise<void> {
  if (depth > MAX_DEPTH || entries.length >= MAX_RESULTS) return
  let dirents: import('fs').Dirent[]
  try {
    dirents = await fsp.readdir(absDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const d of dirents) {
    if (entries.length >= MAX_RESULTS) return
    const abs = join(absDir, d.name)
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name)) continue
      await walk(abs, depth + 1, seen, entries)
    } else if (d.isFile()) {
      await addIfCandidate(abs, seen, entries)
    }
  }
}

export async function listAgentZoo(): Promise<AgentZooEntry[]> {
  const root = resolve(workspaceRoot())
  const seen = new Set<string>()
  const entries: AgentZooEntry[] = []

  // Prime the list with ATLIS's currently-used runtime files when the repo is in the workspace.
  for (const p of ['ATLIS/src/main/agent/runner.ts', 'ATLIS/src/main/agent/tools.ts', '.claude/settings.local.json']) {
    try {
      await addIfCandidate(resolveWorkspacePath(p), seen, entries)
    } catch {
      // Workspace root may not contain these files; the recursive scan below will still find candidates under the configured root.
    }
  }

  await walk(root, 0, seen, entries)

  const order: Record<AgentZooKind, number> = { agent: 0, skill: 1, tool: 2, runtime: 3, config: 4 }
  return entries.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path))
}

export async function readZooFile(path: string): Promise<string> {
  const abs = resolveWorkspacePath(path)
  return fsp.readFile(abs, 'utf8')
}

export async function saveZooFile(path: string, content: string): Promise<void> {
  const abs = resolveWorkspacePath(path)
  await fsp.writeFile(abs, content, 'utf8')
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'new-agent'
}

export async function createAgentFile(input: { name: string; description?: string; instructions?: string; tools?: string[] }): Promise<AgentZooEntry> {
  const name = input.name.trim()
  if (!name) throw new Error('Agent name is required.')

  const slug = slugify(name)
  const rel = `.claude/agents/${slug}.md`
  const abs = resolveWorkspacePath(rel)
  await fsp.mkdir(dirname(abs), { recursive: true })

  try {
    await fsp.access(abs)
    throw new Error(`An agent already exists at ${rel}.`)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('An agent already exists')) throw err
  }

  const tools = input.tools?.length ? input.tools.map((t) => t.trim()).filter(Boolean) : []
  const description = input.description?.trim() || `${name} agent.`
  const instructions = input.instructions?.trim() || 'Describe this agent’s role, operating style, constraints, and preferred tools here.'
  const content = `---\nname: ${name}\ndescription: ${description}\ntools: [${tools.join(', ')}]\n---\n\n# ${name}\n\n${instructions}\n`
  await fsp.writeFile(abs, content, 'utf8')

  return {
    id: rel,
    name,
    kind: 'agent',
    path: rel,
    origin: 'Claude workspace config',
    description,
    editable: true
  }
}
