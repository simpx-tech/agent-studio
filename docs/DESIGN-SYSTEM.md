# Design system

Agent Studio's interface is built from one set of semantic design tokens in
`src/lib/theme.css`, shared primitives in `src/lib/styles.css`, and component styles that read
only those tokens. Raw colors belong in `theme.css`; components never hard-code hex, `rgb()` or
named colors, so every surface follows the selected theme.

## Principles

- **Quiet chrome, readable content.** Neutral graphite surfaces, hairline borders and a single
  lime accent. Chat prose is the most prominent text on screen.
- **One accent.** `--accent` marks the primary action, selection, focus and live state. Status
  colors (success, warning, danger, info) are reserved for meaning, never decoration.
- **Readable sizes.** UI text is 12–13px, prose 14px. Nothing is smaller than 10px, and 10px is
  only for counts and badges. No uppercase letter-spaced labels.
- **Consistent geometry.** A 4px spacing rhythm, radii from `--radius-xs` to `--radius-2xl`, and
  32px default controls (44px touch targets on phones).
- **Motion is feedback.** Hover and state transitions use `--duration-fast`; overlays fade in
  with opacity only, so measured layout never moves during an animation. A running reply's
  calls enter, fold into their group and slide into place with `--duration-slow`, animating
  only opacity and transforms: layout changes at once and the animation plays over it. The
  global reduced-motion rule stops CSS animations; script animations check it themselves.
- **Cheap selectors.** Every hover change and transition frame restyles elements, so never pair
  `:has()` with a universal selector such as `.app-shell:has(…) *`: Chromium would search the
  whole app again on each recalculation. Mark app-wide states, such as the resize cursor while a
  divider is dragged, with a class on the root element.

## Tokens

| Group        | Tokens                                                                                                                           | Use                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Surfaces     | `--bg`, `--bg-sidebar`, `--surface-1…3`, `--surface-overlay`, `--surface-sunken`                                                 | Canvas, cards, raised controls, popovers and dialogs, wells |
| State layers | `--hover`, `--active`, `--selected`, `--input-bg`                                                                                | Translucent overlays that work on any surface               |
| Lines        | `--border`, `--border-strong`, `--border-hover`                                                                                  | Dividers, control outlines, hover outlines                  |
| Text         | `--text`, `--text-prose`, `--text-secondary`, `--text-muted`, `--text-faint`                                                     | Headings, chat prose, body, metadata, placeholders          |
| Accent       | `--accent`, `--accent-hover`, `--accent-fg`, `--accent-text`, `--accent-soft`, `--accent-border`, `--focus-ring`, `--focus-glow` | Primary buttons, links, selection, focus                    |
| Status       | `--success`, `--warning`, `--danger`, `--info` with `-soft`/`-border` variants, `--danger-solid`                                 | Meaningful states and destructive actions                   |
| Usage        | `--pace-*`, `--meter-*`, `--quota-guide`, `--quota-guide-over`, `--quota-excess`                                                 | Limit bars and pace indicators                              |
| Code         | `--code-*`, `--syntax-*`, `--diff-*`                                                                                             | Code blocks, highlighting and diffs                         |
| Type         | `--font-sans` (Geist), `--font-mono` (Geist Mono), `--text-2xs…3xl`, `--leading-*`, `--tracking-*`                               | All text                                                    |
| Shape        | `--radius-*`, `--control-*`, `--shadow-sm…xl`, `--backdrop`                                                                      | Corners, control heights, elevation                         |

`--provider-color` is set per element from the provider catalog. Tint provider marks with
`color-mix(… var(--provider-color) 11%, transparent)` and draw the glyph with
`color-mix(in srgb, var(--provider-color) var(--provider-ink-mix), var(--text))`, which keeps the
mark legible in the light theme.

## Themes

Dark is the default. Settings → Appearance offers Dark, Light and System per device; the choice
lives in local storage (`agent-studio.theme`) and sets `data-theme` on the root element, which
selects the light token values. Visualization frames receive the same theme through
`visualizationDocument()` so embedded visuals match the surrounding prose.

## Brand

The Agent A mark is an A-frame in the text color with a lime head (the agent) and crossbar, drawn
on a 64-unit grid in `BrandMark.svelte`. App icons place it on a graphite tile with a soft lime
glow. Icons at 16–32px use a heavier variant, and 16px drops the crossbar so the figure stays
legible. `node scripts/brand-icons.mjs` regenerates `static/agent-studio.svg`,
`static/favicon.svg`, the web and PWA PNGs, and the Tauri icon set from that geometry; change the
mark in the script and `BrandMark.svelte` together.

## Primitives

- **Buttons:** `.primary` (accent fill), `.secondary` (raised neutral), `.danger` (solid red for
  confirmed destruction), `.text-button` (inline action), `.icon-button` (32px ghost).
- **Icons:** Lucide outlines at their default stroke; never fill a glyph for emphasis. Choose one
  that stays clear as an outline: Stop response uses `CircleStop`, because an outlined square
  reads as an unchecked checkbox.
- **Fields:** text inputs, textareas and `ChoicePicker` in its `field` variant share one outline,
  hover and focus treatment. Checkboxes use `.checkbox`.
- **Dropdowns:** always `ChoicePicker.svelte`; toolbar triggers are borderless pills with an icon.
- **Overlays:** `.modal` and `ConnectionDialog` for dialogs, `--surface-overlay` with
  `--shadow-lg`/`--shadow-xl` for popovers and menus.
- **Disclosures:** quiet rows with a leading icon, a rotating chevron and a hover layer; expanded
  groups indent their children behind a hairline. Closed `<details>` content is `display: none`
  rather than Chromium's `content-visibility: hidden`, which a text selection across it restyles
  all at once. Chat disclosures render their contents on first expansion (`revealedDisclosures`
  in `src/lib/disclosures.ts`) and keep them afterwards.
- **Cards:** `--surface-1`, `--border`, `--radius-xl`. Settings sections and provider groups use
  them; avoid nesting more than one card level.
