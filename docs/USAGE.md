# Usage and context tracking

Chats show compact progress bars directly below the message input: **Context**, **5-hour**, and **Weekly**, omitting an unreported Codex 5-hour window. Claude and Codex also show a **Credits** control. The context bar shows the latest response's provider-reported context count. Before a measurement, or when a reply supplies no usable request-level count, it says **Not measured yet**. Unknown bars use a striped track and omit a numeric progress value, preserving the distinction from a measured zero.

Click any usage control to open reset times, budgets, credits, and guidance in a panel above the input. The panel leaves the message box and Send button usable; close it with Escape, its Close button, or the same control. Its title and Checked text align vertically with Close. There are no gauge or refresh buttons. **Fable weekly** appears in this expansion only for a Claude Fable selection, including a CLI default that resolves to Fable. Hover the Agent picker for the selected provider's tool-access policy; the message field's hover retains its keyboard shortcuts.

Usage refreshes automatically without generating a model response. While a chat is visible, checks run once a minute; returning to the app and completing a reply/title also refresh account usage. A minute of caching limits redundant calls.

## Credits

Claude and Codex also have a **Credits** control below the input. Open it for details, or see the same reading beside each account's limits in Connections. These readings use the existing read-only usage query and exact account/computer routing, including remote and WSL connections. They refresh with account usage, stay in session memory, and retain the last reading on query failure. Older hosts without credit support show **Not reported**. Narrow chat layouts wrap the usage controls into two columns.

- **Codex:** account credit balance, unlimited/available/no-credit status when reported, and a separate count of available usage resets. Read `rateLimitsByLimitId.codex.credits`, with the legacy `rateLimits.credits` fallback only when the multi-bucket view is absent or empty. Never borrow another model bucket's balance. Credits have no assumed dollar conversion or percentage denominator.
- **Claude:** whether extra usage is enabled, spending this month, monthly spending cap, reported utilization, and remaining room under that cap. Read `rate_limits.extra_usage` from `get_usage`. Monetary amounts use the reported `currency` and `decimal_places`; missing units leave money unknown. The prepaid balance is not exposed by the supported CLI interface and is explicitly labelled unavailable. Remaining room under a spending cap is never labelled a prepaid balance. Disabled extra usage still retains reported spending and cap amounts. Missing caps are not assumed unlimited.

Zero, unavailable, disabled, and unlimited states remain distinct. Tracking does not buy credits, redeem resets, change spending controls, or infer spending from per-reply costs.

Schema checks: installed Codex 0.153.4 generated app-server types; Claude Code 2.1.267 live read-only usage response and official SDK 0.3.267 types. [Codex account protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs) describes credit snapshots; [Claude usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans) explains the separate credit balance and spending cap.

Verified September 14, 2026: `npm run verify` (192 unit/HTTP tests, production build, 129 browser scenarios), Rust formatting and Clippy, and 126 Rust tests passed; four existing opt-in Rust integrations remain ignored. `npm run tauri dev -- --config scripts/native-credits.tauri.json --no-watch` and `scripts/credits-native-smoke.mjs` verified live Windows queries for both providers with an isolated app identifier/profile. Browser coverage checks credit values, failed-refresh retention, drafts, keyboard closing, and desktop/mobile layouts; images were visually reviewed. Evidence is in ignored `artifacts/credits/` and `artifacts/credits-*.png`. Credit-specific live WSL and paired-remote checks were not run; routing remains on the existing usage transport, covered by the full suite. No provider responses were generated or billing settings changed.

## Reply usage and cost

Each completed reply has a collapsed timing row below its final answer and artifact/progress cards, showing only the reply's elapsed time and cumulative total AI time. Work history is separately expandable below the model title. Expand the timing row with a click, Enter, or Space to see token counts, cached input, reasoning tokens when reported, elapsed time, and estimated cost in USD. Cached input is already included in input. Missing reply timing is labelled **Time not recorded**. Cost is stored with the reply and travels through relay checkpoints and saved history.

