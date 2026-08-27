import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The rules other rules DEPEND on, pinned by name.
 *
 * Not a style test — a test that a handful of load-bearing declarations still
 * exist. Each one here was deleted by a sweep for unused classes and each
 * failure was silent: nothing threw, no test went red, and the pane simply
 * stopped being laid out. A stylesheet has no type checker, so this is it.
 */
const css = readFileSync(new URL('./review-pane.css', import.meta.url), 'utf8');

/** One top-level rule's body, by exact selector. */
function body(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `no rule for \`${selector}\``).toBeGreaterThan(-1);
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
}

describe('the declarations other rules rest on', () => {
  it('gives `.sh-md` the gap its children have no margin for', () => {
    /*
     * `.sh-md p { margin: 0 }` is only correct because the column supplies the
     * rhythm. With the parent gone every block in a PR body closed up against
     * the next one and the whole thing read as one paragraph — with the parsing
     * apparently broken, which it was not.
     */
    const rhythm = body('.sh-md');
    expect(rhythm).toContain('flex-direction: column');
    expect(rhythm).toMatch(/gap:\s*var\(--sh-space/);
    expect(body('.sh-md p')).toContain('margin: 0');
  });

  it('still dresses the task footer, which shared a selector list with a dead one', () => {
    // It was `.sh-review__foot, .sh-pr-detail__foot { … }`. Removing the second
    // took the first with it: a rule that dresses two surfaces dies with
    // whichever of them goes first.
    expect(body('.sh-review__foot')).toContain('display: flex');
    expect(css).toContain('.sh-review__blocked');
  });

  it('measures PROSE and lets the document reach the pane', () => {
    // Two edges, and only one of them may be the thing that visibly stops: a
    // measure is invisible, a container edge is not. Capping both made the
    // document appear to end in the middle of a wide window.
    expect(css).toMatch(/\.sh-pr-brief__verdict,\n\.sh-pr-talk \{\n\s*max-inline-size: \d+ch;/);
    expect(body('.sh-pr-doc')).not.toContain('max-inline-size');
  });

  it('does NOT measure the description, which is the one block with a rule over it', () => {
    // Every other measured block is a line or two of chrome. The description
    // carries its own heading, so a rule runs to the document's edge directly
    // above it — and prose stopping short of that rule reads as a column that
    // failed to fill rather than as a measure.
    expect(body('.sh-pr-body')).not.toContain('max-inline-size');
  });
});
