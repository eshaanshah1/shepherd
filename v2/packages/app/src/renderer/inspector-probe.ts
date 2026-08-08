import {
  colorTokens,
  cssVarName,
  roleNames,
  roleVarName,
  roles,
  type ColorToken,
  type RoleName,
} from '@shepherd/design-tokens';

/**
 * The token inspector's MEASUREMENT half — design-system spec §4.
 *
 * The question this answers is "which role paints this?", and the reason it is a
 * measurement rather than a lookup is the whole point of the tool: a lookup
 * table is a second copy of the stylesheet, written by the same person who got
 * the colour wrong, and it would agree with the mistake. Every wrong colour this
 * project has shipped was a guess about which token paints a surface (spec §4);
 * a tool that guesses too is worth nothing.
 *
 * So: **probe and diff.** For each candidate role, write a sentinel colour into
 * that role's custom property, read the element's computed `background-color` /
 * `border-color` / `color` / `outline-color`, write a *second*, different
 * sentinel, read again — and the properties whose value differs between the two
 * readings are the ones that role paints. Then restore.
 *
 * Four things about that are not obvious, and each is load-bearing:
 *
 *   1. **Two sentinels, never a baseline diff.** Comparing a probe against the
 *      resting value gives a false negative whenever the resting value happens
 *      to equal the probe, and a false negative here reads as "not painted by
 *      any role" — the tool's most important verdict, which must never be
 *      produced by an accident of arithmetic. Differing from *itself* under two
 *      probes cannot happen by coincidence.
 *   2. **The probe is written up the whole ancestor chain, not on the element.**
 *      `color` is an INHERITED property: if an ancestor declares
 *      `color: var(--sh-text)` and the element merely inherits the result, then
 *      re-declaring `--sh-text` on the element changes nothing at all — the
 *      inherited value was already computed upstream. Writing the sentinel on
 *      every element from `documentElement` down to the target means whichever
 *      one actually declares the property re-resolves. (It also overrides a
 *      scoped re-declaration on the way down, which is fine: *where* the value
 *      comes from is a separate measurement, `declaringElement`, taken with the
 *      probes restored.)
 *   3. **Several roles move the same property, and only one of them is the
 *      answer.** `--sh-fill-hover` is `color-mix(… var(--sh-text) 6% …)`, so
 *      probing `text` moves any background painted by `fillHover`. The reduction
 *      is the role graph in `roles.ts`: a role reached only *through* another
 *      candidate is dropped from the answer and reported as `via`. This is the
 *      same alias/wash indirection §2 introduced to make scoped re-declaration
 *      work, arriving as an ambiguity in the measurement.
 *   4. **No role is a real answer.** A hardcoded colour, an inline style, or a
 *      tier-1 palette var used directly (`var(--sh-ink-line)`) yields
 *      `role: null` — and that is the defect this tool exists to find, so it is
 *      reported as loudly as a hit. When nothing role-shaped explains a
 *      property, a second pass probes the PALETTE, because "painted by
 *      `--sh-ink-line`, which is private" is an actionable answer and "unknown"
 *      is not.
 *   5. **A pseudo-element is where half this system's colour lives**, so the
 *      four properties are measured on `::before` and `::after` too, whenever
 *      those generate a box. `StatusDot` is an empty span that is entirely its
 *      `::before`; `SectionLabel`'s hairline is an `::after`. Reading only the
 *      element would report a status dot as an unpainted transparent box.
 *

 * Nothing here imports React or touches the overlay: it takes an `Element` and
 * returns data. That is what makes it testable, and `inspector-probe.test.ts`
 * records exactly which half of it jsdom can and cannot verify.
 */

/** The four paint properties. Everything else on screen is geometry. */
export const PROBED_PROPERTIES = [
  'background-color',
  'border-color',
  'color',
  'outline-color',
] as const;

export type ProbedProperty = (typeof PROBED_PROPERTIES)[number];

