/**
 * Table preview: the real GameTable fed a recorded state (?s=target|combat|crowded)
 * through a stand-in for ATLIS's bridge. For checking layout without a game.
 */
import { createRoot } from 'react-dom/client'
import './preview.css'
import fixtures from './fixtures.json'
import { GameTable } from '../../src/renderer/src/components/mtg/game/GameTable'

const which = (new URLSearchParams(location.search).get('s') ?? 'target') as keyof typeof fixtures
const listeners = new Set<(e: unknown) => void>()
const look = { mat: new URLSearchParams(location.search).get('mat') ?? 'preset:gilded', dim: 0.55, blur: 0 }
// ?active=<player id> starts on that player's turn; window.__turn(id) switches turns live.
const active = new URLSearchParams(location.search).get('active')
const withActive = (st: unknown, id: number): unknown => ({ ...(st as object), activePlayer: id })
;(window as unknown as { __turn: (id: number) => void }).__turn = (id) => {
  const f = fixtures[which] as unknown
  listeners.forEach((cb) => cb(withActive(Array.isArray(f) ? f[f.length - 1] : f, id)))
}
// window.__state(fn) sends an edited copy of the fixture's last state (e.g. a seat with other permanents).
;(window as unknown as { __state: (fn: (s: any) => unknown) => void }).__state = (fn) => {
  const f = fixtures[which] as unknown
  const st = structuredClone(Array.isArray(f) ? f[f.length - 1] : f)
  listeners.forEach((cb) => cb(fn(active == null ? st : withActive(st, Number(active))) ?? st))
}
const mtg = {
  // A fixture that is a list of states replays them 700ms apart (for effects that happen between snapshots).
  onGameEvent: (cb: (e: unknown) => void) => {
    listeners.add(cb)
    const raw = fixtures[which] as unknown
    const f = active == null ? raw : Array.isArray(raw) ? raw.map((s) => withActive(s, Number(active))) : withActive(raw, Number(active))
    if (Array.isArray(f)) f.forEach((st, i) => setTimeout(() => cb(st), 50 + i * 700))
    else setTimeout(() => cb(f), 50)
    return () => listeners.delete(cb)
  },
  gameSend: async (cmd: unknown) => { console.log('send', cmd) },
  gameStop: async () => {},
  soundLibrary: async () => ({ settings: { enabled: false, volume: 0.5, events: {} }, forge: [], custom: [] }),
  soundSave: async () => {},
  // ?mats=a.png,b.png pretends those playmats were added (their images won't load here).
  tableLook: async () => ({ look, mats: (new URLSearchParams(location.search).get('mats') ?? '').split(',').filter(Boolean) }),
  tableSaveLook: async () => {}
}
;(window as unknown as { atlis: unknown }).atlis = { mtg }
createRoot(document.getElementById('root')!).render(<GameTable onExit={() => {}} onStatus={() => {}} />)
