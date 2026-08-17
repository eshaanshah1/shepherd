import { asRecord, stringOrNull } from './record.ts';

/**
 * One content array → typed blocks.
 *
 * Empty TEXT is dropped and an empty TOOL RESULT is kept, which looks
 * inconsistent and is not: a tool that returned nothing still ran, and a
 * consumer drawing the call needs the result to exist beside it. An empty text
 * block is only ever noise.
 */

export type Block =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly id: string | null;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool-result';
      readonly toolUseId: string | null;
      readonly output: string;
      readonly isError: boolean;
    }
  | { readonly type: 'image'; readonly path: string | null; readonly url: string | null };

/**
 * A tool result's payload, flattened to one string.
 *
 * It arrives as a string, an array of blocks, or an object — which of the three
 * depends on the tool, and all three occur. The last resort stringifies rather
 * than dropping: an unrenderable result is still evidence the tool ran, and a
 * consumer can show the JSON where it cannot show prose.
 */
export function toolResultOutput(value: unknown): string {
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      const rec = asRecord(item);
      const text = stringOrNull(rec?.text) ?? stringOrNull(rec?.content);
      if (text !== null) parts.push(text);
    }
    return parts.join('\n');
  }

  const rec = asRecord(value);
  if (rec !== null) {
    const text = stringOrNull(rec.text) ?? stringOrNull(rec.content);
    if (text !== null) return text;
  }
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

function oneBlock(rec: Record<string, unknown>): Block | null {
  switch (rec.type) {
    case 'text': {
      const text = stringOrNull(rec.text);
      return text !== null && text.trim() !== '' ? { type: 'text', text } : null;
    }
    case 'thinking':
    case 'redacted_thinking': {
      const text = stringOrNull(rec.thinking) ?? stringOrNull(rec.text);
      return text !== null && text.trim() !== '' ? { type: 'thinking', text } : null;
    }
    case 'tool_use':
      return {
        type: 'tool-call',
        id: stringOrNull(rec.id),
        // A call with no name is still a call; losing it would leave a result
        // with nothing to pair against.
        name: stringOrNull(rec.name) ?? 'tool',
        input: rec.input,
      };
    case 'tool_result':
      return {
        type: 'tool-result',
        toolUseId: stringOrNull(rec.tool_use_id),
        output: toolResultOutput(rec.content),
        isError: rec.is_error === true,
      };
    case 'image': {
      const source = asRecord(rec.source);
      const url = stringOrNull(source?.url) ?? stringOrNull(rec.url);
      const path = stringOrNull(rec.path);
      return url === null && path === null ? null : { type: 'image', path, url };
    }
    default:
      return null;
  }
}

export function contentBlocks(content: unknown): readonly Block[] {
  if (typeof content === 'string') {
    return content.trim() === '' ? [] : [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [];

  const blocks: Block[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      if (item.trim() !== '') blocks.push({ type: 'text', text: item });
      continue;
    }
    const rec = asRecord(item);
    if (rec === null) continue;
    const block = oneBlock(rec);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}