/**
 * The two sentinels.
 *
 * Wildly distinctive so a partial mix still separates them: at `fillHover`'s 6%
 * these become `rgba(255, 0, 128, .06)` and `rgba(0, 255, 128, .06)`, which are
 * still different strings. Two colours that differed only in luminance would
 * collapse to the same rounded value through a low-alpha `color-mix`.
 */
export const PROBE_A = 'rgb(255, 0, 128)';
export const PROBE_B = 'rgb(0, 255, 128)';

/** The one thing this module needs from the environment. */
export interface ComputedReader {
  getPropertyValue(property: string): string;
}

/**
 * How a computed style is read.
 *
 * Injectable for exactly one reason, and it is a jsdom fact rather than a design
 * preference: **jsdom does not substitute `var()`.** `getComputedStyle(el)
 * .backgroundColor` returns the literal string `"var(--sh-surface)"` however the
 * variable is set, so the probe can never move it and every finding would be
 * "no role" — a test suite that passes vacuously. jsdom DOES resolve the custom
 * property cascade itself (`getPropertyValue('--sh-surface')` correctly returns a
 * scoped re-declaration's value), so the test supplies a reader that performs the
 * substitution jsdom omits and the rest of this file is exercised for real. See
 * the test's own header for what that does and does not prove.
 */
export type ReadComputed = (element: Element, pseudo: string | null) => ComputedReader;

const defaultRead: ReadComputed = (element, pseudo) => getComputedStyle(element, pseudo);

export interface ProbeOptions {
  /** Defaults to every role. Narrowing it is for tests and for speed. */
  readonly roles?: readonly RoleName[];
  readonly read?: ReadComputed;
}

export interface RoleFinding {
  readonly property: ProbedProperty;
  /**
   * `null` for the element itself, `'::before'` / `'::after'` for a pseudo that
   * generates a box. In this design system that is not an edge case: a
   * `StatusDot` IS its `::before`, and a `SectionLabel`'s rule IS its `::after`.
   */
  readonly pseudo: string | null;
  /** The resting computed value, read with every probe restored. */
  readonly value: string;
  /** The role that paints it, or `null` — the honest failure. */
  readonly role: RoleName | null;
  /**
   * Other roles whose probe also moved this property: the ones the winner is
   * built from (`fillHover` → `text`), upstream-last.
   */
  readonly via: readonly RoleName[];
  /**
   * The tier-1 palette token painting it when no role does. Private by design,
   * which is the finding: a call site on tier 1 is a call site an extension's
   * theme cannot move.
   */
  readonly paletteToken: ColorToken | null;
  /**
   * Where the winning role's value is DECIDED — `documentElement` normally, and
   * the re-declaring ancestor inside a scoped subtree (spec §2). Null when
   * nothing was found to decide.
   */
  readonly declaredOn: Element | null;
  /**
   * Where the CSS rule that consumes the role lives. Differs from the element
   * for an inherited property (`color` on a child of the element that declared
   * it), which is itself worth seeing.
   */
  readonly paintedOn: Element | null;
  /**
   * Whether this property reaches the screen at all.
   *
   * A DEFECT IN THIS TOOL, found by running it against the real app in Chromium
   * and worth keeping written down: `border-color` and `outline-color` both
   * initialise to `currentColor`, so every element on the page has a resolved
   * border colour — including the several hundred that draw no border. The first
   * audit therefore reported "border-color: not painted by any role" for
   * literally every element, which is *true* and completely useless, and a tool
   * whose honest verdict is buried under four hundred honest non-verdicts has
   * failed at the only thing it is for.
   *
   * So the property is still measured and still reported, and this flag says
   * whether the answer means anything. Not dropped: "border-color resolves to
   * your text colour and no border is drawn" is a real thing to know when you
   * expected a hairline.
   */
  readonly drawn: boolean;
}

/** An element with an inline style — everything in an HTML/SVG tree. */
type Styled = Element & ElementCSSInlineStyle;

