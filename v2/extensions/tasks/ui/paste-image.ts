import { planDownsize } from '../src/image-downsize.ts';
import type { PastedImage } from '../src/images.ts';

/**
 * A pasted file → the base64 the service half writes to disk.
 *
 * The downsize happens HERE because this is the only side with a canvas: the
 * decision is pure and lives in `image-downsize.ts`, and the pixels are the
 * page's business. A 2.3MB screenshot pasted straight through is 2.3MB written
 * per task and 3MB across the message port, for an image nobody will read at
 * that size.
 */
export async function readPastedImage(file: File): Promise<PastedImage | null> {
  if (!file.type.startsWith('image/')) return null;

  const bitmap = await createImageBitmap(file);
  const plan = planDownsize(bitmap.width, bitmap.height);

  // Already small enough: keep the ORIGINAL bytes rather than re-encoding, so
  // a small PNG is not silently turned into a slightly different PNG.
  if (plan.scale >= 1) {
    bitmap.close();
    return { mediaType: file.type, data: await toBase64(file) };
  }

  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext('2d');
  if (context === null) {
    bitmap.close();
    return { mediaType: file.type, data: await toBase64(file) };
  }
  context.drawImage(bitmap, 0, 0, plan.width, plan.height);
  bitmap.close();

  // PNG, always: a screenshot is flat colour and text, which is what PNG is
  // for, and JPEG artefacts on a screenshot of code are the thing that would
  // make the agent misread it.
  const url = canvas.toDataURL('image/png');
  return { mediaType: 'image/png', data: url.slice(url.indexOf(',') + 1) };
}

async function toBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  // Chunked: `String.fromCharCode(...bytes)` on a multi-megabyte array blows
  // the argument limit, which is a crash on exactly the large paste this
  // function exists to handle.
  for (let i = 0; i < buffer.length; i += 8192) {
    binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
  }
  return btoa(binary);
}
