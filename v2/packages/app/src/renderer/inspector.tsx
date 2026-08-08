import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Card, KeyCap, Row, SectionLabel } from '@shepherd/ui';
import { describeElement, probeRoles, type RoleFinding } from './inspector-probe.ts';
import './inspector.css';

/**
 * The token inspector — design-system spec §4, and the last piece of that plan.
 *
 * **Why it exists.** The people writing UI in this codebase, agents included,
 * cannot see which role paints a surface. Every wrong colour the project has
 * shipped was a guess, and the review loop for a guess is the user pointing at a
 * screenshot. This answers "which token do I use here" by measurement — hover an
 * element, read the role names painting its background, border, foreground and
 * outline, with the value and the place the value is decided. It is also the
 * answer an extension author gets, which is why it reports ROLES (tier 2, the
 * public vocabulary) and names a palette token only to say you are on the
 * private tier by mistake.
 *
 * **⌘⇧I, handled in the page.** Never a menu accelerator: AppKit resolves a key
 * equivalent before the web contents ever see the event, so a menu item here
 * would be `⌘⇧I` deleted from every terminal in the app — the rule
 * `menu-template.ts` and `view-overlay.tsx` are both built on. `⌘⌥I` is
 * Electron's `toggleDevTools` role and is left alone. The listener is in the
 * CAPTURE phase because a terminal has focus almost always and xterm handles
 * keydown on the way down.
 *
 * **Dev-only, by a build-time constant.** `main.tsx` imports this module behind
 * `import.meta.env.DEV`, which is statically false in a production bundle, so
 * the import — and this file's stylesheet — is dropped rather than shipped and
 * skipped. Same treatment as `react-grab`, for the same reason (§6: dev/prod
 * isolation applies to tooling too). It follows that nothing about the shipped
 * app changes, that `window.capture` photographs a window this panel is not in,
 * and that the smokes cannot see it: it is off by default even in dev.
 *
 * **It does not touch the app it measures.** The overlay is a separate React
 * root over a `pointer-events: none` container, so no hover, focus or cursor
 * moves because the inspector is open; the probe restores the exact `style`
 * attribute of every element it wrote to; and the one thing it does hold is the
 * click, which is what "click to pin" means.
 */

interface Report {
  readonly element: Element;
  readonly description: string;
  readonly rect: DOMRect;
  readonly findings: readonly RoleFinding[];
}

/** Ours? Then it is chrome, not a subject — no probing, no pinning. */
function isOverlay(node: EventTarget | null): boolean {
  return node instanceof Element && node.closest('[data-sh-inspector]') !== null;
}