function isStyled(element: Element): element is Styled {
  return 'style' in element;
}

/** `[element, parent, …, documentElement]`. The probe writes to all of it. */
export function ancestorChain(element: Element): Styled[] {
  const chain: Styled[] = [];
  let current: Element | null = element;
  while (current !== null) {
    if (isStyled(current)) chain.push(current);
    current = current.parentElement;
  }
  return chain;
}

interface Saved {
  readonly element: Styled;
  readonly attribute: string | null;
}

/**
 * Remember each element's whole `style` ATTRIBUTE and hand back the undo.
 *
 * The inline layer, deliberately: the probe is written inline (it has to win
 * over the stylesheet rule it is testing), so the restore has to put back the
 * inline layer and nothing else. Restoring a value read from the *computed*
 * style would pin every probed element to whatever it resolved to at that
 * instant — the cascade would be frozen, `:root`'s theme swap would stop
 * reaching them, and a dev tool would have permanently changed the app it was
 * measuring. `documentElement` is always in the chain and always already carries
 * inline custom properties (`applyThemeVariables` sets the whole token map
 * there), so this is not a hypothetical.
 *
 * The whole attribute rather than the one property, and that is a measured
 * correction rather than convenience: `style.removeProperty` on an element with
 * no `style` attribute CREATES an empty one (`style=""`), and touching `.style`
 * at all re-serializes an existing attribute (a trailing `;` appears). Both were
 * caught by the restore tests. Neither changes a pixel, and both are a trace —
 * `[style]` is a legal selector, `react-grab` and a diffed DOM snapshot both read
 * the attribute, and an inspector that edits the page it reports on is the one
 * kind of bug this tool could not be used to find.
 */
function save(chain: readonly Styled[]): () => void {
  const saved: Saved[] = chain.map((element) => ({
    element,
    attribute: element.getAttribute('style'),
  }));
  return () => {
    for (const entry of saved) {
      if (entry.attribute === null) entry.element.removeAttribute('style');
      else entry.element.setAttribute('style', entry.attribute);
    }
  };
}

/**
 * Stop every transition in the document, and hand back the undo.
 *
 * **This is the defect that would have made the whole tool lie**, found by
 * running it against the real app and not findable any other way. `.sh-ui-row`
 * declares `transition: color 140ms linear`. `getComputedStyle` during a running
 * transition returns the *interpolated* value, so a probe that writes the
 * sentinel and reads back immediately gets the colour the property is
 * transitioning FROM — the old one — twice. Both sentinels read identical, the
 * diff is empty, and the finding is "not painted by any role."
 *
 * Which means the tool reported `no role` for every `Button`, every `Row`, every
 * `Field` and every `IconButton` — precisely the primitives it exists to explain
 * — while reporting correctly for the handful of shell rules that happen to
 * declare no transition. A false negative that is *selective* and looks exactly
 * like a real finding is the worst outcome this file could have.
 *
 * (It also would not reproduce on a machine set to reduced motion, where the
 * shell's own `* { transition: none !important }` media query already does this.)
 *
 * The fix is the mechanism the design system already has for the same problem:
 * `tokens.css`'s `.sh-no-transitions`, which exists because a theme swap would
 * otherwise animate every colour in the window at slightly different times. This
 * is that rule, injected rather than borrowed, so the probe does not depend on
 * `@shepherd/ui`'s stylesheet being loaded in whatever page it runs in.
 *
 * ANIMATIONS are deliberately left running, exactly as `.sh-no-transitions`
 * leaves them: freezing them stops every spinner mid-frame. A colour driven by
 * an `@keyframes` would still defeat the probe; nothing in this app has one, and
 * the honest place to record that is here.
 */
function freezeTransitions(element: Element): () => void {
  const doc = element.ownerDocument;
  const style = doc.createElement('style');
  style.dataset['shInspector'] = 'freeze';
  style.textContent = '*, *::before, *::after { transition: none !important; }';
  (doc.head ?? doc.documentElement).append(style);
  // Force the new rule to take effect before the first probe is written. Without
  // it the first read can still be mid-transition from whatever the page was
  // already doing.
  doc.documentElement.getBoundingClientRect();
  return () => style.remove();
}

