import { describe, expect, it } from 'vitest';
import type { ToolActivity } from './activity';
import {
  commandKind,
  connectedTool,
  fileLanguage,
  fileTypeIcon,
  primaryCommand,
  toolVisual,
  type ToolIconKey,
} from './tool-presentation';

const tool = (fields: Partial<ToolActivity>): ToolActivity => ({
  id: 'claude:t',
  revision: 1,
  category: 'tool',
  name: 'Run command',
  status: 'complete',
  sources: [],
  agents: [],
  ...fields,
});

describe('tool presentation', () => {
  it('names a command by its first line after lines a CLI hook added', () => {
    expect(primaryCommand('git status')).toEqual({ line: 'git status', more: false });
    expect(
      primaryCommand(
        'node "C:/Users/me/.codex/hooks/claude-context/context-hook.cjs" --record-cwd 3f\nGet-Content notes.txt',
      ),
    ).toEqual({ line: 'Get-Content notes.txt', more: false });
    expect(primaryCommand("\ncat <<'EOF' > a.txt\nhello\nEOF")).toEqual({
      line: "cat <<'EOF' > a.txt",
      more: true,
    });
    expect(primaryCommand('   ')).toEqual({ line: '', more: false });
  });

  it('classifies commands by the program they run, past setup and wrappers', () => {
    const cases: [string, ReturnType<typeof commandKind>][] = [
      ['git status --short', 'git'],
      ['cd /repo && git log --oneline -5', 'git'],
      ['& "C:\\Program Files\\Git\\bin\\git.exe" diff', 'git'],
      ['git grep applyRunEvent', 'search'],
      ['gh pr view 12', 'pullRequest'],
      ['npm test -- --run', 'test'],
      ['npm run test:unit', 'test'],
      ['FOO=1 npm run build', 'build'],
      ['npm run verify', 'build'],
      ['npm ci', 'package'],
      ['pnpm lint', 'lint'],
      ['yarn dev', 'server'],
      ['npx vitest run src/lib', 'test'],
      ['npx --yes prettier --check .', 'lint'],
      ['npx playwright test tests/a.spec.ts', 'test'],
      ['cargo test --manifest-path src-tauri/Cargo.toml', 'test'],
      ['cargo clippy -- -D warnings', 'lint'],
      ['cargo build', 'build'],
      ['python -m pytest -q', 'test'],
      ['pip install requests', 'package'],
      ['node scripts/probe.mjs', 'script'],
      ['docker compose up -d', 'container'],
      ['curl -s https://example.com', 'network'],
      ['ssh agent-studio-vps uptime', 'remote'],
      ['Get-ChildItem -Recurse src | Select-Object -First 5', 'list'],
      ['ls -la', 'list'],
      ['Get-Content -Raw README.md', 'read'],
      ['sed -n 1,80p src/app.ts', 'read'],
      ["sed -i 's/a/b/' src/app.ts", 'write'],
      ['rg -n "tool-card" tests', 'search'],
      ['Remove-Item -Recurse build', 'delete'],
      ['mkdir -p out', 'create'],
      ['Copy-Item a b', 'move'],
      ['Get-Process agent-studio', 'process'],
      ['Start-Sleep -Seconds 5', 'wait'],
      ['timeout 60 npm test', 'test'],
      ['sudo apt-get install jq', 'package'],
      ['claude -p "hello"', 'agentCli'],
      ['$env:NODE_ENV = "test"; npx vitest', 'test'],
      ['echo "---" && git status', 'git'],
      ['echo hello', 'terminal'],
      ['./configure', 'terminal'],
    ];
    for (const [command, kind] of cases) expect(commandKind(command), command).toBe(kind);
  });

  it('shows commands with their description, or the command itself as code', () => {
    expect(
      toolVisual(tool({ command: 'git status', shell: 'bash', detail: 'Show working tree' })),
    ).toMatchObject({ icon: 'git', title: 'Show working tree', detail: 'git status' });
    expect(
      toolVisual(tool({ command: 'npm test\nnpm run build', commandRun: true })),
    ).toMatchObject({
      icon: 'test',
      title: 'npm test …',
      code: true,
      hint: 'npm test\nnpm run build',
    });
    // Older calls recorded no command.
    expect(toolVisual(tool({ commandRun: true, detail: 'Run unit tests' }))).toEqual({
      icon: 'terminal',
      title: 'Run unit tests',
    });
  });

  it('gives files, searches, images, edits and connected tools their own icons', () => {
    const folder = 'C:\\Projects\\studio';
    expect(
      toolVisual(
        tool({ name: 'Read', operation: 'read', path: 'C:\\Projects\\studio\\src\\app.ts' }),
        {
          folder,
        },
      ),
    ).toMatchObject({
      icon: 'code',
      detail: 'src/app.ts',
      hint: 'C:\\Projects\\studio\\src\\app.ts',
    });
    expect(toolVisual(tool({ name: 'Read', operation: 'read', path: '/notes.txt' }))).toMatchObject(
      {
        icon: 'file',
      },
    );
    expect(
      toolVisual(tool({ name: 'View image', operation: 'viewImage', path: '/tmp/shot.png' })),
    ).toMatchObject({ icon: 'image', detail: '/tmp/shot.png' });
    expect(toolVisual(tool({ name: 'Edit', operation: 'edit', path: '/a.ts' }))).toMatchObject({
      icon: 'edit',
    });
    expect(
      toolVisual(tool({ name: 'Edit', operation: 'edit', path: '/a.ts' }), { newFile: true }),
    ).toMatchObject({ icon: 'newFile' });
    expect(
      toolVisual(
        tool({
          name: 'Edit files',
          operation: 'edit',
          facts: [{ label: 'Files', value: '/r/a.ts\n/r/b.ts' }],
        }),
        { folder: '/r' },
      ),
    ).toMatchObject({ detail: 'a.ts and 1 more' });
    expect(
      toolVisual(tool({ name: 'Search file contents', operation: 'grep', query: 'applyRunEvent' })),
    ).toMatchObject({ icon: 'grep', detail: 'applyRunEvent' });
    expect(
      toolVisual(tool({ name: 'Find files', operation: 'glob', query: '**/*.ts' })),
    ).toMatchObject({ icon: 'findFiles' });
    expect(
      toolVisual(tool({ category: 'search', name: 'Web search', query: 'svelte runes' })),
    ).toMatchObject({ icon: 'web', detail: 'svelte runes' });
    expect(toolVisual(tool({ name: 'mcp__chrome-devtools__take_screenshot' }))).toMatchObject({
      icon: 'screenshot',
      title: 'take_screenshot',
      detail: 'chrome-devtools',
    });
    expect(toolVisual(tool({ name: 'mcp__Claude_Browser__navigate' }))).toMatchObject({
      icon: 'browser',
    });
    expect(
      toolVisual(
        tool({ name: 'Connected tool: search', facts: [{ label: 'Connection', value: 'docs' }] }),
      ),
    ).toMatchObject({ icon: 'plug', title: 'search', detail: 'docs' });
    expect(toolVisual(tool({ category: 'agent', name: 'Sub-agents' })).icon).toBe('agent');
    expect(toolVisual(tool({ category: 'hook', name: 'PreToolUse hook' })).icon).toBe('hook');
    expect(toolVisual(tool({ name: 'Wait for background tasks' })).icon).toBe('waitTasks');
    expect(toolVisual(tool({ name: 'Legacy tool' })).icon).toBe('tool');
    expect(connectedTool(tool({ name: 'Bash' }))).toBeUndefined();
  });

  it('gives each edited file the icon of its type', () => {
    const cases: [string, ToolIconKey][] = [
      ['src/lib/theme.css', 'style'],
      ['src/lib/styles.scss', 'style'],
      ['src/app.html', 'markup'],
      ['static/page.xml', 'markup'],
      ['src/lib/components/FileChanges.svelte', 'component'],
      ['web/App.tsx', 'component'],
      ['src/lib/tool-presentation.ts', 'code'],
      ['src-tauri/src/lib.rs', 'code'],
      ['scripts/brand-icons.mjs', 'code'],
      ['src/lib/file-changes.test.ts', 'test'],
      ['tests/file-changes.spec.ts', 'test'],
      ['runner_test.go', 'test'],
      ['package.json', 'data'],
      ['package-lock.json', 'lock'],
      ['pnpm-lock.yaml', 'lock'],
      ['src-tauri/Cargo.lock', 'lock'],
      ['src-tauri/Cargo.toml', 'config'],
      ['.github/workflows/release.yml', 'config'],
      ['.env.production', 'config'],
      ['.prettierrc', 'config'],
      ['scripts/vps/install.sh', 'shell'],
      ['scripts/start-windows.ps1', 'shell'],
      ['relay/Dockerfile', 'container'],
      ['compose.yaml', 'container'],
      ['.gitattributes', 'git'],
      ['Makefile', 'build'],
      ['docs/CAPABILITIES.md', 'file'],
      ['LICENSE', 'file'],
      ['notes.unknown', 'file'],
      ['static/favicon.svg', 'image'],
      ['artifacts/file-changes.png', 'image'],
      ['analysis.ipynb', 'notebook'],
      ['db/schema.sql', 'database'],
      ['data/report.csv', 'spreadsheet'],
      ['static/fonts/Geist.woff2', 'font'],
      ['release/installer.zip', 'archive'],
      ['docs/demo.mp4', 'media'],
      ['target/debug/studio.exe', 'binary'],
    ];
    for (const [path, icon] of cases) expect([path, fileTypeIcon(path)]).toEqual([path, icon]);
    expect(fileTypeIcon('C:\\Projects\\studio\\src\\lib\\Theme.CSS')).toBe('style');
    expect(fileTypeIcon('unlock.ts')).toBe('code');
  });

  it('highlights file content by its extension', () => {
    expect(fileLanguage('src/lib/activity.ts')).toBe('typescript');
    expect(fileLanguage('src-tauri/src/lib.rs')).toBe('rust');
    expect(fileLanguage('C:\\x\\Component.svelte')).toBe('xml');
    expect(fileLanguage('Makefile')).toBe('makefile');
    expect(fileLanguage('notes.unknown')).toBeUndefined();
    expect(fileLanguage()).toBeUndefined();
  });
});
