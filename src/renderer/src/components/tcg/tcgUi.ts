import { tcgplayerImage, type ImageRef, type ImageSize } from '../../lib/mtgImages'
import type { TcgPrinting } from '../../types'

/** Shared bits for the non-Magic card views on the Magic page. */

export type Tone = { tone: 'ok' | 'bad'; text: string }

export const money = (n: number | null | undefined): string =>
  n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Main throws a readable message; Electron wraps it in its own IPC preamble. */
export const clean = (err: unknown): string =>
  String(err instanceof Error ? err.message : err).replace(/^.*?Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')

export const num = (s: string): number | null => {
  if (!s.trim()) return null
  const n = Number(s.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return 'never'
  const m = Math.round((Date.now() - ts) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

/**
 * TCGplayer serves card scans and sealed product shots from the same CDN,
 * keyed by product id — the same helper the Magic page uses for sealed. Only
 * the shape differs: a card is a 5:7 portrait, a box sits square on white.
 */
export function cardImage(productId: string, size: ImageSize, sealed: boolean): ImageRef | null {
  const ref = tcgplayerImage(productId, size)
  return ref ? { ...ref, shape: sealed ? 'product' : 'card' } : null
}

/** The printings a product can be tracked in. Sealed has no finish; foil-only cards have one. */
export const printingsOf = (p: { sealed: boolean; foilOnly?: boolean }): TcgPrinting[] =>
  p.sealed ? ['Normal'] : p.foilOnly ? ['Foil'] : ['Normal', 'Foil']

export const printingLabel = (printing: TcgPrinting, sealed: boolean): string =>
  sealed ? '' : printing === 'Foil' ? 'foil' : 'reg'