function write(chain: readonly Styled[], name: string, value: string): void {
  // `important`, because a scoped re-declaration in the chain may itself be
  // `!important` and a probe that loses the cascade reads as "this role does not
  // paint anything" — a false negative, which is the one error class this whole
  // file is arranged to avoid.
  for (const element of chain) element.style.setProperty(name, value, 'important');
}

/** One measurable thing: a property, on the element or on one of its pseudos. */
interface Slot {
  readonly pseudo: string | null;
  readonly property: ProbedProperty;
}

const slotKey = (slot: Slot): string => `${slot.pseudo ?? ''}|${slot.property}`;

/**
 * The pseudo-elements that actually paint, plus the element itself.
 *
 * `::before` and `::after` are not decoration in THIS design system — they are
 * where the colour is. `StatusDot` is an empty span whose entire visible self is
 * a `::before`; `SectionLabel`'s hairline rule is an `::after`; `Button`'s
 * coarse-pointer hit target is a third. A probe that read only the element would
 * report a status dot as "background-color: transparent, no role", which is both
 * true and a lie about the thing on screen.
 *
 * Only pseudos with real `content` are measured. Every element has a `::before`
 * as far as `getComputedStyle` is concerned; one with `content: none` generates
 * no box and reporting on it would restore exactly the noise `drawn` was added
 * to remove.
 */
function paintedSlots(element: Element, read: ReadComputed): Slot[] {
  const pseudos: Array<string | null> = [null];
  for (const pseudo of ['::before', '::after']) {
    const content = read(element, pseudo).getPropertyValue('content');
    if (content !== '' && content !== 'none' && content !== 'normal') pseudos.push(pseudo);
  }
  return pseudos.flatMap((pseudo) =>
    PROBED_PROPERTIES.map((property) => ({ pseudo, property })),
  );
}

function readAll(
  element: Element,
  slots: readonly Slot[],
  read: ReadComputed,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const slot of slots) {
    out.set(slotKey(slot), read(element, slot.pseudo).getPropertyValue(slot.property));
  }
  return out;
}

/**
 * Which slots this variable moves.
 *
 * One save, two writes, one restore. No paint happens between them — style
 * recalculation is synchronous on read but the frame is not committed until the
 * task ends — so the app does not flash magenta while it is being measured.
 *
 * The probe is written on the ELEMENT chain even for a pseudo's slot, and that
 * is not a shortcut: a pseudo-element inherits custom properties from the element
 * that originates it, so `--sh-success` set on a `StatusDot` reaches its
 * `::before` exactly as the stylesheet's own value does.
 */
function moves(
  element: Element,
  chain: readonly Styled[],
  slots: readonly Slot[],
  varName: string,
  read: ReadComputed,
): Set<string> {
  const restore = save(chain);
  write(chain, varName, PROBE_A);
  const first = readAll(element, slots, read);
  write(chain, varName, PROBE_B);
  const second = readAll(element, slots, read);
  restore();

  const moved = new Set<string>();
  for (const slot of slots) {
    const key = slotKey(slot);
    if (first.get(key) !== second.get(key)) moved.add(key);
  }
  return moved;
}

/**
 * Every role `role` is built out of, transitively — `fillHover` → `text`.
 *
 * Read off `roles.ts`'s own `of` links rather than restated, so a role added
 * there is disambiguated here with no edit. Cycle-safe by the `seen` set: an
 * alias loop is a build-time mistake `roleToken` already throws on, and the
 * inspector must not be the thing that hangs because of it.
 */
export function roleDependencies(role: RoleName): Set<RoleName> {
  const out = new Set<RoleName>();
  let current = roles[role];
  while (current.kind !== 'token') {
    if (out.has(current.of)) break;
    out.add(current.of);
    current = roles[current.of];
  }
  return out;
}

