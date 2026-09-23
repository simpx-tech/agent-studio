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
// Colors, font and rhythm mirror the chat prose tokens in theme.css and styles.css.
const visualizationThemes = {
  dark: 'color-scheme:dark;--foreground:#dadade;--heading:#ececee;--card:#1c1c1f;--muted-foreground:#8b8b94;--border:#2e2e33;--primary:#c4e88c;--primary-foreground:#172107;--viz-series-1:#c4e88c;--viz-series-2:#85cfc4;--viz-series-3:#ebb57c;--viz-series-4:#b9a6e6;--viz-series-5:#e5a1b1;--viz-series-6:#8fbdf0',
  light:
    'color-scheme:light;--foreground:#27272a;--heading:#18181b;--card:#f4f4f5;--muted-foreground:#6b6b76;--border:#e2e2e6;--primary:#5f9a1f;--primary-foreground:#ffffff;--viz-series-1:#5f9a1f;--viz-series-2:#178f82;--viz-series-3:#d27a22;--viz-series-4:#7657c4;--viz-series-5:#cc4a6e;--viz-series-6:#3478d0',
};

export function visualizationDocument(source: string, theme: 'dark' | 'light' = 'dark'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{${visualizationThemes[theme]};--background:transparent;--card-foreground:var(--foreground);--muted:var(--card);--secondary:var(--card);--secondary-foreground:var(--foreground);--accent:var(--card);--accent-foreground:var(--foreground);--font-size-base:14px;--color-text-primary:var(--foreground);--color-text-secondary:var(--muted-foreground);--color-background-primary:var(--background);--color-background-secondary:var(--card);--color-border-primary:var(--border)}
*{box-sizing:border-box}html,body{background:transparent}body{margin:0;padding:0;color:var(--foreground);font:14px/1.7 'Geist Variable',ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}p{margin:0 0 12px}h1,h2,h3{color:var(--heading);margin:24px 0 10px;line-height:1.25;letter-spacing:-.011em}h1{font-size:21px}h2{font-size:18px}h3{font-size:15.5px}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}button,.btn{padding:4px 10px;background:var(--card);border:1px solid var(--border);border-radius:8px}.card{padding:12px;background:var(--card);border-radius:10px}.text-muted,.text-small{color:var(--muted-foreground)}.text-small{font-size:12px}.viz-row,.viz-controls{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:12px}.tabular-nums{font-variant-numeric:tabular-nums}svg,canvas,img{max-width:100%}svg text{font-family:inherit}input[type=range]{max-width:100%;accent-color:var(--primary)}:focus-visible{outline:2px solid var(--viz-series-1);outline-offset:3px}
</style></head><body>${source}</body></html>`;
}
