export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(Math.round(n))
}

export function fmtUsd(n: number): string {
  if (n >= 100) return '$' + n.toFixed(0)
  if (n >= 1) return '$' + n.toFixed(2)
  return '$' + n.toFixed(4)
}

export function fmtWh(wh: number): string {
  if (wh >= 1000) return (wh / 1000).toFixed(2) + ' kWh'
  if (wh >= 1) return wh.toFixed(2) + ' Wh'
  return (wh * 1000).toFixed(1) + ' mWh'
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  copilot: 'Copilot',
  lmstudio: 'LM Studio'
}

export const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#d97757',
  openai: '#34d399',
  copilot: '#7c5cff',
  lmstudio: '#22d3ee'
}
