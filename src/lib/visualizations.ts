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
:root{color-scheme:dark;--background:transparent;--foreground:#cedcc1;--card:#1b1e1c;--card-foreground:var(--foreground);--muted:var(--card);--muted-foreground:#8f978e;--border:#2c302c;--primary:#c5df91;--primary-foreground:#141615;--secondary:var(--card);--secondary-foreground:var(--foreground);--accent:var(--card);--accent-foreground:var(--foreground);--font-size-base:13px;--viz-series-1:#c5df91;--viz-series-2:#8dc9c1;--viz-series-3:#e3b580;--viz-series-4:#b8a4d7;--viz-series-5:#dca0ad;--viz-series-6:#9bbde0;--color-text-primary:var(--foreground);--color-text-secondary:var(--muted-foreground);--color-background-primary:var(--background);--color-background-secondary:var(--card);--color-border-primary:var(--border)}
*{box-sizing:border-box}html,body{background:transparent}body{margin:0;padding:0;color:var(--foreground);font:13px/1.9 'DM Sans Variable',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}p{margin:0 0 13px}h1,h2,h3{color:#e3eed9;margin:20px 0 12px;letter-spacing:-.3px}h1{font-size:23px}h2{font-size:19px}h3{font-size:16px}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}button,.btn{padding:4px 10px;background:var(--card);border:1px solid var(--border);border-radius:6px}.card{padding:12px;background:var(--card);border-radius:6px}.text-muted,.text-small{color:var(--muted-foreground)}.text-small{font-size:12px}.viz-row,.viz-controls{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:12px}.tabular-nums{font-variant-numeric:tabular-nums}svg,canvas,img{max-width:100%}svg text{font-family:inherit}input[type=range]{max-width:100%;accent-color:var(--primary)}:focus-visible{outline:2px solid var(--viz-series-1);outline-offset:3px}
</style></head><body>${source}</body></html>`;
}
