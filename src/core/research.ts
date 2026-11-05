import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Reference images for the copilot's optional research phase: found in openly licensed image
 * libraries (Openverse, Wikimedia Commons) or taken from web pages the copilot found with WebSearch
 * (a wiki article about a film creature), downloaded into the project's refs/ folder and put on one
 * contact sheet (see bridge.py op_refsheet) that the copilot looks at and the chat shows.
 */

export interface RefImage {
  url: string;
  title?: string;
  /** The page the image comes from (credit). */
  source?: string;
  license?: string;
  creator?: string;
}

const UA = 'Kiln (desktop 3D modeling app; fetching reference images for the user)';
const TIMEOUT_MS = 12_000;
const MAX_BYTES = 12 * 1024 * 1024;
const JUNK = /(logo|icon|sprite|avatar|badge|flag|button|banner|emoji|spacer|pixel|tracking|placeholder|favicon|wordmark|site-?header|\/ads?\/|\.svg\.png|distribution|cladogram|diagram|range[_ -]?map|locator|signature)/i;

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
}

/** Openly licensed photos and art for a query: Openverse first, then Wikimedia Commons. */
export async function searchImages(query: string, count: number): Promise<RefImage[]> {
  const out: RefImage[] = [];
  const seen = new Set<string>();
  const add = (r: RefImage) => {
    if (!r.url || seen.has(r.url) || out.length >= count) return;
    seen.add(r.url);
    out.push(r);
  };
  try {
    const j = (await getJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${Math.min(20, count * 2)}&mature=false`)) as {
      results?: Array<{ id: string; url: string; thumbnail?: string; title?: string; foreign_landing_url?: string; license?: string; license_version?: string; creator?: string; filetype?: string }>;
    };
    for (const r of j.results ?? []) {
      if (r.filetype && !/^(jpe?g|png|webp)$/i.test(r.filetype)) continue;
      add({ url: r.thumbnail || r.url, title: r.title, source: r.foreign_landing_url, license: r.license ? `CC ${r.license.toUpperCase()} ${r.license_version ?? ''}`.trim() : undefined, creator: r.creator });
    }
  } catch {
    /* fall through to Commons */
  }
  if (out.length < count) {
    try {
      const j = (await getJson(
        `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=${Math.min(20, count * 2)}&gsrsearch=${encodeURIComponent(query)}&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=640`,
      )) as { query?: { pages?: Record<string, { title: string; imageinfo?: Array<{ thumburl?: string; url: string; mime: string; descriptionurl?: string; extmetadata?: Record<string, { value?: string }> }> }> } };
      for (const p of Object.values(j.query?.pages ?? {})) {
        const ii = p.imageinfo?.[0];
        if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime)) continue;
        add({ url: ii.thumburl || ii.url, title: p.title.replace(/^File:/, '').replace(/\.\w+$/, ''), source: ii.descriptionurl, license: ii.extmetadata?.LicenseShortName?.value, creator: ii.extmetadata?.Artist?.value?.replace(/<[^>]+>/g, '') });
      }
    } catch {
      /* nothing more */
    }
  }
  return out;
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(2).find((v) => v !== undefined);

/** A moderately sized version of common wiki image URLs (full-size originals are often huge). */
function sized(url: string): string {
  // Fandom: .../revision/latest/scale-to-width-down/180?cb=... -> 640 wide
  if (/static\.wikia\.nocookie\.net/.test(url)) return url.replace(/\/scale-to-width-down\/\d+/, '/scale-to-width-down/640').replace(/\/revision\/latest(?!\/scale)/, '/revision/latest/scale-to-width-down/640');
  // Wikipedia/Commons thumbs: .../thumb/a/ab/Name.jpg/220px-Name.jpg -> 640px
  return url.replace(/\/(\d{2,4})px-([^/]+)$/, (_m, _w, rest) => `/640px-${rest}`);
}

/**
 * The images of a wiki article through its MediaWiki API (Wikipedia, Fandom and most wikis): the
 * article's lead image first, then its other pictures by size. Fandom answers the API but not
 * page requests from apps.
 */
async function wikiImages(page: string, count: number): Promise<RefImage[] | null> {
  const u = new URL(page);
  const m = /\/wiki\/([^?#]+)/.exec(u.pathname);
  if (!m) return null;
  const title = decodeURIComponent(m[1]!).replace(/_/g, ' ');
  if (/^(file|category|special|template|user|talk):/i.test(title)) return null;
  for (const api of [`${u.origin}/api.php`, `${u.origin}/w/api.php`]) {
    try {
      const q = `${api}?action=query&format=json&origin=*&redirects=1&titles=${encodeURIComponent(title)}`;
      const lead = (await getJson(`${q}&prop=pageimages&piprop=thumbnail&pithumbsize=640`)) as { query?: { pages?: Record<string, { title?: string; thumbnail?: { source: string } }> } };
      const leadPage = Object.values(lead.query?.pages ?? {})[0];
      const all = (await getJson(`${q}&generator=images&gimlimit=40&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=640`)) as {
        query?: { pages?: Record<string, { title: string; imageinfo?: Array<{ thumburl?: string; url: string; mime: string; width: number; height: number; descriptionurl?: string }> }> };
      };
      const out: Array<RefImage & { score: number }> = [];
      if (leadPage?.thumbnail?.source && !JUNK.test(leadPage.thumbnail.source)) out.push({ url: leadPage.thumbnail.source, title: leadPage.title ?? title, source: page, score: 1e12 });
      for (const f of Object.values(all.query?.pages ?? {})) {
        const ii = f.imageinfo?.[0];
        if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime) || JUNK.test(f.title) || ii.width < 150 || ii.height < 150) continue;
        const url = ii.thumburl || ii.url;
        if (out.some((o) => o.url.split('?')[0]!.split('/revision')[0] === url.split('?')[0]!.split('/revision')[0])) continue;
        out.push({ url, title: f.title.replace(/^File:/i, '').replace(/\.\w+$/, ''), source: ii.descriptionurl ?? page, score: ii.width * ii.height });
      }
      if (lead.query || all.query) return out.sort((a, b) => b.score - a.score).slice(0, count).map(({ score: _s, ...r }) => r);
    } catch {
      /* try the other API path, then the page itself */
    }
  }
  return null;
}

/** The main images of a web page: a wiki article's pictures through its API, else the page's preview image (og:image) and its biggest content images. */
export async function pageImages(page: string, count: number): Promise<RefImage[]> {
  const wiki = await wikiImages(page, count);
  if (wiki?.length) return wiki;
  const r = await fetch(page, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(page).host}`);
  const html = (await r.text()).slice(0, 4_000_000);
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const found = new Map<string, number>();
  const push = (src: string | undefined, score: number) => {
    if (!src || src.startsWith('data:')) return;
    let abs: string;
    try {
      abs = new URL(src.replace(/&amp;/g, '&'), r.url || page).toString();
    } catch {
      return;
    }
    if (/\.svg(\?|$)/i.test(abs) || JUNK.test(abs)) return;
    abs = sized(abs);
    found.set(abs, Math.max(found.get(abs) ?? 0, score));
  };
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = attr(tag, 'property') ?? attr(tag, 'name');
    if (key && /^(og:image|og:image:url|twitter:image)$/i.test(key)) push(attr(tag, 'content'), 1e9);
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const set = attr(tag, 'srcset') ?? attr(tag, 'data-srcset');
    let src = attr(tag, 'data-src') ?? attr(tag, 'data-original') ?? attr(tag, 'src');
    if (set) {
      const best = set.split(',').map((s) => s.trim().split(/\s+/)).map(([u, w]) => ({ u, w: parseFloat(w ?? '1') || 1 })).sort((a, b) => b.w - a.w)[0];
      if (best?.u) src = best.u;
    }
    const w = Number(attr(tag, 'width')) || 0;
    const h = Number(attr(tag, 'height')) || 0;
    if ((w && w < 100) || (h && h < 100)) continue;
    const alt = attr(tag, 'alt') ?? '';
    push(src, (w && h ? w * h : 60_000) + (alt ? 10_000 : 0));
  }
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([url]) => ({ url, title, source: page }));
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Downloads one image into dir; null when it isn't a usable JPEG/PNG/WebP. hash identifies its content. */
export async function download(url: string, dir: string, name: string): Promise<{ file: string; hash: string } | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/webp,image/png,image/jpeg,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const type = (r.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!r.ok || !EXT[type]) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2_000 || buf.length > MAX_BYTES) return null;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.${EXT[type]}`);
    writeFileSync(file, buf);
    return { file, hash: createHash('sha1').update(buf).digest('hex') };
  } catch {
    return null;
  }
}

export interface ReferenceRequest {
  query?: string;
  pages?: string[];
  images?: string[];
  count?: number;
}

/** Gathers up to `count` reference images: direct URLs first, then page images, then a library search. */
export async function gather(req: ReferenceRequest, dir: string, stamp: string): Promise<{ files: string[]; refs: RefImage[]; notes: string[] }> {
  const count = Math.max(1, Math.min(8, req.count ?? 6));
  const notes: string[] = [];
  const candidates: RefImage[] = [];
  for (const u of req.images ?? []) candidates.push({ url: u, source: u });
  const perPage = Math.max(2, Math.ceil(count / Math.max(1, req.pages?.length ?? 1)) + 1);
  const pageResults = await Promise.all(
    (req.pages ?? []).slice(0, 3).map((p) =>
      pageImages(p, perPage).catch((e: Error) => {
        notes.push(`Could not read ${p}: ${e.message}`);
        return [] as RefImage[];
      }),
    ),
  );
  for (const list of pageResults) candidates.push(...list);
  if (req.query) candidates.push(...(await searchImages(req.query, count + 2)));
  const seen = new Set<string>();
  const unique = candidates.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true))).slice(0, count + 4);
  const files: string[] = [];
  const refs: RefImage[] = [];
  const kept: number[] = [];
  const results = await Promise.all(unique.map((c, i) => download(c.url, dir, `${stamp}-${i + 1}`)));
  const hashes = new Set<string>();
  results.forEach((d, i) => {
    if (!d) return;
    // The same picture is often on several sites (two wikis about one film): keep it once.
    if (files.length < count && !hashes.has(d.hash)) {
      hashes.add(d.hash);
      files.push(d.file);
      refs.push(unique[i]!);
      kept.push(i);
    } else {
      rmSync(d.file, { force: true });
    }
  });
  const failed = results.filter((d) => !d).length;
  if (failed && files.length < count) notes.push(`${failed} image(s) could not be downloaded or weren't JPEG/PNG/WebP.`);
  if (refs.length) {
    try {
      appendFileSync(join(dir, 'sources.txt'), refs.map((r, i) => `${stamp}-${kept[i]! + 1}\t${r.url}\t${r.source ?? ''}\t${r.license ?? ''}\t${r.creator ?? ''}\n`).join(''));
    } catch {
      /* credits are best-effort */
    }
  }
  return { files, refs, notes };
}