export function Inspector(): ReactElement | null {
  const [active, setActive] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [side, setSide] = useState<'left' | 'right'>('right');
  /*
   * The element last hovered, in a ref rather than in state.
   *
   * Measuring is a DOM write-then-restore and it must not be a render input:
   * kept in state, every mousemove over the same element would re-probe on the
   * next render. The ref lets `measure` bail on "same element as last time",
   * which is what makes hovering a row cost one probe instead of forty.
   */
  const subject = useRef<Element | null>(null);
  /** `active`, readable from a listener registered once. See the Esc guard. */
  const open = useRef(false);
  open.current = active;

  const measure = useCallback((element: Element): void => {
    subject.current = element;
    setReport({
      element,
      description: describeElement(element),
      rect: element.getBoundingClientRect(),
      findings: probeRoles(element),
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // `code`, not `key`: with ⇧ held the character is `I`, and on a
      // non-US layout it may be something else entirely. The physical key is
      // what a shortcut means.
      if (event.metaKey && event.shiftKey && event.code === 'KeyI') {
        // Swallowed, or the keystroke also reaches the focused terminal and the
        // agent in it receives a stray ⇧I.
        event.preventDefault();
        event.stopPropagation();
        setActive((current) => !current);
        return;
      }
      // Guarded on being open, so this is NOT a global Esc handler the terminal
      // never asked for — `view-overlay.tsx` records exactly that defect. The
      // guard reads a ref rather than deciding inside a state updater: an updater
      // must be pure, and React invokes it twice under StrictMode, which would
      // make `preventDefault` fire twice for one keystroke.
      if (event.key === 'Escape' && open.current) {
        event.preventDefault();
        event.stopPropagation();
        setActive(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Leaving the mode forgets everything, so re-entering starts clean rather
  // than on a stale rect from wherever the pointer was last time.
  useEffect(() => {
    if (active) return;
    setPinned(false);
    setReport(null);
    subject.current = null;
  }, [active]);

  useEffect(() => {
    if (!active) return;

    const onMove = (event: MouseEvent): void => {
      setSide(event.clientX > window.innerWidth * 0.55 ? 'left' : 'right');
      if (pinned || isOverlay(event.target)) return;
      const element = event.target;
      if (!(element instanceof Element) || element === subject.current) return;
      measure(element);
    };

    /*
     * The click is TAKEN, in the capture phase, and that is the mode's whole
     * cost: while the inspector is open the app is a picture. Anything less —
     * pinning on a modifier, say — means a click that both pins and activates
     * whatever it landed on, which in this app could be a pane close button.
     */
    const onClick = (event: MouseEvent): void => {
      if (isOverlay(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const element = event.target;
      if (element instanceof Element && element !== subject.current) measure(element);
      setPinned((current) => !current);
    };

    const root = document.documentElement;
    root.dataset['shInspecting'] = 'true';
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    return () => {
      delete root.dataset['shInspecting'];
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
    };
  }, [active, pinned, measure]);

  if (!active) return null;

  return (
    <div className="sh-insp" data-sh-inspector="" data-testid="token-inspector">
      {report !== null && (
        <div
          className="sh-insp-box"
          data-pinned={pinned ? 'true' : 'false'}
          style={{
            left: report.rect.left,
            top: report.rect.top,
            width: report.rect.width,
            height: report.rect.height,
          }}
        />
      )}
      <Card
        className="sh-insp-panel"
        data-side={side}
        data-pinned={pinned ? 'true' : 'false'}
        data-testid="token-inspector-panel"
        header={
          <span className="sh-insp-head">
            <span className="sh-insp-target">{report?.description ?? 'hover anything'}</span>
            <SectionLabel rule={false}>{pinned ? 'pinned' : 'roles'}</SectionLabel>
          </span>
        }
      >
        {/* The rows scroll; the legend below them does not, or the one line
            telling you how to get out disappears on a busy element. */}
        <div className="sh-insp-rows">
          {report === null
            ? null
            : report.findings.map((finding) => (
                <FindingRow key={`${finding.pseudo ?? ''}${finding.property}`} finding={finding} />
              ))}
        </div>
        <p className="sh-insp-foot">
          <KeyCap>⌘⇧I</KeyCap> close · click to {pinned ? 'unpin' : 'pin'} · <KeyCap>esc</KeyCap>
        </p>
      </Card>
    </div>
  );
}

/**
 * One property, one row.
 *
 * `Row`, the primitive, because this is exactly what it is for: a fixed-height
 * line with a 12×12 leading slot whose contents vary. The occupant here is a
 * colour swatch rather than a `StatusDot` — the dot takes a status ROLE
 * (`working`, `danger`, …) and the measured colour is not one of the five, so
 * asking for one would be inventing a sixth status to mean "this colour".
 */
function FindingRow({ finding }: { readonly finding: RoleFinding }): ReactElement {
  /*
   * The three answers, in the order of how much they tell you:
   *
   *   a role         — the thing you came for.
   *   a palette token — no role explains it, but something private does. This is
   *                     the defect §2 names: a call site on tier 1 is a call
   *                     site an extension's theme cannot move.
   *   nothing         — a hardcoded colour, an inline style, or a property
   *                     nothing paints. Said plainly, because a tool that
   *                     reported the nearest match here would be worse than no
   *                     tool: the whole value is that this verdict is trusted.
   */
  const missing = finding.role === null && finding.drawn;
  const name = !finding.drawn
    ? 'not drawn'
    : (finding.role ??
      (finding.paletteToken === null ? 'no role' : `no role · --sh-${finding.paletteToken}`));
  const where = describeElement(finding.declaredOn);
  const painted = describeElement(finding.paintedOn);

  return (
    <Row
      data-testid="token-inspector-finding"
      data-property={finding.property}
      data-pseudo={finding.pseudo ?? ''}
      data-role={finding.role ?? ''}
      // `border-color` and `outline-color` are `currentColor` by default, so an
      // element that draws no edge still HAS one of each. Dimmed rather than
      // hidden: the row rhythm is four properties, always, and "there is no
      // border here" is the answer when you expected a hairline.
      data-drawn={finding.drawn ? 'true' : 'false'}
      leading={
        <span
          className="sh-insp-swatch"
          // Inline, and the one inline colour in this codebase that is correct:
          // it is the value that was MEASURED, not a value that was chosen.
          style={{ background: finding.value }}
        />
      }
      meta={
        <span className="sh-insp-meta">
          {finding.value === '' ? '—' : finding.value}
          {' · '}
          {/* Where the value is decided. `:root` most of the time, and a
              re-declaring ancestor inside a scoped subtree — which is the case
              that makes this line worth the width (spec §2). */}
          <span className="sh-insp-where" title={`declared on ${where}, consumed by ${painted}`}>
            {where}
          </span>
        </span>
      }
    >
      <span className="sh-insp-prop">
        {finding.property.replace('-color', '')}
        {/* A `StatusDot` is its `::before` and nothing else, so the pseudo is
            part of the property's name here rather than a footnote. */}
        {finding.pseudo !== null && <span className="sh-insp-pseudo">{finding.pseudo}</span>}
      </span>
      <span className="sh-insp-role" data-missing={missing ? 'true' : 'false'}>
        {name}
      </span>
      {finding.via.length > 0 && <span className="sh-insp-via"> via {finding.via.join(', ')}</span>}
    </Row>
  );
}

/**
 * Mount the inspector into its own React root.
 *
 * Its own root rather than a node in `App`, and that is the gate working
 * properly rather than a shortcut: `main.tsx` reaches this through a dynamic
 * import behind `import.meta.env.DEV`, so the module is dropped from a
 * production build entirely. A `<Inspector/>` element inside `App` would be
 * statically imported and therefore shipped — inert, but shipped — and `App`
 * would gain a child that exists only in one build configuration, which its
 * tests would then have to know about.
 */
export function mountInspector(): void {
  const host = document.createElement('div');
  // The same attribute `isOverlay` looks for, on the host too: a click that lands
  // on the root rather than on the panel inside it is still ours, and treating it
  // as a subject would make the inspector report on itself.
  host.dataset['shInspector'] = 'root';
  document.body.append(host);
  createRoot(host).render(<Inspector />);
}
