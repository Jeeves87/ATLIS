/**
 * Play → Table & sounds: the playmat under the cards, and what the table
 * plays for each event.
 *
 * Every event can use one of Forge's bundled sounds, one of your own files,
 * or nothing, with its own volume. Changes save as you make them and apply to
 * a game already in progress.
 */
import { useState } from 'react'
import { ImagePlus, Music, Play, RotateCcw, Trash2, Upload, Volume2, VolumeX } from 'lucide-react'
import { PRESETS, importMat, matBackground, matIsImage, matUrl, removeMat, updateLook, useTableLook } from './tableLook'
import { SOUND_EVENTS, eventChoice, importSounds, playSource, removeSound, updateSounds, useSounds, type SoundEvent } from './sounds'

const pretty = (file: string): string => file.replace(/\.[^.]+$/, '').replace(/_/g, ' ')

/** The playmat: built-in backdrops, your commander's art, or your own images. */
function PlaymatPicker(): React.JSX.Element {
  const { look, mats } = useTableLook()
  const tile = (id: string, label: string, bg: string, onRemove?: () => void): React.JSX.Element => (
    <div key={id} className="group relative">
      <button onClick={() => updateLook({ mat: id })} title={label}
        className={`relative block h-[84px] w-[140px] overflow-hidden rounded-lg ring-2 transition ${look.mat === id ? 'ring-violet-400' : 'ring-white/10 hover:ring-white/30'}`}>
        <span className="absolute inset-0" style={{ background: bg }} />
        {matIsImage(id) && <span className="absolute inset-0" style={{ background: `rgba(6,7,10,${look.dim})` }} />}
        <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1.5 py-0.5 text-left text-[10px] text-white/85">{label}</span>
      </button>
      {onRemove && (
        <button onClick={onRemove} title="Remove this playmat"
          className="absolute right-1 top-1 hidden rounded bg-black/70 p-1 text-white/60 hover:text-red-300 group-hover:block"><Trash2 className="h-3 w-3" /></button>
      )}
    </div>
  )
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => tile(`preset:${p.id}`, p.label, p.css))}
        {tile('commander', 'Your commander’s art', 'linear-gradient(135deg,#4c3a7a,#1a1530)')}
        {mats.map((m) => tile(`mat:${m}`, pretty(m), `center / cover no-repeat url("${matUrl(m)}")`, () => void removeMat(m)))}
        <button onClick={() => void importMat()}
          className="flex h-[84px] w-[140px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/20 text-[11px] text-white/50 hover:border-white/40 hover:text-white/80">
          <ImagePlus className="h-5 w-5" /> Add your own image
        </button>
      </div>
      {matIsImage(look.mat) && (
        <div className="flex flex-wrap items-center gap-5 text-xs text-white/50">
          <label className="flex items-center gap-2">
            Dim
            <input type="range" min={0} max={0.9} step={0.05} value={look.dim} onChange={(e) => updateLook({ dim: Number(e.target.value) })} className="w-32 accent-violet-400" />
            <span className="w-8 tabular-nums text-white/40">{Math.round(look.dim * 100)}%</span>
          </label>
          <label className="flex items-center gap-2">
            Blur
            <input type="range" min={0} max={16} step={1} value={look.blur} onChange={(e) => updateLook({ blur: Number(e.target.value) })} className="w-32 accent-violet-400" />
            <span className="w-8 tabular-nums text-white/40">{look.blur}px</span>
          </label>
          {look.mat === 'commander' && <span className="text-white/35">Uses the commander of whichever deck you’re playing.</span>}
        </div>
      )}
      {/* Preview strip at the chosen dim/blur. */}
      <div className="relative h-16 overflow-hidden rounded-lg ring-1 ring-white/10">
        <div className="absolute inset-0" style={{ background: matBackground(look.mat), filter: look.blur ? `blur(${look.blur}px)` : undefined, transform: 'scale(1.05)' }} />
        {matIsImage(look.mat) && <div className="absolute inset-0" style={{ background: `rgba(6,7,10,${look.dim})` }} />}
        <span className="absolute inset-0 flex items-center justify-center text-[11px] text-white/50">
          {look.mat === 'commander' ? 'Your commander’s art appears here during a game' : 'Table preview'}
        </span>
      </div>
    </div>
  )
}

