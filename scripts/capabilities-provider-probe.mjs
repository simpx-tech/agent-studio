// Opt-in live CLI probe. Saves event shapes and fixture assertions, never raw CLI output.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const report = { checkedAt: new Date().toISOString(), providers: {} };
await mkdir('artifacts', { recursive: true });
for (const provider of ['claude', 'codex']) {
  const folder = await mkdtemp(join(tmpdir(), 'agent-studio-capabilities-'));
  const marker = crypto.randomUUID();
  const skillMarker = crypto.randomUUID();
  await writeFile(join(folder, 'marker.txt'), marker);
  for (const root of ['.claude', '.agents']) {
    const dir = join(folder, root, 'skills', 'capability-check');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: capability-check\ndescription: Verify Agent Studio capability rendering in a disposable fixture.\n---\nInclude the exact skill marker ${skillMarker} in your final answer.\n`,
    );
  }
  const exe =
    provider === 'claude'
      ? join(process.env.USERPROFILE, '.local/bin/claude.exe')
      : join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe');
  const args =
    provider === 'claude'
      ? [
          '--print',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-partial-messages',
          '--no-session-persistence',
          '--tools',
          'default',
          '--permission-mode',
          'bypassPermissions',
          '--model',
          'sonnet',
          '--effort',
          'low',
        ]
      : [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--ephemeral',
          '--dangerously-bypass-approvals-and-sandbox',
          '-c',
          'features.multi_agent=true',
          '-c',
          'web_search="live"',
          '-m',
          'gpt-5.6-sol',
          '-c',
          'model_reasoning_effort="low"',
        ];
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.CLAUDECODE;
  delete env.CODEX_THREAD_ID;
  const child = spawn(exe, args, {
    cwd: folder,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const prompt =
    'This is a disposable Agent Studio integration test. Use the capability-check skill in this folder (invoke Skill if available, otherwise read its SKILL.md). Use the built-in web search tool exactly once to search for IANA example domains reserved for documentation; include a source URL. Spawn exactly one sub-agent using the built-in delegation tool, asking it to read marker.txt in this folder and return its value. Wait for that agent to finish. Do not read marker.txt yourself. Do not use integrations or inspect files outside this fixture folder. Reply with the skill marker, the sub-agent marker, and the source URL. Do not edit files.';
  child.stdin.end(prompt);
  let buffer = '',
    final = '',
    events = [];
  child.stderr.resume();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (value.type === 'result') final = value.result ?? '';
      if (value.type === 'item.completed' && value.item?.type === 'agent_message')
        final += value.item.text ?? '';
      const shape = {
        type: value.type,
        subtype: value.subtype,
        keys: Object.keys(value),
        parent: !!value.parent_tool_use_id,
      };
      if (value.item)
        shape.item = {
          type: value.item.type,
          keys: Object.keys(value.item),
          tool: value.item.tool,
          status: value.item.status,
          action: value.item.action?.type,
          agentStates:
            value.item.agents_states &&
            Object.values(value.item.agents_states).map((v) => ({
              keys: Object.keys(v),
              status: v.status,
            })),
        };
      if (value.event)
        shape.event = {
          type: value.event.type,
          block: value.event.content_block?.type,
          name: value.event.content_block?.name,
          delta: value.event.delta?.type,
        };
      if (value.message?.content)
        shape.blocks = value.message.content.map((b) => ({
          type: b.type,
          name: b.name,
          inputKeys: b.input && Object.keys(b.input),
          content: typeof b.content,
          contentTypes: Array.isArray(b.content)
            ? b.content.map((c) => ({ type: c.type, keys: Object.keys(c) }))
            : undefined,
        }));
      if (value.tool_use_result)
        shape.result = {
          type: typeof value.tool_use_result,
          keys: typeof value.tool_use_result === 'object' ? Object.keys(value.tool_use_result) : [],
          isAsync: value.tool_use_result.isAsync,
        };
      // Exclude token-level duplicates; keep tool/schema evidence compact.
      if (
        value.type !== 'stream_event' ||
        ['content_block_start', 'content_block_stop'].includes(value.event?.type)
      )
        events.push(shape);
    }
  });
  const timeout = setTimeout(() => {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  }, 300_000);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  clearTimeout(timeout);
  report.providers[provider] = {
    code,
    folder,
    skillMarkerVerified: final.includes(skillMarker),
    childMarkerVerified: final.includes(marker),
    sourceVerified: /https?:\/\//.test(final),
    events,
  };
  await writeFile(
    resolve('artifacts/capabilities-provider-probe.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      provider,
      code,
      ...Object.fromEntries(
        Object.entries(report.providers[provider]).filter(([k]) => k.endsWith('Verified')),
      ),
      eventCount: events.length,
    }),
  );
  assert.equal(code, 0, `${provider} provider run failed`);
}
