import { useEffect, useMemo, useState } from 'react'
import { useAtlis } from '../state/store'
import { APPS } from '../lib/appRegistry'

// celestial-body gradient pairs lifted from the antiquity theme picker
const DIAMONDS: [string, string][] = [
  ['#fccf8a', '#d1a67b'], // helios gold
  ['#d2dddc', '#97a09f'], // eris steel
  ['#a7b777', '#747c5c'], // priapus green
  ['#f9997f', '#b78487'], // eros rose
  ['#c7cfe5', '#989daa'], // pale lavender
  ['#666c93', '#484a5e'] // moon slate
]

const ROMAN: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
]
function toRoman(n: number): string {
  if (n <= 0) return 'nulla'
  let out = ''
  for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v }
  return out
}

// deterministic rng so the star chart doesn't reshuffle on re-render
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function StarChart() {
  const { stars, sparkles, constellations, labels } = useMemo(() => {
    const rnd = mulberry32(1893) // year of Mucha's "Job" poster, obviously
    const stars: { x: number; y: number; r: number; o: number }[] = []
    const sparkles: { x: number; y: number; s: number; o: number; slow: boolean }[] = []
    for (let i = 0; i < 130; i++) {
      const x = rnd() * 1200
      const y = rnd() * 800
      if (i % 9 === 0) sparkles.push({ x, y, s: 0.5 + rnd() * 1.1, o: 0.3 + rnd() * 0.45, slow: rnd() > 0.5 })
      else stars.push({ x, y, r: 0.5 + rnd() * 1.1, o: 0.15 + rnd() * 0.45 })
    }
    const constellations: string[] = []
    for (let c = 0; c < 5; c++) {
      const cx = 100 + rnd() * 1000
      const cy = 80 + rnd() * 560
      let px = cx
      let py = cy
      const pts = [`M ${px.toFixed(1)} ${py.toFixed(1)}`]
      for (let s = 0; s < 3 + Math.floor(rnd() * 3); s++) {
        px += (rnd() - 0.5) * 220
        py += (rnd() - 0.5) * 160
        pts.push(`L ${px.toFixed(1)} ${py.toFixed(1)}`)
      }
      constellations.push(pts.join(' '))
    }
    const names = ['wasp-512', 'ngc-5325', 'sagittae β', 'hd 32518', 'polaris', 'zenith']
    const labels = names.map((t) => ({ t, x: 60 + rnd() * 1080, y: 50 + rnd() * 680 }))
    return { stars, sparkles, constellations, labels }
  }, [])

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1200 800"
      preserveAspectRatio="xMidYMid slice"
    >
      {/* faint stars */}
      {stars.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="var(--antiq-text-light)" opacity={s.o} />
      ))}
      {/* four-point sparkle stars */}
      {sparkles.map((s, i) => (
        <path
          key={i}
          d="M 0 -7 L 1.6 -1.6 L 7 0 L 1.6 1.6 L 0 7 L -1.6 1.6 L -7 0 L -1.6 -1.6 Z"
          transform={`translate(${s.x} ${s.y}) scale(${s.s})`}
          fill="var(--antiq-text-light)"
          opacity={s.o}
          className={s.slow ? 'antiq-twinkle' : undefined}
          style={s.slow ? { animationDelay: `${(i * 0.7) % 4}s` } : undefined}
        />
      ))}
      {/* constellation line-work */}
      {constellations.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--antiq-pattern)" strokeWidth="0.7" opacity="0.35" />
      ))}
      {/* imagined catalogue labels */}
      {labels.map((l, i) => (
        <text
          key={i}
          x={l.x}
          y={l.y}
          fontSize="9"
          fontStyle="italic"
          fill="var(--antiq-text-light)"
          opacity="0.28"
          fontFamily="var(--antiq-serif)"
        >
          {l.t}
        </text>
      ))}
      {/* orbital rings around the emblem */}
      <g opacity="0.3">
        <circle cx="600" cy="330" r="235" fill="none" stroke="var(--antiq-pattern)" strokeWidth="0.8" strokeDasharray="1 7" />
        <circle cx="600" cy="330" r="300" fill="none" stroke="var(--antiq-pattern)" strokeWidth="0.6" strokeDasharray="5 9" />
        <ellipse cx="600" cy="330" rx="420" ry="330" fill="none" stroke="var(--antiq-pattern)" strokeWidth="0.5" strokeDasharray="1 10" />
      </g>
      {/* protractor chart, bottom-left */}
      <g opacity="0.35" stroke="var(--antiq-highlight)" fill="none">
        {[70, 115, 160].map((r) => (
          <circle key={r} cx="30" cy="770" r={r} strokeWidth="0.8" />
        ))}
        {Array.from({ length: 7 }, (_, i) => {
          const a = (i * 15 - 90) * (Math.PI / 180)
          return (
            <line
              key={i}
              x1={30 + Math.cos(a) * 55}
              y1={770 + Math.sin(a) * 55}
              x2={30 + Math.cos(a) * 175}
              y2={770 + Math.sin(a) * 175}
              strokeWidth="0.6"
            />
          )
        })}
      </g>
      {/* illumination of terra — the curved horizon glow */}
      <ellipse cx="600" cy="1010" rx="850" ry="230" fill="var(--antiq-text-light)" opacity="0.05" />
      <ellipse cx="600" cy="1030" rx="850" ry="230" fill="none" stroke="var(--antiq-text-light)" opacity="0.14" strokeWidth="1" />
    </svg>
  )
}

