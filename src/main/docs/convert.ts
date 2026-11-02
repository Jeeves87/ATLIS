import { marked } from 'marked'
import TurndownService from 'turndown'

/**
 * HTML > Markdown cascade. HTML is the native authoring/storage format for
 * documents and assistant output; Markdown is a *calculated* projection of it,
 * produced on demand (export, copy-as-markdown, model context).
 */

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-'
})

export function htmlToMd(html: string): string {
  return turndown.turndown(html)
}

export function mdToHtml(md: string): string {
  return marked.parse(md, { async: false }) as string
}

/** True if the content is already substantive HTML rather than markdown/plain text. */
export function looksLikeHtml(content: string): boolean {
  return /<\/?(html|body|div|section|article|table|h[1-6]|p|ul|ol)\b/i.test(content)
}
