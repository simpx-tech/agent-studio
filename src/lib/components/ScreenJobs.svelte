<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { LoaderCircle, Square, Trash2 } from '@lucide/svelte';
  import { clock } from '$lib/clock';
  import { forgetScreenJob, screenJobOutput, screenJobs, stopScreenJob } from '$lib/transport';
  import { jobDuration, terminalText, type ScreenDetail, type ScreenJob } from '$lib/screens';
  import ConnectionDialog from './ConnectionDialog.svelte';
  let {
    environmentId,
    screen,
    online,
    noted,
    close,
  }: {
    environmentId: string;
    screen: ScreenDetail;
    online: boolean;
    /** The jobs as the screen's computer listed them last. */
    noted: (jobs: ScreenJob[]) => void;
    close: () => void;
  } = $props();
  let jobs = $state<ScreenJob[]>([]);
  let listed = $state(false);
  let listError = $state('');
  let selected = $state<string>();
  // What the selected job printed, each stream's text in the order it arrived.
  let chunks = $state<{ stream: 'stdout' | 'stderr'; text: string }[]>([]);
  let outputError = $state('');
  let busy = $state(false);
  let output = $state<HTMLElement>();
  let closed = false;
  // The output being followed; a newer selection ends the one before.
  let following = 0;
  const shown = $derived(jobs.find((job) => job.id === selected));
  const message = (e: unknown) =>
    (e instanceof Error ? e.message : String(e)).replace(/^Error: /, '');
  const states: Record<ScreenJob['state'], string> = {
    running: 'Running',
    done: 'Done',
    stopped: 'Stopped',
    interrupted: 'Interrupted',
    failed: 'Failed',
  };
  function outcome(job: ScreenJob) {
    if (job.state === 'done')
      return job.timedOut
        ? 'Timed out'
        : job.exitCode === 0
          ? 'Done'
          : `Exit ${job.exitCode ?? '?'}`;
    return states[job.state];
  }
  function params(job: ScreenJob) {
    return Object.entries(job.params ?? {})
      .map(
        ([name, value]) => `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
      )
      .join(' ');
  }

  async function list() {
    try {
      const next = await screenJobs(environmentId, screen.id);
      if (closed) return;
      jobs = next;
      listed = true;
      listError = '';
      noted(next);
      if (!selected && next.length) select(next[0].id);
    } catch (e) {
      listError = message(e);
    }
  }
  onMount(() => {
    void list();
    const timer = setInterval(() => {
      if (online) void list();
    }, 2000);
    return () => {
      closed = true;
      following++;
      clearInterval(timer);
    };
  });

  /** Reads a job's output from its start, then follows it while it runs. */
  async function select(id: string) {
    selected = id;
    chunks = [];
    outputError = '';
    const mine = ++following;
    let after = 0;
    for (;;) {
      const running = jobs.find((job) => job.id === id)?.state === 'running';
      let answer;
      try {
        answer = await screenJobOutput(environmentId, screen.id, id, after, {
          wait: running && after > 0,
          peek: true,
        });
      } catch (e) {
        if (mine === following) outputError = message(e);
        return;
      }
      if (mine !== following || closed) return;
      const atEnd = !output || output.scrollHeight - output.scrollTop - output.clientHeight < 24;
      for (const chunk of answer.chunks) {
        const text = terminalText(chunk.text);
        const last = chunks.at(-1);
        if (last && last.stream === chunk.stream) last.text += text;
        else chunks.push({ stream: chunk.stream, text });
      }
      after = answer.next;
      const index = jobs.findIndex((job) => job.id === id);
      if (index >= 0) jobs[index] = answer.job;
      if (atEnd) void tick().then(() => output?.scrollTo({ top: output.scrollHeight }));
      if (answer.job.state !== 'running') return;
    }
  }
  async function stop(job: ScreenJob) {
    busy = true;
    try {
      const stopped = await stopScreenJob(environmentId, screen.id, job.id);
      const index = jobs.findIndex((known) => known.id === job.id);
      if (index >= 0) jobs[index] = stopped;
    } catch (e) {
      listError = message(e);
    } finally {
      busy = false;
    }
  }
  async function forget(job: ScreenJob) {
    busy = true;
    try {
      await forgetScreenJob(environmentId, screen.id, job.id);
      jobs = jobs.filter((known) => known.id !== job.id);
      noted(jobs);
      if (selected === job.id) {
        following++;
        selected = undefined;
        chunks = [];
        if (jobs.length) void select(jobs[0].id);
      }
    } catch (e) {
      listError = message(e);
    } finally {
      busy = false;
    }
  }
</script>

<ConnectionDialog title="Jobs" wide {close}>
  <div class="screen-jobs">
    {#if listError}<div class="error-banner" role="alert">{listError}</div>{/if}
    {#if listed && !jobs.length}<p class="jobs-empty">No jobs</p>{:else if !listed && !listError}<p
        class="jobs-empty"
        role="status"
      >
        Loading…
      </p>{:else}
      <div class="jobs-layout">
        <ul class="jobs-list" aria-label="Jobs of this screen">
          {#each jobs as job (job.id)}
            <li>
              <button
                class="job-row"
                class:selected={job.id === selected}
                aria-current={job.id === selected ? 'true' : undefined}
                onclick={() => void select(job.id)}
              >
                <span class="job-label">{job.label}</span>
                {#if params(job)}<span class="job-params" title={params(job)}>{params(job)}</span
                  >{/if}
                <span
                  class="job-state"
                  class:running={job.state === 'running'}
                  class:failed={job.state === 'failed' ||
                    (job.state === 'done' && (job.exitCode !== 0 || job.timedOut))}
                  >{#if job.state === 'running'}<LoaderCircle
                      size={12}
                      class="spinning"
                      aria-hidden="true"
                    />{/if}{outcome(job)} · {jobDuration(job, clock.now)}{#if job.where}
                    · {job.where}{/if}</span
                >
              </button>
            </li>
          {/each}
        </ul>
        <section class="job-output" aria-label="Output">
          {#if shown}
            <div class="job-output-tools">
              <span class="job-started" title={shown.startedAt}
                >{new Date(shown.startedAt).toLocaleString()}</span
              >
              {#if shown.state === 'running'}<button
                  class="secondary"
                  disabled={busy || !online}
                  onclick={() => shown && void stop(shown)}><Square size={13} />Stop</button
                >{:else}<button
                  class="secondary"
                  disabled={busy || !online}
                  onclick={() => shown && void forget(shown)}><Trash2 size={13} />Remove</button
                >{/if}
            </div>
            {#if shown.error}<div class="error-banner" role="alert">{shown.error}</div>{/if}
            {#if outputError}<div class="error-banner" role="alert">{outputError}</div>{/if}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (The output scrolls, so keys reach it.) -->
            <pre
              bind:this={output}
              class="job-text"
              tabindex="0"
              aria-label="Job output">{#each chunks as chunk, index (index)}<span
                  class:stderr={chunk.stream === 'stderr'}>{chunk.text}</span
                >{/each}</pre>
          {/if}
        </section>
      </div>
    {/if}
  </div>
</ConnectionDialog>

<style>
  .screen-jobs {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1;
    min-height: 0;
  }
  .jobs-empty {
    margin: 0;
  }
  .jobs-layout {
    display: grid;
    grid-template-columns: minmax(200px, 280px) minmax(0, 1fr);
    gap: 14px;
    flex: 1;
    min-height: 0;
  }
  .jobs-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .job-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    padding: 8px 10px;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-lg);
    color: var(--text);
    cursor: pointer;
  }
  .job-row:hover {
    background: var(--hover);
  }
  .job-row.selected {
    background: var(--selected);
    border-color: var(--border);
  }
  .job-label {
    font-weight: 500;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .job-params {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .job-state {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .job-state.running {
    color: var(--accent-strong);
  }
  .job-state.failed {
    color: var(--danger);
  }
  .job-output {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    min-height: 0;
  }
  .job-output-tools {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .job-output-tools button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .job-started {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .job-text {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 10px 12px;
    overflow: auto;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .job-text .stderr {
    color: var(--warning);
  }
  @media (max-width: 700px) {
    .jobs-layout {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(120px, 30%) minmax(0, 1fr);
    }
  }
</style>
