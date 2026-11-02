import { LayoutGrid } from 'lucide-react'
import { useAtlis } from '../state/store'
import { APPS } from '../lib/appRegistry'

export default function AppSelector() {
  const { disabledApps, toggleApp } = useAtlis()
  const toggleable = APPS.filter((a) => !a.core)
  return (
    <section className="mt-4 rounded-lg border border-ink-600 bg-ink-800 p-5">
      <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist-400">
        <LayoutGrid size={13} className="text-volt-400" /> App selector
        <span className="font-normal normal-case tracking-normal text-mist-500">— choose which apps appear in ATLIS</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {toggleable.map(({ view, icon: Icon, label }) => {
          const on = !disabledApps.includes(view)
          return (
            <button
              key={view}
              onClick={() => toggleApp(view)}
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] transition-colors ${
                on
                  ? 'border-ink-600 bg-ink-900 text-mist-200 hover:border-volt-500'
                  : 'border-ink-700 bg-ink-850 text-mist-500 opacity-60 hover:opacity-90'
              }`}
            >
              <Icon size={14} strokeWidth={1.8} className={on ? 'text-volt-400' : undefined} />
              <span className="flex-1 text-left">{label}</span>
              <span className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-ok-400' : 'bg-ink-600'}`} />
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-[10.5px] text-mist-500">
        Hidden apps vanish from the nav rail and hub, and Feed pauses its background refresh while hidden. Nothing is
        uninstalled — flip any of them back on here whenever you like.
      </p>
    </section>
  )
}
