<script lang="ts">
  import type { PaneLink } from '$lib/comparison';
  import { paneLabel, type SentFile } from '$lib/sent-files';
  import { modelViewCount } from '$lib/tool-output';
  import { ModelPane, type ModelPlace } from '$lib/model-pane.svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import ComparePane from './ComparePane.svelte';
  import ModelStage from './ModelStage.svelte';

  let {
    link,
    paneKey,
    runId,
    toolId,
    connectionId,
    file,
  }: {
    /** The comparison this model is a pane of. */
    link: PaneLink;
    paneKey: string;
    runId: string;
    toolId: string;
    connectionId?: string;
    file: SentFile;
  } = $props();

  // One model in both places, as a reply's model is: the chat and the file viewer share its
  // bytes, its animation and the views another computer drew.
  const pane = new ModelPane(() => ({ runId, toolId, connectionId, file }), {
    moved: (place, view) => link.moved(paneKey, place, { kind: 'model', view }),
    // The drawn views are one turn for both places.
    turned: (turn) => link.moved(paneKey, 'inline', { kind: 'turn', turn }),
  });
  const label = $derived(paneLabel(file));
  const detail = $derived(pane.viewsOnly ? `${pane.label} · ${modelViewCount} views` : pane.label);
  const title = $derived(`${file.name} · ${detail}`);

  $effect(() =>
    link.join(paneKey, {
      expanded,
      shown: pane.shown,
      view(place) {
        if (pane.viewsOnly) return { kind: 'turn', turn: pane.turn };
        const view = pane.view(place);
        return view && { kind: 'model', view };
      },
      follow(place, view) {
        if (view.kind === 'turn' && pane.viewsOnly) pane.follow(view.turn);
        else if (view.kind === 'model' && !pane.viewsOnly) pane.setView(place, view.view);
      },
      // A camera closer by a factor shows the model that much larger.
      zoom: (place, factor) => pane.zoom(place, 1 / factor),
      reset: (place) => (pane.viewsOnly ? pane.home() : pane.reset(place)),
      get animated() {
        return pane.clips.length > 0;
      },
      get playing() {
        return pane.playing;
      },
      setPlaying: (playing) => pane.setPlaying(playing),
    }),
  );
</script>

{#snippet clips()}
  {#if pane.clips.length > 1}
    <ChoicePicker
      options={pane.clips.map((name, index) => ({ id: String(index), name }))}
      value={String(pane.clip)}
      label={`Animation of ${label}`}
      onchange={(value) => pane.play(Number(value))}
    />
  {/if}
{/snippet}

{#snippet model(place: ModelPlace)}
  <ComparePane {place} {label} {detail} {title} extra={clips}>
    {#snippet stage()}<ModelStage {pane} {place} compared />{/snippet}
  </ComparePane>
{/snippet}

<!-- The file viewer draws this pane at full size, beside the comparison's others. -->
{#snippet expanded()}
  {@render model('expanded')}
{/snippet}

{@render model('inline')}
