import { useState } from 'react'
import { X, Loader2, PlaySquare, MessageSquare, Rss, Globe } from 'lucide-react'

/**
 * Add-a-source dialog. One free-form box: paste a YouTube channel/@handle, a
 * subreddit (r/…), or any blog/RSS URL — the main process auto-detects the kind
 * and resolves a fetchable feed (with light RSS auto-discovery).
 */
export default function AddSourceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const value = input.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.atlis.feed.addSource(value)
      onAdded()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-ink-950/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[460px] rounded-lg border border-ink-600 bg-ink-850 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-600 px-4 py-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-mist-400">Add source</span>
          <button onClick={onClose} className="rounded p-1 text-mist-500 hover:bg-ink-700 hover:text-mist-200">
            <X size={14} />
          </button>
        </div>

        <div className="p-4">
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onClose()
            }}
            placeholder="YouTube channel, r/subreddit, or blog / RSS URL…"
            className="w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-[13px] text-mist-100 placeholder:text-mist-500 focus:border-volt-500 focus:outline-none"
          />

          <div className="mt-3 grid grid-cols-1 gap-1.5 text-[11px] text-mist-500">
            <Example icon={PlaySquare} color="#ff5252" text="https://youtube.com/@mkbhd  ·  @veritasium" />
            <Example icon={MessageSquare} color="#ff7a3c" text="r/programming  ·  reddit.com/r/LocalLLaMA" />
            <Example icon={Rss} color="#22d3ee" text="https://simonwillison.net/atom/everything/  ·  a blog URL" />
            <Example icon={Globe} color="#d97757" text="anthropic  ·  anthropic.com/news  (feedless sites)" />
          </div>

          {error && (
            <div className="mt-3 rounded border border-danger-400/40 bg-danger-400/10 px-3 py-2 text-[11.5px] text-danger-400">
              {error}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-ink-600 px-3 py-1.5 text-[12px] text-mist-300 hover:bg-ink-700"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={busy || !input.trim()}
              className="flex items-center gap-1.5 rounded-md border border-volt-500/50 bg-volt-500/15 px-3 py-1.5 text-[12px] font-medium text-volt-300 hover:bg-volt-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              {busy ? 'Resolving…' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Example({ icon: Icon, color, text }: { icon: typeof Rss; color: string; text: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon size={12} style={{ color }} className="shrink-0" />
      <span className="truncate font-mono">{text}</span>
    </div>
  )
}
