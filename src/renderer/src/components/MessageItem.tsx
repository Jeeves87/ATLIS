import { memo, useState } from 'react'
import { ChevronRight, TerminalSquare, AlertTriangle, Copy, Check } from 'lucide-react'
import { motion } from 'framer-motion'
import type { ImageAttachment, Message } from '../types'
import { renderContent } from '../lib/markdown'

const mediaUrl = (a: ImageAttachment) => `atlis-media://media/${a.filename}`

/** Thumbnail grid for a message's image attachments; click opens a lightbox. */
function Attachments({ attachments, onOpen }: { attachments: ImageAttachment[]; onOpen: (src: string) => void }) {
  if (!attachments.length) return null
  return (
    <div className="mb-1.5 flex flex-wrap gap-2">
      {attachments.map((a) => (
        <button
          key={a.id}
          onClick={() => onOpen(mediaUrl(a))}
          title={a.name}
          className="overflow-hidden rounded-md border border-ink-600 bg-ink-900 transition-colors hover:border-volt-500/60"
        >
          <img src={mediaUrl(a)} alt={a.name} className="max-h-56 max-w-[16rem] object-contain" />
        </button>
      ))}
    </div>
  )
}

function ToolRow({ message }: { message: Message }) {
  const [open, setOpen] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const payload = message.tool_payload ? JSON.parse(message.tool_payload) : {}
  const isCall = message.kind === 'tool_call'
  const args = isCall ? payload.arguments : null

  return (
    <div className="rounded-md border border-ink-600 bg-ink-850">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left">
        <ChevronRight size={12} className={`text-mist-500 transition-transform ${open ? 'rotate-90' : ''}`} />
        <TerminalSquare size={12} className={isCall ? 'text-volt-400' : 'text-ok-400'} />
        <span className="font-mono text-[11px] text-mist-300">
          {isCall ? 'call' : 'result'} · {message.tool_name}
        </span>
        {isCall && args && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mist-500">{args}</span>
        )}
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto border-t border-ink-600 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-mist-300">
          {isCall ? JSON.stringify(JSON.parse(args || '{}'), null, 2) : message.content_md}
        </pre>
      )}
      {isCall && message.content_md && (
        <div className="prose-atlis border-t border-ink-600 px-3 py-2 text-[13px] text-mist-300" dangerouslySetInnerHTML={{ __html: renderContent(message.content_md) }} />
      )}
      {!isCall && open && message.attachments.length > 0 && (
        <div className="border-t border-ink-600 px-3 py-2">
          <Attachments attachments={message.attachments} onOpen={setLightbox} />
        </div>
      )}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/85 p-8 backdrop-blur-sm"
        >
          <img src={lightbox} alt="" className="max-h-full max-w-full rounded-lg border border-ink-600 object-contain shadow-2xl" />
        </div>
      )}
    </div>
  )
}

// Deterministic fallback palette for roundtable authors without a configured color.
const AUTHOR_PALETTE = ['#7c5cff', '#22d3ee', '#f59e0b', '#34d399', '#f472b6', '#a3e635', '#fb7185', '#60a5fa']
export function authorColor(name: string, configured?: string): string {
  if (configured) return configured
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AUTHOR_PALETTE[h % AUTHOR_PALETTE.length]
}

function MessageItem({ message, authorColors }: { message: Message; authorColors?: Record<string, string> }) {
  const [copied, setCopied] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)

  if (message.kind === 'tool_call' || message.kind === 'tool_result') return <ToolRow message={message} />

  if (message.kind === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-danger-400/40 bg-danger-400/5 px-3 py-2 text-[12.5px] text-danger-400">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span className="whitespace-pre-wrap">{message.content_md}</span>
      </div>
    )
  }

  const isUser = message.role === 'user'
  const copyAsMarkdown = async () => {
    const md = message.content_html && !isUser ? await window.atlis.docs.toMarkdown(renderContent(message.content_md)) : message.content_md
    await navigator.clipboard.writeText(md || message.content_md)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={`group relative ${isUser ? 'self-end' : 'self-stretch'}`}
    >
      <div
        className={
          isUser
            ? 'max-w-xl rounded-lg rounded-br-sm border border-volt-500/30 bg-volt-500/10 px-3.5 py-2.5'
            : 'rounded-lg border border-ink-600/80 bg-ink-850/88 px-3.5 py-3 shadow-sm shadow-ink-950/30 backdrop-blur-[1px]'
        }
      >
        {!isUser && (
          <div className="mb-1 flex items-center gap-2">
            {message.author ? (
              <span className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: authorColor(message.author, authorColors?.[message.author]) }}
                />
                <span
                  className="text-[10px] font-semibold uppercase tracking-[0.18em]"
                  style={{ color: authorColor(message.author, authorColors?.[message.author]) }}
                >
                  {message.author}
                </span>
              </span>
            ) : (
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-volt-400">ATLIS</span>
            )}
            <button
              onClick={copyAsMarkdown}
              title="Copy as Markdown (calculated from HTML)"
              className="hidden text-mist-500 hover:text-mist-300 group-hover:block"
            >
              {copied ? <Check size={11} className="text-ok-400" /> : <Copy size={11} />}
            </button>
          </div>
        )}
        <Attachments attachments={message.attachments} onOpen={setLightbox} />
        {(message.content_md || message.content_html) && (
          <div
            className="prose-atlis text-[13.5px]"
            dangerouslySetInnerHTML={{ __html: isUser && message.content_html ? renderContent(message.content_html) : renderContent(message.content_md) }}
          />
        )}
        {message.kind === 'streaming' && <span className="pulse-dot ml-0.5 inline-block h-3.5 w-1.5 bg-volt-400 align-text-bottom" />}
      </div>

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/85 p-8 backdrop-blur-sm"
        >
          <img src={lightbox} alt="" className="max-h-full max-w-full rounded-lg border border-ink-600 object-contain shadow-2xl" />
        </div>
      )}
    </motion.div>
  )
}

export default memo(MessageItem)
