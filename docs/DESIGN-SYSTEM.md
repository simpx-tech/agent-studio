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
- **Motion is feedback.** Hover and state transitions use `--duration-fast`; overlays (dialogs
  and their backdrops, popovers, menus, docked panels) fade in with opacity only, so measured
  layout never moves during an animation. What appears in a chat fades in with opacity only too,
  since the chat measures its content to keep its place: a message, the reply it starts or a
  steer written in the last 1.5 seconds (`fresh` in `MessageView.svelte`, so a chat's messages
  show at once when it opens), a question as Claude writes it, an opened disclosure's content
  and a reply footer panel. A page, sidebar tab or mode fades its view in when chosen, and a new
  chat's welcome rises 6px; sidebar rows never animate on their own, since they are reused in
  place as chats reorder. Compact buttons give a little while pressed, through the `scale`
  property so their own transforms stay (0.93 for icon buttons, 0.97 for text buttons; never
  rows, menu items or cards). A theme change crosses over through a view transition. A running
  reply's calls enter, fold into their group and slide into place with `--duration-slow`,
  animating only opacity and transforms: layout changes at once and the animation plays over
  it. Sending a message from the end of a chat glides the conversation to it, while following
  streamed output stays instant. The global reduced-motion rule stops CSS animations of
  elements and their `::before` and `::after`; other pseudo-elements (`::backdrop`,
  `::details-content`) animate only under `prefers-reduced-motion: no-preference`, and script
  animations, that glide and the theme crossfade included, check it themselves.
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
| Accounts     | `--account-red`, `-orange`, `-yellow`, `-green`, `-teal`, `-blue`, `-violet`, `-pink`, `-brown`, `-gray`                         | The color that marks each account                           |
| Code         | `--code-*`, `--syntax-*`, `--diff-*`                                                                                             | Code blocks, highlighting and diffs                         |
| Type         | `--font-sans` (Geist), `--font-mono` (Geist Mono), `--text-2xs…3xl`, `--leading-*`, `--tracking-*`                               | All text                                                    |
| Shape        | `--radius-*`, `--control-*`, `--shadow-sm…xl`, `--backdrop`                                                                      | Corners, control heights, elevation                         |

`--provider-color` is set per element from the provider catalog. Tint provider marks with
`color-mix(… var(--provider-color) 11%, transparent)` and draw the glyph with
`color-mix(in srgb, var(--provider-color) var(--provider-ink-mix), var(--text))`, which keeps the
mark legible in the light theme.

Model marks are tinted the same way. `modelMark` in `src/lib/model-marks.ts` names a model's
line and version and sets `--provider-color` to the line's token, which is the same in both themes:
`--model-opus`, `--model-sonnet`, `--model-fable`, `--model-haiku`, `--model-mythos`,
`--model-astra`, `--model-sol`, `--model-luna`, `--model-terra`, `--model-flash` and `--model-pro`.
GPT and Gemini models of no named line keep the provider color. `ModelMark.svelte` sets the line's
print beside its version in semibold tabular numerals, in three shapes: a pill in each Model picker
choice (one width for the usual versions, so the names line up), a tile on reply avatars with the
version beneath the print, and a chip on the Model trigger that draws the print alone, since the
selected name beside it already shows the version. The mark's edge is drawn over the print, so
pale prints keep their shape on light surfaces. A pill without a version keeps that width, with
its print at the start or, without a known line, the provider glyph in the middle.

Model line prints (`ModelIcon.svelte`) are the one exception to the Lucide outline rule: small
abstract compositions of flat shapes on a 64-unit canvas, like mid-century art prints, filling the
square they are given. Each line has its own palette in `theme.css`, `--art-<line>-0` for the
ground and `-1` to `-4` for its shapes, identical in every theme like the prints themselves.
Overlaps are drawn as paths of their own rather than clipped, so the prints use no ids and a page
can hold any number of copies: Opus arches under a pale sun, Sonnet three flowing ribbons, Fable two overlapping circles, Haiku a sun over a quiet horizon, Mythos a radiant sun disc, Astra a star cut by four quarter circles, Sol a striped setting sun, Luna a crescent in its halo, Terra layered hills, other GPT models quarter-circle tiles, Flash a zigzag split, Pro a faceted prism, and other Gemini models twin circles.

Account colors are a third identity palette. Each account has one of ten named colors
(`src/lib/account-colors.ts`), whose tokens have a value per theme like status colors: bright on
graphite, deeper on white. Unlike provider and model tints they fill their marks, so the hue reads
at a glance: `AccountMark.svelte` draws the agent's glyph in `--text-inverse` on the account's
color, as a 28px tile in an Agent picker choice, a 20px chip on the Agent trigger and a 52px tile
on a new chat's welcome. `.account-dot` is the same color as an 8px dot before an account's name
in running text, 10px beside a Connections heading. Set `--account-color` from
`accountColorValue`, never a raw color. Only accounts the Agent picker names are filled: an agent
with one account on a computer keeps its tinted provider mark and the bot icon. Manage account
shows the palette as 22px swatches in one radio group, the chosen one ringed in its own color.

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
- **Icons:** Lucide outlines at their default stroke; never fill a glyph for emphasis (model line
  prints are the one exception, see above). Choose one
  that stays clear as an outline: Stop response uses `CircleStop`, because an outlined square
  reads as an unchecked checkbox.
