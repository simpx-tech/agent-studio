<script lang="ts">
  import { ArrowRight, Eye, EyeOff, KeyRound, LoaderCircle, WifiOff } from '@lucide/svelte';
  import BrandMark from './BrandMark.svelte';
  import BrowserStatus from './BrowserStatus.svelte';

  let {
    checking,
    ready,
    online,
    error,
    retry,
    login,
  }: {
    checking: boolean;
    ready: boolean;
    online: boolean;
    error: string;
    retry: () => void;
    login: (key: string) => Promise<void>;
  } = $props();
  let key = $state('');
  let keyVisible = $state(false);
  let busy = $state(false);
  let failure = $state('');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || checking || !ready || !online || !key.trim()) return;
    busy = true;
    keyVisible = false;
    failure = '';
    try {
      await login(key.trim());
    } catch (error) {
      failure = String(error).replace(/^Error: /, '');
    } finally {
      key = '';
      busy = false;
    }
  }
</script>

<main class="workspace-login" aria-labelledby="workspace-login-title">
  <div class="login-content">
    <div class="login-brand">
      <BrandMark size={20} />
      <span>Agent <span class="brand-light">Studio</span></span>
      <span class="viewer-label">Viewer</span>
    </div>
    <div class="login-heading">
      <h1 id="workspace-login-title">Sign in to your workspace</h1>
      <p>View your chats and manage agents running on your connected computers.</p>
    </div>
    {#if !online}
      <p class="login-status" role="status">
        <WifiOff size={17} />You’re offline. Connect to the internet to sign in.
      </p>
    {:else if checking}
      <p class="login-status" role="status">
        <LoaderCircle size={17} class="spinning" />Checking your workspace session…
      </p>
    {/if}
    {#if failure || error}
      <div
        class="login-error"
        role={error.includes('Reconnecting automatically') && !failure ? 'status' : 'alert'}
      >
        <p>{failure || error}</p>
        {#if !failure}<button class="text-button" type="button" onclick={retry}>Try again</button
          >{/if}
      </div>
    {/if}
    <form onsubmit={submit} aria-busy={busy || checking}>
      <label for="workspace-key">Workspace key</label>
      <div class="key-field">
        <KeyRound size={17} aria-hidden="true" />
        <input
          id="workspace-key"
          name="workspace-key"
          type={keyVisible ? 'text' : 'password'}
          bind:value={key}
          placeholder="Enter your private workspace key"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          minlength="32"
          required
          disabled={busy || checking || !ready}
          aria-describedby="workspace-key-help"
        />
        <button
          class="key-visibility"
          type="button"
          aria-label={keyVisible ? 'Hide workspace key' : 'Show workspace key'}
          title={keyVisible ? 'Hide workspace key' : 'Show workspace key'}
          aria-controls="workspace-key"
          disabled={busy || checking || !ready}
          onclick={() => (keyVisible = !keyVisible)}
        >
          {#if keyVisible}<EyeOff size={18} aria-hidden="true" />{:else}<Eye
              size={18}
              aria-hidden="true"
            />{/if}
        </button>
      </div>
      <p id="workspace-key-help">Use the key provided by your workspace administrator.</p>
      <button class="primary" disabled={busy || checking || !ready || !online || !key.trim()}>
        {#if busy}<LoaderCircle size={17} class="spinning" />Signing in…{:else}Sign in<ArrowRight
            size={17}
          />{/if}
      </button>
    </form>
    <p class="login-note">
      Your session stays signed in on this browser. Agents run on your computers, so keep Agent
      Studio open there.
    </p>
    <BrowserStatus showConnection={false} />
  </div>
</main>

<style>
  .workspace-login {
    height: var(--mobile-height, 100dvh);
    overflow: auto;
    display: flex;
    padding: 40px 24px;
    background:
      radial-gradient(900px 420px at 50% -8%, var(--accent-soft), transparent 70%), var(--bg);
  }
  .login-content {
    width: 100%;
    max-width: 400px;
    margin: auto;
  }
  .login-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 36px;
    font-size: 16px;
    font-weight: 650;
    letter-spacing: var(--tracking-tighter);
  }
  .login-heading h1 {
    font-size: 26px;
    line-height: 1.2;
    margin-bottom: 8px;
  }
  .login-heading p {
    color: var(--text-muted);
    font-size: var(--text-md);
  }
  .login-heading {
    margin-bottom: 24px;
  }
  form {
    display: grid;
    gap: 8px;
    padding: 20px;
    border: 1px solid var(--border);
    border-radius: var(--radius-2xl);
    background: var(--surface-1);
    box-shadow: var(--shadow-md);
  }
  label {
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .key-field {
    position: relative;
  }
  .key-field > :global(svg) {
    position: absolute;
    left: 13px;
    top: 13px;
    color: var(--text-muted);
    pointer-events: none;
  }
  input {
    min-height: 44px;
    padding-left: 40px;
    padding-right: 46px;
    font-size: var(--text-md);
  }
  input::-ms-reveal {
    display: none;
  }
  .key-visibility {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
  }
  .key-visibility:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }
  #workspace-key-help,
  .login-note {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .primary {
    min-height: 42px;
    margin-top: 8px;
  }
  .login-note {
    margin-top: 20px;
    text-align: center;
  }
  .login-status {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 18px;
    color: var(--text-secondary);
  }
  .login-error {
    padding: 10px 12px;
    border: 1px solid var(--warning-border);
    border-radius: var(--radius-lg);
    background: var(--warning-soft);
    margin-bottom: 18px;
    overflow-wrap: anywhere;
  }
  .login-error p {
    color: var(--text);
  }
  .login-content :global(.browser-status) {
    padding: 16px 0 0;
    border: 0;
    background: transparent;
    text-align: center;
  }
  @media (max-width: 650px) {
    .workspace-login {
      position: fixed;
      inset: var(--mobile-top, 0px) 0 auto;
      padding: 28px 20px;
    }
    .login-brand {
      margin-bottom: 28px;
    }
    input {
      font-size: 16px;
    }
  }
</style>
