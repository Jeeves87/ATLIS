/**
 * The table's look: which playmat sits under the cards, and how much it's
 * dimmed so cards stay readable on top of it.
 *
 * A playmat is one of:
 *   preset:<id>   a built-in painted backdrop (pure CSS, no files)
 *   commander     your commander's own art, blurred and dimmed
 *   mat:<file>    an image you added (copied into ATLIS's own folder)
 */
import { useEffect, useSyncExternalStore } from 'react'
import { scryfallImage } from '../../../lib/mtgImages'

export interface TableLook {
  mat: string
  /** 0 = image at full strength, 1 = black. */
  dim: number
  blur: number
}

export const PRESETS: Array<{ id: string; label: string; css: string }> = [
  { id: 'grove', label: 'Moonlit grove', css: 'radial-gradient(ellipse at 50% 55%, #22352c 0%, #142019 45%, #0a0f0c 100%)' },
  { id: 'arcane', label: 'Arcane study', css: 'radial-gradient(ellipse at 50% 45%, #2e2550 0%, #1a1630 45%, #0b0a14 100%), repeating-linear-gradient(60deg, rgba(255,255,255,0.025) 0 2px, transparent 2px 46px)' },
  { id: 'gilded', label: 'Gilded hall', css: 'radial-gradient(ellipse at 50% 50%, #3a3142 0%, #221d2a 50%, #110e15 100%), repeating-linear-gradient(45deg, rgba(212,175,95,0.05) 0 1px, transparent 1px 38px), repeating-linear-gradient(-45deg, rgba(212,175,95,0.05) 0 1px, transparent 1px 38px)' },
  { id: 'ember', label: 'Ember forge', css: 'radial-gradient(ellipse at 50% 100%, #5a2414 0%, #2a1310 40%, #0f0908 100%)' },
  { id: 'tide', label: 'Deep tide', css: 'radial-gradient(ellipse at 50% 40%, #12384a 0%, #0c2230 45%, #060d13 100%)' },
  { id: 'slate', label: 'Plain slate', css: 'linear-gradient(180deg, #1a1c21 0%, #101115 100%)' }
]

const DEFAULTS: TableLook = { mat: 'preset:grove', dim: 0.55, blur: 0 }

let look: TableLook = DEFAULTS
let mats: string[] = []
let loaded: Promise<void> | null = null
const listeners = new Set<() => void>()
let snapshot = { look, mats }
const emit = (): void => { snapshot = { look, mats }; listeners.forEach((l) => l()) }

export function loadLook(force = false): Promise<void> {
  if (loaded && !force) return loaded
  loaded = window.atlis.mtg.tableLook().then((r) => {
    look = { ...DEFAULTS, ...((r.look as Partial<TableLook> | null) ?? {}) }
    mats = r.mats
    emit()
  }).catch(() => { /* defaults are fine */ })
  return loaded
}

export function useTableLook(): typeof snapshot {
  useEffect(() => { void loadLook() }, [])
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => snapshot)
}

export function updateLook(patch: Partial<TableLook>): void {
  look = { ...look, ...patch }
  emit()
  void window.atlis.mtg.tableSaveLook(look)
}

export async function importMat(): Promise<string | null> {
  const added = await window.atlis.mtg.tableImportMat()
  await loadLook(true)
  if (added[0]) updateLook({ mat: `mat:${added[0]}`, dim: Math.min(look.dim, 0.45) })
  return added[0] ?? null
}

export async function removeMat(name: string): Promise<void> {
  await window.atlis.mtg.tableRemoveMat(name)
  if (look.mat === `mat:${name}`) updateLook({ mat: DEFAULTS.mat })
  await loadLook(true)
}

export const matUrl = (file: string): string => `atlis-sound://mat/${encodeURIComponent(file)}`

/** CSS background for a playmat. `commanderArt` is a Scryfall id (your commander's printing). */
export function matBackground(mat: string, commanderArt?: string | null): string {
  if (mat.startsWith('mat:')) return `center / cover no-repeat url("${matUrl(mat.slice(4))}")`
  if (mat === 'commander') {
    const img = commanderArt ? scryfallImage(commanderArt, 'art_crop') : null
    if (img) return `center / cover no-repeat url("${img.src}")`
  }
  const p = PRESETS.find((x) => `preset:${x.id}` === mat) ?? PRESETS[0]
  return p.css
}

/** Image mats get the dim overlay; painted presets are already dark. */
export const matIsImage = (mat: string): boolean => mat.startsWith('mat:') || mat === 'commander'
