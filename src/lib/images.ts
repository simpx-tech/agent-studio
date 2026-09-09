import { z } from 'zod';

export const imageTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const maxImagesPerMessage = 4;
export const maxImageBytes = 2 * 1024 * 1024;
export const maxConversationImageBytes = 8 * 1024 * 1024;
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
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
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
    throw new Error(`${file.name}: images must be between 1 byte and 2 MB.`);
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

export function checkImageBudget(messages: { images?: ChatImage[] }[]) {
  const images = messages.flatMap((message) => message.images ?? []);
  if (images.reduce((sum, image) => sum + imageByteLength(image), 0) > maxConversationImageBytes)
    throw new Error(
      'This conversation has reached its 8 MB image limit. Start a new conversation to attach more images.',
    );
}
