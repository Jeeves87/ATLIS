import type { Provider, ProviderId } from './types'
import { anthropicProvider } from './anthropic'
import { openaiProvider } from './openai'
import { copilotProvider } from './copilot'
import { lmstudioProvider } from './lmstudio'

const providers: Record<ProviderId, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  copilot: copilotProvider,
  lmstudio: lmstudioProvider
}

export function getProvider(id: string): Provider {
  const p = providers[id as ProviderId]
  if (!p) throw new Error(`Unknown provider: ${id}`)
  return p
}

export const PROVIDER_IDS: ProviderId[] = ['anthropic', 'openai', 'copilot', 'lmstudio']
