<script lang="ts">
  import {
    Monitor,
    Server,
    Plus,
    Link,
    RefreshCw,
    Settings2,
    ArrowUpRight,
    LoaderCircle,
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
    computerViews,
    computerViewId,
    reconcileDiscoveredWsl,
    type Installation,
    type Account,
    type Environment,
    type WslDiscovery,
    type CliInventory,
    type Connection,
    sharedContextChoice,
    applySharedContextChoice,
  } from '$lib/fleet';
  import ChoicePicker from './ChoicePicker.svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import AccountUsage from './AccountUsage.svelte';
  import { snapshotFor, usageKey, type UsageSnapshot } from '$lib/usage';
  import type { Presence } from '$lib/sync';
  import { desktop, contextCache } from '$lib/transport';
  let {
    workspace = $bindable(),
    installation,
    wslDiscovery,
    wslError,
    cliInventories,
    statuses = $bindable(),
    usageSnapshots,
    usageLoading,
    usageErrors,
    presence,
    reconnecting = false,
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
    running,
  }: {
    workspace: Workspace;
    installation: Installation | undefined;
    wslDiscovery: WslDiscovery | undefined;
    wslError: string;
    cliInventories: Record<string, CliInventory>;
    statuses: Record<string, ProviderStatus>;
    usageSnapshots: Record<string, UsageSnapshot>;
    usageLoading: Record<string, boolean>;
    usageErrors: Record<string, string>;
    presence: Presence[];
    reconnecting?: boolean;
    syncStatus: string;
    syncError: string;
    paired: boolean;
    save: () => Promise<void>;
    refresh: () => Promise<void>;
    connect: (url: string, key: string) => Promise<void>;
    disconnect: () => Promise<void>;
    resolveConflict: () => Promise<void>;
    chat: (provider: ProviderId, connectionId?: string, computerId?: string) => void;
    providerStatuses: ProviderStatus[];
    login: (provider: ProviderId, connectionId?: string) => Promise<void>;
    running: boolean;
  } = $props();
  let provider = $state<ProviderId>('claude');
  let name = $state('');
  let linkedAccountId = $state('');
  let createdConnectionId = $state('');
  let creationStage = $state('');
  let signingInConnection = $state('');
  let error = $state('');
  let busy = $state(false);
  let url = $state(desktop() ? 'http://127.0.0.1:4317' : window.location.origin);
  let key = $state('');
  let computerName = $state('');
  let computerGroup = $state('');
  let dialog = $state<'account' | 'manage-account' | 'computer' | 'relay' | null>(null);
  let managedAccountId = $state('');
  let managedComputerId = $state<string | null>(null);
  let accountName = $state('');
  let sharedSources = $state<Record<string, string>>({});
  let sharedSourcesBaseline = $state<Record<string, string>>({});
  let removing = $state('');
  let environmentId = $state('');
  let accountComputerId = $state('');
  const computers = $derived(
    computerViews(workspace.fleet).sort(
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
  function localEnvironment(id: string) {
    return executionHost(workspace.fleet, id) === installation?.id;
  }
  const ownEnvironment = $derived(
    workspace.fleet.environments.find((e) => e.id === installation?.id),
  );
  const ownComputer = $derived(
    workspace.fleet.computers.find((c) => c.id === ownEnvironment?.computerId),
  );
  const selectedProvider = $derived(
    workspace.fleet.accounts.find((a) => a.id === linkedAccountId)?.provider ?? provider,
  );
  function connectionOnTarget(accountId: string) {
    return workspace.fleet.connections.find(
      (connection) =>
        connection.accountId === accountId && connection.environmentId === targetEnvironment?.id,
    );
  }
  const managedAccount = $derived(workspace.fleet.accounts.find((a) => a.id === managedAccountId));
  const managedConnections = $derived(
    workspace.fleet.connections.filter(
      (c) => c.accountId === managedAccountId && onComputer(c.environmentId, managedComputerId),
    ),
  );
  const canConnectManagedAccountHere = $derived(
    !!installation &&
      !!managedAccount &&
      !workspace.fleet.connections.some(
        (c) => c.accountId === managedAccountId && c.environmentId === installation.id,
      ),
  );
  function cliInstalled(environmentId: string, provider: ProviderId) {
    const inventory = cliInventories[environmentId];
    return (
      !!inventory?.entries?.some((entry) => entry.id === provider && entry.path) && !inventory.error
    );
  }
  function connectableProviders(computerId: string) {
    const environments = computers.find((c) => c.id === computerId)?.environments ?? [];
    return providerIds.filter(
      (id) =>
        id !== 'gemini' &&
        environments.some((e) => localEnvironment(e.id) && cliInstalled(e.id, id)),
    );
  }
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
    if (busy) return;
    busy = true;
    error = '';
    try {
      await fn();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
      creationStage = '';
      signingInConnection = '';
    }
  }
  async function add() {
    if (
      !installation ||
      !targetEnvironment ||
      !localEnvironment(targetEnvironment.id) ||
      computerViewId(targetEnvironment) !== accountComputerId
    )
      throw new Error('Choose an environment on this computer.');
    if (createdConnectionId) {
      creationStage = 'Opening sign-in…';
      await login(selectedProvider, createdConnectionId);
      closeDialog();
      return;
    }
    const account = linkedAccountId
      ? workspace.fleet.accounts.find((a) => a.id === linkedAccountId)
      : accountSchema.parse({ id: crypto.randomUUID(), name, provider, purpose: 'personal' });
    if (!account) throw new Error('Choose an account.');
    if (!cliInstalled(targetEnvironment.id, account.provider))
      throw new Error('Install this CLI on the selected computer, then refresh Connections.');
    if (account.provider === 'gemini')
      throw new Error('Additional accounts are supported for Claude and Codex.');
    if (linkedAccountId && connectionOnTarget(linkedAccountId))
      throw new Error('This account is already connected on this computer.');
    const connection = {
      id: crypto.randomUUID(),
      environmentId: targetEnvironment.id,
      accountId: account.id,
      profile: 'isolated' as const,
    };
    creationStage = 'Creating account…';
    if (!linkedAccountId) workspace.fleet.accounts.push(account);
    workspace.fleet.connections.push(connection);
    try {
      await save();
    } catch (e) {
      workspace.fleet.connections = workspace.fleet.connections.filter(
        (c) => c.id !== connection.id,
      );
      if (!linkedAccountId)
        workspace.fleet.accounts = workspace.fleet.accounts.filter((a) => a.id !== account.id);
      throw e;
    }
    createdConnectionId = connection.id;
    statuses[connection.id] = {
      id: account.provider,
      installed: true,
      auth: 'login',
      version: null,
      detail: 'Sign in to connect this account.',
    };
    creationStage = 'Opening sign-in…';
    await login(account.provider, connection.id);
    closeDialog();
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
            : 'Install the CLI';
    const host = presenceFor(environmentId);
    if (!paired || !host?.online) return 'Offline';
    return host.connections.find((c) => c.connectionId === id)?.auth === 'ready'
      ? 'Connected'
      : 'Needs attention on host';
  }

  function closeDialog() {
    dialog = null;
    error = '';
    removing = '';
    creationStage = '';
  }
  function manageAccount(account: Account, computerId: string | null) {
    managedAccountId = account.id;
    managedComputerId = computerId;
    accountName = account.name;
    sharedSources = Object.fromEntries(
      workspace.fleet.connections.map((c) => [c.id, sharedContextChoice(c)]),
    );
    sharedSourcesBaseline = { ...sharedSources };
    error = '';
    removing = '';
    dialog = 'manage-account';
  }
  function sharedOptions(connection: Connection) {
    const isSource = workspace.fleet.connections.some(
      (c) => c.sharedContextConnectionId === connection.id,
    );
    return [
      { id: 'computer', name: 'This computer’s CLI context' },
      { id: '', name: 'This account only' },
      ...workspace.fleet.connections
        .filter(
          (c) =>
            !isSource &&
            c.id !== connection.id &&
            c.environmentId === connection.environmentId &&
            !c.sharedContextConnectionId &&
            workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider ===
              managedAccount?.provider,
        )
        .map((c) => ({
          id: c.id,
          name:
            workspace.fleet.accounts.find((a) => a.id === c.accountId)?.name ??
            'Unavailable account',
        })),
    ];
  }
  function openAccount(
    id: ProviderId = 'claude',
    computerId = ownComputer?.id ?? '',
    accountId = '',
  ) {
    const available = connectableProviders(computerId);
    provider = available.includes(id) ? id : (available[0] ?? id);
    linkedAccountId = accountId;
    createdConnectionId = '';
    creationStage = '';
    accountComputerId = computerId;
    environmentId =
      workspace.fleet.environments.find(
        (environment) =>
          computerViewId(environment) === computerId &&
          localEnvironment(environment.id) &&
          !environment.discoveredOn,
      )?.id ??
      workspace.fleet.environments.find(
        (environment) =>
          computerViewId(environment) === computerId && localEnvironment(environment.id),
      )?.id ??
      '';
    name = workspace.fleet.accounts.find((a) => a.id === accountId)?.name ?? '';
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
                computerViewId(environment) === computerId,
            ),
        ),
    );
  }
  function onComputer(environmentId: string, computerId: string | null) {
    return (
      computerId === null ||
      workspace.fleet.environments.some(
        (environment) =>
          environment.id === environmentId && computerViewId(environment) === computerId,
      )
    );
  }
  function computerStatus(computerId: string) {
    const computer = computers.find((c) => c.id === computerId);
    if (computer?.wsl && computer.environments.some((e) => localEnvironment(e.id)))
      return distroState(computer.environments[0]);
    const hosts = workspace.fleet.environments
      .filter((environment) => computerViewId(environment) === computerId)
      .map((environment) => presenceFor(environment.id));
    if (computerId === ownComputer?.id) return running ? 'Working' : 'This computer';
    if (!paired || !hosts.some((host) => host?.online)) return 'Offline';
    return hosts.some((host) => host?.online && host.running.length) ? 'Working' : 'Online';
  }
  function inventoryLabel(environmentId: string, provider: ProviderId) {
    const inventory = cliInventories[environmentId];
    const entry = inventory?.entries?.find((entry) => entry.id === provider);
    if (inventory?.checking) return entry ? 'Updating…' : 'Checking installation…';
    if (inventory?.error) return entry ? 'Last check' : 'Installation unknown';
    return entry ? (entry.path ? 'Installed' : 'Not installed') : 'Installation unknown';
  }