/** Sun-with-a-face, art-nouveau style; rays rotate imperceptibly slowly */
function SunEmblem() {
  const rays = Array.from({ length: 16 }, (_, i) => i)
  return (
    <svg width="130" height="130" viewBox="-65 -65 130 130">
      <g className="antiq-rays">
        {rays.map((i) => (
          <path
            key={i}
            d={i % 2 === 0 ? 'M -6 -38 L 0 -62 L 6 -38 Z' : 'M -5 -38 L 0 -50 L 5 -38 Z'}
            transform={`rotate(${i * 22.5})`}
            fill="var(--antiq-accent)"
            stroke="var(--antiq-accent-dark)"
            strokeWidth="1"
          />
        ))}
      </g>
      <circle r="36" fill="var(--antiq-accent)" stroke="var(--antiq-accent-dark)" strokeWidth="1.5" />
      {/* serene closed eyes, small nose, faint smile */}
      <g stroke="#6b4f2a" strokeWidth="1.8" fill="none" strokeLinecap="round">
        <path d="M -20 -6 q 6 5 12 0" />
        <path d="M 8 -6 q 6 5 12 0" />
        <path d="M -1 2 q 3 4 0 7" />
        <path d="M -9 18 q 9 6 18 0" />
      </g>
      <circle cx="-22" cy="10" r="4.5" fill="#c98a5b" opacity="0.35" />
      <circle cx="22" cy="10" r="4.5" fill="#c98a5b" opacity="0.35" />
    </svg>
  )
}

/** Crescent moon with a sleeping face, for the night hours */
function MoonEmblem() {
  return (
    <svg width="130" height="130" viewBox="-65 -65 130 130">
      <g opacity="0.5">
        {Array.from({ length: 8 }, (_, i) => (
          <path
            key={i}
            d="M 0 -3.5 L 0.9 -0.9 L 3.5 0 L 0.9 0.9 L 0 3.5 L -0.9 0.9 L -3.5 0 L -0.9 -0.9 Z"
            transform={`rotate(${i * 45}) translate(0 -52)`}
            fill="var(--antiq-text-light)"
          />
        ))}
      </g>
      <circle r="36" fill="#c7cfe5" stroke="var(--antiq-moon)" strokeWidth="1.5" />
      <circle cx="16" cy="-12" r="30" fill="var(--antiq-base)" />
      {/* the sliver keeps a sleeping profile */}
      <g stroke="var(--antiq-moon)" strokeWidth="1.8" fill="none" strokeLinecap="round">
        <path d="M -26 -8 q 5 4 10 0" />
        <path d="M -25 12 q 5 4 10 0" />
      </g>
      <circle cx="-14" cy="24" r="3" fill="var(--antiq-moon)" opacity="0.3" />
    </svg>
  )
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export default function HubView() {
  const { setView, sessions, projects, disabledApps } = useAtlis()
  // tarot-style destination cards, mirroring the NavRail order (sans the hub itself)
  const cards = APPS.filter((a) => a.view !== 'hub' && (a.core || !disabledApps.includes(a.view)))
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const hour = now.getHours()
  const isDay = hour >= 6 && hour < 19
  const greeting = hour < 5 ? 'the small hours' : hour < 12 ? 'good morning' : hour < 18 ? 'good afternoon' : 'good evening'
  const hh = String(hour).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const dateLine = `${toRoman(now.getDate())} · ${MONTHS[now.getMonth()]} · ${toRoman(now.getFullYear())}`

  return (
    <div className="antiq relative min-h-0 flex-1 overflow-y-auto">
      <StarChart />

      <div className="relative z-10 flex min-h-full flex-col items-center px-8 pb-10 pt-6">
        {/* chart heading, like an old plate engraving */}
        <div className="flex w-full items-baseline justify-between text-[11px] opacity-70">
          <span className="antiq-smallcaps tracking-[0.3em]">atlis</span>
          <span className="antiq-caption">tabula systematis · plate {toRoman((now.getMonth() + 1))}</span>
        </div>

        {/* celestial centerpiece */}
        <div className="mt-8 flex flex-col items-center">
          {isDay ? <SunEmblem /> : <MoonEmblem />}
          <div className="mt-4 text-5xl tracking-wide text-[var(--antiq-accent)]" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {hh}:{mm}
          </div>
          <div className="antiq-smallcaps mt-2 text-sm text-[var(--antiq-text-light)] opacity-80">{dateLine}</div>
          <div className="antiq-caption mt-1 text-sm">{greeting}</div>
        </div>

        {/* the deck of destinations */}
        <div className="mt-10 flex max-w-[1060px] flex-wrap justify-center gap-4">
          {cards.map(({ view, icon: Icon, label, motto }, i) => {
            const [c1, c2] = DIAMONDS[i % DIAMONDS.length]
            return (
              <button key={view} className="antiq-card group text-left" onClick={() => setView(view)}>
                <div className="flex items-baseline justify-between px-1">
                  <span className="text-[10px] tracking-[0.2em] text-[var(--antiq-accent-dark)]">{toRoman(i + 1)}</span>
                  <span className="text-[10px] text-[var(--antiq-accent-dark)]">✶</span>
                </div>
                <div className="mt-4 mb-5 flex justify-center">
                  <div className="antiq-diamond" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
                    <Icon size={19} strokeWidth={1.7} color="#121212" />
                  </div>
                </div>
                <div className="antiq-smallcaps text-center text-[13px] text-[var(--antiq-accent)]">{label}</div>
                <div className="antiq-caption text-center text-[10px] opacity-0 transition-opacity duration-200 group-hover:opacity-80">
                  {motto}
                </div>
              </button>
            )
          })}
        </div>

        {/* ledger line */}
        <div className="antiq-smallcaps mt-auto pt-10 text-[11px] tracking-[0.22em] opacity-60">
          {toRoman(sessions.length)} sessions · {toRoman(projects.length)} projects
        </div>
      </div>
    </div>
  )
}
