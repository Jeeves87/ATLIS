import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

/** True if the content is already substantive HTML rather than markdown. */
export function looksLikeHtml(content: string): boolean {
  return /<\/?(html|body|div|section|article|table|h[1-6]|p|ul|ol)\b/i.test(content)
}

/**
 * HTML > Markdown cascade: if the model gave us HTML, render it natively;
 * otherwise treat it as markdown and compute HTML from it.
 */
export function renderContent(content: string): string {
  const html = looksLikeHtml(content) ? content : (marked.parse(content, { async: false }) as string)
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['script', 'iframe', 'object', 'embed'], FORBID_ATTR: ['onerror', 'onclick', 'onload'] })
}

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['script', 'object', 'embed'], FORBID_ATTR: ['onerror', 'onclick', 'onload'] })
}
