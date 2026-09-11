import { z } from 'zod';

export const visualizationSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_-]+$/),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  title: z
    .string()
    .min(1)
    .max(100)
    .refine((s) => !!s.trim() && !/[\u0000-\u001f\u007f]/.test(s)),
  source: z
    .string()
    .min(1)
    .max(512_000)
    .refine(
      (s) => !!s.trim() && !s.includes('\0') && new TextEncoder().encode(s).length <= 512_000,
    ),
});
export type Visualization = z.infer<typeof visualizationSchema>;
export const visualizationsSchema = z
  .array(visualizationSchema)
  .max(12)
  .refine(
    (items) =>
      new Set(items.map((v) => v.id)).size === items.length &&
      items.reduce((total, v) => total + new TextEncoder().encode(v.source).length, 0) <= 2_000_000,
  );

export function mergeVisualizations(left: Visualization[] = [], right: Visualization[] = []) {
  const result = [...left];
  for (const visual of right) {
    const index = result.findIndex((v) => v.id === visual.id);
    if (index >= 0 && result[index].revision >= visual.revision) continue;
    const next = [...result];
    if (index >= 0) next[index] = visual;
    else next.push(visual);
    if (visualizationsSchema.safeParse(next).success) result.splice(0, result.length, ...next);
  }
  return result;
}

// Static presentation defaults only. This document is sent to the existing
// sandbox renderer and never inserted in the privileged chat document.
export function visualizationDocument(source: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{color-scheme:light dark;--background:light-dark(#fff,#17191f);--foreground:light-dark(#20232b,#eef0f6);--card:light-dark(#f3f4f7,#242731);--card-foreground:var(--foreground);--muted:var(--card);--muted-foreground:light-dark(#606571,#b4b9c5);--border:light-dark(#d6d9e0,#434857);--primary:var(--foreground);--primary-foreground:var(--background);--secondary:var(--card);--secondary-foreground:var(--foreground);--accent:var(--card);--accent-foreground:var(--foreground);--font-size-base:14px;--viz-series-1:light-dark(#3458be,#93b2ff);--viz-series-2:light-dark(#24754e,#82d5a7);--viz-series-3:light-dark(#a0521c,#f2b37f);--viz-series-4:light-dark(#8041a6,#cda3ee);--viz-series-5:light-dark(#a63559,#f4a2ba);--viz-series-6:light-dark(#197384,#80d4df);--color-text-primary:var(--foreground);--color-text-secondary:var(--muted-foreground);--color-background-primary:var(--background);--color-background-secondary:var(--card);--color-border-primary:var(--border)}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--background);color:var(--foreground);font:14px/1.5 system-ui,sans-serif}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}button,.btn{padding:6px 12px;background:var(--card);border:1px solid var(--border);border-radius:6px}.card{padding:16px;background:var(--card);border-radius:8px}.text-muted,.text-small{color:var(--muted-foreground)}.text-small{font-size:12px}.viz-row,.viz-controls{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:12px}.tabular-nums{font-variant-numeric:tabular-nums}svg,canvas,img{max-width:100%}input[type=range]{max-width:100%}:focus-visible{outline:2px solid var(--viz-series-1);outline-offset:3px}
</style></head><body>${source}</body></html>`;
}