/**
 * The nearest ancestor (inclusive) at which this custom property's computed
 * value stops matching its parent's — i.e. the element that DECIDES it.
 *
 * Custom properties inherit, so a difference across a parent/child edge can only
 * come from a declaration at the child. Walking to the top and finding no
 * difference means the value comes from `:root`, which is what is returned.
 *
 * Two honest caveats, both worth knowing before trusting an answer:
 *   - A browser substitutes `var()` inside a custom property's computed value,
 *     so an ALIAS or WASH (`--sh-fill-hover`) reports the ancestor that
 *     re-declared the role it references (`--sh-text`) rather than `:root` where
 *     the wash itself is declared. That is the more useful answer — it names the
 *     scope the value comes from — but it is not "where the line of CSS is".
 *   - jsdom does not substitute, so there it reports `:root` for those. The test
 *     therefore pins the direct case, which both agree on.
 */
export function declaringElement(
  element: Element,
  varName: string,
  read: ReadComputed = defaultRead,
): Element | null {
  let current: Element | null = element;
  while (current !== null) {
    const parent: Element | null = current.parentElement;
    if (parent === null) return current;
    const mine = read(current, null).getPropertyValue(varName).trim();
    const theirs = read(parent, null).getPropertyValue(varName).trim();
    if (mine !== theirs) return current;
    current = parent;
  }
  return null;
}

/**
 * The innermost element whose own rule consumes the variable.
 *
 * Found by widening the probe one ancestor at a time until the property moves:
 * with the sentinel on the element alone, an inherited `color` does not budge;
 * add the element that declared `color: var(--sh-text)` and it does. The last
 * element added is that declaration's home.
 */
function paintSite(
  element: Element,
  chain: readonly Styled[],
  varName: string,
  slot: Slot,
  read: ReadComputed,
): Element | null {
  for (let depth = 1; depth <= chain.length; depth += 1) {
    const slice = chain.slice(0, depth);
    const restore = save(slice);
    write(slice, varName, PROBE_A);
    const first = read(element, slot.pseudo).getPropertyValue(slot.property);
    write(slice, varName, PROBE_B);
    const second = read(element, slot.pseudo).getPropertyValue(slot.property);
    restore();
    if (first !== second) return chain[depth - 1] ?? null;
  }
  return null;
}

/**
 * Zero alpha, in whichever notation the engine serialized.
 *
 * Chromium answers `rgba(0, 0, 0, 0)` for `transparent`, and `color(srgb r g b /
 * 0)` for a zero-alpha `color-mix` — which is not a hypothetical here, since
 * every tint in this app is a `color-mix`. Anything unrecognised counts as
 * opaque: the failure to avoid is silently hiding a finding.
 */
function isTransparent(value: string): boolean {
  const text = value.trim();
  if (text === '' || text === 'transparent') return text === 'transparent';
  const alpha = /(?:,|\/)\s*(0|0?\.0+)\s*\)$/.exec(text);
  return alpha !== null;
}

/**
 * Does this property actually reach the screen?
 *
 * `background-color` and `color` always do. The other two are conditional on a
 * width and a style, and both are `currentColor` by default — see `drawn`.
 *
 * Unparseable widths (jsdom answers `''` for most of them) count as DRAWN. The
 * failure to avoid is hiding a real finding behind a measurement this function
 * could not take; the cost of the other direction is a row that says "no role"
 * about an edge nobody can see.
 */
function isDrawn(property: ProbedProperty, style: ComputedReader): boolean {
  if (property === 'color') return true;
  // A fully transparent background is not a colour nobody chose a role for — it
  // is a surface that paints nothing, which is the normal state of most elements
  // in a flat language. Reported as a finding it reads as a defect, and the whole
  // value of the `no role` verdict is that it is never crying wolf.
  if (property === 'background-color') {
    return !isTransparent(style.getPropertyValue('background-color'));
  }
  const sides =
    property === 'outline-color'
      ? ['outline']
      : ['border-top', 'border-right', 'border-bottom', 'border-left'];
  return sides.some((side) => {
    const width = style.getPropertyValue(`${side}-width`);
    const lineStyle = style.getPropertyValue(`${side}-style`);
    if (width === '') return true;
    if (lineStyle === 'none' || lineStyle === 'hidden') return false;
    return Number.parseFloat(width) > 0;
  });
}

