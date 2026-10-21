/**
 * Tables, documents and videos a reply shows (send_files), read from the computer that keeps them
 * while their card lives: a table a page of rows at a time, as its views reach them, a document's
 * beginning for its card and its whole text for the viewer, and a video as it plays. The card in
 * the chat and the file viewer share one reading.
 */
import { SvelteMap } from 'svelte/reactivity';
import { formatBytes, otherFormats, type DocumentText, type TablePage } from './tool-output';
import {
  modelFromAnotherComputer,
  readToolOutputDocument,
  readToolOutputTable,
  toolOutputVideo,
} from './transport';
import type { SentFile } from './sent-files';

/** A kept file of a call: its run, its call, its place among the call's other files. */
export type KeptSource = {
  runId: string;
  toolId: string;
  index: number;
  connectionId?: string;
};
const failure = (cause: unknown) => String(cause instanceof Error ? cause.message : cause);

/** The name a card gives a file's format, such as CSV or MP4. */
export const formatName = (file: SentFile) =>
  otherFormats[file.mediaType as keyof typeof otherFormats] ?? file.mediaType;

/** Rows a page of a table holds, which one read brings. */
export const TABLE_PAGE = 200;

/** One kept table, read a page at a time. */
export class KeptTable {
  readonly #source: () => KeptSource;
  /** Every sheet's name and size, known once the first page arrives. */
  sheets = $state<TablePage['sheets']>([]);
  /** The sheet the views show. */
  sheet = $state(0);
  /** The longest cell of each column, by sheet, as the computer keeping the table found them. */
  lengths = $state<Record<number, number[]>>({});
  error = $state('');
  readonly #pages = new SvelteMap<string, string[][]>();
  readonly #asked = new Set<string>();

  constructor(source: () => KeptSource) {
    this.#source = source;
  }
  /** The shown sheet's size, once known. */
  get shown(): TablePage['sheets'][number] | undefined {
    return this.sheets[this.sheet];
  }
  /** A row of the shown sheet, counted from its first; asks for its page when it has not come. */
  row(index: number): string[] | undefined {
    const page = Math.floor(index / TABLE_PAGE);
    return this.#pages.get(`${this.sheet}:${page}`)?.[index - page * TABLE_PAGE];
  }
  /** Asks for the pages that hold rows `from` to `to` of the shown sheet, each once. */
  need(from: number, to: number) {
    const sheet = this.sheet;
    for (let page = Math.floor(from / TABLE_PAGE); page <= Math.floor(to / TABLE_PAGE); page++) {
      const key = `${sheet}:${page}`;
      if (this.#asked.has(key)) continue;
      this.#asked.add(key);
      readToolOutputTable(this.#source(), sheet, page * TABLE_PAGE, TABLE_PAGE).then(
        (read) => {
          this.sheets = read.sheets;
          if (read.lengths && !this.lengths[sheet]) this.lengths[sheet] = read.lengths;
          this.#pages.set(key, read.rows);
          this.error = '';
        },
        (cause) => {
          // A failed page is asked again on Retry.
          this.#asked.delete(key);
          this.error = failure(cause);
        },
      );
    }
  }
  /** Whether the pages holding rows `from` to `to` have come. */
  has(from: number, to: number) {
    for (let page = Math.floor(from / TABLE_PAGE); page <= Math.floor(to / TABLE_PAGE); page++)
      if (!this.#pages.has(`${this.sheet}:${page}`)) return false;
    return true;
  }
  select(sheet: number) {
    this.sheet = sheet;
  }
  retry() {
    this.error = '';
    this.need(0, 0);
  }
  /** What a card and the viewer say of the table: its sheets, or its rows and columns. */
  detail(file: SentFile): string {
    const size = this.sheets.length > 1 ? `${this.sheets.length} sheets` : this.shownSize();
    return [formatName(file), size, formatBytes(file.bytes)].filter(Boolean).join(' · ');
  }
  shownSize(): string {
    const shown = this.shown;
    if (!shown) return '';
    const count = (n: number, noun: string) =>
      `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;
    return `${count(shown.rows, 'row')} × ${count(shown.columns, 'column')}`;
  }
}

/** One kept document: its beginning for a card, its whole text for the viewer. */
export class KeptDocument {
  readonly #source: () => KeptSource;
  head = $state<DocumentText>();
  whole = $state<DocumentText>();
  error = $state('');
  #reading: Partial<Record<'head' | 'whole', boolean>> = {};

  constructor(source: () => KeptSource) {
    this.#source = source;
  }
  /** The text there is: the whole once read, else the beginning. */
  get text(): DocumentText | undefined {
    return this.whole ?? this.head;
  }
  /** Reads the beginning a card shows, or the whole document when `whole`. */
  read(whole = false) {
    const part = whole ? 'whole' : 'head';
    if (this[part] || this.#reading[part] || (!whole && this.whole)) return;
    this.#reading[part] = true;
    readToolOutputDocument(this.#source(), whole ? undefined : DOCUMENT_HEAD).then(
      (read) => {
        this.#reading[part] = false;
        this.error = '';
        // A document that fit in its beginning was read whole.
        if (read.complete) this.whole = read;
        else this[part] = read;
      },
      (cause) => {
        this.#reading[part] = false;
        this.error = failure(cause);
      },
    );
  }
  retry(whole = false) {
    this.error = '';
    this.read(whole);
  }
}
/** The beginning of a document its card shows: a few screens of text. */
export const DOCUMENT_HEAD = 16 * 1024;

/**
 * One kept video, where the window plays it from: streamed by this computer, or read whole from
 * another one, only once the reader asks to play it there, since it may be large.
 */
export class KeptVideo {
  readonly #source: () => KeptSource;
  url = $state<string>();
  error = $state('');
  loading = $state(false);
  #release?: () => void;
  /** Whether the video comes from another computer, read whole before it plays. */
  readonly remote: boolean;

  constructor(source: () => KeptSource) {
    this.#source = source;
    this.remote = modelFromAnotherComputer(source().connectionId);
  }
  load(): Promise<string | undefined> {
    if (this.url) return Promise.resolve(this.url);
    if (this.loading) return Promise.resolve(undefined);
    this.loading = true;
    this.error = '';
    return toolOutputVideo(this.#source()).then(
      ({ url, release }) => {
        this.loading = false;
        this.#release = release;
        this.url = url;
        return url;
      },
      (cause) => {
        this.loading = false;
        this.error = failure(cause);
        return undefined;
      },
    );
  }
  dispose() {
    this.#release?.();
    this.#release = undefined;
  }
}
