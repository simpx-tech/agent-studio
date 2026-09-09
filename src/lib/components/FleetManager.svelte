<script lang="ts">
  import {
    Monitor,
    Server,
    Plus,
    Link,
    RefreshCw,
    ShieldCheck,
    Download,
    ChevronDown,
    Settings2,
    ArrowUpRight,
  } from '@lucide/svelte';
  import {
    providers,
    providerIds,
    type Workspace,
    type ProviderId,
    type ProviderStatus,
  } from '$lib/domain';
  import {
    accountSchema,
    executionHost,
    reconcileDiscoveredWsl,
    type Installation,
    type Account,
    type Environment,
    type WslDiscovery,
  } from '$lib/fleet';
  import ChoicePicker from './ChoicePicker.svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import type { Presence } from '$lib/sync';
  import { desktop, signIn } from '$lib/transport';
  let {
    workspace,
    installation,
    wslDiscovery,
    wslError,
    statuses,
    presence,
    syncStatus,
    syncError,
    paired,
    save,
    refresh,
    connect,
    disconnect,
    resolveConflict,
    chat,
    providerStatuses,
    login,
    exportWorkspace,
    running,
  }: {
    workspace: Workspace;
    installation: Installation | undefined;
    wslDiscovery: WslDiscovery | undefined;
    wslError: string;
    statuses: Record<string, ProviderStatus>;
    presence: Presence[];
    syncStatus: string;
    syncError: string;
    paired: boolean;
    save: () => Promise<void>;
    refresh: () => Promise<void>;
    connect: (url: string, key: string) => Promise<void>;
    disconnect: () => Promise<void>;
    resolveConflict: () => Promise<void>;
    chat: (provider: ProviderId, connectionId?: string) => void;
    providerStatuses: ProviderStatus[];
    login: (provider: ProviderId) => Promise<void>;
    exportWorkspace: () => Promise<void>;
    running: boolean;
  } = $props();
  let provider = $state<ProviderId>('claude');
  let name = $state('');
  let purpose = $state<'personal' | 'work'>('personal');
  let existingAccount = $state('');
  let profile = $state<'existing' | 'isolated'>('isolated');
  let error = $state('');
  let busy = $state(false);
  let url = $state('http://127.0.0.1:4317');
  let key = $state('');
  let computerName = $state('');
  let computerGroup = $state('');
  let dialog = $state<'account' | 'computer' | 'relay' | null>(null);
  let editing = $state('');
  let accountName = $state('');
  let accountPurpose = $state<'personal' | 'work'>('personal');
  let removing = $state('');
  let environmentId = $state('');
  let accountComputerId = $state('');
  const computers = $derived(
    [...workspace.fleet.computers].sort(
      (a, b) =>
        Number(b.id === ownComputer?.id) - Number(a.id === ownComputer?.id) ||
        a.name.localeCompare(b.name),
    ),
  );
  const unassignedAccounts = $derived(
    workspace.fleet.accounts.filter(
      (account) =>
        !workspace.fleet.connections.some(
          (connection) =>
            connection.accountId === account.id &&
            workspace.fleet.environments.some(
              (environment) =>
                environment.id === connection.environmentId &&
                workspace.fleet.computers.some(
                  (computer) => computer.id === environment.computerId,
                ),
            ),
        ),
    ),
  );
  const targetEnvironment = $derived(
    workspace.fleet.environments.find((e) => e.id === (environmentId || installation?.id)),
  );
  const targetWsl = $derived(!!targetEnvironment?.discoveredOn);
  function localEnvironment(id: string) {
    return executionHost(workspace.fleet, id) === installation?.id;
  }
  const ownEnvironment = $derived(
    workspace.fleet.environments.find((e) => e.id === installation?.id),
  );
  const ownComputer = $derived(
    workspace.fleet.computers.find((c) => c.id === ownEnvironment?.computerId),
  );
  const purposes = [
    { id: 'personal', name: 'Personal' },
    { id: 'work', name: 'Work' },
  ];
  const selectedProvider = $derived(
    workspace.fleet.accounts.find((a) => a.id === existingAccount)?.provider ?? provider,
  );
  function distroState(environment: Environment) {
    if (
      !environment.distribution ||
      ownEnvironment?.computerId !== environment.computerId ||
      installation?.platform !== 'windows'
    )
      return '';
    if (wslError) return 'WSL state unavailable';
    const distro = wslDiscovery?.distributions.find(
      (d) => d.name.toLowerCase() === environment.distribution?.toLowerCase(),
    );
    return !wslDiscovery
      ? 'Checking WSL…'
      : !distro
        ? 'Not detected in Windows'
        : distro.running === null
          ? 'WSL state unavailable'
          : distro.running
            ? 'WSL running'
            : 'WSL stopped';
  }
  async function action(fn: () => Promise<void>) {
    busy = true;
    error = '';
    try {
      await fn();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  async function add() {
    if (
      !installation ||
      !targetEnvironment ||
      !localEnvironment(targetEnvironment.id) ||
      targetEnvironment.computerId !== accountComputerId
    )
      throw new Error('Choose an environment on this computer.');
    const account = existingAccount
      ? workspace.fleet.accounts.find((a) => a.id === existingAccount)
      : accountSchema.parse({ id: crypto.randomUUID(), name, provider, purpose });
    if (!account) throw new Error('Choose an account.');
    if (targetWsl && account.provider === 'gemini')
      throw new Error('Choose Codex or Claude for a WSL connection.');
    const mode = account.provider === 'gemini' ? 'existing' : profile;
    if (
      workspace.fleet.connections.some(
        (c) =>
          c.environmentId === targetEnvironment.id &&
          (c.accountId === account.id ||
            (mode === 'existing' &&
              c.profile === 'existing' &&
              workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider ===
                account.provider)),
      )
    )
      throw new Error(
        'This environment already has that account or a connection to this provider’s existing CLI login. Use a separate profile for another account.',
      );
    if (!existingAccount) workspace.fleet.accounts.push(account);
    workspace.fleet.connections.push({
      id: crypto.randomUUID(),
      environmentId: targetEnvironment.id,
      accountId: account.id,
      profile: mode,
    });
    name = '';
    existingAccount = '';
    await save();
    await refresh();
    dialog = null;
  }
  function presenceFor(id: string) {
    return presence.find((p) => p.environmentId === executionHost(workspace.fleet, id));
  }
  function connectionStatus(id: string, environmentId: string) {
    if (localEnvironment(environmentId))
      return !statuses[id]
        ? 'Checking…'
        : statuses[id]?.auth === 'ready'
          ? 'Connected'
          : statuses[id]?.installed
            ? 'Sign in or refresh'
            : 'Check CLI setup';
    const host = presenceFor(environmentId);
    if (!paired || !host?.online) return 'Offline';
    return host.connections.find((c) => c.connectionId === id)?.auth === 'ready'
      ? 'Connected'
      : 'Needs attention on host';
  }

  function closeDialog() {
    dialog = null;
    error = '';
  }
  function openAccount(
    id: ProviderId = 'claude',
    accountId = '',
    useExisting = false,
    computerId = ownComputer?.id ?? '',
  ) {
    provider = id;
    existingAccount = accountId;
    profile = useExisting ? 'existing' : 'isolated';
    accountComputerId = computerId;
    environmentId =
      workspace.fleet.environments.find(
        (environment) =>
          environment.computerId === computerId &&
          localEnvironment(environment.id) &&
          !environment.discoveredOn,
      )?.id ??
      workspace.fleet.environments.find(
        (environment) => environment.computerId === computerId && localEnvironment(environment.id),
      )?.id ??
      '';
    if (useExisting) {
      const location = providerStatus(id)?.location;
      const detected = workspace.fleet.environments.find(
        (environment) =>
          environment.computerId === computerId &&
          localEnvironment(environment.id) &&
          environment.name === location,
      );
      if (detected) environmentId = detected.id;
    }
    name = '';
    purpose = 'personal';
    error = '';
    dialog = 'account';
  }
  function openComputer() {
    computerName = ownComputer?.name ?? '';
    computerGroup = ownEnvironment?.computerId ?? '';
    error = '';
    dialog = 'computer';
  }
  function providerStatus(id: ProviderId) {
    return providerStatuses.find((s) => s.id === id);
  }
  function providerStatusLabel(id: ProviderId) {
    const status = providerStatus(id);
    return !status
      ? 'Checking…'
      : !desktop()
        ? 'Desktop only'
        : !status.installed
          ? 'Set up'
          : status.auth === 'ready'
            ? 'Connected'
            : status.auth === 'login'
              ? 'Sign in'
              : 'Installed';
  }
  function locationName(id: string) {
    const environment = workspace.fleet.environments.find((e) => e.id === id);
    return environment?.name ?? 'Unknown environment';
  }
  function computerAccounts(computerId: string, provider: ProviderId) {
    return workspace.fleet.accounts.filter(
      (account) =>
        account.provider === provider &&
        workspace.fleet.connections.some(
          (connection) =>
            connection.accountId === account.id &&
            workspace.fleet.environments.some(
              (environment) =>
                environment.id === connection.environmentId &&
                environment.computerId === computerId,
            ),
        ),
    );
  }
  function onComputer(environmentId: string, computerId: string | null) {
    return (
      computerId === null ||
      workspace.fleet.environments.some(
        (environment) => environment.id === environmentId && environment.computerId === computerId,
      )
    );
  }
  function computerStatus(computerId: string) {
    const hosts = workspace.fleet.environments
      .filter((environment) => environment.computerId === computerId)
      .map((environment) => presenceFor(environment.id));
    if (computerId === ownComputer?.id) return running ? 'Working' : 'This computer';
    if (!paired || !hosts.some((host) => host?.online)) return 'Offline';
    return hosts.some((host) => host?.online && host.running.length) ? 'Working' : 'Online';
  }
</script>

{#snippet accountCard(account: Account, computerId: string | null)}
  {@const editingId = (computerId ?? 'unassigned') + ':' + account.id}

  <div class="fleet-account">
    <div class="fleet-account-heading">
      <div>
        <h4>{account.name}</h4>
        <small
          >{#if computerId === null}{providers[account.provider].name} ·
          {/if}{account.purpose === 'work' ? 'Work' : 'Personal'}</small
        >
      </div>
      <button
        class="text-button"
        aria-expanded={editing === editingId}
        onclick={() => {
          editing = editing === editingId ? '' : editingId;
          accountName = account.name;
          accountPurpose = account.purpose;
          removing = '';
        }}>Manage account</button
      >
    </div>
    {#each workspace.fleet.connections.filter((c) => c.accountId === account.id && onComputer(c.environmentId, computerId)) as connection}
      {@const status = connectionStatus(connection.id, connection.environmentId)}
      <div class="account-connection">
        <div class="connection-copy">
          <strong>{locationName(connection.environmentId)}</strong><small
            ><span class:ready={status === 'Connected'}>{status}</span>{#if editing === editingId}
              · {connection.profile === 'isolated'
                ? 'Separate CLI profile'
                : 'Existing CLI login'}{/if}</small
          >
        </div>
        <div class="fleet-actions">
          {#if localEnvironment(connection.environmentId) && (editing === editingId || statuses[connection.id]?.auth !== 'ready')}<button
              class="text-button"
              disabled={busy || !desktop() || running}
              onclick={() =>
                action(async () => {
                  await signIn(account.provider, connection.id);
                })}>Open sign-in</button
            >{/if}
          <button class="secondary" onclick={() => chat(account.provider, connection.id)}
            >Chat<ArrowUpRight size={13} /></button
          >
        </div>
      </div>
      {#if localEnvironment(connection.environmentId) && statuses[connection.id]?.detail && statuses[connection.id]?.auth !== 'ready'}<p
          class="connection-hint"
        >
          {statuses[connection.id].detail}
        </p>{/if}
      {#if editing === editingId && localEnvironment(connection.environmentId)}
        {#if removing === connection.id}<div class="remove-connection">
            <p>Remove this connection? Saved chats and the CLI’s login files are kept.</p>
            <div class="fleet-actions">
              <button
                class="secondary"
                disabled={busy}
                onclick={() =>
                  action(async () => {
                    workspace.fleet.connections = workspace.fleet.connections.filter(
                      (c) => c.id !== connection.id,
                    );
                    delete statuses[connection.id];
                    removing = '';
                    await save();
                  })}>Remove connection</button
              ><button class="text-button" onclick={() => (removing = '')}>Keep connection</button>
            </div>
          </div>
        {:else}<button
            class="text-button disconnect-connection"
            onclick={() => (removing = connection.id)}
            >Disconnect {workspace.fleet.environments.find((e) => e.id === connection.environmentId)
              ?.name ?? 'environment'}</button
          >{/if}
      {/if}
    {:else}<p class="connection-hint">No computers connected yet.</p>{/each}
    {#if editing === editingId}<form
        class="account-edit"
        onsubmit={(e) => {
          e.preventDefault();
          void action(async () => {
            Object.assign(
              account,
              accountSchema.parse({
                ...account,
                name: accountName,
                purpose: accountPurpose,
              }),
            );
            await save();
            editing = '';
          });
        }}
      >
        <div class="fleet-fields">
          <label
            >Account name<input
              aria-label="Edit account name"
              bind:value={accountName}
              required
              maxlength="60"
            /></label
          >
          <div class="fleet-field">
            <span>Purpose</span><ChoicePicker
              field
              label="Edit account purpose"
              value={accountPurpose}
              options={purposes}
              disabled={busy}
              onchange={(value) => (accountPurpose = value as 'personal' | 'work')}
            />
          </div>
        </div>
        <div class="fleet-actions">
          <button class="secondary" disabled={busy}>Save account</button><button
            class="text-button"
            type="button"
            onclick={() => (editing = '')}>Cancel</button
          ><button
            class="text-button"
            type="button"
            disabled={busy}
            onclick={() => openAccount(account.provider, account.id, false, ownComputer?.id)}
            >{computerId === ownComputer?.id
              ? 'Connect on another environment'
              : 'Connect on this computer'}</button
          >
        </div>
        {#if !workspace.fleet.connections.some((c) => c.accountId === account.id)}<button
            class="text-button"
            type="button"
            disabled={busy}
            onclick={() =>
              action(async () => {
                workspace.fleet.accounts = workspace.fleet.accounts.filter(
                  (a) => a.id !== account.id,
                );
                editing = '';
                await save();
              })}>Remove account label</button
          >{/if}
      </form>{/if}
  </div>
{/snippet}

<div class="page-scroll">
  <div class="page-content fleet-page">
    <section class="page-heading">
      <div>
        <h1>Connections</h1>
        <p>Choose a computer to manage its accounts and CLIs.</p>
      </div>
      <button class="secondary refresh-connections" disabled={busy} onclick={() => action(refresh)}
        ><RefreshCw size={15} />Refresh connections</button
      >
    </section>
    {#if error && !dialog}<div class="error-banner" role="alert">{error}</div>{/if}
    <section class="computers-section" aria-labelledby="computers-heading">
      <div class="section-heading">
        <div>
          <h2 id="computers-heading">Your computers</h2>
          <span>Accounts and CLI setup live with the computer that runs them.</span>
        </div>
        <span class="computer-count"
          >{computers.length} {computers.length === 1 ? 'computer' : 'computers'}</span
        >
      </div>
      <div class="fleet-computers">
        {#each computers as computer (computer.id)}
          {@const local = computer.id === ownComputer?.id}
          {@const environments = workspace.fleet.environments.filter(
            (environment) => environment.computerId === computer.id,
          )}
          <article class="fleet-computer" aria-label={computer.name + ' computer'}>
            <header class="computer-heading">
              <span class="computer-icon"><Monitor size={21} /></span>
              <div class="computer-identity">
                <h3>{computer.name}</h3>
                <span class="computer-state" class:ready={computerStatus(computer.id) !== 'Offline'}
                  >{computerStatus(computer.id)}</span
                >
              </div>
              {#if local}<div class="fleet-actions">
                  <button
                    class="secondary"
                    disabled={busy || !installation}
                    onclick={() => openAccount('claude', '', false, computer.id)}
                    ><Plus size={14} />Add account</button
                  ><button
                    class="icon-button"
                    aria-label={'Manage computer ' + computer.name}
                    title="Manage computer"
                    disabled={busy}
                    onclick={openComputer}><Settings2 size={17} /></button
                  >
                </div>{/if}
            </header>
            <div class="computer-environments">
              {#each environments as environment}<div class="environment-row">
                  <div>
                    <strong>{environment.name}</strong>{#if environment.discoveredOn}<small
                        >Automatically detected · {distroState(environment) ||
                          'Managed by Windows'}</small
                      >{/if}
                  </div>
                  <span
                    class="environment-status"
                    class:ready={localEnvironment(environment.id) ||
                      (paired && !!presenceFor(environment.id)?.online)}
                    >{environment.id === installation?.id
                      ? 'Here'
                      : localEnvironment(environment.id)
                        ? 'Managed here'
                        : paired && presenceFor(environment.id)?.online
                          ? presenceFor(environment.id)?.running.length
                            ? 'Working'
                            : 'Online'
                          : 'Offline'}</span
                  >
                </div>{/each}
            </div>
            {#if local && installation?.platform === 'windows'}<p class="computer-hint">
                Windows CLI first, WSL when needed. WSL runs through this app automatically.
              </p>{/if}
            {#if local && wslError}<p class="sync-error" role="alert">{wslError}</p>{/if}
            {#if environments.length}
              <div class="computer-providers" aria-label={'Accounts and CLIs on ' + computer.name}>
                {#each providerIds as id}
                  {@const accounts = computerAccounts(computer.id, id)}
                  <article
                    class="connection-card provider-group"
                    aria-label={providers[id].name + ' connections'}
                  >
                    <header class="provider-heading">
                      <span class="provider-icon" style:--provider-color={providers[id].color}
                        >{providers[id].mark}</span
                      >
                      <div>
                        <h4>{providers[id].name}</h4>
                        <span class="small muted"
                          >{accounts.length
                            ? accounts.length + (accounts.length === 1 ? ' account' : ' accounts')
                            : providers[id].company}</span
                        >
                      </div>
                      {#if local && !accounts.length}<span
                          class="connection-badge"
                          class:connected={providerStatus(id)?.auth === 'ready'}
                          ><i></i>{providerStatusLabel(id)}</span
                        >{/if}
                    </header>
                    {#each accounts as account (account.id)}
                      {@render accountCard(account, computer.id)}
                    {:else}{#if local}
                        <div class="current-login">
                          <div>
                            <strong
                              >{providerStatus(id)?.installed
                                ? 'Current CLI login'
                                : 'Connect your account'}</strong
                            >
                            <p>
                              {providerStatus(id)?.installed
                                ? (providerStatus(id)?.location ??
                                    ownEnvironment?.name ??
                                    'This computer') +
                                  ' · ' +
                                  (providerStatus(id)?.version ?? 'CLI detected')
                                : 'Set up ' +
                                  providers[id].name +
                                  ' on this computer to get started.'}
                            </p>
                          </div>
                          <div class="fleet-actions">
                            {#if providerStatus(id)?.auth === 'ready'}<button
                                class="text-button"
                                disabled={busy || !installation}
                                onclick={() => openAccount(id, '', true)}>Name this account</button
                              ><button class="secondary" onclick={() => chat(id)}
                                >Start chat<ArrowUpRight size={13} /></button
                              >{:else}<button
                                class="secondary"
                                disabled={busy ||
                                  !desktop() ||
                                  !providerStatus(id)?.installed ||
                                  running}
                                onclick={() => action(() => login(id))}
                                >Open sign-in<ArrowUpRight size={13} /></button
                              >{/if}
                          </div>
                        </div>
                      {:else}<p class="connection-hint remote-empty">
                          No account connected on this computer.
                        </p>{/if}{/each}
                    {#if local}
                      <details class="provider-setup">
                        <summary><span>CLI setup</span><ChevronDown size={14} /></summary>
                        <div class="provider-setup-content">
                          <p>
                            {providerStatus(id)?.detail ?? 'Looking for the CLI on this device…'}
                          </p>
                          {#if accounts.length}<p>
                              {providerStatus(id)?.location ??
                                ownEnvironment?.name ??
                                'This computer'} · {providerStatus(id)?.version ??
                                'Checking installation'} · {providerStatusLabel(id)}
                            </p>{/if}
                          <div class="connection-commands">
                            <div><span>INSTALL</span><code>{providers[id].install}</code></div>
                            <div><span>SIGN IN</span><code>{providers[id].login}</code></div>
                          </div>
                          <p>
                            {id === 'gemini'
                              ? 'Uses your Google subscription through Antigravity CLI (agy).'
                              : 'Uses your ' +
                                providers[id].account +
                                ' subscription. Separate profiles keep additional accounts independent.'}
                          </p>
                          {#if accounts.length}<div class="fleet-actions">
                              <button
                                class="secondary"
                                disabled={busy ||
                                  !desktop() ||
                                  !providerStatus(id)?.installed ||
                                  running}
                                onclick={() => action(() => login(id))}
                                >Open current CLI sign-in</button
                              ><button class="text-button" onclick={() => chat(id)}
                                >Use current CLI login</button
                              >
                            </div>{:else if providerStatus(id)?.auth === 'ready'}<button
                              class="text-button"
                              disabled={busy || !desktop() || running}
                              onclick={() => action(() => login(id))}>Open sign-in</button
                            >{/if}
                        </div>
                      </details>
                    {/if}
                  </article>
                {/each}
              </div>
              {#if !local}<p class="computer-hint remote-hint">
                  Use connected accounts here when {computer.name} is online. Add CLI profiles and complete
                  sign-in in Agent Studio on {computer.name}.
                </p>{/if}
            {:else}<p class="connection-hint">No environments connected to this computer.</p>
              <button
                class="text-button"
                disabled={busy}
                onclick={() =>
                  action(async () => {
                    workspace.fleet.computers = workspace.fleet.computers.filter(
                      (c) => c.id !== computer.id,
                    );
                    await save();
                  })}>Remove empty computer</button
              >{/if}
          </article>
        {:else}<p class="connection-hint">Loading this computer’s connections…</p>{/each}
      </div>
    </section>
    {#if unassignedAccounts.length}<details class="unassigned-accounts">
        <summary>Accounts without a computer <span>{unassignedAccounts.length}</span></summary>
        <p class="connection-hint">
          These saved account labels are available when you add an account to a computer.
        </p>
        {#each unassignedAccounts as account (account.id)}{@render accountCard(
            account,
            null,
          )}{/each}
      </details>{/if}
    <section class="fleet-relay" aria-labelledby="sync-heading">
      <div class="relay-title">
        <Server size={18} />
        <h2 id="sync-heading">Workspace sync</h2>
      </div>
      <div class="relay-state">
        <span class="connection-badge" class:connected={paired && !syncError}
          ><i></i>{paired ? (syncError ? 'Reconnecting' : 'Paired') : 'Local only'}</span
        >
      </div>
      <p>
        {paired
          ? syncStatus
          : 'Connect your desktop and MacBook to share chats, accounts, and live progress.'}
      </p>
      {#if syncError}<p class="sync-error" role="alert">{syncError}</p>{/if}
      {#if syncError.includes('changed on both devices')}<button
          class="secondary"
          disabled={busy}
          onclick={() => action(resolveConflict)}>Back up local data & use relay settings</button
        >{/if}
      {#if paired}<details class="sync-settings">
          <summary>Sync settings</summary>
          <p>Keep Agent Studio open on each computer you want to use. WSL uses its Windows host.</p>
          <button class="text-button" disabled={busy} onclick={() => action(disconnect)}
            >Disconnect relay</button
          >
        </details>{:else}<button
          class="secondary"
          disabled={busy}
          onclick={() => {
            error = '';
            dialog = 'relay';
          }}><Link size={14} />Set up sync</button
        >{/if}
    </section>
    <footer class="connections-footer">
      <div>
        <ShieldCheck size={16} /><span
          >Provider sign-ins stay on each computer. <details>
            <summary>Storage & privacy</summary>
            <p>
              Conversations and settings are saved on this device. Pairing sync shares chat content
              and account labels with the relay and your paired computers. Passwords and provider
              tokens stay with their CLIs. Conversation files and exports are plain text.
            </p>
          </details></span
        >
      </div>
      <button class="text-button" onclick={() => action(exportWorkspace)} disabled={busy}
        ><Download size={14} />Export workspace</button
      >
    </footer>
  </div>
</div>

{#if dialog === 'account'}<ConnectionDialog title="Connect an account" {busy} close={closeDialog}>
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void action(add);
      }}
    >
      <p class="account-target">
        Connect an account on <strong
          >{workspace.fleet.computers.find((computer) => computer.id === accountComputerId)?.name ??
            'this computer'}</strong
        >. Choose its environment and sign-in method.
      </p>
      <div class="fleet-fields">
        <div class="fleet-field">
          <span>Environment</span><ChoicePicker
            field
            label="Connection environment"
            value={targetEnvironment?.id ?? ''}
            disabled={busy}
            options={workspace.fleet.environments
              .filter((e) => localEnvironment(e.id) && e.computerId === accountComputerId)
              .map((e) => ({
                id: e.id,
                name: e.name,
                detail: e.discoveredOn ? 'Managed by the Windows app' : 'Native CLI',
              }))}
            onchange={(value) => {
              environmentId = value;
              if (
                workspace.fleet.environments.find((e) => e.id === value)?.discoveredOn &&
                selectedProvider === 'gemini'
              ) {
                existingAccount = '';
                provider = 'claude';
              }
            }}
          />
        </div>
        <div class="fleet-field">
          <span>Account</span><ChoicePicker
            field
            label="Account to connect"
            value={existingAccount}
            disabled={busy}
            options={[
              { id: '', name: 'Add a new account' },
              ...workspace.fleet.accounts
                .filter((a) => !targetWsl || a.provider !== 'gemini')
                .map((account) => ({
                  id: account.id,
                  name: account.name,
                  detail: providers[account.provider].name,
                })),
            ]}
            onchange={(value) => (existingAccount = value)}
          />
        </div>
        {#if !existingAccount}<div class="fleet-field">
            <span>Provider</span><ChoicePicker
              field
              label="Account provider"
              value={provider}
              disabled={busy}
              options={providerIds
                .filter((id) => !targetWsl || id !== 'gemini')
                .map((id) => ({
                  id,
                  name: providers[id].name,
                  mark: providers[id].mark,
                  color: providers[id].color,
                }))}
              onchange={(value) => (provider = value as ProviderId)}
            />
          </div>
          <label
            >Account name<input
              aria-label="Account name"
              placeholder="Personal 1 or Company"
              bind:value={name}
              maxlength="60"
              required
            /></label
          >
          <div class="fleet-field">
            <span>Purpose</span><ChoicePicker
              field
              label="Account purpose"
              value={purpose}
              options={purposes}
              disabled={busy}
              onchange={(value) => (purpose = value as 'personal' | 'work')}
            />
          </div>{/if}
        <div class="fleet-field">
          <span>Login profile</span><ChoicePicker
            field
            label="Login profile"
            value={selectedProvider === 'gemini' ? 'existing' : profile}
            disabled={busy || selectedProvider === 'gemini'}
            options={[
              {
                id: 'isolated',
                name: 'Separate login for this account',
                detail: 'An independent sign-in for another personal or work account',
              },
              {
                id: 'existing',
                name: 'Use the existing CLI login',
                detail: 'Share the login and settings you already use in this environment',
              },
            ]}
            onchange={(value) => (profile = value as 'existing' | 'isolated')}
          />
        </div>
      </div>

      <div class="login-profile-help" role="note" aria-label="How this login works">
        {#if selectedProvider === 'gemini'}<strong>Uses your existing Antigravity login</strong>
          <p>
            Gemini supports the current CLI login only. Sign-in and settings are shared with
            Antigravity in this environment.
          </p>
        {:else if profile === 'isolated'}<strong
            >A separate sign-in, using the same installed CLI</strong
          >
          <p>
            Starts with its own login and settings for this connection. Sign in to your other
            personal or work account without changing the account you use in your terminal.
          </p>
        {:else if targetEnvironment?.discoveredOn}<strong
            >Windows CLI first, WSL as a fallback</strong
          >
          <p>
            Uses your Windows {providers[selectedProvider].name} installation and login first, including
            for folders in {targetEnvironment.name}. If it is not installed on Windows, uses the
            existing CLI login in that WSL distribution. The selected folder stays the same.
          </p>
        {:else}<strong>The same sign-in you use in your terminal</strong>
          <p>
            Uses the current {providers[selectedProvider].name} login and settings in {targetEnvironment?.name ??
              'this environment'}. Signing out or switching that CLI’s account also changes this
            connection.
          </p>{/if}
        <p class="profile-location-note">
          Separate profiles and other computers keep their own sign-ins. The relay syncs account
          labels and chats, never provider logins.
        </p>
      </div>
      <div class="dialog-actions">
        <button class="secondary" type="button" disabled={busy} onclick={closeDialog}>Cancel</button
        ><button class="primary" disabled={busy || !installation}
          >Connect account<Plus size={15} /></button
        >
      </div>
    </form>
  </ConnectionDialog>
{:else if dialog === 'computer' && ownComputer && ownEnvironment}<ConnectionDialog
    title="Manage computer"
    {busy}
    close={closeDialog}
  >
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void action(async () => {
          if (!computerName.trim()) return;
          ownComputer.name = computerName.trim();
          const oldId = ownEnvironment.computerId;
          if (computerGroup !== oldId) {
            ownEnvironment.computerId = computerGroup;
            for (const environment of workspace.fleet.environments) {
              if (environment.discoveredOn === ownEnvironment.id)
                environment.computerId = computerGroup;
            }
            reconcileDiscoveredWsl(workspace.fleet);
          }
          await save();
          closeDialog();
        });
      }}
    >
      <p>
        Settings for {ownComputer.name}. Windows and its WSL environments belong to the same
        computer.
      </p>
      <label
        >Computer name<input
          aria-label="Computer name"
          bind:value={computerName}
          required
          maxlength="60"
        /></label
      >
      <details>
        <summary>Advanced: group environments</summary>
        <p>Use this when separate app installations belong to the same physical computer.</p>
        <div class="fleet-field">
          <span>Group this environment under</span><ChoicePicker
            field
            label="Group this environment under"
            value={computerGroup}
            options={workspace.fleet.computers}
            disabled={busy}
            onchange={(id) => (computerGroup = id)}
          />
        </div>
      </details>
      <div class="dialog-actions">
        <button class="secondary" type="button" disabled={busy} onclick={closeDialog}>Cancel</button
        ><button class="primary" disabled={busy || !computerName.trim()}>Save computer</button>
      </div>
    </form>
  </ConnectionDialog>
{:else if dialog === 'relay'}<ConnectionDialog
    title="Set up workspace sync"
    {busy}
    close={closeDialog}
  >
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void action(async () => {
          await connect(url.trim().replace(/\/$/, ''), key.trim());
          key = '';
          closeDialog();
        });
      }}
    >
      <p>
        Enter the same relay address and pairing key on each computer. You can host the relay
        locally or on your VPS.
      </p>
      <label>Relay URL<input aria-label="Relay URL" type="url" bind:value={url} required /></label
      ><label
        >Pairing key<input
          aria-label="Relay pairing key"
          type="password"
          bind:value={key}
          minlength="32"
          autocomplete="off"
          required
        /></label
      >
      <p>
        Pairing shares chat content and account labels with the relay and your paired computers.
        Provider credentials stay on each host. The pairing key stays in memory until the app
        closes.
      </p>
      <div class="dialog-actions">
        <button class="secondary" type="button" disabled={busy} onclick={closeDialog}>Cancel</button
        ><button class="primary" disabled={busy || !desktop()}>Pair & sync<Link size={15} /></button
        >
      </div>
    </form>
  </ConnectionDialog>{/if}

<style>
  .fleet-page {
    padding-top: 32px;
    padding-bottom: 28px;
  }
  .page-heading {
    margin-bottom: 30px;
  }
  .page-heading h1 {
    font-size: 30px;
  }
  .page-heading p {
    font-size: 13px;
    line-height: 1.6;
  }
  .section-heading {
    margin: 0 0 18px;
    gap: 14px;
  }
  .section-heading > div {
    display: block;
  }
  .section-heading h2 {
    margin: 0 0 7px;
    font-size: 17px;
  }
  .section-heading > div > span {
    display: block;
    background: none;
    padding: 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.6;
  }
  .computer-count {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }
  .fleet-computers {
    display: grid;
    gap: 24px;
  }
  .fleet-computer {
    border: 1px solid var(--line);
    background: #181c19;
    border-radius: 14px;
    padding: 22px;
    min-width: 0;
  }
  .computer-heading {
    display: flex;
    align-items: center;
    gap: 13px;
    margin-bottom: 20px;
  }
  .computer-icon {
    display: grid;
    place-items: center;
    width: 43px;
    height: 43px;
    border-radius: 10px;
    border: 1px solid #3a4533;
    background: #232b1f;
    color: var(--green);
    flex-shrink: 0;
  }
  .computer-identity {
    flex: 1;
    min-width: 0;
  }
  .computer-identity h3 {
    font-size: 18px;
    margin: 0 0 5px;
    overflow-wrap: anywhere;
  }
  .computer-state {
    font-size: 11px;
    color: var(--muted);
  }
  .computer-environments {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .environment-row {
    display: flex;
    align-items: center;
    gap: 26px;
    justify-content: space-between;
    padding: 11px 13px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    min-width: 180px;
  }
  .environment-row strong {
    font-size: 12px;
    font-weight: 500;
  }
  .environment-row small {
    display: block;
    color: var(--muted);
    font-size: 10px;
    margin-top: 5px;
    line-height: 1.6;
  }
  .environment-status {
    font-size: 10px;
    color: var(--muted);
    white-space: nowrap;
  }
  .ready {
    color: #b7ce98;
  }
  .computer-hint {
    font-size: 11px;
    line-height: 1.7;
    color: var(--muted);
    margin: 12px 0 0;
  }
  .computer-providers {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 270px), 1fr));
    gap: 14px;
    align-items: start;
    margin-top: 22px;
  }
  .provider-group {
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel);
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .provider-heading {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 17px 16px;
  }
  .provider-heading h4 {
    font-size: 15px;
    margin: 0 0 4px;
    font-weight: 600;
  }
  .provider-heading .provider-icon {
    width: 33px;
    height: 33px;
    font-size: 23px;
    border-radius: 8px;
    flex-shrink: 0;
  }
  .provider-heading .connection-badge {
    margin-left: auto;
  }
  .fleet-actions {
    display: flex;
    gap: 11px;
    align-items: center;
    flex-wrap: wrap;
  }
  .fleet-actions .secondary {
    font-size: 11px;
    padding: 8px 11px;
  }
  .fleet-actions .text-button {
    font-size: 11px;
  }
  .current-login {
    padding: 0 16px 16px;
  }
  .current-login strong {
    font-size: 12px;
    font-weight: 500;
  }
  .current-login p {
    font-size: 11px;
    color: var(--muted);
    margin: 6px 0 14px;
    line-height: 1.6;
  }
  .current-login .fleet-actions {
    justify-content: flex-end;
  }
  .provider-setup {
    border-top: 1px solid var(--line);
  }
  .provider-setup > summary {
    display: flex;
    justify-content: space-between;
    list-style: none;
    padding: 10px 16px;
    cursor: pointer;
    color: var(--muted);
    font-size: 11px;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  .provider-setup[open] > summary {
    color: var(--text);
  }
  .provider-setup[open] > summary :global(svg) {
    transform: rotate(180deg);
  }
  .provider-setup-content {
    padding: 0 16px 16px;
    font-size: 11px;
    line-height: 1.7;
    color: var(--muted);
  }
  .connection-commands {
    display: grid;
    grid-template-columns: 1fr;
    margin: 14px 0;
  }
  .connection-commands > div + div {
    border-left: 0;
    border-top: 1px solid var(--line);
  }
  .connection-commands code {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .fleet-account {
    border-top: 1px solid var(--line);
    padding: 16px;
  }
  .fleet-account-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 9px;
  }
  .fleet-account-heading h4 {
    margin: 0 0 4px;
    font-size: 13px;
    font-weight: 500;
  }
  .fleet-account-heading small {
    font-size: 10px;
    color: var(--muted);
  }
  .fleet-account-heading > .text-button {
    font-size: 10px;
    flex-shrink: 0;
  }
  .account-connection {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 14px;
  }
  .connection-copy strong {
    font-size: 11px;
    font-weight: 400;
  }
  .connection-copy small {
    display: block;
    font-size: 10px;
    color: var(--muted);
    margin-top: 4px;
  }
  .connection-hint {
    font-size: 11px;
    color: var(--muted);
    line-height: 1.7;
  }
  .remote-empty {
    padding: 0 16px 10px;
  }
  .account-edit {
    display: grid;
    gap: 16px;
    border-top: 1px solid var(--line);
    margin-top: 16px;
    padding-top: 16px;
  }
  .fleet-fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }
  .account-edit .fleet-fields {
    grid-template-columns: 1fr;
  }
  label,
  .fleet-field {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    color: var(--muted);
    min-width: 0;
  }
  input {
    width: 100%;
  }
  .disconnect-connection {
    font-size: 11px;
    margin-top: 12px;
  }
  .remove-connection {
    font-size: 12px;
    padding: 12px;
    border: 1px solid #705044;
    border-radius: 8px;
    margin-top: 12px;
  }
  .unassigned-accounts {
    border: 1px solid var(--line);
    border-radius: 10px;
    margin-top: 24px;
    padding: 16px;
  }
  .unassigned-accounts > summary {
    cursor: pointer;
    font-size: 12px;
    color: var(--muted);
  }
  .unassigned-accounts > summary span {
    margin-left: 6px;
  }
  .fleet-relay {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    align-items: center;
    gap: 20px;
    margin-top: 26px;
    padding: 20px;
    border: 1px solid var(--line);
    background: var(--panel);
    border-radius: 12px;
  }
  .relay-title {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .relay-title :global(svg) {
    color: var(--muted);
  }
  .relay-title h2 {
    font-size: 14px;
    font-weight: 500;
    margin: 0;
  }
  .fleet-relay p {
    font-size: 11px;
    line-height: 1.7;
    color: var(--muted);
    margin: 0;
  }
  .fleet-relay > .sync-error {
    grid-column: 1 / -1;
  }
  .sync-settings summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 12px;
  }
  .sync-settings[open] {
    grid-column: 1 / -1;
  }
  .sync-settings p {
    margin: 12px 0;
  }
  .sync-error {
    color: #efb18a !important;
    font-size: 12px;
    overflow-wrap: anywhere;
    line-height: 1.7;
  }
  .connections-footer {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    border-top: 1px solid var(--line);
    padding-top: 22px;
    margin-top: 28px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.6;
  }
  .connections-footer > div {
    display: flex;
    gap: 10px;
    max-width: 560px;
  }
  .connections-footer :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
  }
  .connections-footer summary {
    cursor: pointer;
    font-size: 10px;
    margin-top: 4px;
  }
  .connections-footer > button {
    flex-shrink: 0;
    font-size: 11px;
  }
  .login-profile-help {
    border: 1px solid #3d4934;
    background: #20271c;
    border-radius: 9px;
    padding: 14px;
  }
  .login-profile-help strong {
    display: block;
    font-size: 12px;
    color: var(--text);
    margin-bottom: 7px;
  }
  .login-profile-help .profile-location-note {
    padding-top: 9px;
    margin-top: 9px;
    border-top: 1px solid var(--line);
    font-size: 11px;
  }
  @media (max-width: 1190px) {
    .fleet-page {
      padding-inline: 28px;
    }
  }
  @media (max-width: 1000px) {
    .page-heading {
      flex-wrap: wrap;
    }
    .fleet-relay {
      grid-template-columns: 1fr auto;
    }
    .fleet-relay > p {
      grid-column: 1 / -1;
    }
  }
  @media (max-width: 650px) {
    .fleet-page {
      padding-inline: 20px;
    }
    .fleet-computer {
      padding: 15px;
    }
    .computer-heading {
      flex-wrap: wrap;
    }
    .computer-heading > .fleet-actions {
      width: 100%;
      justify-content: flex-end;
    }
    .computer-environments {
      display: grid;
    }
    .fleet-fields {
      grid-template-columns: 1fr;
    }
    .connections-footer {
      flex-wrap: wrap;
    }
  }
</style>
