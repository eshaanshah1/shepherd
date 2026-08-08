import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { imageFileName, substituteImageTokens, writePastedImages } from './images.ts';

/** A one-pixel PNG, so the bytes on disk are a real file and not a fixture string. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shepherd-images-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('imageFileName', () => {
  it('names files one-based, matching the token a person sees', () => {
    expect(imageFileName(0, 'image/png')).toBe('image-1.png');
    expect(imageFileName(2, 'image/png')).toBe('image-3.png');
  });

  it('takes the extension from the media type, and spells jpeg jpg', () => {
    expect(imageFileName(0, 'image/jpeg')).toBe('image-1.jpg');
    expect(imageFileName(0, 'image/webp')).toBe('image-1.webp');
    expect(imageFileName(0, 'image/gif')).toBe('image-1.gif');
  });

  it('never lets a media type become path syntax', () => {
    // The media type comes off the clipboard, so it is input. A `/` or a `..`
    // in a filename is a write outside the directory the caller chose.
    expect(imageFileName(0, 'image/../../etc/passwd')).toBe('image-1.png');
    expect(imageFileName(0, 'image/svg+xml')).toBe('image-1.svgxml');
    expect(imageFileName(0, 'nonsense')).toBe('image-1.png');
  });
});

describe('substituteImageTokens', () => {
  it('replaces each token with its path', () => {
    expect(substituteImageTokens('look at [Image #1] and [Image #2]', ['/a.png', '/b.png'])).toBe(
      'look at /a.png and /b.png',
    );
  });

  it('leaves a token alone when there is no such image', () => {
    // It is the user's own text at that point; rewriting it to nothing would
    // silently delete a sentence.
    expect(substituteImageTokens('see [Image #3]', ['/a.png'])).toBe('see [Image #3]\n/a.png');
  });

  it('appends an image whose token was deleted rather than dropping it', () => {
    // The token is ordinary text in a textarea and a backspace removes it. An
    // image the user attached and the agent never hears about is worse.
    expect(substituteImageTokens('fix the header', ['/a.png'])).toBe('fix the header\n/a.png');
  });

  it('handles an empty brief', () => {
    expect(substituteImageTokens('', ['/a.png'])).toBe('/a.png');
  });
});

describe('writePastedImages', () => {
  it('writes nothing and changes nothing when there are no images', () => {
    const written = writePastedImages(join(dir, 'unused'), { brief: 'hi', images: [] });
    expect(written).toEqual({ brief: 'hi', files: [] });
    expect(() => readdirSync(join(dir, 'unused'))).toThrow();
  });

  it('writes each image and resolves the brief to real paths', () => {
    const written = writePastedImages(dir, {
      brief: 'compare [Image #1] with [Image #2]',
      images: [
        { mediaType: 'image/png', data: PNG },
        { mediaType: 'image/jpeg', data: PNG },
      ],
    });

    expect(readdirSync(dir).sort()).toEqual(['image-1.png', 'image-2.jpg']);
    expect(written.files).toEqual([join(dir, 'image-1.png'), join(dir, 'image-2.jpg')]);
    expect(written.brief).toBe(`compare ${written.files[0]} with ${written.files[1]}`);
  });

  it('decodes the base64 to the real bytes', () => {
    // The renderer hands over base64; what lands on disk has to be the image,
    // not the text of it — an agent reading a file of base64 sees nothing.
    const written = writePastedImages(dir, {
      brief: '[Image #1]',
      images: [{ mediaType: 'image/png', data: PNG }],
    });
    const bytes = readFileSync(written.files[0]!);
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  });
});
