import { promises as fsp } from 'fs'
import { join } from 'path'
import { resolveWorkspacePath, workspaceRoot } from '../workspace'

/**
 * Skills system, borrowed from Odysseus: each skill is a folder under
 * <workspace>/skills/<name>/SKILL.md with simple `key: value` frontmatter
 * (name, description, when_to_use) followed by a free-form markdown body
 * (procedure, pitfalls, verification…). Names + descriptions are injected
 * into the agent prompt; the agent pulls the full body on demand with
 * skill_read, and can author new skills with skill_save. The Agent Zoo
 * view already surfaces these files for human editing.
 */

export interface SkillMeta {
  name: string
  description: string
  when_to_use: string
}

const SKILLS_DIR = 'skills'

function skillsRoot(): string {
  return join(workspaceRoot(), SKILLS_DIR)
}

function slugify(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug) throw new Error(`Invalid skill name "${name}".`)
  return slug
}

/** Parse `--- key: value … ---` frontmatter; tolerant of missing fences. */
function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: md }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim()
  }
  return { meta, body: m[2] }
}

export async function listSkills(): Promise<SkillMeta[]> {
  let entries: string[]
  try {
    entries = (await fsp.readdir(skillsRoot(), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return [] // no skills dir yet
  }
  const out: SkillMeta[] = []
  for (const dir of entries.slice(0, 100)) {
    try {
      const md = await fsp.readFile(join(skillsRoot(), dir, 'SKILL.md'), 'utf8')
      const { meta } = parseFrontmatter(md)
      out.push({
        name: meta.name || dir,
        description: meta.description || '(no description)',
        when_to_use: meta.when_to_use || ''
      })
    } catch {
      // folder without SKILL.md — skip
    }
  }
  return out
}

export async function readSkill(name: string): Promise<string> {
  const file = resolveWorkspacePath(join(SKILLS_DIR, slugify(name), 'SKILL.md'))
  return fsp.readFile(file, 'utf8')
}

export async function saveSkill(input: {
  name: string
  description: string
  when_to_use?: string
  body: string
}): Promise<string> {
  const slug = slugify(input.name)
  const dir = resolveWorkspacePath(join(SKILLS_DIR, slug))
  await fsp.mkdir(dir, { recursive: true })
  const md = [
    '---',
    `name: ${slug}`,
    `description: ${(input.description || '').replace(/\r?\n/g, ' ').slice(0, 200)}`,
    `when_to_use: ${(input.when_to_use || '').replace(/\r?\n/g, ' ').slice(0, 400)}`,
    '---',
    '',
    input.body.trim(),
    ''
  ].join('\n')
  const file = join(dir, 'SKILL.md')
  await fsp.writeFile(file, md, 'utf8')
  return file
}

/** Prompt block listing available skills (empty string when none exist). */
export async function skillsPromptBlock(): Promise<string> {
  const skills = await listSkills()
  if (!skills.length) return ''
  const lines = skills.map((s) => `- ${s.name}: ${s.description}${s.when_to_use ? ` (use when: ${s.when_to_use})` : ''}`)
  return `## Skills
You have a library of learned skills (procedures that worked before). Before starting a multi-step task, check whether one applies and load it with skill_read:
${lines.join('\n')}`
}
