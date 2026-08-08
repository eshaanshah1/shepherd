// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cssVariableBlock } from '@shepherd/design-tokens';
import {
  ancestorChain,
  declaringElement,
  describeElement,
  probeRoles,
  roleDependencies,
  type ComputedReader,
  type ReadComputed,
} from './inspector-probe.ts';

/**
 * What jsdom can and cannot prove about the probe — measured first, then worked
 * around, and the workaround's limits stated here rather than discovered later.
 *
 * **jsdom does not substitute `var()` in a property.** Measured directly:
 * `getComputedStyle(el).backgroundColor` for a rule reading
 * `background-color: var(--sh-surface)` returns the literal string
 * `"var(--sh-surface)"`, whatever `--sh-surface` is set to and wherever it is
 * set. A probe therefore cannot move it, every finding would be `role: null`, and
 * a suite written straight against `getComputedStyle` would PASS while asserting
 * nothing — the vacuous-green failure mode this file exists to avoid.
 *
 * **jsdom does resolve the custom-property cascade.** Also measured:
 * `getPropertyValue('--sh-text')` correctly returns `:root`'s value at the root,
 * a scoped re-declaration's value inside that subtree, and an inline
 * `setProperty` on the element itself. That is the half the probe actually
 * depends on, and it is real.
 *
 * So the tests inject a reader that performs the substitution jsdom omits,
 * reading the variables out of jsdom's own cascade. What that DOES prove:
 *
 *   - the two-sentinel diff, including that a property which resolves through no
 *     variable at all never moves (the `no role` verdict);
 *   - the ancestor-chain write and the exact restore, inline layer included;
 *   - the wash/alias reduction — that `fillHover` wins over `text` for a
 *     background painted by the wash, with `text` reported as `via`;
 *   - the palette fallback, naming the tier-1 token when no role explains it;
 *   - `declaringElement` naming a re-declaring ancestor rather than `:root`,
 *     which is the case the scoped-re-declaration design (§2) turns on;
 *   - `paintSite` widening from the element outward.
 *
 * What it does NOT prove, and what only the real app can:
 *
 *   - that Chromium's `var()` substitution behaves as the injected reader
 *     models it (nesting, fallbacks, invalid-at-computed-value-time);
 *   - anything about `color-mix`, which jsdom neither computes nor rejects — a
 *     wash's probe here moves a *string*, in Chromium it moves a colour;
 *   - the inherited-property path end to end. jsdom's inheritance of `color` is
 *     partial, so the chain write is pinned structurally (`ancestorChain`,
 *     save/restore across every element in it) rather than through an inherited
 *     computed value;
 *   - `border-color` as a shorthand serialization, which jsdom answers with
 *     `rgba(0, 0, 0, 0)` regardless of what the longhands say;
 *   - anything about `::before` / `::after`. jsdom's `getComputedStyle` ignores
 *     the pseudo argument and answers with the element's own style, so `content`
 *     reads as `''` and every pseudo slot is (correctly, for jsdom) skipped —
 *     which means the pseudo path is exercised by real Chromium and by nothing
 *     here. It was added because a `StatusDot` is entirely its `::before`, and
 *     that is the shape the real audit confirmed.
 *
 * Two of the tests below exist ONLY because a real-Chromium run found the
 * behaviour they pin (`drawn`, and the pseudo skip). That order — measure the
 * app, then write the test — is the one this file is arranged around.
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

/**
 * The reader jsdom needs: substitute `var()` out of the value using jsdom's own
 * (correct) custom-property cascade, innermost last, with fallbacks honoured.
 */
const substituting: ReadComputed = (element: Element): ComputedReader => ({
  getPropertyValue(property: string): string {
    let value = getComputedStyle(element).getPropertyValue(property);
    for (let round = 0; round < 8 && value.includes('var('); round += 1) {
      value = value.replace(
        /var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g,
        (_match: string, name: string, fallback?: string) => {
          const resolved = getComputedStyle(element).getPropertyValue(name).trim();
          return resolved === '' ? (fallback ?? '').trim() : resolved;
        },
      );
    }
    return value;
  },
});

function fixture(rules: string, markup: string): void {
  const style = document.createElement('style');
  // The REAL token block, not a hand-written stand-in: the roles under test are
  // the ones the app ships, aliases and washes included.
  style.textContent = `${cssVariableBlock('dark')}\n${rules}`;
  document.head.append(style);
  document.body.innerHTML = markup;
}

function must(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`fixture is missing #${id}`);
  return element;
}

