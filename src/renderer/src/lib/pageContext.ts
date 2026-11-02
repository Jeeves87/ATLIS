import type { PageCapture } from '../types'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Fold a staged browser page into an outgoing message: the model (md) gets the
 * full page text, the transcript (html) shows only a compact link.
 */
export function withPageContext(md: string, html: string, page: PageCapture): { md: string; html: string } {
  return {
    md: `${md || 'Take a look at this page.'}\n\n---\nAttached page: ${page.title}\nURL: ${page.url}\n\n${page.text}`,
    html: `${html}<p><em>🌐 Attached page: <a href="${esc(page.url)}">${esc(page.title || page.url)}</a></em></p>`
  }
}
