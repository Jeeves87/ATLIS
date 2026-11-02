/**
 * Arrows over the table, measured from the DOM: attackers → what they're
 * attacking, blockers → what they block, and the top of the stack → its
 * targets. Elements carry data-cid (cards) / data-pid (players); positions
 * are re-measured after every state change and on resize.
 */
import { useLayoutEffect, useState, type RefObject } from 'react'
import type { GameState } from '../../../types'

interface Arrow { x1: number; y1: number; x2: number; y2: number; kind: 'attack' | 'block' | 'target' }

const COLOR: Record<Arrow['kind'], string> = { attack: '#fb923c', block: '#38bdf8', target: '#f87171' }

export default function Arrows({ state, root }: { state: GameState | null; root: RefObject<HTMLDivElement | null> }): React.JSX.Element | null {
  const [arrows, setArrows] = useState<Arrow[]>([])

  useLayoutEffect(() => {
    const measure = (): void => {
      const host = root.current
      if (!host || !state) { setArrows([]); return }
      const base = host.getBoundingClientRect()
      const center = (sel: string): { x: number; y: number } | null => {
        const el = host.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2 }
      }
      const out: Arrow[] = []
      for (const c of state.combat) {
        const a = center(`[data-cid="${c.attacker}"]`)
        const d = c.defender == null ? null : center(c.defenderIsPlayer ? `[data-pid="${c.defender}"]` : `[data-cid="${c.defender}"]`)
        if (a && d && !c.blockers.length) out.push({ x1: a.x, y1: a.y, x2: d.x, y2: d.y, kind: 'attack' })
        for (const b of c.blockers) {
          const bp = center(`[data-cid="${b}"]`)
          if (a && bp) out.push({ x1: bp.x, y1: bp.y, x2: a.x, y2: a.y, kind: 'block' })
        }
      }
      // Only the top of the stack: that's what resolves next.
      const top = state.stack[0]
      if (top) {
        const from = center(`[data-stack="${top.id}"]`) ?? (top.source != null ? center(`[data-cid="${top.source}"]`) : null)
        for (const t of top.targetCards) { const p = center(`[data-cid="${t}"]`); if (from && p) out.push({ x1: from.x, y1: from.y, x2: p.x, y2: p.y, kind: 'target' }) }
        for (const t of top.targetPlayers) { const p = center(`[data-pid="${t}"]`); if (from && p) out.push({ x1: from.x, y1: from.y, x2: p.x, y2: p.y, kind: 'target' }) }
      }
      setArrows(out)
    }
    // After the browser lays out the new cards.
    const raf = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', measure) }
  }, [state, root])

  if (!arrows.length) return null
  return (
    <svg className="pointer-events-none absolute inset-0 z-30 h-full w-full overflow-visible">
      <defs>
        {(Object.keys(COLOR) as Arrow['kind'][]).map((k) => (
          <marker key={k} id={`ah-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={COLOR[k]} />
          </marker>
        ))}
      </defs>
      {arrows.map((a, i) => {
        // A gentle curve reads better than a straight line across the table.
        const mx = (a.x1 + a.x2) / 2 + (a.y2 - a.y1) * 0.12
        const my = (a.y1 + a.y2) / 2 - (a.x2 - a.x1) * 0.12
        const d = `M${a.x1},${a.y1} Q${mx},${my} ${a.x2},${a.y2}`
        return (
          <g key={i}>
            {/* A soft glow under every line; targets get a flowing beam on top. */}
            <path d={d} fill="none" stroke={COLOR[a.kind]} strokeWidth={a.kind === 'target' ? 12 : 9} strokeOpacity={0.22} strokeLinecap="round" style={{ filter: 'blur(4px)' }} />
            <path d={d} fill="none" stroke={COLOR[a.kind]} strokeWidth={3} strokeOpacity={0.9} strokeLinecap="round"
              strokeDasharray={a.kind === 'target' ? '14 8' : undefined} markerEnd={`url(#ah-${a.kind})`}
              style={a.kind === 'target' ? { animation: 'atlis-beam 0.6s linear infinite' } : undefined} />
          </g>
        )
      })}
    </svg>
  )
}
