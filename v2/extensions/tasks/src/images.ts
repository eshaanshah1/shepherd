import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A pasted image, on its way to an agent.
 *
 * Claude Code holds a pasted image in memory as base64 and shows `[Image #1]`
 * where it sits in the text. We cannot hand an in-memory block to a pane — a
 * pane gets a prompt file and a typed line — so the image is **written to disk
 * beside the prompt** and the token becomes its path. The agent then reads it
 * with the tool it already has.
 *
 * The file therefore OUTLIVES the prompt file, which is deleted by the launch
 * line the moment the agent starts: the prompt is consumed by `cat`, the image
 * is consumed whenever the agent gets around to looking at it.
 */

export interface PastedImage {
  /** `image/png`, `image/jpeg`, … — what the clipboard said it was. */
  readonly mediaType: string;
  /** Base64, no `data:` prefix. It arrives already encoded from the renderer. */
  readonly data: string;
}

/**
 * The placeholder the brief carries, Claude Code's own spelling.
 *
 * One-based, because it is shown to a person: `[Image #1]` is the first image.
 */
const TOKEN = /\[Image #(\d+)\]/g;

/**
 * `image/png` → `png`. The subtype, sanitized, because it becomes a filename.
 *
 * `jpeg` is spelled `jpg` for no better reason than that every tool that opens
 * one writes it that way; an unrecognizable type falls back to `png`, which is
 * what a clipboard paste is in every case we can produce.
 */
function extensionOf(mediaType: string): string {
  const subtype = mediaType.split('/')[1]?.replace(/[^a-z0-9]/gi, '').toLowerCase() ?? '';
  if (subtype === 'jpeg') return 'jpg';
  return subtype === '' ? 'png' : subtype;
}

export function imageFileName(index: number, mediaType: string): string {
  return `image-${index + 1}.${extensionOf(mediaType)}`;
}

/**
 * Put the paths where the tokens are — and never drop an image.
 *
 * A token whose image does not exist is left alone: it is the user's own text
 * at that point, and rewriting it to nothing would silently delete a sentence.
 * An image with no token is **appended** rather than discarded — the token is
 * ordinary text in a textarea and can be deleted by a backspace, and an image
 * the user attached and the agent never hears about is the worse failure.
 */
export function substituteImageTokens(brief: string, paths: readonly string[]): string {
  const referenced = new Set<number>();
  const substituted = brief.replaceAll(TOKEN, (whole, digits: string) => {
    const index = Number(digits) - 1;
    const path = paths[index];
    if (path === undefined) return whole;
    referenced.add(index);
    return path;
  });

  const orphans = paths.filter((_, index) => !referenced.has(index));
  if (orphans.length === 0) return substituted;
  return [substituted.trimEnd(), ...orphans].filter((part) => part !== '').join('\n');
}

export interface WrittenImages {
  /** The brief with every token resolved to a path. */
  readonly brief: string;
  /** What was written, in the order the images were given. */
  readonly files: readonly string[];
}

/**
 * Write the images and resolve the brief that points at them.
 *
 * `dir` must be **this launch's own directory** — the names are `image-1.png`,
 * `image-2.png`, … with no id in them, so a directory shared between two tasks
 * would have the second overwrite the first's. Names a person will read in a
 * prompt are worth that constraint; the caller already mints a unique name for
 * the prompt file and can mint a sibling directory the same way.
 */
export function writePastedImages(
  dir: string,
  input: { readonly brief: string; readonly images: readonly PastedImage[] },
): WrittenImages {
  if (input.images.length === 0) return { brief: input.brief, files: [] };

  mkdirSync(dir, { recursive: true });
  const files = input.images.map((image, index) => {
    const path = join(dir, imageFileName(index, image.mediaType));
    writeFileSync(path, Buffer.from(image.data, 'base64'));
    return path;
  });
  return { brief: substituteImageTokens(input.brief, files), files };
}
