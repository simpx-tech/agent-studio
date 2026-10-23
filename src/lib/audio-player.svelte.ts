/**
 * A sound a reply shows, played: one player for its card in the chat and its view in the file
 * viewer, so opening or closing the viewer neither stops nor restarts it. Its element is never in
 * the page, whose controls the card and the viewer draw, and one sound plays at a time.
 */
import { KeptMedia, type KeptSource } from './shown-files.svelte';

/** The sound playing now, which another one stops by starting. */
let current: AudioPlayer | undefined;

/** Why a sound cannot play, from what its element reports. */
function failure(error: MediaError | null): string {
  if (!error || error.code === MediaError.MEDIA_ERR_ABORTED) return '';
  return error.code === MediaError.MEDIA_ERR_NETWORK
    ? 'This file could not be read.'
    : 'This file cannot be played here.';
}

export class AudioPlayer {
  /** Where the sound comes from: this computer's store, or another computer through the relay. */
  readonly media: KeptMedia;
  /** Whether it plays, or will once its file arrives. */
  playing = $state(false);
  /** Where it is, in seconds. */
  time = $state(0);
  /** Its length in seconds, once known; a recording streamed without one has none. */
  duration = $state<number>();
  muted = $state(false);
  /** Why it cannot play. */
  error = $state('');
  #element?: HTMLAudioElement;
  #frame = 0;
  #disposed = false;

  constructor(source: () => KeptSource) {
    this.media = new KeptMedia(source);
  }

  /** What the card shows before the sound plays: one on this computer reports its length. */
  prepare() {
    if (!this.media.remote) void this.#source();
  }

  /**
   * Plays or pauses. Playing starts within the reader's gesture, before its file arrives, so an
   * engine that lets only a gesture start sound still plays it once it comes.
   */
  toggle() {
    const element = this.#audio();
    if (!element.paused) {
      element.pause();
      return;
    }
    if (current && current !== this) current.pause();
    current = this;
    this.error = '';
    element.play().catch((cause: unknown) => {
      // A pause before it started, or an engine refusing to start it now, is no failure.
      const name = cause instanceof DOMException ? cause.name : '';
      if (name !== 'AbortError' && name !== 'NotAllowedError') this.error = failure(element.error);
      this.playing = !element.paused;
    });
    void this.#source();
  }
  pause() {
    this.#element?.pause();
  }
  /** Moves to `seconds`, within the sound. */
  seek(seconds: number) {
    const element = this.#element;
    if (!element || this.duration === undefined) return;
    const time = Math.min(this.duration, Math.max(0, seconds));
    element.currentTime = time;
    this.time = time;
  }
  toggleMute() {
    const element = this.#audio();
    element.muted = !element.muted;
  }
  /** Reads the file again after it could not be read or played. */
  retry() {
    this.error = '';
    this.media.error = '';
    if (this.#element) {
      this.#element.removeAttribute('src');
      this.#element.load();
    }
    this.toggle();
  }
  dispose() {
    this.#disposed = true;
    cancelAnimationFrame(this.#frame);
    if (current === this) current = undefined;
    const element = this.#element;
    if (element) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
    this.media.dispose();
  }

  /** Gives the element its file once there is one, read from another computer only once. */
  async #source() {
    const element = this.#audio();
    if (element.getAttribute('src')) return;
    const url = await this.media.load();
    if (this.#disposed) return;
    if (url) {
      if (!element.getAttribute('src')) element.src = url;
    } else if (this.media.error) {
      // A read that failed leaves nothing to play.
      element.pause();
      this.playing = false;
    }
  }

  #audio(): HTMLAudioElement {
    if (this.#element) return this.#element;
    const element = new Audio();
    element.preload = 'metadata';
    const length = () => {
      const duration = element.duration;
      this.duration = Number.isFinite(duration) && duration > 0 ? duration : undefined;
    };
    element.addEventListener('loadedmetadata', length);
    element.addEventListener('durationchange', length);
    element.addEventListener('play', () => {
      this.playing = true;
      this.#follow();
    });
    for (const stopped of ['pause', 'ended'])
      element.addEventListener(stopped, () => {
        this.playing = false;
        this.time = element.currentTime;
        if (current === this) current = undefined;
      });
    element.addEventListener('timeupdate', () => (this.time = element.currentTime));
    element.addEventListener('volumechange', () => (this.muted = element.muted));
    element.addEventListener('error', () => {
      this.error = failure(element.error);
      this.playing = false;
    });
    this.#element = element;
    return element;
  }

  /**
   * While it plays, the position follows every frame: `timeupdate` comes a few times a second,
   * which moves the bar in steps.
   */
  #follow() {
    cancelAnimationFrame(this.#frame);
    const step = () => {
      const element = this.#element;
      if (!element || element.paused) return;
      this.time = element.currentTime;
      this.#frame = requestAnimationFrame(step);
    };
    this.#frame = requestAnimationFrame(step);
  }
}