The same row also shows **total AI time** through that reply: the sum of its duration and all earlier saved assistant reply durations in the conversation. It includes recorded stopped and failed replies across model changes, and excludes user messages, idle time between messages, running replies, and separate conversations. Tool and child-agent times are already within the reply duration and are not added again. Totals are derived from saved durations, so history and relay updates retain them without another stored counter. Missing historical timing is marked with **≥** and explained in the expansion; if all timing is missing, the total says **Not recorded**. Long totals display minutes and hours.

Claude supplies `total_cost_usd` in its final result, including failed results when present. The app displays that provider estimate once, without summing model or child totals again. Current Codex and Antigravity reply events supply no supported cost field, so their cost stays **Not reported**. Older saved replies also remain unknown. A reported zero is displayed as $0.00; tiny positive costs retain precision. The estimate describes the reply's reported cost; actual billing depends on the account plan. See [Claude cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) and [subscription cost interpretation](https://code.claude.com/docs/en/costs).

## Subscription limits

These are account readings, not estimates from the number of local messages. They include usage from other sessions and title generation. They stay in memory and are not exported with conversations. A missing window or missing percentage reads **Not reported**, never 0%. Failed refreshes retain the last successful reading and mark it **Last reported**. Readings older than three minutes, or whose reset time passed, are also marked as old; the app does not assume a reset succeeded or fabricate fresh capacity.

The readers launch installed CLIs in hidden, bounded processes and let each CLI authenticate normally. They do not read credential files, scan account transcripts, redeem reset credits, enable overages, or purchase anything.

| Provider | Read interface | Interpretation |
| --- | --- | --- |
| Codex | App-server `account/rateLimits/read` | Prefer `rateLimitsByLimitId`; classify windows by `windowDurationMins`, not primary/secondary position. Preserve separate model buckets; Spark readings only apply to Spark. |
| Claude | Stream-JSON control `get_usage`, with `skip_behaviors: true` | 5-hour and 7-day `utilization` are percentages used. Fable comes from the server-labelled `model_scoped` array. Do not interpret undocumented internal bucket names. |
| Gemini | Antigravity `--print /usage --output-format json` | Use only the Gemini Models group. Convert `remaining_fraction` to percentage used. An account can omit its 5-hour window. |

Claude's structured usage interface is marked **experimental** by its SDK. The implementation was verified against installed Claude Code 2.1.263 and the official `@anthropic-ai/claude-agent-sdk` 0.3.263 types. Unavailable/changed responses produce an unavailable or last-reported state. Occasionally `rate_limits_available: true` arrives with `rate_limits: null`; this is a failed reading, not a zeroed account. Read-only queries time out after 25 seconds and are cancelled on app close.

## Quota pace and context guidance

Arrows use plain 16px icons at the app's standard stroke weight, with no borders or colored backgrounds.

The panel shows usage, reset times, a remaining hourly/daily budget, and actionable warnings. Pace is represented by bare trend arrows: green downward **Below pace**, blue right **On track**, amber upward **Ahead of pace**, and red upward **Limit reached**. Unknown pace uses a gray dash. Hover descriptions and accessible names retain the full meanings; quota bars use matching colors. The next-request estimate and Details section are removed.

Quota indicators compare the percentage used with the percentage of the full window elapsed. The guide assumes even use over the entire window, including nights and weekends; it is a planning aid, not an extra provider limit. The inferred window starts at the reported reset time minus its duration. Both sides of the comparison use the quota reading's `checkedAt` timestamp, so an unchanged reading does not become more favorable merely because the clock advances.

| Indicator | Meaning | Suggested action |
| --- | --- | --- |
| Green ↘ Below pace | More than 5 percentage points below the even-use guide | Room to spare compared with evenly spread usage |
| Blue → On track | Within 5 percentage points of the guide | Stay near the guide |
| Amber ↗ Ahead of pace | More than 5 percentage points above the guide | Ease usage to last until reset |
| Red ↗ Limit reached | Reported usage is at least 100% | Wait for reset or use another provider |
| Gray − Pace unavailable | Missing, stale, failed, expired, or inconsistent reading | Refresh for a usable reading |

For example, 70% used halfway through a window is ahead of the 50% guide. Continuing at the same window-average pace projects about 140% by reset. With 2.5 hours left in a five-hour window, the remaining allowance is 12% of the full limit per hour. Slow-down guidance is calculated only after at least 5% of a window has elapsed. Daily allowance is used for longer remaining periods; five-hour windows and periods with less than a day remaining use hourly allowance. Fable's extra window is assessed independently and only displayed for Fable.