function find(element: Element, property: string) {
  const finding = probeRoles(element, { read: substituting }).find(
    (candidate) => candidate.property === property,
  );
  if (finding === undefined) throw new Error(`no finding for ${property}`);
  return finding;
}

describe('probeRoles', () => {
  it('names the role painting a background and a foreground', () => {
    fixture(
      `#target { background-color: var(--sh-surface); color: var(--sh-text); }`,
      `<div id="target">x</div>`,
    );
    const target = must('target');

    expect(find(target, 'background-color').role).toBe('surface');
    expect(find(target, 'color').role).toBe('text');
  });

  it('names the WASH, not the role the wash is built from', () => {
    // `fillHover` is `color-mix(… var(--sh-text) 6% …)`, so a probe of `text`
    // moves this background too. The answer is the wash; `text` is how it is
    // built, and the reduction that decides so is read off `roles.ts`.
    fixture(`#target { background-color: var(--sh-fill-hover); }`, `<div id="target">x</div>`);

    const finding = find(must('target'), 'background-color');
    expect(finding.role).toBe('fillHover');
    expect(finding.via).toContain('text');
  });

  it('says NO ROLE for a hardcoded colour, and names no token either', () => {
    fixture(`#target { background-color: rgb(12, 34, 56); }`, `<div id="target">x</div>`);

    const finding = find(must('target'), 'background-color');
    expect(finding.role).toBeNull();
    expect(finding.paletteToken).toBeNull();
    expect(finding.value).toBe('rgb(12, 34, 56)');
  });

  it('says NO ROLE for an inline style, which is the same defect by another door', () => {
    fixture('', `<div id="target" style="background-color: rgb(9, 9, 9)">x</div>`);

    expect(find(must('target'), 'background-color').role).toBeNull();
  });

  it('says NO ROLE but names the private token when a call site is on tier 1', () => {
    fixture(`#target { background-color: var(--sh-ink-line); }`, `<div id="target">x</div>`);

    const finding = find(must('target'), 'background-color');
    expect(finding.role).toBeNull();
    expect(finding.paletteToken).toBe('ink-line');
  });

  it('answers with the RE-DECLARING ancestor, not :root, inside a scoped subtree', () => {
    // Spec §2's whole mechanism, and the reason the inspector reports a location
    // at all: a pane re-declares the generic role for its subtree, so `:root`
    // would be a wrong answer that looks right.
    fixture(
      `
        .scope { --sh-text: rgb(3, 4, 5); }
        #target { color: var(--sh-text); }
      `,
      `<div class="scope" id="scope"><div id="target">x</div></div>`,
    );

    const finding = find(must('target'), 'color');
    expect(finding.role).toBe('text');
    expect(finding.declaredOn).toBe(must('scope'));
    expect(finding.declaredOn).not.toBe(document.documentElement);
    // The rule consuming the role is the element's own.
    expect(finding.paintedOn).toBe(must('target'));
  });

  it('answers :root when nothing between re-declares the role', () => {
    fixture(`#target { color: var(--sh-text); }`, `<div id="target">x</div>`);

    expect(find(must('target'), 'color').declaredOn).toBe(document.documentElement);
  });

  it('restores every probe it wrote, on the element and up the chain', () => {
    fixture(
      `#target { background-color: var(--sh-surface); }`,
      `<div class="scope" id="scope" style="--sh-text: rgb(1, 1, 1)"><div id="target" style="--sh-surface: rgb(2, 2, 2)">x</div></div>`,
    );
    const target = must('target');
    const before = {
      target: target.getAttribute('style'),
      scope: must('scope').getAttribute('style'),
      root: document.documentElement.getAttribute('style'),
    };

    probeRoles(target, { read: substituting });

    expect(target.getAttribute('style')).toBe(before.target);
    expect(must('scope').getAttribute('style')).toBe(before.scope);
    expect(document.documentElement.getAttribute('style')).toBe(before.root);
  });

  it('restores the probe even when nothing is found', () => {
    fixture(`#target { background-color: rgb(1, 2, 3); }`, `<div id="target">x</div>`);
    const target = must('target');

    probeRoles(target, { read: substituting });

    expect(target.getAttribute('style')).toBeNull();
    // `:root` carries the app's inline token map in the real page; the fixture's
    // is empty, and an empty one must come back empty rather than as `style=""`.
    expect(document.documentElement.getAttribute('style')).toBeNull();
  });

  it('reports one finding per probed property, always', () => {
    fixture('', `<div id="target">x</div>`);

    const findings = probeRoles(must('target'), { read: substituting });
    expect(findings.map((finding) => finding.property)).toEqual([
      'background-color',
      'border-color',
      'color',
      'outline-color',
    ]);
    // No pseudo generates a box here, so none is reported. Every element has a
    // `::before` as far as `getComputedStyle` is concerned; one with
    // `content: none` paints nothing and a row about it would be exactly the
    // noise `drawn` was added to remove.
    expect(findings.every((finding) => finding.pseudo === null)).toBe(true);
  });

  it('says an edge nobody draws is not drawn', () => {
    // The defect the first real-Chromium audit found in this tool: `border-color`
    // and `outline-color` are `currentColor` by default, so EVERY element on a
    // page resolves both — and an unfiltered report says "not painted by any
    // role" about four hundred borders that do not exist, burying the handful
    // that do. jsdom reports no border longhands at all, so what is pinned here
    // is the fail-open half: an unmeasurable width counts as drawn rather than
    // hiding a finding, and the two always-drawn properties are unconditional.
    fixture(
      `#painted { background-color: rgb(1, 2, 3); } #bare { background-color: transparent; }`,
      `<div id="painted">x</div><div id="bare">y</div>`,
    );

    const painted = Object.fromEntries(
      probeRoles(must('painted'), { read: substituting }).map((f) => [f.property, f.drawn]),
    );
    expect(painted['background-color']).toBe(true);
    // Always. A property that carries text is drawn whether or not there is any.
    expect(painted['color']).toBe(true);

    // A transparent background paints nothing, so "no role explains it" would be
    // crying wolf — and the `no role` verdict is worth exactly as much as its
    // false-positive rate.
    const bare = Object.fromEntries(
      probeRoles(must('bare'), { read: substituting }).map((f) => [f.property, f.drawn]),
    );
    expect(bare['background-color']).toBe(false);
  });

  it('honours a narrowed candidate list, so the answer cannot come from elsewhere', () => {
    fixture(`#target { background-color: var(--sh-surface); }`, `<div id="target">x</div>`);

    const finding = probeRoles(must('target'), { read: substituting, roles: ['accent', 'danger'] }).find(
      (candidate) => candidate.property === 'background-color',
    );
    expect(finding?.role).toBeNull();
  });
});

