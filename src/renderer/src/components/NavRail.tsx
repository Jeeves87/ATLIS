import { useAtlis } from '../state/store'
import { APPS } from '../lib/appRegistry'

export default function NavRail() {
  const { view, setView, disabledApps } = useAtlis()
  const items = APPS.filter((a) => a.core || !disabledApps.includes(a.view))
  return (
    <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-ink-600 bg-ink-850 py-3">
      {items.map(({ view: v, icon: Icon, label }) => (
        <button
          key={v}
          title={label}
          onClick={() => setView(v)}
          className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
            view === v ? 'bg-volt-500/15 text-volt-400' : 'text-mist-500 hover:bg-ink-700 hover:text-mist-300'
          }`}
        >
          {view === v && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-volt-500" />}
          <Icon size={17} strokeWidth={1.8} />
        </button>
      ))}
    </nav>
  )
}
