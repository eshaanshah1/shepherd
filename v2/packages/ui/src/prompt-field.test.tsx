// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readValue } from './prompt-field.tsx';

/**
 * Only `readValue` is tested here, and the omission is the point: jsdom
 * implements neither caret movement nor `execCommand`, so a test of ⌘A, ⌥←,
 * cut/paste or undo would be asserting the harness rather than the field. Those
 * live in docs/superpowers/specs/2026-08-08-composer-editing-requirements.md as
 * a by-hand checklist, which is honest about how they are verified.
 */
describe('readValue', () => {
  const field = (html: string): HTMLElement => {
    const node = document.createElement('div');
    node.innerHTML = html;
    return node;
  };

  it('reads a pill as its TOKEN, never its label', () => {
    // The label says "Image 1" and the agent must be told "[Image #1]" — the
    // token is what a path is substituted for downstream.
    const node = field('look at <span data-token="[Image #1]">Image 1</span> please');
    expect(readValue(node)).toBe('look at [Image #1] please');
  });

  it('reads a <br> as a newline, which is how contenteditable spells one', () => {
    expect(readValue(field('one<br>two'))).toBe('one\ntwo');
  });

  it('reads a block as a newline plus its text — the other browser spelling', () => {
    expect(readValue(field('one<div>two</div>'))).toBe('one\ntwo');
  });

  it('reads plain text unchanged, which is the ordinary case', () => {
    expect(readValue(field('just a brief'))).toBe('just a brief');
  });
});
