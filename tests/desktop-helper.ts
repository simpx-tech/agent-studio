import type { Page } from '@playwright/test';
export async function mockDesktop(page: Page, mode = 'success') {
  await page.addInitScript(
    ({ mode }) => {
      if (window.top !== window) return;
      (window as any).isTauri = true;
      // Each page load starts the app again unless a test pins its app session.
      const started = { id: crypto.randomUUID(), startedAt: Date.now() };
      const callbacks = new Map<number, (value: unknown) => void>();
      let next = 0;
      let pending: (() => void) | undefined;
      // The host's image store: images kept by hash, persisted across reloads like the
      // workspace (tests keep them small), read back through the studio-image protocol.
      const storedImages = (): Record<string, { mediaType: string; data: string }> =>
        JSON.parse(localStorage.getItem('test-images') ?? '{}');
      (window as any).__TAURI_INTERNALS__ = {
        convertFileSrc: (path: string, protocol?: string) => {
          if (protocol !== 'studio-image') return '/artifact-preview';
          const image = storedImages()[path];
          return image ? `data:${image.mediaType};base64,${image.data}` : 'data:,';
        },
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
          if (['app_update_status', 'check_app_update', 'install_app_update'].includes(command)) {
            const status = JSON.parse(
              localStorage.getItem('test-app-update') ??
                '{"currentVersion":"0.2.0","phase":"current","checkedAt":1790000000000,"repliesRunning":false}',
            );
            if (command !== 'install_app_update') return status;
            const error = localStorage.getItem('test-app-update-error');
            if (error) throw error;
            localStorage.setItem('test-app-update-installed', 'true');
            return;
          }
          if (['cli_update_status', 'check_cli_updates', 'set_cli_auto_update'].includes(command)) {
            const updates = JSON.parse(
              localStorage.getItem('test-cli-updates') ??
                '{"automatic":{"claude":true,"codex":true},"statuses":[]}',
            );
            if (command === 'set_cli_auto_update') updates.automatic[args.provider] = args.automatic;
            if (command === 'check_cli_updates')
              (window as any).cliUpdateChecks = ((window as any).cliUpdateChecks ?? 0) + 1;
            localStorage.setItem('test-cli-updates', JSON.stringify(updates));
            return updates;
          }
          if (command === 'window_behavior' || command === 'set_close_to_tray') {
            const behavior = JSON.parse(
              localStorage.getItem('test-window-behavior') ??
                '{"closeToTray":true,"area":"tray","clickOpens":true}',
            );
            if (command === 'set_close_to_tray') {
              const error = localStorage.getItem('test-window-behavior-error');
              if (error) throw error;
              behavior.closeToTray = args.enabled;
              localStorage.setItem('test-window-behavior', JSON.stringify(behavior));
            }
            return behavior;
          }
          // The native version deliberately differs from package.json's.
          if (command === 'plugin:app|version') return '0.2.0';
          if (command === 'save_artifact') {
            (window as any).savedArtifact = args;
            return 'C:/Downloads/' + args.filename;
          }
          if (command === 'site_icon') {
            ((window as any).siteIconReads ??= []).push(args.origin);
            // Only one fixture site serves an icon; the others keep the generic mark.
            return args.origin === 'https://en.wikipedia.org'
              ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
              : null;
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
          if (command === 'app_session')
            return JSON.parse(localStorage.getItem('test-app-session') ?? 'null') ?? started;
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
            if (args.path === 'D:\\') throw new Error('Drive not ready');
            const wsl = args.environmentId === '33333333-3333-4333-8333-333333333333';
            const path = args.path || (wsl ? '/home/test/studio' : 'C:\\Projects\\studio');
            const separator = wsl ? '/' : '\\';
            // A small fixture tree; unknown paths open as empty folders like before.
            const tree: Record<
              string,
              {
                parent: string | null;
                entries: { name: string; hidden?: boolean; repository?: boolean }[];
              }
            > = wsl
              ? {
                  '/': { parent: null, entries: [{ name: 'home' }, { name: 'mnt' }] },
                  '/home': { parent: '/', entries: [{ name: 'test' }] },
                  '/home/test': {
                    parent: '/home',
                    entries: [
                      { name: '.config', hidden: true },
                      { name: 'studio', repository: true },
                    ],
                  },
                  '/home/test/studio': { parent: '/home/test', entries: [] },
                }
              : {
                  'C:\\': {
                    parent: null,
                    entries: [
                      { name: '$RECYCLE.BIN', hidden: true },
                      { name: 'Projects' },
                      { name: 'Users' },
                    ],
                  },
                  'C:\\Projects': {
                    parent: 'C:\\',
                    entries: [
                      { name: '.cache', hidden: true },
                      { name: 'archive' },
                      { name: 'studio', repository: true },
                      { name: 'tools', repository: true },
                    ],
                  },
                  'C:\\Projects\\studio': { parent: 'C:\\Projects', entries: [] },
                };
            const node = tree[path] ?? {
              parent: wsl ? '/home/test' : 'C:\\Projects',
              entries: [],
            };
            return {
              path,
              parent: node.parent,
              entries: node.entries.map((entry) => ({
                hidden: false,
                repository: false,
                ...entry,
                path: `${path.endsWith(separator) ? path : path + separator}${entry.name}`,
              })),
              truncated: false,
              places: wsl
                ? [
                    { kind: 'home', name: 'Home', path: '/home/test/studio' },
                    { kind: 'root', name: 'Root', path: '/' },
                    { kind: 'mount', name: 'C: drive', path: '/mnt/c' },
                  ]
                : [
                    { kind: 'home', name: 'Home', path: 'C:\\Projects\\studio' },
                    { kind: 'folder', name: 'Projects', path: 'C:\\Projects' },
                    { kind: 'drive', name: 'C:\\', path: 'C:\\' },
                    { kind: 'drive', name: 'D:\\', path: 'D:\\' },
                  ],
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
          if (command === 'detect_environment_login') {
            const wsl = args.environmentId === '33333333-3333-4333-8333-333333333333';
            return {
              id: args.provider,
              installed:
                !wsl ||
                (args.provider === 'codex' &&
                  mode !== 'wsl-empty' &&
                  !localStorage.getItem('test-wsl-missing')),
              location: wsl ? 'WSL · Ubuntu' : 'Windows',
              auth: localStorage.getItem(`test-auth-${args.provider}`) ?? 'ready',
              version: 'Test fixture',
              detail: 'Fixture connection',
              account:
                localStorage.getItem(`test-account-${wsl ? 'wsl-' : ''}${args.provider}`) ??
                undefined,
            };
          }
          if (command === 'detect_connection') {
            // One account's check can fail outright, as a native error, or find no CLI.
            const failure = localStorage.getItem(`test-check-error-${args.connectionId}`);
            if (failure) throw failure;
            const missing = !!localStorage.getItem(`test-cli-missing-${args.connectionId}`);
            const fleet = JSON.parse(localStorage.getItem('test-workspace')!).fleet;
            const connection = fleet.connections.find((c: any) => c.id === args.connectionId);
            const wsl = connection?.environmentId === '33333333-3333-4333-8333-333333333333';
            const account =
              connection?.profile === 'isolated'
                ? localStorage.getItem(`test-account-isolated-${args.provider}`)
                : localStorage.getItem(`test-account-${wsl ? 'wsl-' : ''}${args.provider}`);
            return {
              account: account ?? undefined,
              id: args.provider,
              installed:
                !missing &&
                (!wsl ||
                  (args.provider === 'codex' &&
                    mode !== 'wsl-empty' &&
                    !localStorage.getItem('test-wsl-missing'))),
              location: wsl ? 'WSL · Ubuntu' : 'Windows',
              auth: missing
                ? 'unknown'
                : (localStorage.getItem(`test-auth-connection-${args.connectionId}`) ??
                  localStorage.getItem(`test-auth-${args.provider}`) ??
                  (mode === 'login-flow' &&
                  args.provider === 'gemini' &&
                  localStorage.getItem('test-google-login') !== 'ready'
                    ? 'login'
                    : 'ready')),
              version: missing ? null : 'Test fixture',
              detail: missing
                ? `${args.provider} CLI was not found. Install it, then refresh Connections.`
                : 'Fixture connection',
            };
          }
          if (command === 'store_chat_image') {
            const bytes = new Uint8Array(args as ArrayBuffer);
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            const hash = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
            const mediaType =
              bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : 'image/webp';
            let binary = '';
            for (let at = 0; at < bytes.length; at += 0x8000)
              binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
            const images = storedImages();
            images[hash] = { mediaType, data: btoa(binary) };
            localStorage.setItem('test-images', JSON.stringify(images));
            return { hash, bytes: bytes.length, mediaType };
          }
          if (command === 'read_chat_image') {
            ((window as any).chatImageReads ??= []).push(args.hash);
            const image = storedImages()[args.hash];
            if (!image)
              throw 'This image is not on this computer, and the relay cannot provide it.';
            return Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0)).buffer;
          }
          if (command === 'upload_chat_images') return [];
          // Chats the CLIs saved on this computer: tests set `importSources`, `importListings`
          // (by source id, a listing or an error message) and `importResults` (by key), and hold
          // the sources in `holdListings` until `releaseListing[source]()` is called.
          if (command === 'list_import_sources') return (window as any).importSources ?? [];
          if (command === 'list_importable_chats') {
            const w = window as any;
            if (w.holdListings?.includes(args.source))
              await new Promise<void>((resolve) => {
                (w.releaseListing ??= {})[args.source] = resolve;
              });
            const listing = w.importListings?.[args.source];
            if (typeof listing === 'string') throw listing;
            return listing ?? { source: args.source, chats: [] };
          }
          if (command === 'import_chat') {
            const w = window as any;
            (w.importCalls ??= []).push(args);
            if (w.holdImport) await new Promise<void>((resolve) => (w.releaseImport = resolve));
            const result = w.importResults?.[args.key];
            if (typeof result === 'string') throw result;
            if (!result) throw 'This list of chats is out of date. Refresh it and try again.';
            return result;
          }
          if (command === 'load_workspace')
            return JSON.parse(localStorage.getItem('test-workspace') ?? 'null');
          if (command === 'save_workspace') {
            localStorage.setItem('test-workspace', JSON.stringify(args.workspace));
            return;
          }
          // The host assembles a patch from the conversations it was sent and its last write,
          // and asks for the whole workspace when it cannot. Mirror both so a partial save is
          // as visible to these tests as a whole one.
          if (command === 'save_workspace_patch') {
            const saved = JSON.parse(localStorage.getItem('test-workspace') ?? 'null');
            const kept = new Map<string, unknown>(
              (saved?.conversations ?? []).map((c: { id: string }) => [c.id, c]),
            );
            const sent = new Map<string, unknown>(
              args.upsert.map((c: { id: string }) => [c.id, c]),
            );
            const conversations = (args.order as string[]).map((id) => {
              const conversation = sent.get(id) ?? kept.get(id);
              if (!conversation)
                throw new Error('The whole workspace is needed to save this change.');
              sent.delete(id);
              return conversation;
            });
            if (sent.size) throw new Error('The whole workspace is needed to save this change.');
            localStorage.setItem(
              'test-workspace',
              JSON.stringify({ ...args.index, conversations }),
            );
            return;
          }
          if (command === 'load_drafts')
            return JSON.parse(localStorage.getItem('test-drafts') ?? 'null');
          if (command === 'save_drafts') {
            localStorage.setItem('test-drafts', JSON.stringify(args.drafts));
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
              // A spec can name the aliases the way a CLI resolved them.
              claude: JSON.parse(localStorage.getItem('test-claude-models') ?? 'null') ?? [
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
              account: localStorage.getItem(`test-account-${id}`) ?? undefined,
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
            const state = window as any;
            (state.signInCalls ??= []).push(args.connectionId ?? args.provider);
            localStorage.setItem('test-sign-in-provider', args.provider);
            localStorage.setItem('test-sign-in-connection', args.connectionId ?? '');
            // Its console takes a moment to open, which a test can hold until it releases it.
            if (state.holdSignIn)
              await new Promise<void>((resolve) => (state.heldSignIns ??= []).push(resolve));
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
          if (
            command === 'read_tool_output' ||
            command === 'read_tool_output_image' ||
            command === 'read_tool_output_model' ||
            command === 'read_tool_output_model_file'
          ) {
            const state = window as any;
            (state.toolOutputCalls ??= []).push({ command, ...args });
            if (state.holdToolOutput)
              await new Promise<void>((resolve) => (state.releaseToolOutput = resolve));
            if (state.failToolOutput) throw state.failToolOutput;
            // Fixtures: stdout/stderr text, a shorter previewStdout for long results, images.
            const output = state.toolOutputs?.[args.toolId];
            if (!output) throw 'This output was not kept on the computer that ran it.';
            if (command === 'read_tool_output_image') {
              const image = output.images?.[args.index];
              if (!image) throw 'This output was not kept on the computer that ran it.';
              return image;
            }
            if (command === 'read_tool_output_model') {
              const model = output.models?.[args.index];
              if (!model) throw 'This output was not kept on the computer that ran it.';
              return model;
            }
            // This computer's own window reads a kept model as raw bytes.
            if (command === 'read_tool_output_model_file') {
              const model = output.models?.[args.index];
              if (!model) throw 'This output was not kept on the computer that ran it.';
              return Uint8Array.from(atob(model.data), (c) => c.charCodeAt(0)).buffer;
            }
            const text = (value = '', preview?: string) =>
              preview && !args.full
                ? { text: preview, bytes: value.length, complete: false }
                : { text: value, bytes: value.length, complete: true };
            return {
              version: 2,
              toolId: args.toolId,
              exitCode: output.exitCode,
              startLine: output.startLine,
              truncated: false,
              stdout: text(output.stdout, output.previewStdout),
              stderr: text(output.stderr),
              images: (output.images ?? []).map((image: any, index: number) => ({
                index,
                mediaType: image.mediaType,
                bytes: image.bytes,
                width: image.width,
                height: image.height,
              })),
              imagesOmitted: 0,
              command: output.command,
              input: output.input,
            };
          }
          if (command === 'search_mentions') {
            const state = window as any;
            (state.mentionCalls ??= []).push(args);
            if (state.holdMentions) await new Promise<void>((resolve) => { (state.pendingMentions ??= []).push({ ...args, resolve }); });
            if (state.failMentions) throw 'File search is unavailable on the selected computer.';
            return { entries: args.kind === 'app' ? [
              { kind: 'app', name: 'Demo App', path: 'app://demo', token: '$demo-app' },
            ] : [
              { kind: 'file', name: 'src/my file.ts', path: `${args.location?.path ?? '/standalone'}/src/my file.ts`, token: '@"src/my file.ts"' },
              { kind: 'file', name: 'src/other.ts', path: `${args.location?.path ?? '/standalone'}/src/other.ts`, token: '@src/other.ts' },
            ], truncated: false, notice: '' };
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
            // A login whose renewal fails: Claude answers without limits and reports the
            // account signed out from then on.
            if (localStorage.getItem(`test-usage-expired-${args.connectionId}`)) {
              localStorage.setItem(`test-auth-connection-${args.connectionId}`, 'login');
              throw new Error('Claude did not return its usage limits. Try refreshing shortly.');
            }
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
            const reply = state.capabilityRuns?.[args.runId];
            if (reply) reply.finish('cancelled');
            else pending?.();
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
              const takeOver = args.request.takeOver;
              if (takeOver) {
                // The waiting reply hands over its process and ends, or refuses.
                const w = window as any;
                (w.takeOvers ??= []).push(takeOver);
                const waiting = w.capabilityRuns?.[takeOver.runId];
                if (w.refuseTakeOver || !waiting)
                  throw new Error(
                    w.refuseTakeOver ??
                      'The reply had already moved on, so your message waits for it to finish.',
                  );
                waiting.finish('complete');
                emit({ kind: 'takeover' });
              }
              (window as any).emitCapability = emit;
              return await new Promise((resolve, reject) => {
                (window as any).finishCapabilities = resolve;
                // A failed reply rejects with its error, which Tauri delivers as a string.
                (window as any).failCapabilities = reject;
                pending = () => resolve('cancelled');
                // Replies of different conversations run side by side, each held until finished.
                ((window as any).capabilityRuns ??= {})[args.request.runId] = {
                  conversationId: args.request.conversationId,
                  emit,
                  finish: resolve,
                };
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
