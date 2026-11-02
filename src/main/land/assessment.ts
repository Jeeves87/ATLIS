/**
 * Indiana DLGF assessment ingest — land value, owner, and deeded acreage.
 *
 * This is the file that answers "what is the dirt worth, separately from the
 * house on it". Counties are required by IC 6-1.1-4-25 to submit property tax
 * files to the DLGF annually, and the state republishes them through Gateway.
 * Because the assessor has already split gross assessed value into a land
 * component and an improvement component, no estimation is needed: the value of
 * raw ground is a published number, including under developed parcels — which
 * is what makes a real $/acre comparable possible from thousands of samples
 * rather than the handful a listing agent picks.
 *
 * Two things about the format are worth knowing before touching this:
 *
 *  - The files are FIXED-WIDTH, not delimited, laid out by 50 IAC 26-20-4.
 *    The offsets below are transcribed from that rule and are verified on load
 *    by an arithmetic identity the data itself must satisfy (land + improvement
 *    must equal total). If a future year shifts the layout, that check fails
 *    loudly instead of silently importing garbage into every score.
 *
 *  - Gateway serves them through an ASP.NET postback, not a plain URL, so the
 *    form's hidden state has to be replayed. That is why this reads the page
 *    first rather than hitting a download link directly.
 *
 * Kentucky has no equivalent: there is no statewide parcel or assessment
 * publication, and each PVA runs its own portal. So this module is Indiana-only
 * by nature, not by omission.
 */
import * as db from '../db'
import type { Progress } from './enrich'
import { LAND_UA } from './sources'
import {
  dlgfCountyNumber, parseParcelFile, unzipSingle, normalizeKey, type ParsedAssessment
} from './parcelfile'

export { dlgfCountyNumber, normalizeKey, parseParcelFile } from './parcelfile'

const GATEWAY = 'https://gateway.ifionline.org/public/download.aspx'


/**
 * PARCEL record layout, 50 IAC 26-20-4. Values are the rule's 1-based inclusive
 * column ranges converted to [start, end) zero-based slice bounds.
 */
// ------------------------------------------------------------------- fetch

const hidden = (html: string, name: string): string => {
  const m = new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html)
    ?? new RegExp(`id="${name}"[^>]*value="([^"]*)"`).exec(html)
  return m ? decodeEntities(m[1]) : ''
}

const decodeEntities = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")

