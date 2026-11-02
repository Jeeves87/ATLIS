import type React from 'react'
import { useEffect, useState } from 'react'
import { Box, X, type LucideIcon } from 'lucide-react'
import type { ImageRef } from '../../lib/mtgImages'

type ThumbSize = 'xs' | 'sm' | 'md' | 'lg' | 'fill'

/**
 * The slot a thumbnail occupies. Row sizes are always SQUARE — a card (5:7
 * portrait) sits centred inside the same slot a booster box fills — so the
 * names beside a mixed list of cards and sealed product line up. `lg` takes
 * the image's own shape, since it stands alone; `fill` takes whatever box the
 * parent gives it (grid tiles), with the picture contained inside.
 */
const SLOT: Record<Exclude<ThumbSize, 'lg'>, string> = {
  xs: 'h-7 w-7',
  sm: 'h-10 w-10',
  md: 'h-16 w-16',
  fill: 'h-full w-full'
}
const LG_SLOT: Record<ImageRef['shape'], string> = {
  card: 'aspect-[5/7] w-full',
  product: 'aspect-square w-full'
}

/**
 * A thumbnail that degrades instead of breaking: primary URL, then the
 * fallback, then a plain icon tile. Product shots come on a white studio
 * background, so they sit on white with `contain` rather than being cropped —
 * cropping a booster box cuts off the set name, which is the part that tells
 * two boxes apart.
 */
export default function ProductThumb({
  image,
  alt,
  size = 'sm',
  icon: Icon = Box,
  onClick,
  title,
  className = ''
}: {
  image: ImageRef | null
  alt: string
  size?: ThumbSize
  icon?: LucideIcon
  onClick?: () => void
  title?: string
  className?: string
}): React.JSX.Element {
  // 0 = primary, 1 = fallback, 2 = give up and show the icon
  const [stage, setStage] = useState(0)
  useEffect(() => setStage(0), [image?.src])

  const shape = image?.shape ?? 'product'
  const src = !image ? null : stage === 0 ? image.src : stage === 1 ? image.fallback : null
  const slot = `${size === 'lg' ? LG_SLOT[shape] : SLOT[size]} flex shrink-0 items-center justify-center`
  // Border/ring/radius go on the VISIBLE picture, not the slot — otherwise a
  // card centred in a square slot gets a square frame around empty space.
  const frame = `overflow-hidden rounded-sm ${onClick ? 'ring-1 ring-white/10 transition group-hover:ring-violet-400/60' : ''} ${className}`

  const body = src ? (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      draggable={false}
      onError={() => setStage((s) => (s === 0 && image?.fallback ? 1 : 2))}
      className={`${frame} ${
        shape === 'product'
          ? size === 'fill'
            ? // Shrink-wrap the photo so its white studio ground doesn't
              // become a white slab filling the whole tile.
              'max-h-full max-w-full bg-white object-contain p-1'
            : 'h-full w-full bg-white object-contain p-px'
          : 'aspect-[5/7] h-full max-w-full object-cover'
      }`}
    />
  ) : (
    <span className={`${frame} flex h-full w-full items-center justify-center bg-white/5 text-white/35`}>
      <Icon className={size === 'lg' || size === 'fill' ? 'h-8 w-8' : size === 'md' ? 'h-5 w-5' : 'h-3.5 w-3.5'} />
    </span>
  )

  if (!onClick) return <span className={slot} title={title}>{body}</span>
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      title={title ?? 'Click to enlarge'}
      className={`group ${slot}`}
    >
      {body}
    </button>
  )
}

/**
 * Full-size view of a product shot or card, for when a 40px thumbnail isn't
 * enough to tell a Collector Box from a Collector Box Case. Takes the LARGE
 * ImageRef (TCGplayer's 1000px zoom shot / Scryfall's large scan).
 */
export function ImageZoom({
  image,
  name,
  subtitle,
  onClose
}: {
  image: ImageRef
  name: string
  subtitle?: string | null
  onClose: () => void
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const [useFallback, setUseFallback] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const src = useFallback ? image.fallback : image.src
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
      role="presentation"
    >
      <div className="flex max-h-full max-w-full flex-col items-center gap-3" onClick={(e) => e.stopPropagation()} role="presentation">
        {src && !failed ? (
          <img
            src={src}
            alt={name}
            onError={() => (image.fallback && !useFallback ? setUseFallback(true) : setFailed(true))}
            className={`max-h-[80vh] max-w-[80vw] rounded-xl object-contain shadow-2xl ring-1 ring-white/15 ${
              image.shape === 'product' ? 'bg-white p-3' : ''
            }`}
          />
        ) : (
          <div className="flex h-64 w-64 items-center justify-center rounded-xl bg-white/5 text-white/40">
            <Box className="h-10 w-10" />
          </div>
        )}
        <div className="text-center">
          <div className="text-sm font-medium text-white">{name}</div>
          {subtitle && <div className="text-xs text-white/50">{subtitle}</div>}
        </div>
      </div>
      <button
        onClick={onClose}
        className="absolute right-5 top-5 rounded-md p-2 text-white/60 hover:bg-white/10 hover:text-white"
        title="Close"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  )
}
