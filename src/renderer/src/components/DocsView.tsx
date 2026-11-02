import { useEffect, useState } from 'react'
import { FileText, Trash2, Copy, Check, Code2, Eye } from 'lucide-react'
import type { Doc, DocMeta } from '../types'
import { sanitizeHtml } from '../lib/markdown'
import { fmtTime } from '../lib/format'

/**
 * Document library. HTML is the native, stored format (the agent authors HTML
 * via save_document); Markdown is *calculated* from it on demand — the
 * HTML > Markdown cascade.
 */
export default function DocsView() {
  const [docs, setDocs] = useState<DocMeta[]>([])
  const [active, setActive] = useState<Doc | null>(null)
  const [mode, setMode] = useState<'html' | 'md'>('html')
  const [md, setMd] = useState('')
  const [copied, setCopied] = useState(false)

  const refresh = () => window.atlis.docs.list().then(setDocs)

  useEffect(() => {
    refresh()
    return window.atlis.docs.onChanged(refresh)
  }, [])

  useEffect(() => {
    if (active && mode === 'md') window.atlis.docs.toMarkdown(active.html).then(setMd)
  }, [active?.id, mode])

  const open = async (id: string) => {
    const doc = await window.atlis.docs.get(id)
    if (doc) {
      setActive(doc)
      setMode('html')
    }
  }

  const copyCurrent = async () => {
    if (!active) return
    await navigator.clipboard.writeText(mode === 'html' ? active.html : md)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r border-ink-600 bg-ink-850">
        <div className="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-mist-500">
          Documents <span className="ml-1 text-mist-500/60">· HTML native</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {docs.length === 0 && (
            <p className="mt-8 px-3 text-center text-[11.5px] leading-relaxed text-mist-500">
              Nothing saved yet. Ask an agent to research something — it persists findings here as native HTML documents.
            </p>
          )}
          {docs.map((d) => (
            <div
              key={d.id}
              onClick={() => open(d.id)}
              className={`group mb-1 flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 transition-colors ${
                active?.id === d.id ? 'border-volt-500/50 bg-volt-500/10' : 'border-transparent hover:border-ink-600 hover:bg-ink-800'
              }`}
            >
              <FileText size={13} className="shrink-0 text-pulse-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium">{d.title}</div>
                <div className="font-mono text-[10px] text-mist-500">{fmtTime(d.updated_at)}</div>
              </div>
              <button
                onClick={async (e) => {
                  e.stopPropagation()
                  await window.atlis.docs.remove(d.id)
                  if (active?.id === d.id) setActive(null)
                  refresh()
                }}
                className="hidden shrink-0 text-mist-500 hover:text-danger-400 group-hover:block"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {active ? (
          <>
            <div className="flex h-11 shrink-0 items-center gap-3 border-b border-ink-600 bg-ink-850 px-4">
              <span className="truncate text-[13px] font-semibold">{active.title}</span>
              <div className="flex-1" />
              <div className="flex overflow-hidden rounded-md border border-ink-600 text-[10.5px]">
                <button
                  onClick={() => setMode('html')}
                  className={`flex items-center gap-1 px-2.5 py-1 ${mode === 'html' ? 'bg-volt-500/20 text-volt-400' : 'text-mist-500 hover:bg-ink-700'}`}
                >
                  <Eye size={11} /> HTML (native)
                </button>
                <button
                  onClick={() => setMode('md')}
                  className={`flex items-center gap-1 px-2.5 py-1 ${mode === 'md' ? 'bg-volt-500/20 text-volt-400' : 'text-mist-500 hover:bg-ink-700'}`}
                >
                  <Code2 size={11} /> Markdown (calculated)
                </button>
              </div>
              <button onClick={copyCurrent} className="flex items-center gap-1 rounded border border-ink-600 px-2 py-1 text-[10.5px] text-mist-400 hover:text-mist-200">
                {copied ? <Check size={11} className="text-ok-400" /> : <Copy size={11} />}
                Copy {mode === 'md' ? '.md' : '.html'}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              {mode === 'html' ? (
                <div className="prose-atlis mx-auto max-w-3xl text-[13.5px]" dangerouslySetInnerHTML={{ __html: sanitizeHtml(active.html) }} />
              ) : (
                <pre className="mx-auto max-w-3xl font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-mist-300">{md || 'calculating…'}</pre>
              )}
            </div>
          </>
        ) : (
          <div className="grid-texture flex flex-1 items-center justify-center text-[12.5px] text-mist-500">
            Select a document — rendered natively as HTML, exportable as calculated Markdown.
          </div>
        )}
      </div>
    </div>
  )
}