describe('ancestorChain', () => {
  it('runs from the element to documentElement, in that order', () => {
    fixture('', `<div id="outer"><div id="target">x</div></div>`);

    const chain = ancestorChain(must('target'));
    expect(chain[0]).toBe(must('target'));
    expect(chain[1]).toBe(must('outer'));
    expect(chain[chain.length - 1]).toBe(document.documentElement);
  });
});

describe('roleDependencies', () => {
  it('is empty for a role painted straight from the palette', () => {
    expect([...roleDependencies('surface')]).toEqual([]);
  });

  it('follows an alias to the token it ends at', () => {
    // `focusRing` → `accent`, and `accent` is a token role, so the walk stops.
    expect([...roleDependencies('focusRing')]).toEqual(['accent']);
  });

  it('follows a wash to the role it is a wash OF', () => {
    expect([...roleDependencies('fillHover')]).toEqual(['text']);
  });
});

describe('declaringElement', () => {
  it('returns documentElement when nothing between declares the variable', () => {
    fixture('', `<div id="target">x</div>`);

    expect(declaringElement(must('target'), '--sh-text', substituting)).toBe(
      document.documentElement,
    );
  });

  it('returns the nearest ancestor whose value differs from its parent', () => {
    fixture(
      `.outer { --sh-text: rgb(1, 1, 1); } .inner { --sh-text: rgb(2, 2, 2); }`,
      `<div class="outer" id="outer"><div class="inner" id="inner"><div id="target">x</div></div></div>`,
    );

    expect(declaringElement(must('target'), '--sh-text', substituting)).toBe(must('inner'));
  });
});

describe('describeElement', () => {
  it('names the testid a plan or a smoke would use', () => {
    fixture('', `<div id="target" class="sh-ui-row sh-x" data-testid="task-row">x</div>`);

    expect(describeElement(must('target'))).toBe('div#target.sh-ui-row.sh-x[task-row]');
  });

  it('calls the document element :root, because that is what the CSS says', () => {
    expect(describeElement(document.documentElement)).toBe(':root');
  });

  it('has an answer for nothing', () => {
    expect(describeElement(null)).toBe('—');
  });
});
