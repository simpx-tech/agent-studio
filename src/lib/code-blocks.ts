// Copy and Run in console, the two controls of a fenced code block in rendered Markdown.
// `markdown.ts` adds them after sanitization and `styles.css` draws them; this module names the
// languages a console runs, decides where a console can open, and acts on a click.
//
// Run opens a console window on the computer the chat runs on, in the chat's folder, and runs
// the block there (`src-tauri/src/console.rs`). It is offered only in the desktop window of
// that computer and only for languages a console runs as they are written; every block copies.

import type { Conversation } from './domain';
import { executionHost, type Fleet, type Installation } from './fleet';

/** A family of console languages, each run by a shell of its own on the executing computer. */
export type ConsoleShell = 'posix' | 'powershell' | 'cmd';

// Fence labels by the shell that runs them. Session transcripts (`console`, `shell-session`)
// mix prompts with output, and other languages are mostly parts of files, so neither runs.
const shellOf = new Map<string, ConsoleShell>([
  ['bash', 'posix'],
  ['sh', 'posix'],
  ['shell', 'posix'],
  ['zsh', 'posix'],
  ['powershell', 'powershell'],
  ['pwsh', 'powershell'],
  ['ps1', 'powershell'],
  ['ps', 'powershell'],
  ['cmd', 'cmd'],
  ['bat', 'cmd'],
  ['batch', 'cmd'],
  ['dos', 'cmd'],
]);

/** The shell that runs a fence's language, or nothing for code a console does not run. */
export function consoleShell(language: string | undefined): ConsoleShell | undefined {
  return language ? shellOf.get(language.toLowerCase()) : undefined;
}

/**
 * Whether a fenced block has its closing fence. A reply still being written ends in an open
 * block, which gets no controls: running half a command is worse than waiting for the rest.
 */
export function fenceClosed(raw: string): boolean {
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
  // Indented code has no fence to close.
  if (!fence) return true;
  const lines = raw.trimEnd().split('\n');
  return (
    lines.length > 1 && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}$`).test(lines.at(-1)!)
  );
}

/**
 * The shells a console on this computer runs for a chat: every family on Windows, where Git
 * Bash or PowerShell run a POSIX block, and POSIX shells in a WSL distribution and on other
 * systems. Empty for a chat another computer runs, since a console opens only where it is seen.
 */
export function consoleShells(
  fleet: Fleet,
  installation: Installation | undefined,
  conversation: Pick<Conversation, 'settings' | 'location'> | undefined,
): ConsoleShell[] {
  if (!installation || !conversation) return [];
  const connectionId = conversation.settings.connectionId;
  // A chat saved without a connection runs this computer's own CLI login, in no project folder.
  if (!connectionId && conversation.location) return [];
  const environmentId = connectionId
    ? fleet.connections.find((c) => c.id === connectionId)?.environmentId
    : installation.id;
  const environment = fleet.environments.find((e) => e.id === environmentId);
  if (!environment || executionHost(fleet, environment.id) !== installation.id) return [];
  if (environment.platform === 'windows') return ['posix', 'powershell', 'cmd'];
  return environment.platform === 'preview' ? [] : ['posix'];
}

export type CodeBlockAction = { button: HTMLButtonElement; code: string } & (
  { kind: 'copy' } | { kind: 'run'; shell: ConsoleShell }
);

/**
 * The control a click landed on, with its block's code exactly as the block shows it. Only
 * `markdown.ts` writes these elements, after sanitization, so the code is the fence's own text.
 */
export function codeBlockAction(target: EventTarget | null): CodeBlockAction | undefined {
  if (!(target instanceof Element)) return;
  const button = target.closest('button.code-action');
  const block = button?.parentElement?.parentElement;
  if (!(button instanceof HTMLButtonElement) || !block?.classList.contains('code-block')) return;
  const text = block.querySelector(':scope > pre > code')?.textContent;
  if (text == null) return;
  // The renderer ends every block with one newline that is not part of its code.
  const code = text.replace(/\n$/, '');
  if (button.classList.contains('code-copy')) return { kind: 'copy', button, code };
  const shell = button.dataset.shell;
  return button.classList.contains('code-run') &&
    (shell === 'posix' || shell === 'powershell' || shell === 'cmd')
    ? { kind: 'run', button, code, shell }
    : undefined;
}

const settling = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

// A control's label and icon follow its state for a moment, then return to rest. A reply that
// renders again replaces the block and its controls, which also returns them to rest.
function show(button: HTMLButtonElement, state: string, label: string, forMs = 0) {
  const rest = (button.dataset.rest ??= button.textContent ?? '');
  clearTimeout(settling.get(button));
  if (state) button.dataset.state = state;
  else delete button.dataset.state;
  button.textContent = state ? label : rest;
  if (state && forMs)
    settling.set(
      button,
      setTimeout(() => show(button, '', ''), forMs),
    );
}

function note(block: Element | null | undefined, text: string) {
  block?.querySelector(':scope > .code-note')?.remove();
  if (!block || !text) return;
  const line = document.createElement('p');
  line.className = 'code-note';
  line.setAttribute('role', 'alert');
  line.textContent = text;
  block.append(line);
}

/**
 * Copies a block, or opens a console for it through `run`, which resolves with the name of the
 * shell that opened. A failure to open stays below the block until its next attempt.
 */
export async function performCodeBlockAction(
  action: CodeBlockAction,
  run: (shell: ConsoleShell, code: string) => Promise<string>,
): Promise<void> {
  const { button, code } = action;
  const block = button.closest('.code-block');
  if (action.kind === 'copy') {
    try {
      await navigator.clipboard.writeText(code);
      show(button, 'done', 'Copied', 1500);
    } catch {
      show(button, 'failed', 'Not copied', 2500);
    }
    return;
  }
  // One console per click: a second click while one opens does nothing.
  if (button.dataset.state === 'busy') return;
  note(block, '');
  show(button, 'busy', 'Opening…');
  try {
    show(button, 'done', `Opened in ${await run(action.shell, code)}`, 2500);
  } catch (error) {
    show(button, '', '');
    note(block, String(error instanceof Error ? error.message : error));
  }
}
