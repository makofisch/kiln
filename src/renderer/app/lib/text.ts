import { Marked, type Tokens } from 'marked';

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PY = new RegExp(
  [
    String.raw`(#[^\n]*)`,
    String.raw`("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|[rbfu]?"(?:\\.|[^"\\\n])*"?|[rbfu]?'(?:\\.|[^'\\\n])*'?)`,
    String.raw`\b(def|class|for|in|if|elif|else|while|return|import|from|as|with|try|except|finally|lambda|and|or|not|is|pass|break|continue|yield|global|raise|del|assert)\b`,
    String.raw`\b(None|True|False)\b`,
    String.raw`\b(\d+\.?\d*(?:[eE][+-]?\d+)?)\b`,
    String.raw`\b(bpy|bmesh|kiln|math|np|mathutils|Vector|Matrix|Euler|Quaternion|radians|degrees)\b`,
    String.raw`\b([A-Za-z_]\w*)(?=\()`,
  ].join('|'),
  'g',
);

/** Python → HTML with token classes (tolerant of code that is still streaming in). */
export function highlightPython(code: string): string {
  let out = '';
  let last = 0;
  for (const m of code.matchAll(PY)) {
    out += escapeHtml(code.slice(last, m.index));
    const [tok, comment, str, kw, lit, num, mod, fn] = m;
    const cls = comment ? 'c' : str ? 's' : kw ? 'k' : lit ? 'l' : num ? 'n' : mod ? 'm' : fn ? 'f' : '';
    out += cls ? `<span class="tk-${cls}">${escapeHtml(tok)}</span>` : escapeHtml(tok);
    last = m.index + tok.length;
  }
  return out + escapeHtml(code.slice(last));
}

const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text);
    },
    link(token: Tokens.Link) {
      const href = /^(https?:|mailto:)/i.test(token.href) ? token.href : '#';
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${this.parser.parseInline(token.tokens)}</a>`;
    },
    code(token: Tokens.Code) {
      const lang = (token.lang ?? '').toLowerCase();
      const body = lang === 'python' || lang === 'py' ? highlightPython(token.text) : escapeHtml(token.text);
      return `<div class="code-wrap"><button class="code-copy" title="Copy"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9h10v11H9zM5 15V4h10"/></svg></button><pre class="code"><code>${body}</code></pre></div>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return md.parse(text, { async: false }) as string;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Hides the copilot's machine-read trailer (<title>, <next>) while a reply streams in. */
export function stripTrailer(text: string): string {
  return text
    .replace(/<title>[\s\S]*?(<\/title>|$)/gi, '')
    .replace(/<next>[\s\S]*$/i, '')
    .replace(/<(t(i(t(l(e)?)?)?)?|n(e(x(t)?)?)?)?$/i, '')
    .trimEnd();
}
