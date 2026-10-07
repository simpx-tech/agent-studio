<script lang="ts">
  import { highlightCode } from '$lib/markdown';
  import type { ScreenAction, ScreenDetail, ScreenParam } from '$lib/screens';
  import ConnectionDialog from './ConnectionDialog.svelte';
  let {
    screen,
    computerName,
    busy = false,
    error = '',
    allow,
    revoke,
    close,
  }: {
    screen: ScreenDetail;
    computerName: string;
    busy?: boolean;
    error?: string;
    /** Allows exactly the actions shown, named by the screen's digest. */
    allow: () => void;
    revoke: () => void;
    close: () => void;
  } = $props();
  const shells = { powershell: 'PowerShell', bash: 'bash' };
  const seconds = (timeout: number) =>
    timeout % 60 === 0 && timeout >= 60 ? `${timeout / 60} min` : `${timeout} s`;
  /** What a parameter accepts, in words. */
  function accepts(param: ScreenParam): string {
    const parts = [
      { string: 'Text', number: 'A number', integer: 'A whole number', boolean: 'True or false' }[
        param.type
      ],
    ];
    if (param.enum?.length)
      parts.push(`one of ${param.enum.map((v) => JSON.stringify(v)).join(', ')}`);
    if (param.pattern) parts.push(`matching ${param.pattern}`);
    if (param.maxLength) parts.push(`up to ${param.maxLength} characters`);
    if (param.minimum != null) parts.push(`at least ${param.minimum}`);
    if (param.maximum != null) parts.push(`at most ${param.maximum}`);
    if (param.optional) parts.push('optional');
    return parts.join(', ');
  }
  const params = (action: ScreenAction) => Object.entries(action.params ?? {});
</script>

<ConnectionDialog
  title={screen.allowed ? 'Screen actions' : 'Allow screen actions'}
  wide
  {busy}
  {close}
>
  <div class="screen-review">
    <p>
      <strong>{screen.title}</strong> runs {screen.actions.length === 1
        ? 'this command'
        : `these ${screen.actions.length} commands`} on <strong>{computerName}</strong> in
      <code>{screen.folder}</code> when its page asks.
    </p>
    {#each screen.actions as action (action.name)}
      {@const highlighted = highlightCode(action.script, action.shell)}
      <section class="screen-action" aria-label={`Action ${action.name}`}>
        <header>
          <code class="action-name">{action.name}</code><span
            >{shells[action.shell]} · stops after {seconds(action.timeout)}</span
          >
        </header>
        {#if action.description}<p>{action.description}</p>{/if}
        {#if params(action).length}<dl class="action-params" aria-label="Parameters">
            {#each params(action) as [name, param] (name)}<div>
                <dt><code>PARAM_{name.toUpperCase()}</code></dt>
                <dd>
                  {accepts(param)}{#if param.description}
                    · {param.description}{/if}
                </dd>
              </div>{/each}
          </dl>{/if}
        <pre class="action-script"><code class="hljs"
            >{#if highlighted}{@html highlighted.html}{:else}{action.script}{/if}</code
          ></pre>
      </section>
    {/each}
  </div>
  {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
  <div class="dialog-actions">
    {#if screen.allowed}<button type="button" class="secondary" disabled={busy} onclick={revoke}
        >{busy ? 'Revoking…' : 'Revoke'}</button
      >{/if}
    <button type="button" class="secondary" disabled={busy} onclick={close}
      >{screen.allowed ? 'Close' : 'Not now'}</button
    >
    {#if !screen.allowed}<button type="button" class="primary" disabled={busy} onclick={allow}
        >{busy ? 'Allowing…' : 'Allow actions'}</button
      >{/if}
  </div>
</ConnectionDialog>

<style>
  .screen-review {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: grid;
    align-content: start;
    gap: 14px;
    padding-bottom: 16px;
  }
  .screen-review > p code,
  .action-params code {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
  .screen-action {
    display: grid;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    min-width: 0;
  }
  .screen-action header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 10px;
  }
  .action-name {
    font-family: var(--font-mono);
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text);
  }
  .screen-action header span {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .action-params {
    display: grid;
    gap: 4px;
    margin: 0;
    font-size: var(--text-sm);
  }
  .action-params div {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
  }
  .action-params dt {
    color: var(--text);
  }
  .action-params dd {
    margin: 0;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  .action-script {
    margin: 0;
    max-height: 320px;
    overflow: auto;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--code-bg);
    color: var(--code-text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    white-space: pre;
  }
  .dialog-actions {
    flex-shrink: 0;
  }
</style>
