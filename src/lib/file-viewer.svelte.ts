/**
 * The files a chat's replies show, connected so the viewer steps from one to the next.
 *
 * Each image and model registers the element that places it in the chat, and the viewer
 * orders them as the page does: reply by reply, and within a reply where each group's marker
 * stands. The chat renders every message, so its order is the conversation's.
 */
import { getContext, setContext, type Snippet } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { ToolOutputImageInfo } from './tool-output';

type Described = {
  /** The file's name, as the reply gave it. */
  name: string;
  /** Its dimensions and size, or its format and size, as the chat shows them. */
  label: string;
  /** The caption of the group it came in. */
  caption?: string;
};
export type ViewedImage = Described & {
  kind: 'image';
  runId: string;
  toolId: string;
  connectionId?: string;
  info: ToolOutputImageInfo;
  alt: string;
};
export type ViewedModel = Described & {
  kind: 'model';
  /** The model at full size, drawn by its inline view, which keeps its animation and turn. */
  view: Snippet;
  /** Tells the inline view the viewer shows its model, so it gives up its scene meanwhile. */
  shown(showing: boolean): void;
};
/** Files compared side by side, which the viewer shows together as one of the chat's files. */
export type ViewedComparison = Described & {
  kind: 'comparison';
  /** Every pane at full size, drawn by the comparison in the chat. */
  view: Snippet;
  /** Tells the comparison the viewer shows it, so its models give up their scenes meanwhile. */
  shown(showing: boolean): void;
};
/** A table, a document or a video, which its card in the chat draws at full size too. */
export type ViewedPage = Described & {
  kind: 'table' | 'document' | 'video';
  /** The file at full size, drawn by its card, which keeps what it already read. */
  view: Snippet;
  /** Tells the card the viewer shows its file, so a video in the chat pauses meanwhile. */
  shown(showing: boolean): void;
};
export type ViewedFile = ViewedImage | ViewedModel | ViewedComparison | ViewedPage;

export class FileViewer {
  readonly #files = new SvelteMap<Element, () => ViewedFile>();
  /** Where the shown file stands in the chat, while the viewer is open. */
  current = $state<Element>();

  /**
   * An attachment registering the file `describe` returns where its element stands; the element
   * leaving the page removes it. The description is read when needed, so a file whose details
   * change, as a table's do as its rows arrive, stays registered as it was: registering it again
   * would leave the open viewer without its file for a moment, which closed and reopened it.
   */
  attach(describe: () => ViewedFile) {
    return (element: Element) => {
      this.#files.set(element, describe);
      return () => {
        if (this.#files.get(element) === describe) this.#files.delete(element);
      };
    };
  }
  file(element: Element | undefined): ViewedFile | undefined {
    return element ? this.#files.get(element)?.() : undefined;
  }
  /** The files in the order the chat shows them. */
  ordered(): Element[] {
    return [...this.#files.keys()]
      .filter((element) => element.isConnected)
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }
  /** Opens the file whose element holds `from`, such as the button that was clicked. */
  open(from: Element) {
    for (let element: Element | null = from; element; element = element.parentElement)
      if (this.#files.has(element)) {
        this.current = element;
        return;
      }
  }
  step(by: number) {
    const order = this.ordered();
    const index = this.current ? order.indexOf(this.current) : -1;
    if (index >= 0 && order[index + by]) this.current = order[index + by];
  }
  close() {
    this.current = undefined;
  }
}

const key = Symbol('file-viewer');
/** Connects the files shown below this component; the viewer itself is rendered beside them. */
export function provideFileViewer(viewer = new FileViewer()) {
  return setContext(key, viewer);
}
export function fileViewer(): FileViewer | undefined {
  return getContext(key);
}
