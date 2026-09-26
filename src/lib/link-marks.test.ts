import { describe, expect, it } from 'vitest';
import { siteIconRule, siteLink } from './link-marks';

describe('site link marks', () => {
  it('marks each site once and leaves other links plain', () => {
    expect(siteLink('https://en.wikipedia.org/wiki/Special:Random?a=1#top')).toEqual({
      href: 'https://en.wikipedia.org/wiki/Special:Random?a=1#top',
      mark: 'site-1',
    });
    // One mark per site, whatever page a later link names.
    expect(siteLink('https://en.wikipedia.org/wiki/Cat')?.mark).toBe('site-1');
    expect(siteLink('https://github.com')?.mark).toBe('site-2');
    // A different scheme, host or port is a different site.
    expect(siteLink('http://en.wikipedia.org/wiki/Cat')?.mark).toBe('site-3');
    expect(siteLink('https://de.wikipedia.org')?.mark).toBe('site-4');
    expect(siteLink('http://localhost:5173/app')?.mark).toBe('site-5');
    expect(siteLink('http://localhost:4173/app')?.mark).toBe('site-6');
    // Addresses a browser would not open as a page keep their plain link.
    for (const href of [
      'mailto:someone@example.com',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'file:///c:/notes.md',
      '/docs/readme.md',
      '#section',
      'not a url',
      '',
    ])
      expect(siteLink(href), href).toBeNull();
  });

  it('gives a mark only bounded image data', () => {
    expect(siteIconRule('site-1', 'data:image/png;base64,AAAA')).toBe(
      '.link-mark.site-1{-webkit-mask:none;mask:none;background:center/contain no-repeat url("data:image/png;base64,AAAA")}',
    );
    expect(siteIconRule('site-2', 'data:image/svg+xml;base64,PHN2Zy8+')).toContain(
      'url("data:image/svg+xml;base64,PHN2Zy8+")',
    );
    for (const icon of [
      null,
      undefined,
      42,
      '',
      'https://example.com/favicon.ico',
      'data:text/html;base64,PGI+eDwvYj4=',
      'data:image/png,AAAA',
      // Nothing that could close the rule or reach outside it becomes a mark.
      'data:image/png;base64,AA")}.app{background:url("http://tracker.example/x',
      `data:image/png;base64,${'A'.repeat(400_001)}`,
    ])
      expect(siteIconRule('site-1', icon), String(icon).slice(0, 40)).toBe('');
  });
});
