import { z } from 'zod';

export const imageTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageType = (typeof imageTypes)[number];
/**
 * A conversation holds as many images as it likes: a message keeps a reference to each one, and
 * the bytes live apart from the chat data (the image store below). What remains bounds one
 * message, which becomes one provider request and one preview each: enough for a batch of 4K
 * screenshots, and small enough that a hostile or damaged synced workspace cannot make a device
 * allocate without limit. A provider that accepts less than this reports its own limit.
 */
export const maxImagesPerMessage = 16;
export const maxImageBytes = 16 * 1024 * 1024;
export const maxImageLabel = `${maxImageBytes / 1024 / 1024} MB`;
const maxBase64Length = 4 * Math.ceil(maxImageBytes / 3);
const fields = {
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  mediaType: z.enum(imageTypes),
};
/**
 * An image a message keeps in the image store. The chat data holds only this reference: its
 * bytes live once on each computer that needs them and once on the relay, named by their
 * SHA-256, and are read where they are shown or sent to a provider. These five fields are all a
 * reference has, so a relay, a desktop and a browser that each turn one inline image into a
 * reference produce the same record, and merging their copies finds nothing to reconcile.
 */
export const storedImageSchema = z.object({
  ...fields,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(1).max(maxImageBytes),
});
/**
 * An image as releases before the image store kept it: its bytes inline as base64. It is still
 * read, and each computer turns it into a reference where it stores the bytes.
 */
export const inlineImageSchema = z
  .object({
    ...fields,
    data: z
      .string()
      .min(4)
      .max(maxBase64Length)
      // A group repeated once per four characters recurses in the regex engine and overflows its
      // stack on a large image, so the alphabet is one character class and the groups of four are
      // checked by length instead.
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((data) => data.length % 4 === 0, 'Invalid image encoding'),
  })
  .refine(
    (image) => imageByteLength(image) <= maxImageBytes && hasImageHeader(image),
    'Invalid image data',
  );
export const imageSchema = z.union([storedImageSchema, inlineImageSchema]);
export type StoredImage = z.infer<typeof storedImageSchema>;
export type InlineImage = z.infer<typeof inlineImageSchema>;
export type ChatImage = StoredImage | InlineImage;
export const isInline = (image: ChatImage): image is InlineImage => 'data' in image;
/** An image attached in the composer: its bytes stay in memory until the message is sent. */
export type DraftImage = StoredImage & { blob: Blob };

export function imageByteLength(image: { data: string }): number {
  return (
    (image.data.length / 4) * 3 - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0)
  );
}
function hasImageHeader(image: { mediaType: string; data: string }) {
  try {
    const header = atob(image.data.slice(0, 16));
    return matchesType(
      Uint8Array.from(header, (c) => c.charCodeAt(0)),
      image.mediaType,
    );
  } catch {
    return false;
  }
}
/** Whether an image's own first bytes are those of its media type. */
export function matchesType(head: Uint8Array, mediaType: string): boolean {
  const starts = (...bytes: number[]) => bytes.every((byte, i) => head[i] === byte);
  if (mediaType === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mediaType === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  if (mediaType !== 'image/webp') return false;
  const text = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  return text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP';
}
export const imageUrl = (image: InlineImage) => `data:${image.mediaType};base64,${image.data}`;
export const supportsImages = (provider: string) => provider === 'codex' || provider === 'claude';
/** A message's image as its chat data keeps it: the reference alone, without the draft's bytes. */
export const storedImage = ({ id, name, mediaType, hash, bytes }: StoredImage): StoredImage => ({
  id,
  name,
  mediaType,
  hash,
  bytes,
});

/** The lowercase hex SHA-256 of some bytes, which names them in the image store. */
export async function imageHash(bytes: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Decodes an inline image's base64 into its bytes, natively where the engine can. */
export function inlineBytes(image: InlineImage): Uint8Array<ArrayBuffer> {
  const native = Uint8Array as unknown as { fromBase64?(data: string): Uint8Array<ArrayBuffer> };
  if (typeof native.fromBase64 === 'function') return native.fromBase64(image.data);
  const binary = atob(image.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
/** An inline image as the reference the image store keeps for it, with its bytes to store. */
export async function referenceInline(
  image: InlineImage,
): Promise<{ image: StoredImage; bytes: Uint8Array<ArrayBuffer> }> {
  const bytes = inlineBytes(image);
  return {
    image: storedImage({ ...image, hash: await imageHash(bytes), bytes: bytes.byteLength }),
    bytes,
  };
}

export async function readImage(file: File): Promise<DraftImage> {
  if (!(imageTypes as readonly string[]).includes(file.type))
    throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (!file.size || file.size > maxImageBytes)
    throw new Error(`${file.name}: images must be between 1 byte and ${maxImageLabel}.`);
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new Error(`Could not read ${file.name}.`);
  }
  if (!matchesType(new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength)), file.type))
    throw new Error(`${file.name}: this file is not a valid image.`);
  const blob = new Blob([bytes], { type: file.type });
  // Decoded as the thumbnails and messages show it, by an image element: createImageBitmap
  // refuses images an image element shows, such as a PNG with a wrong checksum.
  const url = URL.createObjectURL(blob);
  try {
    const preview = new Image();
    preview.src = url;
    await preview.decode();
  } catch {
    throw new Error(`${file.name}: this image could not be opened.`);
  } finally {
    URL.revokeObjectURL(url);
  }
  return {
    id: crypto.randomUUID(),
    name: file.name.slice(0, 200) || 'Pasted image',
    mediaType: file.type as ImageType,
    hash: await imageHash(bytes),
    bytes: bytes.byteLength,
    blob,
  };
}
/**
 * A sent message's image attached in the composer again, its bytes back in memory: read by
 * `read` from the image store, or decoded from a message an earlier release saved inline.
 */
export async function draftImage(
  image: ChatImage,
  read: (hash: string) => Promise<Blob>,
): Promise<DraftImage> {
  const { name, mediaType } = image;
  if (!isInline(image))
    return {
      ...storedImage(image),
      id: crypto.randomUUID(),
      blob: new Blob([await read(image.hash)], { type: mediaType }),
    };
  const bytes = inlineBytes(image);
  return {
    id: crypto.randomUUID(),
    name,
    mediaType,
    hash: await imageHash(bytes),
    bytes: bytes.byteLength,
    blob: new Blob([bytes], { type: mediaType }),
  };
}

type WithImages = { images?: readonly ChatImage[] };
/**
 * The image lists a conversation holds: in its messages and in the messages a rewind keeps to
 * restore.
 */
export function imageLists(conversation: {
  messages: readonly WithImages[];
  rewind?: { removed: readonly WithImages[] };
}): (readonly ChatImage[])[] {
  return [...conversation.messages, ...(conversation.rewind?.removed ?? [])].flatMap((m) =>
    m.images?.length ? [m.images] : [],
  );
}
/** The images a conversation names in the image store, by hash. */
export function imageHashes(conversation: Parameters<typeof imageLists>[0]): string[] {
  return imageLists(conversation).flatMap((images) =>
    images.flatMap((image) => (isInline(image) ? [] : [image.hash])),
  );
}
/** An image's bytes as base64, for an export that stands on its own. */
export async function blobBase64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read an image.'));
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(',') + 1);
}