/** Replay the Gateway form to get one county-year Real Property zip. */
async function downloadZip(fips: string, year: number, signal?: AbortSignal): Promise<Buffer> {
  const page = await fetch(GATEWAY, { headers: { 'User-Agent': LAND_UA }, signal })
  if (!page.ok) throw new Error(`Gateway page returned ${page.status}`)
  const html = await page.text()

  const form = new URLSearchParams({
    __VIEWSTATE: hidden(html, '__VIEWSTATE'),
    __VIEWSTATEGENERATOR: hidden(html, '__VIEWSTATEGENERATOR'),
    __EVENTVALIDATION: hidden(html, '__EVENTVALIDATION'),
    __EVENTTARGET: '',
    __EVENTARGUMENT: '',
    'ctl00$ContentPlaceHolder1$DropDownList1': '5', // 5 = Real Property
    'ctl00$ContentPlaceHolder1$DropDownList2': String(year),
    'ctl00$ContentPlaceHolder1$DropDownList3': dlgfCountyNumber(fips),
    'ctl00$ContentPlaceHolder1$button2': 'Download'
  })

  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: {
      'User-Agent': LAND_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: GATEWAY
    },
    body: form,
    signal
  })
  if (!res.ok) throw new Error(`Gateway download returned ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  const buf = Buffer.from(await res.arrayBuffer())
  // A form error comes back as a 200 HTML page, so check the payload shape.
  if (type.includes('text/html') || buf.subarray(0, 2).toString() !== 'PK') {
    throw new Error(`Gateway returned ${type || 'no content type'} instead of a zip — the form layout may have changed`)
  }
  return buf
}

// ----------------------------------------------------------------- ingest

export interface AssessmentResult {
  fips: string
  year: number
  parsed: number
  matched: number
  unmatched: number
  absentee: number
  checked: number
  mismatched: number
  /** Parcels the assessor records as having no improvements. */
  vacantConfirmed: number
}

/**
 * Download, parse and store one county-year of assessment data, joining it to
 * parcels already ingested from the GIS layer.
 */
export async function ingestAssessments(
  fips: string,
  year: number,
  onProgress: Progress = () => {},
  signal?: AbortSignal
): Promise<AssessmentResult> {
  const region = db.getLandRegion(fips)
  const county = region?.name ?? fips
  if (region?.state !== 'IN') {
    throw new Error(`${county} is not in Indiana — DLGF assessment files cover Indiana counties only`)
  }

  onProgress(`${county}: downloading ${year} assessment file…`, 0.05)
  const zip = await downloadZip(fips, year, signal)

  onProgress(`${county}: unpacking ${(zip.length / 1e6).toFixed(1)} MB…`, 0.3)
  const { data } = unzipSingle(zip)

  onProgress(`${county}: parsing…`, 0.5)
  const { rows, checked, mismatched } = parseParcelFile(data.toString('latin1'))
  if (!rows.length) throw new Error('assessment file contained no parcel rows')

  // Refuse rather than import misaligned columns — a wrong land value would
  // silently poison every $/acre comparable downstream.
  const badRatio = checked > 0 ? mismatched / checked : 1
  if (badRatio > 0.02) {
    throw new Error(
      `assessment layout check failed: ${mismatched.toLocaleString()} of ${checked.toLocaleString()} rows ` +
      `do not satisfy land + improvements = total. The ${year} file layout likely differs from 50 IAC 26-20-4.`
    )
  }

  onProgress(`${county}: matching ${rows.length.toLocaleString()} records to parcels…`, 0.75)

  // Index this county's parcels by normalised key for the join. Uses the
  // uncapped listing — a viewport-limited query would silently drop parcels.
  const byKey = new Map<string, { id: string; city: string | null }>()
  for (const p of db.listLandParcelKeys(fips)) {
    byKey.set(normalizeKey(p.pin), { id: p.id, city: p.city })
  }

  const out: Array<Omit<db.LandAssessment, 'updated_at'>> = []
  let matched = 0
  let absentee = 0

  for (const r of rows) {
    const hit = byKey.get(normalizeKey(r.parcelKey))
    if (!hit) continue
    matched++
    const isAbsentee = ownerIsAway(r, hit.city)
    if (isAbsentee) absentee++
    out.push({
      parcel_id: hit.id,
      fips,
      av_land: r.avLand,
      av_improvement: r.avImprovement,
      av_total: r.avTotal,
      deeded_acres: r.deededAcres,
      class_code: r.classCode,
      owner_name: r.ownerName,
      owner_street: r.ownerStreet,
      owner_city: r.ownerCity,
      owner_state: r.ownerState,
      owner_zip: r.ownerZip,
      absentee: isAbsentee ? 1 : 0,
      assessment_year: year
    })
  }

  db.replaceLandAssessments(fips, out)
  // Improvement value is the assessor's own word on whether anything is built
  // there, so it supersedes the class-code proxy used at ingest.
  const reconciled = db.reconcileVacancyFromAssessments(fips)
  onProgress(`${county}: stored ${matched.toLocaleString()} assessments, ${reconciled.vacant.toLocaleString()} parcels confirmed unbuilt`, 1)

  return {
    fips, year,
    parsed: rows.length,
    matched,
    unmatched: rows.length - matched,
    absentee,
    checked,
    mismatched,
    vacantConfirmed: reconciled.vacant
  }
}

/**
 * Owner's mailing address is not where the land is.
 *
 * Out-of-state is unambiguous. Within Indiana, the test compares the owner's
 * mailing city against the parcel's own property city — the textbook absentee
 * check, and the reason property city is carried through ingest at all.
 *
 * Deliberately conservative: a blank owner state, blank owner city or unknown
 * property city returns false. A missing value is not evidence of absence, and
 * a false positive here means writing to someone who lives on the land.
 */
function ownerIsAway(r: ParsedAssessment, parcelCity: string | null): boolean {
  const state = (r.ownerState ?? '').trim().toUpperCase()
  if (!state) return false
  if (state !== 'IN' && state !== 'INDIANA') return true

  const ownerCity = (r.ownerCity ?? '').trim().toUpperCase()
  const propCity = (parcelCity ?? '').trim().toUpperCase()
  if (!ownerCity || !propCity) return false
  return ownerCity !== propCity
}
