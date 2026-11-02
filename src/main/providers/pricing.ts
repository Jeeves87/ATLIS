import type { ProviderId, TokenUsage } from './types'

/**
 * Pricing (USD per million tokens) and energy model (joules per token).
 *
 * Prices follow published list prices; entries are matched by longest prefix so
 * dated model ids (e.g. claude-sonnet-4-6-20250930) resolve. Energy figures are
 * estimates — no provider publishes per-token energy, so we model it from public
 * research (epoch.ai / academic inference-power studies): an output token on a
 * frontier-class model ≈ 4-6 J at the datacenter (GPU + overhead, PUE ~1.2),
 * mid-size ≈ 2 J, small ≈ 0.5 J. Input tokens cost roughly a tenth of output.
 * The point of these numbers is honest orders of magnitude, not precision.
 */

export interface ModelMeta {
  inPerM: number // USD / 1M input tokens
  outPerM: number // USD / 1M output tokens
  cacheReadPerM: number
  cacheWritePerM: number
  joulesPerOutputToken: number
  tier: 'frontier' | 'mid' | 'small'
}

const M = (inPerM: number, outPerM: number, j: number, tier: ModelMeta['tier'], cacheRead?: number, cacheWrite?: number): ModelMeta => ({
  inPerM,
  outPerM,
  cacheReadPerM: cacheRead ?? inPerM * 0.1,
  cacheWritePerM: cacheWrite ?? inPerM * 1.25,
  joulesPerOutputToken: j,
  tier
})

// Longest-prefix match table. Copilot is subscription-billed (premium requests),
// so marginal $ is 0 — energy still counts.
const TABLE: Record<string, ModelMeta> = {
  // Anthropic
  'claude-fable-5': M(5, 25, 5, 'frontier'),
  'claude-opus-4-8': M(5, 25, 5, 'frontier'),
  'claude-opus-4-5': M(5, 25, 5, 'frontier'),
  'claude-opus-4-1': M(15, 75, 6, 'frontier'),
  'claude-sonnet-4-6': M(3, 15, 2.5, 'mid'),
  'claude-sonnet-4-5': M(3, 15, 2.5, 'mid'),
  'claude-haiku-4-5': M(1, 5, 0.8, 'small'),
  'claude-3-5-haiku': M(0.8, 4, 0.6, 'small'),
  // OpenAI
  'gpt-5.1': M(1.25, 10, 4, 'frontier'),
  'gpt-5-mini': M(0.25, 2, 1, 'mid'),
  'gpt-5-nano': M(0.05, 0.4, 0.3, 'small'),
  'gpt-5': M(1.25, 10, 4, 'frontier'),
  'gpt-4.1-mini': M(0.4, 1.6, 1, 'mid'),
  'gpt-4.1': M(2, 8, 3, 'mid'),
  'gpt-4o-mini': M(0.15, 0.6, 0.8, 'small'),
  'gpt-4o': M(2.5, 10, 3, 'mid'),
  'o3': M(2, 8, 4, 'frontier'),
  'o4-mini': M(1.1, 4.4, 1.5, 'mid')
}

const FALLBACK = M(3, 15, 3, 'mid')

export function metaFor(model: string): ModelMeta {
  const key = Object.keys(TABLE)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  return key ? TABLE[key] : FALLBACK
}

export function costUsd(provider: ProviderId, model: string, u: TokenUsage): number {
  if (provider === 'copilot') return 0 // subscription-billed
  if (provider === 'lmstudio') return 0 // runs on the user's own GPU
  const m = metaFor(model)
  return (
    (u.inputTokens / 1e6) * m.inPerM +
    (u.outputTokens / 1e6) * m.outPerM +
    (u.cacheReadTokens / 1e6) * m.cacheReadPerM +
    (u.cacheWriteTokens / 1e6) * m.cacheWritePerM
  )
}

export function energyWh(model: string, u: TokenUsage): number {
  const m = metaFor(model)
  const joules =
    u.outputTokens * m.joulesPerOutputToken +
    (u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens) * m.joulesPerOutputToken * 0.1
  return joules / 3600
}
