import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Guards against the freezes described in docs/PERFORMANCE.md. Each failure names the code that
// needs a decision; update an allowlist only for work that stays off the hot paths listed there.

// Whole-workspace copies by file and enclosing function, and why each one is acceptable.
const allowedWorkspaceCopies: [site: string, reason: string][] = [
  ['src/routes/+page.svelte › onMount callback › workspace', 'the runtime getter itself'],
  ['src/routes/+page.svelte › persist', 'a save writes the whole workspace'],
  ['src/lib/transport.ts › saveWorkspace', 'the Viewer stores the whole workspace'],
  ['src/lib/transport.ts › resolveRelaySettings', 'desktop backup before adopting a relay'],
  ['src/lib/transport.ts › resolveRelaySettings', 'Viewer backup before adopting a relay'],
  ['src/lib/transport.ts › resolveRelaySettings', 'adopting the relay’s computers'],
  ['src/lib/transport.ts › localCall', 'recording an explicit Undo edits'],
  ['src/routes/+page.svelte › forkChat', 'the 20 MB limit before an explicit fork'],
  ['src/routes/+page.svelte › fitsWorkspace', 'the 20 MB limit, only when sending images'],
  ['src/routes/+page.svelte › exportWorkspace', 'desktop export'],
  ['src/routes/+page.svelte › exportWorkspace', 'Viewer export'],
];

// Synchronous commands and why each returns without waiting on files, processes or the network.
const synchronousCommands: Record<string, string> = {
  set_pending_chat_badge: 'sets the taskbar overlay, which belongs to the window thread',
  live_account_updates: 'copies bounded readings from memory',
  background_work: 'copies bounded snapshots from memory',
  cancel_title: 'cancels a token',
  app_update_status: 'copies the update status from memory',
};

function sources(root: string, extensions: string[]) {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => extensions.some((extension) => file.endsWith(extension)))
    .filter((file) => !file.endsWith('.test.ts'))
    .map((file) => ({
      file: join(root, file).replaceAll('\\', '/'),
      text: readFileSync(join(root, file), 'utf8'),
    }));
}

// TypeScript of a module or of each Svelte <script> block.
function scripts(file: string, text: string) {
  if (!file.endsWith('.svelte')) return [text];
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

// Named functions around a node, outermost first, so a copy inside an effect or timer shows as
// one, e.g. `+page.svelte › $effect callback`.
function owner(node: ts.Node) {
  const names: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    )
      names.unshift(current.name.text);
    else if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (
        (ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)) &&
        ts.isIdentifier(parent.name)
      )
        names.unshift(parent.name.text);
      else if (ts.isCallExpression(parent))
        names.unshift(`${parent.expression.getText()} callback`);
      // An immediately invoked function belongs to the function around it.
      else if (!ts.isParenthesizedExpression(parent) || !ts.isCallExpression(parent.parent))
        names.unshift('function');
    }
  }
  return names.join(' › ') || 'top level';
}

// A zero-argument `.workspace()` call is the runtime's whole-workspace getter, a $state.snapshot
// of everything. Snapshotting, cloning or serializing `workspace` itself copies all of it too.
function copiesWorkspace(node: ts.Node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'workspace')
    return node.arguments.length === 0;
  const [first] = node.arguments;
  return (
    ['$state.snapshot', 'JSON.stringify', 'structuredClone'].includes(callee.getText()) &&
    !!first &&
    ts.isIdentifier(first) &&
    first.text === 'workspace'
  );
}

function copiesIn(file: string, text: string) {
  const found: string[] = [];
  for (const script of scripts(file, text)) {
    const source = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (copiesWorkspace(node)) found.push(`${file} › ${owner(node)}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

function workspaceCopies() {
  return sources('src', ['.ts', '.svelte'])
    .filter(({ text }) => text.includes('workspace'))
    .flatMap(({ file, text }) => copiesIn(file, text))
    .sort();
}

// Whether each #[tauri::command] function is async, allowing other attributes, comments and
// visibility between the attribute and the signature.
function commandsIn(text: string) {
  const command =
    /#\[tauri::command(?:\([^)]*\))?\]\s*(?:(?:#\[[^\]]*\]|\/\/[^\n]*)\s*)*(?:pub(?:\([^)]*\))?\s+)?(async\s+)?fn\s+(\w+)/g;
  return [...text.matchAll(command)].map(
    ([, asynchronous, name]) => [name, !!asynchronous] as const,
  );
}

function tauriCommands() {
  return new Map(sources('src-tauri/src', ['.rs']).flatMap(({ text }) => commandsIn(text)));
}

// Every command the app registers, so a declaration the scan cannot read fails too.
function registeredCommands() {
  const lib = readFileSync('src-tauri/src/lib.rs', 'utf8');
  const [, list = ''] = /tauri::generate_handler!\[([\s\S]*?)\]/.exec(lib) ?? [];
  return list
    .split(',')
    .map((entry) => entry.trim().split('::').pop()!)
    .filter(Boolean);
}

describe('performance guards', () => {
  it('recognize whole-workspace copies and synchronous commands', () => {
    const component = `<script lang="ts">
      $effect(() => void $state.snapshot(workspace));
      const lookup = () => runtime?.workspace().fleet;
      function save() {
        void (async () => JSON.stringify(workspace))();
      }
      const parts = [$state.snapshot(workspace.fleet), runtime.workspace, JSON.stringify(active)];
    </script>`;
    expect(copiesIn('src/example.svelte', component)).toEqual([
      'src/example.svelte › $effect callback',
      'src/example.svelte › lookup',
      'src/example.svelte › save',
    ]);
    const rust = `#[tauri::command]
      pub fn read() {}
      #[tauri::command(rename_all = "snake_case")]
      // Explains the command.
      #[allow(clippy::too_many_arguments)]
      pub(crate) async fn write() {}`;
    expect(commandsIn(rust)).toEqual([
      ['read', false],
      ['write', true],
    ]);
  });

  it('copies the whole workspace only where the copy is needed', () => {
    expect(
      workspaceCopies(),
      'Whole-workspace copies changed. Each costs about 100 ms with a large workspace, so relay ' +
        'polls, timers, effects, navigation, typing and selection must read only the part they ' +
        'need, such as runtime.fleet() or one conversation. See docs/PERFORMANCE.md.',
    ).toEqual(allowedWorkspaceCopies.map(([site]) => site).sort());
  });

  it('runs native commands off the UI thread', () => {
    const commands = tauriCommands();
    const registered = registeredCommands();
    expect(registered.length).toBeGreaterThan(40);
    expect(registered.filter((name) => !commands.has(name))).toEqual([]);
    expect(
      [...commands]
        .filter(([, asynchronous]) => !asynchronous)
        .map(([name]) => name)
        .sort(),
      'Synchronous Tauri commands run on the UI thread, which also handles window input. ' +
        'Declare new commands async and move file, process and network work into ' +
        'tauri::async_runtime::spawn_blocking. See docs/PERFORMANCE.md.',
    ).toEqual(Object.keys(synchronousCommands).sort());
  });

  it('keeps closed disclosure contents out of style and layout', () => {
    // Chromium's default content-visibility: hidden restyles all hidden content when a text
    // selection crosses it, which froze long chats for seconds.
    const css = readFileSync('src/lib/styles.css', 'utf8');
    expect(css).toMatch(/details:not\(\[open\]\)::details-content\s*\{[^}]*display:\s*none;/);
  });
});
