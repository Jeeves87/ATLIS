import { BrowserWindow } from 'electron'
import * as db from './db'
import { getProvider } from './providers'
import { costUsd, energyWh } from './providers/pricing'
import type { ProviderId } from './providers/types'

/**
 * Blind model arena, adapted from Odysseus' Compare: one prompt, two models
 * streaming side by side under anonymous labels, then a human vote. Votes and
 * costs persist to the comparisons table for the leaderboard.
 */

export interface ArenaEvent {
  compareId: string
  side: 'a' | 'b'
  type: 'delta' | 'done' | 'error'
  delta?: string
  error?: string
  latencyMs?: number
  costUsd?: number
}

const ARENA_SYSTEM = 'You are a helpful assistant. Answer the prompt as well as you can. Use markdown when it improves readability.'

const aborts = new Map<string, AbortController>()

export function startComparison(
  win: BrowserWindow,
  opts: { prompt: string; provider_a: string; model_a: string; provider_b: string; model_b: string; is_blind: boolean }
): db.ComparisonRow {
  const row = db.createComparison(opts)
  const abort = new AbortController()
  aborts.set(row.id, abort)

  const emit = (ev: ArenaEvent) => {
    if (!win.isDestroyed()) win.webContents.send('arena:event', ev)
  }

  const runSide = async (side: 'a' | 'b', providerId: string, model: string): Promise<void> => {
    const started = Date.now()
    try {
      const provider = getProvider(providerId)
      const result = await provider.chat({
        model,
        system: ARENA_SYSTEM,
        messages: [{ role: 'user', content: opts.prompt }],
        tools: [],
        handlers: {
          signal: abort.signal,
          onTextDelta: (delta) => emit({ compareId: row.id, side, type: 'delta', delta })
        }
      })
      const latency = Date.now() - started
      const cost = costUsd(providerId as ProviderId, model, result.usage)
      db.addUsage({
        session_id: null,
        project_id: null,
        provider: providerId,
        model,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        cache_read_tokens: result.usage.cacheReadTokens,
        cache_write_tokens: result.usage.cacheWriteTokens,
        cost_usd: cost,
        energy_wh: energyWh(model, result.usage)
      })
      db.patchComparison(row.id, side === 'a'
        ? { response_a: result.text, cost_a: cost, latency_a_ms: latency }
        : { response_b: result.text, cost_b: cost, latency_b_ms: latency })
      emit({ compareId: row.id, side, type: 'done', latencyMs: latency, costUsd: cost })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      db.patchComparison(row.id, { status: 'error', error: `${side.toUpperCase()}: ${msg}` })
      emit({ compareId: row.id, side, type: 'error', error: msg })
    }
  }

  void Promise.allSettled([
    runSide('a', opts.provider_a, opts.model_a),
    runSide('b', opts.provider_b, opts.model_b)
  ]).then(() => {
    aborts.delete(row.id)
    const current = db.getComparison(row.id)
    if (current && current.status !== 'error') db.patchComparison(row.id, { status: 'done' })
  })

  return row
}

export function stopComparison(id: string): void {
  aborts.get(id)?.abort()
}

export function vote(id: string, winner: 'a' | 'b' | 'tie' | 'both_bad'): db.ComparisonRow | undefined {
  db.patchComparison(id, { winner })
  return db.getComparison(id)
}

export interface LeaderboardRow {
  provider: string
  model: string
  wins: number
  losses: number
  ties: number
  battles: number
  winRate: number
  avgCost: number
}

/** Win-rate table across all voted comparisons ("tie"/"both_bad" count as ties). */
export function leaderboard(): LeaderboardRow[] {
  const rows = db.listComparisons(1000).filter((c) => c.winner)
  const byModel = new Map<string, LeaderboardRow & { costSum: number }>()
  const bump = (provider: string, model: string, outcome: 'win' | 'loss' | 'tie', cost: number) => {
    const key = `${provider}/${model}`
    let r = byModel.get(key)
    if (!r) {
      r = { provider, model, wins: 0, losses: 0, ties: 0, battles: 0, winRate: 0, avgCost: 0, costSum: 0 }
      byModel.set(key, r)
    }
    r.battles++
    r.costSum += cost
    if (outcome === 'win') r.wins++
    else if (outcome === 'loss') r.losses++
    else r.ties++
  }
  for (const c of rows) {
    const aOutcome = c.winner === 'a' ? 'win' : c.winner === 'b' ? 'loss' : 'tie'
    const bOutcome = c.winner === 'b' ? 'win' : c.winner === 'a' ? 'loss' : 'tie'
    bump(c.provider_a, c.model_a, aOutcome, c.cost_a)
    bump(c.provider_b, c.model_b, bOutcome, c.cost_b)
  }
  return [...byModel.values()]
    .map((r) => ({ ...r, winRate: r.battles ? r.wins / r.battles : 0, avgCost: r.battles ? r.costSum / r.battles : 0 }))
    .sort((x, y) => y.winRate - x.winRate || y.battles - x.battles)
}
