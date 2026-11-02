/**
 * Picture URLs for anything the Magic tracker holds a price handle for.
 *
 * Every tracked row already carries the id its price comes from — a Scryfall
 * card id, or a TCGplayer product id for sealed — and both services serve
 * images keyed by that same id. So a thumbnail is DERIVED, never stored: rows
 * saved before this existed get pictures too, and nothing has to be migrated
 * or backfilled.
 *
 * Each helper returns a primary URL plus a fallback, because the primary is a
 * CDN path rather than a documented API. The fallback is the documented route
 * (Scryfall's `?format=image` redirect), used only when the CDN path 404s —
 * it counts against Scryfall's API rate limit, so it must not be the default
 * for a list of fifty thumbnails.
 */

/** art_crop: Scryfall's art-only crop (no frame), used for portraits and playmats. */
export type ImageSize = 'small' | 'normal' | 'large' | 'art_crop'

export interface ImageRef {
  src: string
  fallback: string | null
  /** Card art is a portrait 5:7; product shots are roughly square on white. */
  shape: 'card' | 'product'
}

const SCRYFALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Scryfall's image CDN files every printing under its id's first two hex
 * digits: cards.scryfall.io/<size>/front/e/2/e2096…jpg. Double-faced cards use
 * the same path for their front face. The `?<timestamp>` Scryfall appends is a
 * cache-buster and not required.
 */
export function scryfallImage(id: string, size: ImageSize = 'normal'): ImageRef | null {
  if (!SCRYFALL_ID.test(id)) return null
  const lower = id.toLowerCase()
  return {
    src: `https://cards.scryfall.io/${size}/front/${lower[0]}/${lower[1]}/${lower}.jpg`,
    fallback: `https://api.scryfall.com/cards/${lower}?format=image&version=${size}`,
    shape: 'card'
  }
}

/**
 * TCGplayer's product CDN is keyless and keyed by the same product id sealed
 * prices come from. `_200w` is ~10-15KB; `_in_1000x1000` is the zoom shot. An
 * unknown id answers 403, which the thumbnail treats like any other miss.
 */
export function tcgplayerImage(productId: string, size: ImageSize = 'normal'): ImageRef | null {
  if (!/^\d+$/.test(productId)) return null
  const suffix = size === 'large' ? '_in_1000x1000' : size === 'small' ? '_200w' : '_400w'
  return {
    src: `https://tcgplayer-cdn.tcgplayer.com/product/${productId}${suffix}.jpg`,
    // The 400w rendition is not guaranteed for every product; 200w is.
    fallback: size === 'small' ? null : `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_200w.jpg`,
    shape: 'product'
  }
}

/**
 * The picture for a row, from whatever handle it has. A stored `imageUrl`
 * (watchlist cards save one on creation) wins so existing rows render exactly
 * as they did; otherwise the ext handle decides.
 */
export function imageFor(
  ref: { extSource?: string | null; extId?: string | null; imageUrl?: string | null },
  size: ImageSize = 'normal'
): ImageRef | null {
  const derived =
    ref.extId && ref.extSource === 'scryfall'
      ? scryfallImage(ref.extId, size)
      : ref.extId && ref.extSource === 'tcgplayer'
        ? tcgplayerImage(ref.extId, size)
        : null
  if (ref.imageUrl) {
    return { src: ref.imageUrl, fallback: derived?.src ?? null, shape: derived?.shape ?? 'card' }
  }
  return derived
}
