<script lang="ts">
  import { ChevronRight, Info } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { codeSpans, loadChangelog, type ChangelogRelease } from '$lib/changelog';
  import { appVersion, desktop } from '$lib/transport';

  // Older releases wait behind Show all releases.
  const initialReleases = 5;
  const product = desktop() ? 'Agent Studio' : 'Agent Studio Viewer';
  let version = $state<string>();
  let releases = $state<ChangelogRelease[]>();
  let failed = $state(false);
  let showAll = $state(false);
  // The running version starts open, or the newest release when this build is not listed.
  const expanded = $derived(
    releases?.some((release) => release.version === version) ? version : releases?.[0]?.version,
  );
  const shown = $derived(showAll ? releases : releases?.slice(0, initialReleases));
  const formatDate = (date: string) =>
    new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

  onMount(() => {
    void appVersion().then((value) => (version = value));
    loadChangelog()
      .then((value) => (releases = value))
      .catch(() => (failed = true));
  });
</script>

<section aria-labelledby="about-heading">
  <h2 id="about-heading"><Info size={18} aria-hidden="true" />About</h2>
  {#if version}<p class="version">{product} {version}</p>{/if}
  <h3 id="changelog-heading">Changelog</h3>
  {#if failed}
    <p role="alert">The changelog could not be loaded.</p>
  {:else if !releases || !shown || !version}
    <p>Loading the changelog…</p>
  {:else}
    <ol id="changelog-releases" class="releases" aria-labelledby="changelog-heading">
      {#each shown as release (release.version)}
        <li>
          <details open={release.version === expanded}>
            <summary>
              <ChevronRight size={13} class="disclosure" aria-hidden="true" />
              <span class="release-version">{release.version}</span>
              <time datetime={release.date}>{formatDate(release.date)}</time>
              {#if release.version === version}<span class="current">Current</span>{/if}
            </summary>
            <div class="release-body">
              {#if release.summary}<p>{release.summary}</p>{/if}
              {#each release.groups as group (group.title)}
                <h4>{group.title}</h4>
                <ul>
                  {#each group.items as change, index (index)}
                    <li>
                      {#each codeSpans(change) as span, part (part)}{#if span.code}<code
                            >{span.text}</code
                          >{:else}{span.text}{/if}{/each}
                    </li>
                  {/each}
                </ul>
              {/each}
            </div>
          </details>
        </li>
      {/each}
    </ol>
    {#if releases.length > initialReleases}
      <button
        class="show-releases"
        aria-expanded={showAll}
        aria-controls="changelog-releases"
        onclick={() => (showAll = !showAll)}
        >{showAll ? 'Show fewer releases' : `Show all ${releases.length} releases`}</button
      >
    {/if}
  {/if}
</section>

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .version {
    color: var(--text);
    font-weight: 500;
  }
  h3 {
    margin: 16px 0 8px;
    color: var(--text);
    font-size: var(--text-base);
    font-weight: 600;
  }
  .releases {
    max-width: 640px;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .releases > li + li {
    border-top: 1px solid var(--border);
  }
  summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    padding: 7px 10px;
    border-radius: 0;
    cursor: pointer;
    list-style: none;
    transition: background-color var(--duration-fast) ease;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    background: var(--hover);
  }
  /* The list clips its corners, so keep the focus ring inside the row. */
  summary:focus-visible {
    outline-offset: -2px;
  }
  summary :global(.disclosure) {
    flex: none;
    color: var(--text-faint);
    transition: transform var(--duration-fast) var(--ease-out);
  }
  details[open] > summary :global(.disclosure) {
    transform: rotate(90deg);
  }
  .release-version {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-base);
    font-weight: 500;
  }
  time {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .current {
    padding: 0 7px;
    border-radius: var(--radius-full);
    background: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--text-2xs);
    font-weight: 600;
    line-height: 18px;
  }
  .release-body {
    padding: 0 14px 12px 31px;
  }
  .release-body p {
    margin: 2px 0 8px;
  }
  h4 {
    margin: 8px 0 4px;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 600;
  }
  ul {
    margin: 0;
    padding-left: 18px;
    list-style: disc;
    color: var(--text-secondary);
    font-size: var(--text-base);
    line-height: var(--leading-normal);
  }
  code {
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    background: var(--code-inline-bg);
    color: var(--text);
    font-size: 0.9em;
  }
  .show-releases {
    margin-top: 10px;
    padding: 5px 10px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .show-releases:not(:disabled):hover {
    border-color: var(--border-hover);
  }
  @media (max-width: 650px) {
    .release-body {
      padding-left: 14px;
    }
  }
</style>