Quota bars overlay the current colored fill and a secondary neutral recommendation on one track, sharing the same left edge and 0–100% scale. An endpoint mark keeps the recommendation visible when current usage passes it. Both the compact row and expanded cards omit a separate recommendation label; hover and accessible text retain the comparison. The recommendation uses the even-use guide at the reading's timestamp; context has no timed recommendation. Failed, stale, expired, or missing readings retain any known usage while hiding the recommendation.

Context has no timed reset. Its separate status uses the measured percentage: **Room available** below 80%, **Watch context** from 80%, **Nearly full** from 90%, and **At capacity** from 100%. **Growing quickly** applies below 80% when recent growth projects reaching 80% within three similar exchanges. These are app guidance thresholds. The context chip shows only its label and measured value, without a Reported badge or arrow. Status and advice remain on hover and in its accessible name; expanding the panel retains actionable warnings and growth estimates.

Growth uses up to six consecutive compatible measured readings (five increments), requiring at least three readings. Provider, model, reasoning, instructions, resolved model, and reported capacity must stay compatible. Missing readings, settings changes, and a decrease in context stop the trend; it never bridges a reset/compaction or mixes cumulative billing with context. The average measured growth provides an explicitly approximate number of similar exchanges to 80%. Projections beyond 20 exchanges are omitted; zero growth does not produce an infinite promise. Token room and practical advice to focus messages or carry a summary to a new chat appear in the expanded context card.

Typing leaves the measured reading and its guidance unchanged. Unknown measured context stays unknown while typing; no next-request or draft estimate is displayed. Pace and growth calculations run locally on existing readings and saved messages; they make no additional provider requests.

## Chat context and recorded tokens

The main context meter uses `contextInput` from the latest compatible reply, divided by its reported context window when available. Claude's reading is the latest API request's input plus cache-read and cache-creation input, matching its documented status-line formula. Output and cached-token billing are not added again. Hovering the token count shows the full number. The response's window takes precedence over a newly refreshed model catalog, so a historical reading is not silently recalculated against a changed model capacity.

Typing a draft does not change the reported meter. A pending reply retains the previous reading until fresh usage arrives; a completed reply missing a context measurement clears the reading instead of reviving an older one. Changing provider, model, reasoning, or instructions requires a compatible new reading. Persisted request counts can be displayed even when an older reply has no local prompt estimate. An explicit zero is a real reading; an absent count is unknown.

**Current adapter coverage:** Claude reports request-level context. The Codex `exec --json` and Antigravity result totals used by the current adapters are retained as token totals; they are not relabelled as exact context. Those providers currently show **Not measured yet** in the main meter. Supporting their live context feeds requires further adapter work, not a claim that the providers cannot track context.

Agent Studio starts a fresh CLI request for each reply and replays the local conversation. Failed/cancelled assistant text is not replayed. The UI displays only measured context; local prompt estimates remain internal metadata and are never substituted for a provider reading.

Capacity comes from a response's `modelUsage.contextWindow`, Codex's CLI-maintained `models_cache.json` effective window, Claude's read-only `get_context_usage` summary for the selected model, and the published Gemini input limit for the explicitly supported model families. A separate read-only summary supplies model capacity only; it is not the chat's live context session. Unknown models have unknown capacity; no universal model limit is guessed. Gemini's published limit can differ from a CLI's reserved/compaction budget. This implementation does not add automatic compaction or native session resumption.

Reported input, output, cached input, and available reasoning counts are saved on each reply. Per-reply counts remain saved and available on messages; the usage panel no longer displays aggregate chat totals. Older replies without counts remain explicitly unmeasured. Title usage is included in account limits. Workspace v2 accepts the additional optional fields without dropping existing conversations.

## References checked September 8, 2026

- [Codex app-server account rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)
- [Claude SDK package and type declarations](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [Claude status-line context and rate-limit semantics](https://code.claude.com/docs/en/statusline)
- [Antigravity read-only slash-command support](https://antigravity.google/changelog)
- [Gemini 3.8 Flash input limit](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [3.7 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash), [3.6 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash), [3.1 Pro](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview)
