// The icon a linked site serves for itself, shown before the link the way a browser tab shows
// one. Marks are presentation only: rendered Markdown carries one class per site, and the
// computer showing the reply supplies that site's icon once through a single stylesheet rule,
// so a streaming reply never re-walks its links. Sites whose icon is unknown, unreachable or
// still being read keep the generic mark, and no link, page or icon is saved or relayed.

/** Sites marked in one session. */
const maxSites = 500;
/** Icons read at a time, so a reply full of links never opens a burst of connections. */
const maxReading = 4;
/** A mark is one line high; the host bounds the icon itself. */
const maxIconLength = 400_000;

const marks = new Map<string, string>();
const waiting: string[] = [];
let reading = 0;
let sheet: CSSStyleSheet | null | undefined;

export type SiteLink = { href: string; mark: string };

/**
 * The address and mark class of a link to a site. Links without one — relative paths, mail,
 * files and anything a browser would not open as a page — keep their plain rendering.
 */
export function siteLink(href: string): SiteLink | null {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const known = marks.get(url.origin);
  if (known) return { href: url.href, mark: known };
  if (marks.size >= maxSites) return null;
  const mark = `site-${marks.size + 1}`;
  marks.set(url.origin, mark);
  waiting.push(url.origin);
  void readIcon();
  return { href: url.href, mark };
}

/** The rule that gives a mark its site's icon, or '' for anything that is not bounded image data. */
export function siteIconRule(mark: string, icon: unknown): string {
  if (typeof icon !== 'string' || icon.length > maxIconLength) return '';
  if (!/^data:image\/[a-z][a-z0-9+.-]{1,18};base64,[A-Za-z0-9+/]+={0,2}$/.test(icon)) return '';
  return `.link-mark.${mark}{-webkit-mask:none;mask:none;background:center/contain no-repeat url("${icon}")}`;
}

async function readIcon() {
  // Without a document there is nowhere to show a mark, so no icon is read.
  const origin =
    typeof document !== 'undefined' && reading < maxReading ? waiting.shift() : undefined;
  if (!origin) return;
  reading++;
  try {
    // Only the reader is loaded, keeping transport out of this module's import graph.
    const { siteIcon } = await import('./transport');
    const rule = siteIconRule(marks.get(origin)!, await siteIcon(origin));
    if (rule) insertRule(rule);
  } catch {
    // A site whose icon cannot be read keeps the generic mark.
  } finally {
    reading--;
    void readIcon();
  }
}

function insertRule(rule: string) {
  if (sheet === undefined)
    sheet =
      typeof document === 'undefined'
        ? null
        : (document.head.appendChild(document.createElement('style')).sheet ?? null);
  const target = sheet;
  if (!target) return;
  try {
    target.insertRule(rule, target.cssRules.length);
  } catch {
    // A rule this engine cannot parse leaves the generic mark in place.
  }
}
