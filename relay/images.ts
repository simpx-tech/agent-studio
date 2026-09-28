/**
 * The relay's image store. A message keeps a reference to each image (`storedImageSchema` in
 * src/lib/images.ts); the bytes live here once per workspace, named by their SHA-256, uploaded
 * by the device that attached them and read by the devices that show or send them.
 *
 * Apps from before the store still send images inline. Their bytes are stored here and the
 * message keeps a reference, and they read their answers with the bytes put back inline, so an
 * app not yet updated keeps syncing and running replies unchanged.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { maxImageBytes } from '../src/lib/images.ts';

const hashPattern = /^[0-9a-f]{64}$/;
export const validImageHash = (hash: unknown): hash is string =>
  typeof hash === 'string' && hashPattern.test(hash);
/** Refused uploads, answered with their status. */
export class ImageUploadError extends Error {
  // A declared field: the relay runs as plain Node TypeScript, which has no parameter properties.
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
/** The type an image's own first bytes report, of those a message may carry. */
export function imageType(head: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  const starts = (...bytes: number[]) => bytes.every((byte, i) => head[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  const text = (from: number, to: number) =>
    Buffer.from(head.subarray(from, to)).toString('latin1');
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function imageStore(directory: string, now = Date.now) {
  const root = join(directory, 'images');
  const path = (hash: string) => join(root, hash);
  const has = (hash: string) => validImageHash(hash) && existsSync(path(hash));
  /** Keeps bytes under their hash, written whole before they are named. */
  function write(hash: string, bytes: Uint8Array) {
    if (has(hash)) return;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = join(root, `${hash}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, bytes, { mode: 0o600 });
      const fd = openSync(temporary, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (!has(hash)) renameSync(temporary, path(hash));
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  /** Stores the bytes of an image a message carried inline, returning their hash. */
  function keep(bytes: Uint8Array, mediaType: string): string {
    if (!bytes.length || bytes.length > maxImageBytes || imageType(bytes) !== mediaType)
      throw new ImageUploadError(400, 'An image in this message is not a valid image.');
    const hash = sha256(bytes);
    write(hash, bytes);
    return hash;
  }
  function read(hash: string): Buffer | undefined {
    if (!validImageHash(hash)) return undefined;
    try {
      return readFileSync(path(hash));
    } catch {
      return undefined;
    }
  }
  /**
   * An upload of one image, streamed to a temporary file while its hash is computed: it is
   * named only when its bytes are an image and match the hash it was sent under.
   */
  async function receive(req: IncomingMessage, hash: string, authorized: () => boolean) {
    if (!validImageHash(hash)) throw new ImageUploadError(400, 'Invalid image hash.');
    if (Number(req.headers['content-length']) > maxImageBytes)
      throw new ImageUploadError(413, 'Images must be 16 MB or smaller.');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = join(root, `${hash}.${randomUUID()}.tmp`);
    const digest = createHash('sha256');
    const head = new Uint8Array(16);
    let length = 0;
    const fd = openSync(temporary, 'w', 0o600);
    try {
      try {
        for await (const chunk of req as AsyncIterable<Buffer>) {
          if (length < head.length) head.set(chunk.subarray(0, head.length - length), length);
          length += chunk.length;
          if (length > maxImageBytes)
            throw new ImageUploadError(413, 'Images must be 16 MB or smaller.');
          digest.update(chunk);
          writeSync(fd, chunk);
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (!authorized()) throw new Error('Workspace access was revoked. Pair this device again.');
      if (!length || !imageType(head))
        throw new ImageUploadError(400, 'Upload a PNG, JPEG, or WebP image.');
      if (digest.digest('hex') !== hash)
        throw new ImageUploadError(400, 'The image does not match its hash.');
      if (!has(hash)) renameSync(temporary, path(hash));
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  /**
   * Removes images nothing refers to any more, once they are older than `grace`: a device
   * uploads an image before it publishes the message that names it, so a fresh upload is kept.
   */
  function prune(referenced: ReadonlySet<string>, grace = 24 * 60 * 60 * 1000) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      const hash = name.split('.')[0];
      if (validImageHash(name) && referenced.has(hash)) continue;
      try {
        if (now() - statSync(join(root, name)).mtimeMs > grace) rmSync(join(root, name));
      } catch {
        /* Another cleanup got there first. */
      }
    }
  }
  return { root, has, keep, read, receive, prune };
}
export type ImageStore = ReturnType<typeof imageStore>;

type ImageList = unknown[];
type Messages = readonly { images?: ImageList }[];
type Conversations = readonly { messages: Messages; rewind?: { removed: Messages } }[];
/** Every list of images the messages hold, including those a rewind keeps to restore. */
function* imageLists(conversations: Conversations): Generator<ImageList> {
  for (const conversation of conversations) {
    for (const message of conversation.messages) if (message.images?.length) yield message.images;
    for (const message of conversation.rewind?.removed ?? [])
      if (message.images?.length) yield message.images;
  }
}
type Inline = { id: string; name: string; mediaType: string; data: string };
type Stored = { id: string; name: string; mediaType: string; hash: string; bytes: number };
const isInline = (image: unknown): image is Inline => typeof (image as Inline)?.data === 'string';
const isStored = (image: unknown): image is Stored => validImageHash((image as Stored)?.hash);

/** Replaces images carried inline with references, storing their bytes. */
function storeList(images: ImageList, store: ImageStore): boolean {
  let changed = false;
  images.forEach((image, index) => {
    if (!isInline(image)) return;
    const bytes = Buffer.from(image.data, 'base64');
    images[index] = {
      id: image.id,
      name: image.name,
      mediaType: image.mediaType,
      hash: store.keep(bytes, image.mediaType),
      bytes: bytes.length,
    } satisfies Stored;
    changed = true;
  });
  return changed;
}
/** Stores the images of conversations that still carry them inline; true when any did. */
export function storeInlineImages(conversations: Conversations, store: ImageStore): boolean {
  let changed = false;
  for (const images of imageLists(conversations)) changed = storeList(images, store) || changed;
  return changed;
}
/** The same, for the messages of a run request. */
export function storeInlineMessages(messages: Messages, store: ImageStore): boolean {
  let changed = false;
  for (const message of messages)
    if (message.images?.length) changed = storeList(message.images, store) || changed;
  return changed;
}
/**
 * A copy of `conversations` with each reference's bytes put back inline, for an app from before
 * the image store. A reference whose bytes are missing stays a reference, which that app then
 * refuses loudly rather than dropping the image.
 */
export function inlineImages<T extends Conversations[number]>(
  conversations: readonly T[],
  store: ImageStore,
): T[] {
  return conversations.map((conversation) => {
    if (![...imageLists([conversation])].some((images) => images.some(isStored)))
      return conversation;
    const copy = structuredClone(conversation) as T;
    for (const images of imageLists([copy])) inlineList(images, store);
    return copy;
  });
}
/** The same, for the messages of a run request an older execution host claims. */
export function inlineMessages<T extends Messages[number]>(
  messages: readonly T[],
  store: ImageStore,
): T[] {
  return messages.map((message) => {
    if (!message.images?.some(isStored)) return message;
    const copy = structuredClone(message) as T;
    inlineList(copy.images!, store);
    return copy;
  });
}
function inlineList(images: ImageList, store: ImageStore) {
  images.forEach((image, index) => {
    if (!isStored(image)) return;
    const bytes = store.read(image.hash);
    if (!bytes) return;
    images[index] = {
      id: image.id,
      name: image.name,
      mediaType: image.mediaType,
      data: bytes.toString('base64'),
    } satisfies Inline;
  });
}
/** The hashes messages refer to, which the store keeps. */
export function referencedImages(conversations: Conversations, runs: Messages[] = []): Set<string> {
  const hashes = new Set<string>();
  const add = (images: ImageList) => {
    for (const image of images) if (isStored(image)) hashes.add(image.hash);
  };
  for (const images of imageLists(conversations)) add(images);
  for (const messages of runs) for (const message of messages) add(message.images ?? []);
  return hashes;
}
