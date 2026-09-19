import type { Page } from '@playwright/test';
export async function mockDesktop(page: Page, mode = 'success') {
  await page.addInitScript(
    ({ mode }) => {
      if (window.top !== window) return;
      (window as any).isTauri = true;
      const callbacks = new Map<number, (value: unknown) => void>();
      let next = 0;
      let pending: (() => void) | undefined;
      (window as any).__TAURI_INTERNALS__ = {
        convertFileSrc: () => '/artifact-preview',
        metadata: { currentWindow: { label: 'main' } },
        transformCallback(fn: (v: unknown) => void) {
          const id = ++next;
          callbacks.set(id, fn);
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        async invoke(command: string, args: any) {
          if (command === 'set_pending_chat_badge') {
            localStorage.setItem('test-badge-count', String(args.count));
            return;
          }
          if (command === 'desktop_notification_settings')
            return JSON.parse(
              localStorage.getItem('test-notifications') ?? '{"enabled":true,"sound":true}',
            );
          if (command === 'set_desktop_notifications') {
            localStorage.setItem('test-notifications', JSON.stringify(args));
            return args;
          }
          if (command === 'desktop_notification') {
            const settings = JSON.parse(
              localStorage.getItem('test-notifications') ?? '{"enabled":true,"sound":true}',
            );
            if (settings.enabled) {
              const sent = JSON.parse(localStorage.getItem('test-notices') ?? '[]');
              sent.push(args.notice);
              localStorage.setItem('test-notices', JSON.stringify(sent));
            }
            return;
          }
          if (command === 'save_artifact') {
            (window as any).savedArtifact = args;
            return 'C:/Downloads/' + args.filename;
          }
          if (command === 'relay_resume') return null;
          if (command === 'plugin:window|is_maximized') return false;
          if (command === 'plugin:event|listen') return 0;
          if (command === 'plugin:event|unlisten') return;
          if (['detect_connection', 'list_models', 'list_folders'].includes(command)) {
            const state = window as any;
            (state.cliCalls ??= []).push({ command, ...args });
            if (state.holdCli?.includes(command))
              await new Promise<void>((resolve) => {
                (state.pendingCli ??= []).push({ command, ...args, resolve });
              });
          }
          if (command === 'get_installation')
            return {
              id: '11111111-1111-4111-8111-111111111111',
              computerId: '22222222-2222-4222-8222-222222222222',
              name: 'Desktop',
              platform: 'windows',
            };
          if (command === 'discover_wsl')
            return {
              distributions:
                mode === 'locations' || mode === 'computer-routing' || mode === 'wsl-empty'
                  ? [{ id: '33333333-3333-4333-8333-333333333333', name: 'Ubuntu', running: true }]
                  : [],
              warning: null,
            };
          if (command === 'list_folders') {
            if (args.path === '/missing') throw new Error('Folder does not exist');
            const path =
              args.path ||
              (args.environmentId === '33333333-3333-4333-8333-333333333333'
                ? '/home/test/studio'
                : 'C:\\Projects\\studio');
            return {
              path,
              parent: path.startsWith('/') ? '/home/test' : 'C:\\Projects',
              entries: [],
              truncated: false,
            };
          }
          if (command === 'inspect_environment_clis')
            return ['codex', 'claude', 'gemini'].map((id) => ({
              id,
              path:
                args.environmentId === '11111111-1111-4111-8111-111111111111'
                  ? 'C:/CLIs/' + id + '.exe'
                  : id === 'codex' &&
                      mode !== 'wsl-empty' &&
                      !localStorage.getItem('test-wsl-missing')
                    ? '/usr/local/bin/codex'
                    : null,
            }));
          if (command === 'detect_connection') {
            const fleet = JSON.parse(localStorage.getItem('test-workspace')!).fleet;
            const wsl =
              fleet.connections.find((c: any) => c.id === args.connectionId)?.environmentId ===
              '33333333-3333-4333-8333-333333333333';
            return {
              id: args.provider,
              installed:
                !wsl ||
                (args.provider === 'codex' &&
                  mode !== 'wsl-empty' &&
                  !localStorage.getItem('test-wsl-missing')),
              location: wsl ? 'WSL · Ubuntu' : 'Windows',
              auth:
                localStorage.getItem(`test-auth-${args.provider}`) ??
                (mode === 'login-flow' &&
                args.provider === 'gemini' &&
                localStorage.getItem('test-google-login') !== 'ready'
                  ? 'login'
                  : 'ready'),
              version: 'Test fixture',
              detail: 'Fixture connection',
            };
          }
          if (command === 'load_workspace')
            return JSON.parse(localStorage.getItem('test-workspace') ?? 'null');
          if (command === 'save_workspace') {
            localStorage.setItem('test-workspace', JSON.stringify(args.workspace));
            return;
          }
          if (command === 'list_models') {
            const model = (
              id: string,
              name: string,
              levels = ['low', 'medium', 'high'],
              defaultReasoning = 'medium',
            ) => ({
              id,
              name,
              reasoningLevels: levels,
              defaultReasoning,
              contextWindow: 20000,
              contextSource: 'Fixture metadata',
            });
            return {
              codex: [
                model('', 'CLI default'),
                model('gpt-6-astra', 'GPT-6 Astra'),
                model('gpt-5.6-sol', 'GPT-5.6 Sol', ['low', 'high'], 'low'),
              ],
              claude: [
                model('', 'CLI default'),
                model('sonnet', 'Sonnet'),
                model('fable', 'Fable'),
                model('opus', 'Opus', ['low', 'medium', 'high', 'max']),
              ],
              gemini: [
                model('gemini-3.8-flash', 'Gemini 3.8 Flash'),
                model('gemini-3.1-pro', 'Gemini 3.1 Pro', ['low', 'high'], 'high'),
              ],
            };
          }
          if (command === 'detect_providers')
            return ['codex', 'claude', 'gemini'].map((id) => ({
              id,
              installed: true,
              version: 'Test fixture',
              auth:
                localStorage.getItem(`test-auth-${id}`) ??
                (mode === 'login-flow' &&
                id === 'gemini' &&
                localStorage.getItem('test-google-login') !== 'ready'
                  ? 'login'
                  : 'ready'),
              detail: 'Fixture connection',
            }));
          if (command === 'sign_in') {
            localStorage.setItem('test-sign-in-provider', args.provider);
            return;
          }
          if (command === 'read_native_instructions') {
            const state = window as any;
            (state.nativeInstructionCalls ??= []).push(args);
            const text =
              state.nativeInstructionText ??
              'Exact native instruction <script>window.promptExecuted = true</script> & text\nPreserve every line.';
            if (state.holdNativeInstructions)
              await new Promise<void>((resolve) => (state.releaseNativeInstructions = resolve));
            if (state.failNativeInstructions) throw new Error('Native session record unavailable');
            return {
              provider: args.provider,
              checkedAt: Date.now(),
              notice: state.noNativeInstructions
                ? 'No native session has been recorded for this conversation.'
                : 'Latest recorded instructions. Tool definitions and conversation history are separate.',
              studioGuidance: 'Current Agent Studio guidance supplied as user context.',
              blocks: state.noNativeInstructions
                ? []
                : [
                    {
                      label: 'Base instructions at session start',
                      text,
                      capturedAt: '2026-09-13T10:00:00Z',
                      version: '0.153.4',
                      model: 'fixture-model',
                    },
                  ],
            };
          }
          if (command === 'read_context') {
            const state = window as any;
            (state.contextCalls ??= []).push(args);
            if (state.holdContext)
              await new Promise<void>((resolve) => (state.releaseContext = resolve));
            if (state.failContext)
              throw new Error('Context is unavailable on the selected computer.');
            return {
              provider: args.provider,
              model: args.model,
              checkedAt: Date.now(),
              execution: 'Windows',
              folder: args.location?.path ?? 'C:\\Runtime',
              profile: `C:\\Profiles\\${args.connectionId}`,
              commands:
                args.provider === 'claude'
                  ? [
                      {
                        name: 'fixture:review',
                        description: 'Review with a fixture skill',
                        argumentHint: '[file]',
                      },
                      {
                        name: 'audit-routes',
                        description: 'Audit routes with a saved native workflow',
                        argumentHint: '[folder]',
                      },
                      { name: 'compact', description: 'Session-only command', argumentHint: '' },
                    ]
                  : [],
              entries: [
                ...(state.hookEntries ?? []),
                {
                  name: 'docs-mcp',
                  path: 'docs-mcp',
                  kind: 'mcps',
                  scope: 'Project',
                  status: 'connected',
                  detail: 'Reported by the selected CLI profile.',
                },
                {
                  name: 'disabled-mcp',
                  path: 'disabled-mcp',
                  kind: 'mcps',
                  scope: 'User',
                  status: 'disabled',
                  detail: 'Disabled in the selected profile.',
                },
                {
                  name: args.provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md',
                  path: `${args.location?.path}\\${args.provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'}`,
                  kind: 'instructions',
                  scope: 'Project',
                  status: 'reported',
                  detail: `Loaded in a fresh CLI context query. Revision ${state.contextRevision ?? 0}.`,
                },
                {
                  name: 'CLAUDE.local.md',
                  path: `${args.location?.path}\\CLAUDE.local.md`,
                  kind: 'instructions',
                  scope: 'Project',
                  status: 'discovered',
                  detail: 'Available on disk; use is unconfirmed.',
                },
                {
                  name: 'test-skill',
                  path: 'C:\\Profiles\\skills\\test-skill\\SKILL.md',
                  kind: 'skills',
                  scope: 'User',
                  status: state.enableSkill ? 'reported' : 'disabled',
                  detail: 'Disabled in the selected profile.',
                },
                {
                  name: 'MEMORY.md',
                  path: 'C:\\Profiles\\projects\\fixture\\memory\\MEMORY.md',
                  kind: 'memories',
                  scope: 'Project memory',
                  status: 'discovered',
                  detail: 'Available on disk; use is unconfirmed.',
                },
              ],
              notes: ['This is a startup inspection, not a read history of an earlier reply.'],
              truncated: false,
            };
          }
          if (command === 'read_usage') {
            if (localStorage.getItem('test-usage-error')) throw new Error('Usage refresh failed');
            const requests = JSON.parse(localStorage.getItem('test-usage-requests') ?? '[]');
            requests.push(args);
            localStorage.setItem('test-usage-requests', JSON.stringify(requests));
            const limitWindow = (
              id: string,
              minutes: number,
              percent: number | null,
              model: string | null = null,
            ) => ({
              id,
              label: id,
              windowMinutes: minutes,
              usedPercent:
                mode === 'usage-pace'
                  ? id === '5-hour'
                    ? 70
                    : model === 'fable'
                      ? 50
                      : 25
                  : percent,
              resetsAt:
                Math.floor(Date.now() / 1000) + (mode === 'usage-pace' ? minutes * 30 : 3600),
              model,
              bucket: args.provider,
            });
            const snapshot = {
              provider: args.provider,
              checkedAt: Math.floor(Date.now() / 1000),
              context:
                args.provider === 'claude'
                  ? {
                      model: args.model || 'claude-sonnet-5',
                      tokens: 20000,
                      source: 'Fixture CLI context',
                    }
                  : null,
              detail: 'Reported by fixture',
              windows: [
                ...(mode === 'usage-missing' ? [] : [limitWindow('5-hour', 300, 12)]),
                limitWindow('Weekly', 10080, args.provider === 'claude' ? 31 : 26),
                ...(args.provider === 'claude'
                  ? [limitWindow('Fable weekly', 10080, 62, 'fable')]
                  : []),
              ],
            };
            if (mode === 'usage-race' && args.provider === 'codex')
              return new Promise(
                (resolve) => ((window as any).resolveUsage = () => resolve(snapshot)),
              );
            return snapshot;
          }
          if (command === 'generate_title') {
            const requests = JSON.parse(localStorage.getItem('test-title-requests') ?? '[]');
            requests.push(args);
            localStorage.setItem('test-title-requests', JSON.stringify(requests));
            if (mode !== 'title-deferred') throw new Error('Title unavailable');
            return new Promise((resolve) => {
              (window as any).resolveTitle = () =>
                resolve({
                  title: 'Planning a balcony garden',
                  provider: args.provider,
                  model: 'gpt-5.6-luna',
                });
            });
          }
          if (command === 'cancel_title') {
            localStorage.setItem('test-cancelled-title', args.conversationId);
            return;
          }
          if (command === 'cancel_run') {
            const state = window as any;
            (state.cancelCalls ??= []).push(args);
            if (state.failCancel)
              throw new Error('The owning computer could not stop the response.');
            if (state.holdCancel)
              await new Promise<void>((resolve) => (state.releaseCancel = resolve));
            pending?.();
            return;
          }
          if (command === 'answer_question' && mode === 'capabilities') {
            const w = window as any;
            if (w.answerFailure)
              throw new Error('The computer is offline. Try again after it reconnects.');
            (w.answersSent ??= []).push(args);
            w.emitCapability({
              kind: 'question',
              question: {
                ...w.testQuestion,
                revision: 2,
                status: 'answered',
                response: args.answer,
              },
            });
            return;
          }
          if (command === 'steer_run' && mode === 'capabilities') {
            const w = window as any;
            (w.steeringSent ??= []).push(args);
            if (w.holdSteering) await new Promise<void>((resolve) => (w.releaseSteering = resolve));
            if (w.steeringFailure)
              throw new Error('This reply has ended. Your steering was not sent.');
            w.emitCapability({
              kind: 'steering',
              steering: { ...args.input, runId: args.runId, sequence: w.steeringSent.length },
            });
            return;
          }
          if (command === 'run_agent') {
            localStorage.setItem('test-last-request', JSON.stringify(args.request));
            const turnCount = Number(localStorage.getItem('test-run-count') ?? 0) + 1;
            localStorage.setItem('test-run-count', String(turnCount));
            const id = args.onEvent.id;
            let index = 0;
            const emit = (message: unknown) => callbacks.get(id)?.({ message, index: index++ });
            emit({ kind: 'activity', text: 'Connected' });
            if (mode === 'capabilities') {
              (window as any).emitCapability = emit;
              return await new Promise((resolve) => {
                (window as any).finishCapabilities = resolve;
                pending = () => resolve('cancelled');
              });
            }
            if (mode === 'settings-deferred')
              await new Promise<void>((resolve) => ((window as any).finishReply = resolve));
            if (mode === 'error')
              throw new Error(
                'Your CLI login needs attention. Open Connections, sign in, and try again.',
              );
            emit({
              kind: 'text',
              text: '## A clear answer\n\nHello **world**.\n\n```html\n<div>Safe code</div>\n```\n\n<script>window.pwned=true</script><img src="https://invalid.test/pixel" onerror="window.pwned=true">\n\n[Unsafe](javascript:alert(1))\n\n| A | B |\n| --- | --- |\n| 1 | 2 |',
            });
            if (mode === 'slow')
              return new Promise((resolve) => (pending = () => resolve('cancelled')));
            if (mode === 'usage-deferred' && turnCount > 1)
              await new Promise<void>((resolve) => ((window as any).finishReply = resolve));
            await new Promise((resolve) => setTimeout(resolve, 200));
            emit(
              mode.startsWith('usage-')
                ? {
                    kind: 'usage',
                    input: 2000,
                    output: 100,
                    cachedInput: 1500,
                    contextInput:
                      mode === 'usage-unmeasured' || (mode === 'usage-deferred' && turnCount > 1)
                        ? null
                        : 2000,
                    contextWindow: 20000,
                  }
                : { kind: 'usage', input: 20, output: 10 },
            );
            return 'complete';
          }
        },
      };
    },
    { mode },
  );
}