- **Fields:** text inputs, textareas and `ChoicePicker` in its `field` variant share one outline,
  hover and focus treatment. Checkboxes use `.checkbox`.
- **Dropdowns:** always `ChoicePicker.svelte`; toolbar triggers are borderless pills with an icon.
  Choices with icons of their own draw them through `optionIcon` at 16px, muted until the choice
  is highlighted or selected, as the Folder list does.
  The toolbar caps each picker, which its trigger fills, at 220px and the Agent's at 280px (170px
  and 220px in windows up to 1100px wide): a cap on the trigger alone leaves the room a longer
  name asked for empty beside it.
- **Sliders:** for ordered choices, such as Reasoning, a `ChoicePicker` with `slider` opens
  `ChoiceSlider.svelte` instead of a list: a 6px `--border-strong` track with a 10px
  `--text-faint` dot at each stop, filled in `--accent-strong` up to a 20px `--accent-strong`
  thumb ringed in `--surface-overlay` (the dots it passes turn `--accent-strong`, a
  `--focus-glow` halo shows while it is dragged and the focus ring from the keyboard), and each
  stop's name under it at `--text-xs` in `--text-muted`, the chosen one in `--text`. The thumb and
  fill glide over `--duration-slow` with `--ease-out`, through transforms only, and follow a drag
  at once. The popover widens with the stops (`sliderWidth`).
- **Tabs:** a switch between whole sections, such as the sidebar's Agent and Workflow modes or
  Model context's categories, is text tabs over a hairline with a 2px `--accent-strong` line
  under the chosen one; a filter of one list, such as Active, History and Screens, is a segmented
  control on `--hover` with `--radius-md` corners. Neither is a pill.
- **Empty lists:** a sidebar list with nothing to show centres a 36px `--surface-1` tile with a
  muted icon of what it lists above one short line in `--text-secondary`, such as No workflows or,
  while searching, No matches (`SidebarEmpty.svelte`); a list still loading keeps a plain line.
- **Selected rows:** the open chat or draft in the sidebar has the selected background and an
  accent bar at its left edge.
- **Day divisions:** where a chat continues on another day, the day's name in `--text-muted` at
  `--text-xs` sits in the middle of a `--border` hairline that spans the conversation
  (`.message-day`), with more room above it than below, so it reads as the start of that day's
  messages.
- **Live state:** a running reply shows the accent `LoaderCircle` spinner, like running calls and
  plan steps, beside Responding or Compacting context in its heading. Its sidebar row ends with
  its elapsed time instead, in `--accent-text` and the compact form running calls use (12s,
  1m 12s, 1h 7m), counted from the shared clock in `src/lib/clock.ts` that the reply footer's
  elapsed time also reads; a reply whose start cannot be read keeps the spinner there. A reply
  working through a plan counts its steps just before that time in `--text-muted`, a step from its
  start (2/3 while the second runs, 5/5 on the last), as the footer's Plan toggle counts them. After the reply ends, a chat whose Monitor watches
  still run ends its row with the accent `Activity` pulse that Work history gives Monitor calls,
  beside any unread dot, until they report their outcome. While a reply waits for your answer to a
  question or form, it asks for attention in orange (`--warning`): its row and heading show
  `MessageCircleQuestionMark` instead, the heading reads Waiting for you, and the waiting
  question, plan approval or MCP form card has an orange border. Choices inside the card and its
  primary action keep the accent.
- **Overlays:** `.modal` and `ConnectionDialog` for dialogs, `--surface-overlay` with
  `--shadow-lg`/`--shadow-xl` for popovers and menus.
- **Disclosures:** quiet rows with a leading icon, a rotating chevron and a hover layer; expanded
  groups indent their children behind a hairline. Closed `<details>` content is `display: none`
  rather than Chromium's `content-visibility: hidden`, which a text selection across it restyles
  all at once. Chat disclosures render their contents on first expansion (`revealedDisclosures`
  in `src/lib/disclosures.ts`) and keep them afterwards.
- **Frame:** in a window wider than 760px, as in Linear, the sidebar lies on the window's own
  surface (`--bg-sidebar`, without an edge of its own), and so do the window's title and its
  buttons. Below them what is shown is a card: `--bg` inside a `--border` line with `--radius-xl`
  corners and `--shadow-md`, 12px from the window's sides and bottom; a chat (`.card-layout`) and
  a side panel docked beside it are two such cards, the gap between them the handle that resizes
  the panel, and Settings and Connections are one (`.page-card`). The window's title names a
  page once: Settings and Connections keep their `h1` for assistive technology alone
  (`.page-name`). Phones keep the page edge to edge.
- **Cards:** `--surface-1`, `--border`, `--radius-xl`. Settings sections and provider groups use
  them; inside the frame, avoid nesting more than one card level.
- **Code blocks:** `--code-bg` with a hairline border. Copy and Run are small text controls with
  a 13px icon that fill the block's top right corner in the block's own surface, so a long first
  line ends cleanly under them. They appear on hover or focus and are always shown, in a row above
  the code, on touch screens and phones. A control reports what its click did in place (Copied in
  `--success`, Opening… with the spinner, Not copied in `--danger`) and returns to rest.