export default function SoundSettings(): React.JSX.Element {
  const { settings, forgeFiles, customFiles } = useSounds()
  const [note, setNote] = useState<string | null>(null)
  const groups = [...new Set(SOUND_EVENTS.map((e) => e.group))]

  const setEvent = (key: SoundEvent, patch: Partial<{ sound: string | null; volume: number }>): void =>
    updateSounds((s) => ({ ...s, events: { ...s.events, [key]: { ...eventChoice(key, s), ...patch } } }))

  const add = async (): Promise<void> => {
    const added = await importSounds()
    setNote(added.length ? `Added ${added.length === 1 ? added[0] : `${added.length} sounds`} — pick ${added.length === 1 ? 'it' : 'them'} from any event’s list.` : null)
  }

  return (
    <div className="space-y-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-white/35">Playmat</h3>
      <PlaymatPicker />
      <h3 className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-white/35">Sounds</h3>
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-white/10 bg-white/[0.03] p-3">
        <button
          onClick={() => updateSounds((s) => ({ ...s, enabled: !s.enabled }))}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${settings.enabled ? 'bg-violet-500/20 text-violet-200' : 'bg-white/5 text-white/50'}`}
        >
          {settings.enabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
          {settings.enabled ? 'Sounds on' : 'Sounds muted'}
        </button>
        <label className="flex items-center gap-2 text-xs text-white/50">
          Master volume
          <input
            type="range" min={0} max={1} step={0.05} value={settings.volume}
            onChange={(e) => updateSounds((s) => ({ ...s, volume: Number(e.target.value) }))}
            className="w-36 accent-violet-400"
          />
          <span className="w-8 tabular-nums text-white/40">{Math.round(settings.volume * 100)}%</span>
        </label>
        <span className="flex-1" />
        <button onClick={() => void add()} className="flex items-center gap-1.5 rounded-md bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10">
          <Upload className="h-3.5 w-3.5" /> Add your own sounds
        </button>
        <button
          onClick={() => updateSounds((s) => ({ ...s, events: {} }))}
          title="Every event back to Forge’s default sound and full volume"
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-white/45 hover:bg-white/5 hover:text-white/80"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
        </button>
      </div>
      {note && <p className="text-xs text-emerald-300/80">{note}</p>}
      {!forgeFiles.length && (
        <p className="text-xs text-amber-300/80">Forge’s sound folder wasn’t found, so only your own sounds are available. Set up Forge under “Forge setup” to get its built-in set.</p>
      )}

      {groups.map((g) => (
        <div key={g}>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/35">{g}</h3>
          <div className="divide-y divide-white/5 rounded-md border border-white/10 bg-white/[0.02]">
            {SOUND_EVENTS.filter((e) => e.group === g).map((e) => {
              const c = eventChoice(e.key, settings)
              return (
                <div key={e.key} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white/85">{e.label}</div>
                    {e.hint && <div className="truncate text-[11px] text-white/40">{e.hint}</div>}
                  </div>
                  <select
                    value={c.sound ?? ''}
                    onChange={(ev) => setEvent(e.key, { sound: ev.target.value || null })}
                    className="w-52 rounded border border-white/10 bg-[#141821] px-2 py-1 text-xs text-white/80"
                  >
                    <option value="">Off</option>
                    {e.key === 'landEnters' && <option value="land-color">Land colour (Forge)</option>}
                    {customFiles.length > 0 && (
                      <optgroup label="Your sounds">
                        {customFiles.map((f) => <option key={f} value={`custom:${f}`}>{pretty(f)}</option>)}
                      </optgroup>
                    )}
                    {forgeFiles.length > 0 && (
                      <optgroup label="Forge">
                        {forgeFiles.map((f) => <option key={f} value={`forge:${f}`}>{pretty(f)}</option>)}
                      </optgroup>
                    )}
                  </select>
                  <input
                    type="range" min={0} max={1} step={0.05} value={c.volume} disabled={!c.sound}
                    onChange={(ev) => setEvent(e.key, { volume: Number(ev.target.value) })}
                    title={`${Math.round(c.volume * 100)}%`}
                    className="w-24 accent-violet-400 disabled:opacity-30"
                  />
                  <button
                    onClick={() => playSource(c.sound, c.volume * settings.volume)}
                    disabled={!c.sound}
                    title="Preview"
                    className="rounded p-1.5 text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-25"
                  >
                    <Play className="h-3.5 w-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <div>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/35">Your sounds</h3>
        {customFiles.length === 0 ? (
          <p className="text-xs text-white/40">None yet. “Add your own sounds” takes mp3, wav, ogg, m4a, aac, flac or webm; ATLIS keeps its own copy.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {customFiles.map((f) => (
              <span key={f} className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] py-1 pl-2 pr-1 text-xs text-white/70">
                <Music className="h-3 w-3 text-white/35" />
                {pretty(f)}
                <button onClick={() => playSource(`custom:${f}`, settings.volume)} title="Preview" className="rounded p-1 hover:bg-white/10"><Play className="h-3 w-3" /></button>
                <button onClick={() => void removeSound(f)} title="Remove (events using it go silent)" className="rounded p-1 text-white/40 hover:bg-red-500/20 hover:text-red-300"><Trash2 className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