/**
 * Measure which role paints each of an element's four colour properties.
 *
 * Every probe is restored before returning, including on the paths that find
 * nothing, and transitions are frozen for the duration — see
 * `freezeTransitions`, which is the difference between this tool working and
 * this tool confidently reporting `no role` for every primitive in the set.
 */
export function probeRoles(element: Element, options: ProbeOptions = {}): RoleFinding[] {
  const read = options.read ?? defaultRead;
  const candidates = options.roles ?? roleNames;
  const chain = ancestorChain(element);
  const thaw = freezeTransitions(element);
  try {
    return measure(element, chain, candidates, read);
  } finally {
    // `finally`, because a throw mid-probe that left the page frozen would stop
    // every animation in the app with nothing on screen saying why.
    thaw();
  }
}

function measure(
  element: Element,
  chain: readonly Styled[],
  candidates: readonly RoleName[],
  read: ReadComputed,
): RoleFinding[] {
  const slots = paintedSlots(element, read);
  const resting = readAll(element, slots, read);

  const movedBy = new Map<RoleName, Set<string>>();
  for (const role of candidates) {
    const moved = moves(element, chain, slots, roleVarName(role), read);
    if (moved.size > 0) movedBy.set(role, moved);
  }

  return slots.map((slot) => {
    const key = slotKey(slot);
    const drawn = isDrawn(slot.property, read(element, slot.pseudo));
    const hits = candidates.filter((role) => movedBy.get(role)?.has(key) === true);
    // A role reached only THROUGH another candidate is not the answer; it is how
    // the answer is built. `fillHover` survives, `text` becomes `via`.
    const direct = hits.filter(
      (role) => !hits.some((other) => other !== role && roleDependencies(other).has(role)),
    );
    const role = direct[0] ?? null;
    const via = hits.filter((candidate) => candidate !== role);
    const shared = {
      property: slot.property,
      pseudo: slot.pseudo,
      value: resting.get(key) ?? '',
      drawn,
    };

    if (role === null) {
      // The honest failure, made actionable: name the private token if one
      // explains it, so the report is "you are on tier 1" rather than "unknown".
      const token =
        colorTokens.find((candidate) =>
          moves(element, chain, slots, cssVarName(candidate), read).has(key),
        ) ?? null;
      return {
        ...shared,
        role: null,
        via: [],
        paletteToken: token,
        declaredOn: token === null ? null : declaringElement(element, cssVarName(token), read),
        paintedOn: token === null ? null : paintSite(element, chain, cssVarName(token), slot, read),
      };
    }

    const varName = roleVarName(role);
    return {
      ...shared,
      role,
      via,
      paletteToken: null,
      declaredOn: declaringElement(element, varName, read),
      paintedOn: paintSite(element, chain, varName, slot, read),
    };
  });
}

/**
 * `div.sh-ui-row[data-testid="task-row"]` — an element in one line.
 *
 * `data-testid` is included because it is the name the smokes and the plans use
 * for a surface, so it is the name a report about that surface should carry.
 */
export function describeElement(element: Element | null): string {
  if (element === null) return '—';
  if (element === element.ownerDocument.documentElement) return ':root';
  const tag = element.tagName.toLowerCase();
  const id = element.id === '' ? '' : `#${element.id}`;
  const classes = [...element.classList].slice(0, 2).map((name) => `.${name}`).join('');
  const testid = element.getAttribute('data-testid');
  return `${tag}${id}${classes}${testid === null ? '' : `[${testid}]`}`;
}
