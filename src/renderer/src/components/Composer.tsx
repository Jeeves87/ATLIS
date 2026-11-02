import { useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Bold, Italic, Code, List, ListOrdered, Quote, SendHorizonal, Braces, ImagePlus, X, Globe } from 'lucide-react'
import { useAtlis } from '../state/store'
import { withPageContext } from '../lib/pageContext'
import type { PageCapture, PendingAttachment } from '../types'

type LocalAttachment = PendingAttachment & { id: string; previewUrl: string }

let attachSeq = 0

function fileToPending(file: File): Promise<LocalAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve({
        id: `att-${++attachSeq}`,
        mime: file.type || 'image/png',
        name: file.name || 'pasted-image.png',
        dataBase64: dataUrl.split(',')[1] ?? '',
        previewUrl: dataUrl
      })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export default function Composer({ sessionId, running }: { sessionId: string; running: boolean }) {
  const loadMessages = useAtlis((s) => s.loadMessages)
  const pendingPage = useAtlis((s) => s.pendingPage)
  const stagePage = useAtlis((s) => s.stagePage)
  const [attachments, setAttachments] = useState<LocalAttachment[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // The TipTap key handler is created once, so read live values through refs.
  const attachmentsRef = useRef<LocalAttachment[]>([])
  const runningRef = useRef(running)
  const pageRef = useRef<PageCapture | null>(pendingPage)
  useEffect(() => { attachmentsRef.current = attachments }, [attachments])
  useEffect(() => { runningRef.current = running }, [running])
  useEffect(() => { pageRef.current = pendingPage }, [pendingPage])

  const addFiles = async (files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    const pending = await Promise.all(images.map(fileToPending))
    setAttachments((prev) => [...prev, ...pending])
  }

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id))

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Message ATLIS — Enter to send, Shift+Enter for a new line…' })
    ],
    editorProps: {
      attributes: { class: 'tiptap text-[13.5px]' },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          send()
          return true
        }
        return false
      },
      handlePaste: (_view, event) => {
        const files = event.clipboardData?.files
        if (files && files.length && Array.from(files).some((f) => f.type.startsWith('image/'))) {
          addFiles(files)
          return true
        }
        return false
      }
    }
  })

  const send = async () => {
    if (!editor || runningRef.current) return
    const text = editor.getText().trim()
    const pending = attachmentsRef.current
    const page = pageRef.current
    if (!text && !pending.length && !page) return
    // HTML is the native format; markdown is calculated from it for the model
    let html = text ? editor.getHTML() : ''
    let md = text ? await window.atlis.docs.toMarkdown(html) : ''
    // the model gets the full page text; the transcript shows only a compact link
    if (page) ({ md, html } = withPageContext(md, html, page))
    const payload: PendingAttachment[] = pending.map((a) => ({ mime: a.mime, name: a.name, dataBase64: a.dataBase64 }))
    editor.commands.clearContent()
    setAttachments([])
    stagePage(null)
    await window.atlis.chat.send(sessionId, md || text, html, payload)
    loadMessages(sessionId)
  }

  const Btn = ({ onClick, active, children, title }: { onClick: () => void; active?: boolean; children: React.ReactNode; title: string }) => (
    <button
      onMouseDown={(e) => {
        e.preventDefault()
        onClick()
      }}
      title={title}
      className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
        active ? 'bg-volt-500/20 text-volt-400' : 'text-mist-500 hover:bg-ink-700 hover:text-mist-300'
      }`}
    >
      {children}
    </button>
  )

  if (!editor) return null

  return (
    <div className="shrink-0 border-t border-ink-600 bg-ink-850 px-5 py-3">
      <div
        className={`relative mx-auto max-w-3xl overflow-hidden rounded-lg border bg-ink-800 transition-colors ${
          dragging ? 'border-volt-500 ring-1 ring-volt-500/40' : 'border-ink-600 focus-within:border-volt-500/60'
        }`}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-ink-900/70 text-[12px] font-medium text-volt-300">
            <ImagePlus size={16} className="mr-2" /> Drop image to attach
          </div>
        )}

        {pendingPage && (
          <div className="flex items-center gap-2 border-b border-ink-600/60 px-2.5 py-2">
            <div className="flex min-w-0 items-center gap-1.5 rounded-full border border-volt-500/40 bg-volt-500/10 px-2.5 py-1 text-[11px] text-volt-300">
              <Globe size={11} className="shrink-0" />
              <span className="truncate" title={pendingPage.url}>{pendingPage.title || pendingPage.url}</span>
              <button onClick={() => stagePage(null)} title="Remove page" className="shrink-0 text-mist-400 hover:text-danger-400">
                <X size={11} />
              </button>
            </div>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-ink-600/60 px-2.5 py-2">
            {attachments.map((a) => (
              <div key={a.id} className="group relative h-16 w-16 overflow-hidden rounded border border-ink-600 bg-ink-900">
                <img src={a.previewUrl} alt={a.name} className="h-full w-full object-cover" />
                <button
                  onClick={() => removeAttachment(a.id)}
                  title="Remove"
                  className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-ink-900/80 text-mist-300 opacity-0 transition-opacity hover:text-danger-400 group-hover:opacity-100"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-0.5 border-b border-ink-600/60 px-2 py-1">
          <Btn title="Bold (Ctrl+B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
            <Bold size={12} />
          </Btn>
          <Btn title="Italic (Ctrl+I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <Italic size={12} />
          </Btn>
          <Btn title="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
            <Code size={12} />
          </Btn>
          <Btn title="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
            <Braces size={12} />
          </Btn>
          <span className="mx-1 h-3.5 w-px bg-ink-600" />
          <Btn title="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <List size={12} />
          </Btn>
          <Btn title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            <ListOrdered size={12} />
          </Btn>
          <Btn title="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
            <Quote size={12} />
          </Btn>
          <span className="mx-1 h-3.5 w-px bg-ink-600" />
          <Btn title="Attach image" onClick={() => fileInputRef.current?.click()}>
            <ImagePlus size={12} />
          </Btn>
          <div className="flex-1" />
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              send()
            }}
            disabled={running}
            className="flex items-center gap-1.5 rounded bg-volt-500 px-2.5 py-1 text-[11px] font-semibold text-white transition-all hover:bg-volt-400 disabled:opacity-40"
          >
            <SendHorizonal size={11} />
            Send
          </button>
        </div>
        <EditorContent editor={editor} />
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