</script>

{#snippet accountCard(account: Account, computerId: string | null)}
  <div class="fleet-account">
    <div class="fleet-account-heading">
      <div>
        <h4>{account.name}</h4>
        {#if computerId === null}<small>{providers[account.provider].name}</small>{/if}
      </div>
      <button
        class="icon-button manage-account"
        aria-label="Manage account"
        title="Manage account"
        aria-haspopup="dialog"
        onclick={() => manageAccount(account, computerId)}><Settings2 size={16} /></button
      >
    </div>
    {#each workspace.fleet.connections.filter((c) => c.accountId === account.id && onComputer(c.environmentId, computerId)) as connection}
      {@const status = connectionStatus(connection.id, connection.environmentId)}
      {@const usageSettings = {
        provider: account.provider,
        model: '',
        connectionId: connection.id,
      }}
      {@const key = usageKey(usageSettings)}
      <div
        class="account-connection"
        aria-label={'Account actions in ' + locationName(connection.environmentId)}
      >
        <div class="connection-controls">
          {#if status !== 'Connected'}<p class="connection-hint">{status}</p>{/if}
          <div class="fleet-actions">
            <button class="secondary" onclick={() => chat(account.provider, connection.id)}
              >Chat<ArrowUpRight size={13} /></button
            >
            {#if localEnvironment(connection.environmentId)}<button
                class="text-button"
                disabled={busy || !desktop() || running || !statuses[connection.id]?.installed}
                onclick={() =>
                  action(async () => {
                    signingInConnection = connection.id;
                    await login(account.provider, connection.id);
                  })}
                >{#if signingInConnection === connection.id}<LoaderCircle
                    size={13}
                    class="spinning"
                  />Opening sign-in…{:else}Open sign-in{/if}</button
              >{/if}
          </div>
          {#if localEnvironment(connection.environmentId) && statuses[connection.id]?.detail && statuses[connection.id]?.auth !== 'ready'}<p
              class="connection-hint"
            >
              {statuses[connection.id].detail}
            </p>{/if}
        </div>
        <AccountUsage
          connectionId={connection.id}
          provider={account.provider}
          name={account.name}
          snapshot={snapshotFor(usageSnapshots, usageSettings)}
          loading={!!usageLoading[key]}
          error={usageErrors[key] ?? ''}
          unavailable={status === 'Connected'
            ? ''
            : status === 'Offline'
              ? 'Computer offline. Usage is unavailable.'
              : status === 'Sign in or refresh'
                ? 'Sign in to read usage.'
                : status === 'Checking…'
                  ? 'Checking account availability…'
                  : status === 'Install the CLI'
                    ? 'Install the CLI to read usage.'
                    : 'Connect the account on its computer to read usage.'}
        />
      </div>
    {:else}<p class="connection-hint">No computers connected yet.</p>{/each}
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
          <span>Accounts and CLIs live with the computer that runs them.</span>
        </div>
        <span class="computer-count"
          >{computers.length} {computers.length === 1 ? 'computer' : 'computers'}</span
        >
      </div>
      <div class="fleet-computers">
        {#each computers as computer (computer.id)}
          {@const environments = computer.environments}
          {@const local = environments.some((environment) => localEnvironment(environment.id))}
          <article class="fleet-computer" aria-label={computer.name + ' computer'}>
            <header class="computer-heading">
              <span class="computer-icon"
                >{#if computer.wsl}<Server size={21} />{:else}<Monitor size={21} />{/if}</span
              >
              <div class="computer-identity">
                <h3>{computer.name}</h3>
                <span class="computer-state" class:ready={computerStatus(computer.id) !== 'Offline'}
                  >{computerStatus(computer.id)}</span
                >
              </div>
              {#if local}<div class="fleet-actions">
                  <button
                    class="secondary"
                    disabled={busy || !installation || !connectableProviders(computer.id).length}
                    onclick={() => openAccount('claude', computer.id)}
                    ><Plus size={14} />Add account</button
                  >{#if computer.id === ownComputer?.id}<button
                      class="icon-button"
                      aria-label={'Manage computer ' + computer.name}
                      title="Manage computer"
                      disabled={busy}
                      onclick={openComputer}><Settings2 size={17} /></button
                    >{/if}
                </div>{/if}
            </header>
            {#if computer.wsl}<p class="computer-hint">
                Linux CLI installations in this distribution are shown below. Managed through {computer.hostName}.
                Selecting this computer uses only its Linux CLI and login. Checking installations
                can start WSL.
              </p>{:else if local && installation?.platform === 'windows'}<p class="computer-hint">
                Selecting this computer uses its Windows CLIs, including when you choose a WSL
                folder.
              </p>{/if}
            {#if computer.id === ownComputer?.id && wslError}<p class="sync-error" role="alert">
                {wslError}
              </p>{/if}
            {#each environments.filter((e) => localEnvironment(e.id) && cliInventories[e.id]?.error) as environment}<p
                class="sync-error"
                role="alert"
              >
                {environment.name}: {cliInventories[environment.id]
                  .error}{#if cliInventories[environment.id].entries}
                  Showing the last successful installation check.{/if}
              </p>{/each}
            {#if environments.length}
              <div class="computer-providers" aria-label={'Accounts and CLIs on ' + computer.name}>
                {#each providerIds as id}
                  {@const accounts = computerAccounts(computer.id, id)}
                  {@const cliEnvironment = environments.find((e) => localEnvironment(e.id))}
                  {@const cliEntry =
                    cliEnvironment &&
                    cliInventories[cliEnvironment.id]?.entries?.find((entry) => entry.id === id)}
                  <article
                    class="connection-card provider-group"
                    aria-label={providers[id].name + ' connections'}
                  >
                    <div
                      class="provider-overview"
                      aria-label={cliEnvironment
                        ? providers[id].name + ' installation in ' + cliEnvironment.name
                        : undefined}
                    >
                      <header class="provider-heading">
                        <span class="provider-icon" style:--provider-color={providers[id].color}
                          >{providers[id].mark}</span
                        >
                        <div class="provider-identity">
                          <h4>{providers[id].name}</h4>
                          <span class="small muted"
                            >{accounts.length
                              ? accounts.length + (accounts.length === 1 ? ' account' : ' accounts')
                              : id === 'gemini'
                                ? 'Google · Antigravity CLI'
                                : providers[id].company}</span
                          >
                        </div>
                        {#if cliEnvironment}<strong
                            class="installation-status"
                            class:ready={!!cliEntry?.path &&
                              !cliInventories[cliEnvironment.id]?.error}
                            >{inventoryLabel(cliEnvironment.id, id)}</strong
                          >{/if}
                      </header>
                      {#if cliEntry?.path}<div class="cli-location">
                          <span>CLI path</span><code title={cliEntry.path}>{cliEntry.path}</code>
                        </div>{/if}
                    </div>
                    {#each accounts as account (account.id)}
                      {@render accountCard(account, computer.id)}
                    {:else}{#if local && computer.wsl}
                        <div class="current-login">
                          <p>
                            {id === 'gemini'
                              ? 'Antigravity chat connections are not supported through WSL.'
                              : cliInstalled(environments[0].id, id)
                                ? 'Connect an account using the Linux CLI in this distribution.'
                                : cliInventories[environments[0].id]?.error ||
                                    !cliInventories[environments[0].id]?.entries
                                  ? 'Refresh Connections to check whether this CLI is installed.'
                                  : 'Install this CLI in ' +
                                    computer.name +
                                    ', then refresh Connections.'}
                          </p>
                          {#if id !== 'gemini' && cliInstalled(environments[0].id, id)}<button
                              class="secondary"
                              disabled={busy || !desktop() || running}
                              onclick={() => openAccount(id, computer.id)}>Add account</button
                            >{/if}
                        </div>
                      {:else if local}
                        <div class="current-login">
                          {#if !providerStatus(id)}<p>Checking login…</p>
                          {:else if !providerStatus(id)?.installed}<p>
                              Install {providers[id].name} to connect an account.
                            </p>
                          {:else if providerStatus(id)?.auth !== 'ready'}<p>
                              {providerStatus(id)?.detail ?? 'Sign in to connect your account.'}
                            </p>{/if}
                          <div class="fleet-actions">
                            <button
                              class="text-button"
                              disabled={busy ||
                                !desktop() ||
                                !providerStatus(id)?.installed ||
                                running}
                              onclick={() => action(() => login(id))}>Open sign-in</button
                            >{#if providerStatus(id)?.auth === 'ready'}<button
                                class="secondary"
                                onclick={() => chat(id, undefined, computer.id)}
                                >Start chat<ArrowUpRight size={13} /></button
                              >{/if}
                          </div>
                        </div>
                      {:else}<p class="connection-hint remote-empty">
                          No account connected on this computer.
                        </p>{/if}{/each}
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
          ><i></i>{paired || reconnecting
            ? syncError
              ? 'Reconnecting'
              : 'Paired'
            : 'Local only'}</span
        >
      </div>
      <p>
        {paired
          ? syncStatus
          : 'Connect your computers and phone to your private workspace. Each person uses their own workspace key.'}
      </p>
      {#if syncError}<p class="sync-error" role="alert">{syncError}</p>{/if}
      {#if syncError.includes('changed on both devices')}<button
          class="secondary"
          disabled={busy}
          onclick={() => action(resolveConflict)}>Back up local data & use relay settings</button
        >{/if}
      {#if paired && !syncError}<details class="sync-settings">
          <summary>Sync settings</summary>
          <p>Keep Agent Studio open on each computer you want to use. WSL uses its Windows host.</p>
          <button class="text-button" disabled={busy} onclick={() => action(disconnect)}
            >{desktop() ? 'Disconnect relay' : 'Sign out'}</button
          >
        </details>{:else}<button
          class="secondary"
          disabled={busy}
          onclick={() => {
            error = '';
            dialog = 'relay';
          }}><Link size={14} />Set up sync</button
        >{/if}
      {#if syncError && (paired || reconnecting)}<button
          class="text-button"
          disabled={busy}
          onclick={() => action(disconnect)}>{desktop() ? 'Disconnect relay' : 'Sign out'}</button
        >{/if}
    </section>
  </div>
</div>

{#if dialog === 'account'}<ConnectionDialog title="Add account" {busy} close={closeDialog}>
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <form
      aria-busy={busy}
      onsubmit={(event) => {
        event.preventDefault();
        void action(add);
      }}
    >
      <p>
        Add an account on <strong
          >{computers.find((computer) => computer.id === accountComputerId)?.name ??
            'this computer'}</strong
        >.
      </p>
      <div class="fleet-fields">
        {#if !linkedAccountId}<div class="fleet-field">
            <span>Provider</span><ChoicePicker
              field
              label="Account provider"
              value={provider}
              disabled={busy || !!createdConnectionId}
              options={connectableProviders(accountComputerId).map((id) => ({
                id,
                name: providers[id].name,
                mark: providers[id].mark,
                color: providers[id].color,
              }))}
              onchange={(value) => (provider = value as ProviderId)}
            />
          </div>{/if}
        <label
          >Account name<input
            aria-label="Account name"
            bind:value={name}
            maxlength="60"
            required
            disabled={busy || !!createdConnectionId || !!linkedAccountId}
          /></label
        >
      </div>
      <p>Sign in with your additional account in the terminal that opens.</p>
      {#if creationStage}<p class="account-progress" role="status">
          <LoaderCircle size={15} class="spinning" />{creationStage}
        </p>{/if}
      <div class="dialog-actions">
        <button class="secondary" type="button" disabled={busy} onclick={closeDialog}>Cancel</button
        >
        <button
          class="primary"
          disabled={busy ||
            !installation ||
            !targetEnvironment ||
            !name.trim() ||
            !cliInstalled(targetEnvironment.id, selectedProvider)}
        >
          {#if busy}<LoaderCircle
              size={15}
              class="spinning"
            />{creationStage}{:else if createdConnectionId}Retry sign-in{:else}Add account<Plus
              size={15}
            />{/if}
        </button>
      </div>
    </form>
  </ConnectionDialog>
{:else if dialog === 'manage-account' && managedAccount}<ConnectionDialog
    title="Manage account"
    {busy}
    close={closeDialog}
  >
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void action(async () => {
          if (!managedAccount) return;
          const editedAccount = managedAccount;
          const previousName = editedAccount.name;
          const nextAccount = accountSchema.parse({ ...editedAccount, name: accountName });
          const editedConnections = managedConnections.map((connection) => ({
            connection,
            before: sharedContextChoice(connection),
            after: sharedSources[connection.id] ?? '',
            snapshot: { ...connection },
          }));
          const converting = managedConnections.filter(
            (connection) =>
              connection.profile === 'existing' && (sharedSources[connection.id] ?? '') === '',
          );
          for (const connection of converting) {
            if (!localEnvironment(connection.environmentId))
              throw new Error('Separate this login on its own computer.');
            if (!cliInstalled(connection.environmentId, managedAccount.provider))
              throw new Error('Install this CLI on the selected computer, then refresh Connections.');
            if (managedAccount.provider === 'gemini')
              throw new Error('Separate profiles are supported for Claude and Codex.');
          }
          for (const connection of workspace.fleet.connections) {
            if (sharedContextChoice(connection) !== (sharedSourcesBaseline[connection.id] ?? ''))
              throw new Error(
                'Shared context changed elsewhere. Reopen Manage account before saving.',
              );
          }
          for (const connection of managedConnections) {
            if (sharedContextChoice(connection) !== sharedSourcesBaseline[connection.id])
              throw new Error(
                'This account’s shared context changed elsewhere. Reopen Manage account before saving.',
              );
            const source = sharedSources[connection.id] ?? '';
            if (running && source !== sharedContextChoice(connection))
              throw new Error('Wait for the running reply before changing shared context.');
            if (source && !sharedOptions(connection).some((option) => option.id === source))
              throw new Error(
                'The shared context source changed. Reopen Manage account and choose it again.',
              );
          }
          Object.assign(editedAccount, nextAccount);
          for (const connection of managedConnections)
            applySharedContextChoice(connection, sharedSources[connection.id] ?? '');
          try {
            await save();
          } catch (error) {
            if (editedAccount.name === nextAccount.name) editedAccount.name = previousName;
            for (const { connection, after, snapshot } of editedConnections) {
              if (sharedContextChoice(connection) !== after) continue;
              for (const key of Object.keys(connection) as (keyof Connection)[])
                if (!(key in snapshot)) delete connection[key];
              Object.assign(connection, snapshot);
            }
            throw error;
          }
          contextCache.clear();
          for (const connection of converting) {
            statuses[connection.id] = {
              id: managedAccount.provider,
              installed: true,
              auth: 'login',
              version: null,
              detail: 'Sign in to connect this account.',
            };
          }
          const opened = converting[0];
          closeDialog();
          if (opened) await login(managedAccount.provider, opened.id);
        });
      }}
    >
      <p class="management-context">
        {providers[managedAccount.provider].name}{#if managedComputerId}
          · {computers.find((c) => c.id === managedComputerId)?.name ?? 'Unavailable computer'}{/if}
      </p>
      <label
        >Account name<input
          aria-label="Edit account name"
          bind:value={accountName}
          required
          maxlength="60"
        /></label
      >
      {#each managedConnections as connection}
        <section
          class="managed-connection"
          aria-label={'Connection in ' + locationName(connection.environmentId)}
        >
          <div>
            <h3>
              {connection.profile === 'isolated' ? 'Separate CLI profile' : 'Existing CLI login'}
            </h3>
            <p>
              {connection.profile === 'isolated'
                ? 'This account has its own login and settings. By default it uses this computer’s CLI context.'
                : 'Shares the login and settings you use in your terminal.'}
            </p>
          </div>
          {#if managedAccount.provider !== 'gemini'}
            <div class="shared-context-control">
              <span>Shared context source</span>
              <ChoicePicker
                field
                label="Shared context source"
                options={sharedOptions(connection)}
                value={sharedSources[connection.id] ?? ''}
                fallbackToFirst={false}
                placeholder="Source unavailable"
                disabled={busy || running}
                onchange={(value) => (sharedSources[connection.id] = value)}
              />
              <p>
                {#if connection.profile === 'existing' && (sharedSources[connection.id] ?? '') === ''}
                  Saving creates a separate profile for this account on this computer and opens its
                  sign-in. Existing chats continue from the terminal’s history, and the terminal
                  keeps its own login and files.
                {:else}
                  This computer’s CLI context is the terminal’s instructions, rules, skills, project
                  memories, and MCP server definitions. Choose another account to use its context
                  instead, or This account only to keep this profile separate. Logins and MCP
                  sign-ins always stay with the account. Applies to the next reply.
                {/if}
              </p>
            </div>
          {/if}
          {#if localEnvironment(connection.environmentId)}
            {#if removing === connection.id}<div
                class="remove-connection"
                role="group"
                aria-label="Confirm disconnection"
              >
                <p>Remove this connection? Saved chats and the CLI’s login files are kept.</p>
                <div class="fleet-actions">
                  <button
                    class="secondary"
                    type="button"
                    disabled={busy}
                    onclick={() =>
                      action(async () => {
                        workspace.fleet.connections = workspace.fleet.connections.filter(
                          (c) => c.id !== connection.id,
                        );
                        delete statuses[connection.id];
                        await save();
                        closeDialog();
                      })}>Remove connection</button
                  >
                  <button
                    class="text-button"
                    type="button"
                    disabled={busy}
                    onclick={() => (removing = '')}>Keep connection</button
                  >
                </div>
              </div>
            {:else}<button
                class="text-button disconnect-connection"
                type="button"
                disabled={busy}
                onclick={() => (removing = connection.id)}
                >{managedConnections.length > 1
                  ? 'Disconnect ' + locationName(connection.environmentId)
                  : 'Disconnect account'}</button
              >{/if}
          {:else}<p>Manage this connection on its computer.</p>{/if}
        </section>
      {/each}
      {#if canConnectManagedAccountHere}<div class="managed-connect">
          <button
            class="text-button"
            type="button"
            disabled={busy ||
              !installation ||
              !cliInstalled(installation.id, managedAccount.provider)}
            onclick={() => {
              if (managedAccount)
                openAccount(managedAccount.provider, ownComputer?.id, managedAccount.id);
            }}>Connect on {ownComputer?.name ?? 'this computer'}</button
          >
        </div>{/if}
      {#if !workspace.fleet.connections.some((c) => c.accountId === managedAccountId)}<button
          class="text-button disconnect-connection"
          type="button"
          disabled={busy}
          onclick={() =>
            action(async () => {
              workspace.fleet.accounts = workspace.fleet.accounts.filter(
                (a) => a.id !== managedAccountId,
              );
              await save();
              closeDialog();
            })}>Remove account label</button
        >{/if}
      <div class="dialog-actions">
        <button class="secondary" type="button" disabled={busy} onclick={closeDialog}>Cancel</button
        >
        <button class="primary" disabled={busy || !accountName.trim() || !!removing}
          >Save account</button
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
        Settings for {ownComputer.name}. Its WSL distributions appear as separate computers and
        remain managed by this Windows app.
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
        {desktop()
          ? 'Enter your relay address and private workspace key. Use the same key only on your own computers and phone. Each person sharing the VPS needs a separate workspace key.'
          : 'Enter your private workspace key from the server owner. Each person has separate chats, computers, and agent connections. Keep Agent Studio open on your connected computers.'}
      </p>
      <label
        >Relay URL<input
          aria-label="Relay URL"
          type="url"
          bind:value={url}
          readonly={!desktop()}
          required
        /></label
      ><label
        >Private workspace key<input
          aria-label="Relay pairing key"
          type="password"
          bind:value={key}
          minlength="32"
          autocomplete="off"
          required
        /></label
      >
      <p>
        Pairing shares chat content and account labels with devices in this private workspace.
        Provider credentials stay on each host. {desktop()
          ? installation?.platform === 'windows'
            ? 'Windows protects the saved pairing and reconnects when you open the app. Disconnect relay removes it from this computer.'
            : 'The pairing key stays in memory until the app closes.'
          : 'This device stays paired across app updates and server restarts. Pairing renews while you use it and expires after seven days without renewal, or when you disconnect or change the workspace key. The key is not saved in your browser. Disconnecting clears chats from the screen; another workspace starts with its own data.'}
      </p>
      <div class="dialog-actions">
        <button class="secondary" type="button" disabled={busy} onclick={closeDialog}>Cancel</button
        ><button class="primary" disabled={busy}>Pair & sync<Link size={15} /></button>
      </div>
    </form>
  </ConnectionDialog>{/if}

<style>
  .cli-location {
    display: flex;
    align-items: baseline;
    gap: 9px;
    padding: 0 16px 16px;
    font-size: 11px;
    color: var(--muted);
  }
  .cli-location span {
    flex-shrink: 0;
  }
  .cli-location code {
    min-width: 0;
    font-size: 10px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .provider-identity {
    flex: 1;
    min-width: 0;
  }
  .installation-status {
    flex-shrink: 0;
    max-width: 104px;
    text-align: right;
    font-size: 11px;
    line-height: 1.4;
    font-weight: 500;
    color: var(--muted);
  }
  .managed-connection {
    border-top: 1px solid var(--line);
    padding-top: 18px;
  }
  .shared-context-control {
    display: grid;
    gap: 7px;
    margin-top: 12px;
  }
  .shared-context-control > span {
    font-size: 12px;
    font-weight: 600;
  }
  .managed-connection h3 {
    font-size: 13px;
    font-weight: 500;
    margin: 0 0 7px;
  }
  .managed-connect {
    border-top: 1px solid var(--line);
    padding-top: 16px;
  }
  .remove-connection .fleet-actions {
    margin-top: 12px;
  }
  .management-context {
    margin-top: -8px;
  }
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
    grid-template-columns: minmax(0, 1fr);
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
  .current-login p {
    font-size: 11px;
    color: var(--muted);
    margin: 6px 0 14px;
    line-height: 1.6;
  }
  .current-login .fleet-actions {
    justify-content: flex-end;
  }
  summary::-webkit-details-marker {
    display: none;
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
    margin: 0;
    font-size: 14px;
    font-weight: 500;
  }
  .fleet-account-heading small {
    font-size: 10px;
    color: var(--muted);
  }
  .fleet-account-heading > .manage-account {
    flex-shrink: 0;
  }
  .account-connection {
    display: grid;
    grid-template-columns: minmax(160px, 0.7fr) minmax(0, 2fr);
    align-items: start;
    gap: 24px;
    margin-top: 14px;
  }
  .connection-controls {
    min-width: 0;
  }
  .connection-controls > .connection-hint:first-child {
    margin-top: 0;
  }
  @media (max-width: 1000px) {
    .account-connection {
      grid-template-columns: minmax(0, 1fr);
      gap: 16px;
    }
  }
  .connection-hint {
    font-size: 11px;
    color: var(--muted);
    line-height: 1.7;
  }
  .remote-empty {
    padding: 0 16px 10px;
  }
  .fleet-fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
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
    color: #d99f95;
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
  .account-progress {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  :global(.spinning) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.spinning) {
      animation: none;
    }
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
    .fleet-fields {
      grid-template-columns: 1fr;
    }
  }
</style>
