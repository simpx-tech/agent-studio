# Structured output

Open **Chat instructions** and enter an optional **Structured output · JSON Schema** for a Claude or Codex conversation. Save keeps the message draft and sends nothing. Leave the field empty to return to normal replies. This setting applies to subsequent replies in this conversation; completed replies retain their captured schema. New conversations start without a schema.

The schema must be valid JSON with an object root (`"type":"object"`), at most 16,000 UTF-8 bytes and 32 levels deep. The provider validates its supported schema dialect and constraints; local checks do not claim full schema validation. For example:

```json
{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}
```

Claude receives the literal schema as a `--json-schema` argument alongside stream-json input/output. Its successful parent `result.structured_output` is authoritative, including an empty object; child results and tool arguments never become the answer. Missing, non-object, or oversized output fails explicitly, and provider retry-exhaustion errors remain failures. Changing or disabling the schema changes Claude's parked-process identity while resuming the same native conversation. Compaction runs without the schema and uses its own compatible process identity.

Codex receives the parsed object in `turn/start.outputSchema` on every applicable reply, including resumed and reused sessions. It is never a thread setting or a steering override. Disabling it omits the parameter on the next turn; compaction omits it. Completed output must parse as a JSON object. Outputs over 512,000 bytes fail instead of being truncated.

JSON is saved as the reply's exact pretty-printed JSON text and displayed as inert highlighted code, without Markdown or HTML interpretation. Existing workspace v3 save/export/relay, reply settings, history, and forks preserve it. Historical JSON travels as ordinary assistant context; historical schema settings never become new native schema arguments. Quotas, costs, tools, reasoning, work history, execution host/account selection, and full-access Build permissions retain their existing behavior. Background titles and unsupported providers cannot request structured output.

Provider references: [Claude Code headless output](https://code.claude.com/docs/en/headless) and [Codex app-server turns](https://learn.chatgpt.com/docs/app-server).

## Verification

Windows native checks on 2026-09-20 used an isolated app identity and disposable project folders with Claude Code 2.1.277 (Sonnet) and Codex CLI 0.153.4 (gpt-5.6-sol). Both returned valid JSON for an initial reply and a second reply, adopted a different schema, and returned normal text after disabling it. The native screenshots and result report are under ignored `artifacts/structured-output/`. No sign-in was required for either selected existing-login connection. WSL execution and cross-computer structured-output runs were not separately exercised.

Run the opt-in native check with `scripts/native-structured-output.tauri.json`, a frontend on port 1457, a separate Cargo target, and the guarded Windows launcher described in [Windows startup](WINDOWS-STARTUP.md). Then run `node scripts/structured-output-native-smoke.mjs`. It checks the QA identifier before touching that isolated workspace and starts four small live replies per provider.

Automated coverage includes malformed/oversized schema input, literal CLI arguments, parent/child and empty-history acknowledgements, missing/failed/oversized results, per-turn Codex parameters, process reuse identity, persistence/relay/forks, desktop/mobile forms, inert JSON rendering, disabling, and ordinary Markdown restoration. Run `npm run verify` and the documented Rust formatting, Clippy, and test gates.
