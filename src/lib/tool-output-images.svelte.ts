import { untrack } from 'svelte';
import { createFetchCache, imageSize, type ToolOutputImage } from './tool-output';
import { readToolOutputImage } from './transport';

// Images a window already loaded, bounded so a long run of screenshots cannot pile up. The
// chat's thumbnails and the file viewer share them, so opening an image reads nothing again.
const images = createFetchCache<ToolOutputImage>(imageSize, { entries: 64, bytes: 96_000_000 });

/** An image a call kept on the computer that ran it. */
export type KeptImageSource = {
  runId: string;
  toolId: string;
  index: number;
  connectionId?: string;
};
const imageKey = ({ runId, toolId, index }: KeptImageSource) => `${runId}\n${toolId}\n${index}`;

export function readKeptImage(source: KeptImageSource): Promise<ToolOutputImage> {
  return images.get(imageKey(source), () =>
    readToolOutputImage(source.runId, source.toolId, source.index, source.connectionId),
  );
}

/** One kept image, read while the component that creates it lives. */
export class KeptImage {
  image = $state<ToolOutputImage>();
  error = $state('');
  #attempt = $state(0);

  constructor(source: () => KeptImageSource) {
    // An image this window already read shows at once, as the file viewer opens it from the
    // chat's thumbnail, rather than a moment later.
    this.image = images.peek(imageKey(source()));
    // Only the image's identity selects it; relay updates of the call do not reload it.
    const key = $derived.by(() => imageKey(source()));
    $effect(() => {
      void key;
      void this.#attempt;
      let live = true;
      this.error = '';
      untrack(() => readKeptImage(source())).then(
        (value) => {
          if (live) this.image = value;
        },
        (reason) => {
          if (live) this.error = String(reason instanceof Error ? reason.message : reason);
        },
      );
      return () => {
        live = false;
      };
    });
  }

  retry() {
    this.#attempt++;
  }
}
