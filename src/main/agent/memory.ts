import * as db from '../db'

/**
 * Persistent memory, following the Odysseus/Hermes pattern: the agent saves
 * durable declarative facts (who the user is, project constraints, stable
 * preferences) with memory_save; recent memories ride along in every agent
 * system prompt and the rest are reachable via memory_search (FTS5).
 */

const INJECT_LIMIT = 15

export function memoryPromptBlock(): string {
  const total = db.memoryCount()
  if (!total) {
    return `## Memory
You have persistent memory across all sessions. Save durable facts about the user, their projects, and confirmed preferences with memory_save (save declarative facts, not instructions). Search older memories with memory_search.`
  }
  const recent = db.listMemories(undefined, INJECT_LIMIT)
  const lines = recent.map((m) => `- [${m.category}] ${m.text} (id ${m.id.slice(0, 8)})`)
  const more = total > recent.length ? `\n…and ${total - recent.length} more — use memory_search to find them.` : ''
  return `## Memory
You have persistent memory across all sessions (${total} entries). Save new durable facts with memory_save (declarative facts, not instructions); correct wrong ones with memory_update/memory_delete. Most recently touched:
${lines.join('\n')}${more}`
}
