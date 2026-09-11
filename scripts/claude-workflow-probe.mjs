// Opt-in protocol probe: one tiny native workflow in a disposable directory.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const cwd = await mkdtemp(join(tmpdir(), 'studio-native-workflow-'));
const prompt =
  'Use the native Workflow tool (discover it with ToolSearch if needed) to run exactly this tiny orchestration as inline script: export const meta = { name: "studio-native-probe", description: "One harmless agent", phases: ["Check"] }; phase("Check"); const result = await agent("Reply exactly STUDIO_NATIVE_WORKFLOW_OK. Do not use tools or read or write files.", { label: "Marker" }); return result; Wait for the workflow to finish and report its result. Do not substitute a sequence of Agent calls or any other implementation. No web, integrations, project reads or edits. If Workflow is unavailable, say so.';
const child = spawn(
  join(homedir(), '.local/bin/claude.exe'),
  [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'bypassPermissions',
    '--tools',
    'default',
    '--model',
    'sonnet',
    '--effort',
    'low',
    '--no-session-persistence',
  ],
  { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
);
const records = [];
const toolNames = new Map();
const timer = setTimeout(
  () => spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }),
  180000,
);
createInterface({ input: child.stdout }).on('line', (line) => {
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    return;
  }
  if (v.type === 'stream_event') return;
  const r = {
    type: v.type,
    subtype: v.subtype,
    keys: Object.keys(v),
    parent: v.parent_tool_use_id,
  };
  if (v.type === 'system') {
    for (const key of [
      'task_id',
      'task_type',
      'tool_use_id',
      'workflow_name',
      'description',
      'status',
      'patch',
      'usage',
      'tasks',
      'workflow_progress',
    ])
      if (v[key] !== undefined) r[key] = v[key];
    if (v.subtype === 'init') r.workflowTool = v.tools?.includes('Workflow');
  }
  for (const b of v.message?.content ?? []) {
    if (b.type === 'tool_use') {
      toolNames.set(b.id, b.name);
      r.tools ??= [];
      r.tools.push({ name: b.name, id: b.id, keys: Object.keys(b.input ?? {}) });
    }
    if (b.type === 'tool_result') {
      r.results ??= [];
      r.results.push({
        tool: toolNames.get(b.tool_use_id),
        id: b.tool_use_id,
        error: b.is_error,
        keys: Object.keys(v.tool_use_result ?? {}),
      });
      if (toolNames.get(b.tool_use_id) === 'Workflow') r.workflow = v.tool_use_result;
    }
  }
  if (v.type === 'result') {
    r.result = v.result;
    r.error = v.is_error;
  }
  records.push(r);
  console.log(JSON.stringify(r));
});
child.stderr.resume();
child.stdin.end(
  JSON.stringify({
    type: 'user',
    uuid: crypto.randomUUID(),
    origin: { kind: 'human' },
    message: { role: 'user', content: prompt },
  }) + '\n',
);
child.on('close', async (code) => {
  clearTimeout(timer);
  await writeFile(
    'artifacts/claude-workflow-probe.json',
    JSON.stringify({ code, cwd, records }, null, 2),
  );
  console.log('Exit', code);
});
