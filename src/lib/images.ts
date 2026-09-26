import { z } from 'zod';

export const imageTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
/**
 * A conversation holds as many images as it likes: saving and syncing move one conversation at a
 * time, so their bytes no longer set the cost of a reply. What remains bounds one message, which
 * becomes one provider request and one preview each: enough for a batch of 4K screenshots, and
 * small enough that a hostile or damaged synced workspace cannot make a device allocate without
 * limit. A provider that accepts less than this reports its own limit.
 */
export const maxImagesPerMessage = 16;
export const maxImageBytes = 16 * 1024 * 1024;
export const maxImageLabel = `${maxImageBytes / 1024 / 1024} MB`;
const maxBase64Length = 4 * Math.ceil(maxImageBytes / 3);
export const imageSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(200),
    mediaType: z.enum(imageTypes),
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
export type ChatImage = z.infer<typeof imageSchema>;

export function imageByteLength(image: { data: string }): number {
  return (
    (image.data.length / 4) * 3 - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0)
  );
}
function hasImageHeader(image: { mediaType: string; data: string }) {
  try {
    const header = atob(image.data.slice(0, 16));
    if (image.mediaType === 'image/png') return header.startsWith('\x89PNG\r\n\x1a\n');
    if (image.mediaType === 'image/jpeg') return header.startsWith('\xff\xd8\xff');
    return header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
  } catch {
    return false;
  }
}
export const imageUrl = (image: ChatImage) => `data:${image.mediaType};base64,${image.data}`;
export const supportsImages = (provider: string) => provider === 'codex' || provider === 'claude';

export async function readImage(file: File): Promise<ChatImage> {
  if (!(imageTypes as readonly string[]).includes(file.type))
    throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (!file.size || file.size > maxImageBytes)
    throw new Error(`${file.name}: images must be between 1 byte and ${maxImageLabel}.`);
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
  const parsed = imageSchema.safeParse({
    id: crypto.randomUUID(),
    name: file.name.slice(0, 200) || 'Pasted image',
    mediaType: file.type,
    data: url.slice(url.indexOf(',') + 1),
  });
  if (!parsed.success) throw new Error(`${file.name}: this file is not a valid image.`);
  const preview = new Image();
  preview.src = imageUrl(parsed.data);
  try {
    await preview.decode();
  } catch {
    throw new Error(`${file.name}: this image could not be opened.`);
  }
  return parsed.data;
}
