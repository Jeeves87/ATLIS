import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Magnet, Plus, FileUp, FolderOpen, Folder, Pause, Play, Trash2, Loader2,
  ArrowDown, ArrowUp, Users, CheckCircle2, AlertTriangle, X
} from 'lucide-react'
import type { TorrentInfo } from '../types'

const fmtBytes = (n: number | null | undefined): string => {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`
}
const fmtSpeed = (n: number): string => `${fmtBytes(n)}/s`
const fmtEta = (sec: number | null): string => {
  if (sec == null || !Number.isFinite(sec)) return '—'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
  return `${Math.floor(sec / 86400)}d`
}

/** ArrayBuffer -> base64, chunked so big-ish files don't blow the arg limit. */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

const STATUS_META: Record<TorrentInfo['status'], { label: string; className: string }> = {
  downloading: { label: 'downloading', className: 'text-volt-400' },
  paused: { label: 'paused', className: 'text-mist-500' },
  done: { label: 'complete · sharing stopped', className: 'text-ok-400' },
  error: { label: 'error', className: 'text-danger-400' }
}

/**
 * Torrents: a deliberately minimal client — add magnets/.torrent files, watch
 * them download, and the engine kills the share the moment a torrent completes.
 */
export default function TorrentsView() {
  const [list, setList] = useState<TorrentInfo[]>([])
  const [dir, setDir] = useState('')
  const [input, setInput] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  useEffect(() => {
    window.atlis.torrents.list().then(setList)
    window.atlis.torrents.getDir().then(setDir)
    return window.atlis.torrents.onChanged(setList)
  }, [])

  const submitAdd = useCallback(async (inputs: Parameters<typeof window.atlis.torrents.add>[0][]) => {
    setAdding(true)
    setAddError(null)
    try {
      for (const inp of inputs) {
        const r = await window.atlis.torrents.add(inp)
        if (!r.ok) setAddError(r.error ?? 'Failed to add torrent')
      }
    } finally {
      setAdding(false)
    }
  }, [])

  const addFromText = async () => {
    const text = input.trim()
    if (!text) return
    if (text.startsWith('magnet:')) await submitAdd([{ magnet: text }])
    else if (/^https?:\/\//i.test(text)) await submitAdd([{ url: text }])
    else {
      setAddError('Paste a magnet: link or an http(s) URL to a .torrent file')
      return
    }
    setInput('')
  }

  const addFiles = async (files: FileList | File[]) => {
    const inputs: { torrentBase64: string; fileName: string }[] = []
    for (const f of Array.from(files)) {
      if (!f.name.toLowerCase().endsWith('.torrent')) continue
      inputs.push({ torrentBase64: toBase64(await f.arrayBuffer()), fileName: f.name })
    }
    if (inputs.length) await submitAdd(inputs)
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (e.dataTransfer.files.length) {
      await addFiles(e.dataTransfer.files)
      return
    }
    const text = e.dataTransfer.getData('text/plain').trim()
    if (text.startsWith('magnet:')) await submitAdd([{ magnet: text }])
  }

  const chooseDir = async () => setDir(await window.atlis.torrents.chooseDir())

  const active = list.filter((t) => t.status === 'downloading')
  const downSpeed = active.reduce((s, t) => s + t.downloadSpeed, 0)
  const upSpeed = active.reduce((s, t) => s + t.uploadSpeed, 0)

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col bg-ink-900"
      onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setDragging(true) }}
      onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {/* header */}
      <div className="flex items-center gap-3 border-b border-ink-600 px-4 py-2.5">
        <Magnet size={15} className="text-volt-400" />
        <span className="text-[13px] font-semibold text-mist-100">Torrents</span>
        <span className="font-mono text-[9.5px] uppercase tracking-wider text-mist-500">
          share ends at 100%
        </span>
        <button
          onClick={chooseDir}
          title={`Download folder: ${dir}\nClick to change`}
          className="ml-auto flex min-w-0 max-w-[340px] items-center gap-1.5 rounded-md border border-ink-600 px-2.5 py-1 text-[11px] text-mist-400 hover:border-pulse-400 hover:text-pulse-400"
        >
          <Folder size={12} className="shrink-0" />
          <span className="truncate font-mono text-[10px]" dir="rtl">{dir}</span>
        </button>
      </div>

      {/* add row */}
      <div className="flex items-center gap-2 border-b border-ink-600 bg-ink-850/50 px-4 py-2.5">
        <input
          value={input}
          onChange={(e) => { setInput(e.target.value); setAddError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') addFromText() }}
          placeholder="Paste a magnet link or a URL to a .torrent file…"
          className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-3 py-1.5 font-mono text-[12px] text-mist-100 placeholder:text-mist-500 focus:border-volt-500 focus:outline-none"
          spellCheck={false}
        />
        <button
          onClick={addFromText}
          disabled={adding || !input.trim()}
          className="flex items-center gap-1 rounded-md border border-volt-500/50 bg-volt-500/15 px-3 py-1.5 text-[12px] font-medium text-volt-400 hover:bg-volt-500/25 disabled:opacity-50"
        >
          {adding ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={adding}
          title="Add .torrent file(s)"
          className="flex items-center gap-1 rounded-md border border-ink-600 px-3 py-1.5 text-[12px] text-mist-400 hover:border-volt-500 hover:text-volt-400 disabled:opacity-50"
        >
          <FileUp size={13} /> .torrent
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".torrent"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = '' }}
        />
      </div>
      {addError && (
        <div className="flex items-center gap-2 border-b border-danger-400/30 bg-danger-400/10 px-4 py-1.5 text-[11.5px] text-danger-400">
          <AlertTriangle size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{addError}</span>
          <button onClick={() => setAddError(null)} className="text-danger-400/70 hover:text-danger-400"><X size={12} /></button>
        </div>
      )}

      {/* totals strip */}
      {list.length > 0 && (
        <div className="flex items-center gap-5 border-b border-ink-600 px-4 py-1.5 font-mono text-[11px]">
          <span className="text-mist-500">{active.length} active · {list.length} total</span>
          <span className="flex items-center gap-1 text-mist-400">
            <ArrowDown size={11} className="text-pulse-400" /> <span className="text-pulse-400">{fmtSpeed(downSpeed)}</span>
          </span>
          <span className="flex items-center gap-1 text-mist-400">
            <ArrowUp size={11} className="text-mist-500" /> {fmtSpeed(upSpeed)}
          </span>
        </div>
      )}

      {/* torrent list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <div className="grid-texture flex h-full flex-col items-center justify-center text-center">
            <Magnet size={34} className="mb-3 text-ink-500" />
            <p className="text-[13px] font-medium text-mist-300">No torrents</p>
            <p className="mt-1 max-w-sm text-[12px] leading-relaxed text-mist-500">
              Paste a magnet link, pick a .torrent file, or drop one anywhere on this page.
              Downloads stop sharing the instant they finish.
            </p>
          </div>
        ) : (
          list.map((t) => (
            <TorrentRowItem
              key={t.id}
              t={t}
              confirming={confirmRemove === t.id}
              onConfirmRemove={(open) => setConfirmRemove(open ? t.id : null)}
            />
          ))
        )}
      </div>

      {/* drop overlay */}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-volt-500 bg-ink-900/80">
          <div className="flex flex-col items-center gap-2 text-volt-400">
            <FileUp size={28} />
            <span className="text-[13px] font-medium">Drop .torrent files to add</span>
          </div>
        </div>
      )}
    </div>
  )
}

function TorrentRowItem({ t, confirming, onConfirmRemove }: {
  t: TorrentInfo
  confirming: boolean
  onConfirmRemove: (open: boolean) => void
}) {
  const meta = STATUS_META[t.status]
  const pct = Math.min(100, t.progress * 100)
  const barColor = t.status === 'done' ? 'bg-ok-400' : t.status === 'error' ? 'bg-danger-400' : t.status === 'paused' ? 'bg-mist-500' : 'bg-volt-500'

  return (
    <div className="group border-b border-ink-700 px-4 py-2.5 hover:bg-ink-850">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {t.status === 'done' && <CheckCircle2 size={12} className="shrink-0 self-center text-ok-400" />}
            <span className="truncate text-[13px] font-medium text-mist-100">{t.name}</span>
            {t.fileCount != null && t.fileCount > 1 && (
              <span className="shrink-0 font-mono text-[10px] text-mist-500">{t.fileCount} files</span>
            )}
          </div>

          {/* progress bar */}
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-700">
            <div className={`h-full rounded-full transition-[width] duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
          </div>

          {/* stats line */}
          <div className="mt-1 flex items-center gap-3 font-mono text-[10px] text-mist-500">
            <span className={meta.className}>{meta.label}</span>
            <span>{t.status === 'done' ? fmtBytes(t.totalBytes) : `${fmtBytes(t.downloadedBytes)} / ${fmtBytes(t.totalBytes)}`}</span>
            <span>{pct.toFixed(t.status === 'downloading' ? 1 : 0)}%</span>
            {t.status === 'downloading' && (
              <>
                <span className="flex items-center gap-0.5 text-pulse-400">
                  <ArrowDown size={9} /> {fmtSpeed(t.downloadSpeed)}
                </span>
                <span className="flex items-center gap-0.5">
                  <ArrowUp size={9} /> {fmtSpeed(t.uploadSpeed)}
                </span>
                <span className="flex items-center gap-0.5">
                  <Users size={9} /> {t.numPeers}
                </span>
                <span>eta {fmtEta(t.etaSec)}</span>
              </>
            )}
            {t.status === 'done' && t.completedAt && <span>finished {new Date(t.completedAt).toLocaleString()}</span>}
            {t.status === 'error' && t.error && <span className="truncate text-danger-400">{t.error}</span>}
          </div>
        </div>

        {/* actions */}
        <div className="flex shrink-0 items-center gap-1">
          {confirming ? (
            <div className="flex items-center gap-1.5 rounded-md border border-danger-400/40 bg-ink-850 px-2 py-1">
              <span className="text-[11px] text-mist-400">Remove?</span>
              <button
                onClick={() => { onConfirmRemove(false); window.atlis.torrents.remove(t.id, false) }}
                className="rounded px-1.5 py-0.5 text-[11px] text-mist-300 hover:bg-ink-700"
              >
                Entry only
              </button>
              <button
                onClick={() => { onConfirmRemove(false); window.atlis.torrents.remove(t.id, true) }}
                className="rounded px-1.5 py-0.5 text-[11px] text-danger-400 hover:bg-danger-400/15"
              >
                + files
              </button>
              <button onClick={() => onConfirmRemove(false)} className="text-mist-500 hover:text-mist-300"><X size={12} /></button>
            </div>
          ) : (
            <>
              {t.status === 'downloading' && (
                <IconBtn title="Pause" onClick={() => window.atlis.torrents.pause(t.id)}><Pause size={14} /></IconBtn>
              )}
              {(t.status === 'paused' || t.status === 'error') && (
                <IconBtn title="Resume" onClick={() => window.atlis.torrents.resume(t.id)}><Play size={14} /></IconBtn>
              )}
              <IconBtn title="Open folder" onClick={() => window.atlis.torrents.openFolder(t.id)}><FolderOpen size={14} /></IconBtn>
              <IconBtn title="Remove" danger onClick={() => onConfirmRemove(true)}><Trash2 size={14} /></IconBtn>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function IconBtn({ title, danger, onClick, children }: {
  title: string
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-mist-500 opacity-0 transition-colors group-hover:opacity-100 ${
        danger ? 'hover:bg-danger-400/15 hover:text-danger-400' : 'hover:bg-ink-700 hover:text-mist-100'
      }`}
    >
      {children}
    </button>
  )
}
