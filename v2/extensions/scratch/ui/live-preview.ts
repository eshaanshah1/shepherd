import { type EditorState, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { CheckboxWidget } from './checkbox-widget.ts';

/**
 * Live preview: the document is always exact text, and what changes is how it
 * is DRAWN.
 *
 * The rule, once: **a construct renders raw when the selection touches it.**
 * The unit differs by kind, and it has to —
 *
 *   - a BLOCK construct uses the LINE, because a heading whose `#` vanished
 *     while you were typing on that line would shift the text under the caret;
 *   - an INLINE construct uses the NODE, because a line with three bolds on it
 *     should not go entirely raw to edit one of them.
 *
 * Raw is implemented by NOT DESCENDING (`enter` returning false) rather than by
 * a suppression flag: a construct we have decided to leave alone is one whose
 * children we must also leave alone, and those are the same statement.
 *
 * Cost is bounded by the viewport rather than the document — the walk covers
 * `view.visibleRanges`.
 */

/** Constructs whose raw form is revealed a whole line at a time. */
const BLOCK_CLASS: Readonly<Record<string, string>> = {
  ATXHeading1: 'sh-scratch-h1',
  ATXHeading2: 'sh-scratch-h2',
  ATXHeading3: 'sh-scratch-h3',
  ATXHeading4: 'sh-scratch-h4',
  ATXHeading5: 'sh-scratch-h5',
  ATXHeading6: 'sh-scratch-h6',
  Blockquote: 'sh-scratch-quote',
  FencedCode: 'sh-scratch-fence',
};

/** Marker text that disappears entirely once its construct renders. */
const MARKER_NODES = new Set([
  'HeaderMark',
  'QuoteMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'LinkMark',
]);

const INLINE_CLASS: Readonly<Record<string, string>> = {
  StrongEmphasis: 'sh-scratch-strong',
  Emphasis: 'sh-scratch-em',
  Strikethrough: 'sh-scratch-strike',
  InlineCode: 'sh-scratch-code',
  Link: 'sh-scratch-link',
  URL: 'sh-scratch-link',
};

/** A list item that is a task: its marker is the checkbox, not the bullet. */
const TASK_LINE = /^\s*[-*+]\s+\[[ xX]\]/;
/** An unordered list marker. Ordered ones keep their digits. */
const BULLET_MARK = /^[-*+]$/;

const hide = Decoration.replace({});

/**
 * The bullet a `-` draws as.
 *
 * Module-local rather than its own file because it has no behaviour to test in
 * isolation — it is one glyph, and what is worth asserting about it is that the
 * decoration builder emits it, which `live-preview.test.ts` does.
 */
class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'sh-scratch-bullet';
    span.textContent = '•';
    return span;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** What `---` draws as, so the dashes are not shown next to the rule. */
class RuleWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const rule = document.createElement('span');
    rule.className = 'sh-scratch-rule';
    return rule;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });

/**
 * A marker plus the space after it.
 *
 * `HeaderMark` is `#`, not `# ` — so hiding the node alone leaves the heading
 * text indented by one character, which is visible and wrong at h1 size. The
 * space belongs to the marker for drawing purposes even though the grammar
 * gives it to neither.
 */
function throughSpace(state: EditorState, from: number, to: number): number {
  const line = state.doc.lineAt(from);
  let end = to;
  while (end < line.to && state.doc.sliceString(end, end + 1) === ' ') end += 1;
  return end;
}

/** Does any selection range touch `[from, to]`? Inclusive at both ends. */
function touches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

/** Does any selection range touch any line that `[from, to]` spans? */
function touchesLines(state: EditorState, from: number, to: number): boolean {
  const first = state.doc.lineAt(Math.min(from, state.doc.length));
  const last = state.doc.lineAt(Math.min(to, state.doc.length));
  return touches(state, first.from, last.to);
}

export function buildDecorations(
  state: EditorState,
  spans: readonly { from: number; to: number }[] = [{ from: 0, to: state.doc.length }],
): DecorationSet {
  /*
   * Collected and SORTED rather than pushed into a `RangeSetBuilder`.
   *
   * A builder requires adds in `from` order, and a syntax walk cannot give it
   * one: `**hi**` decorates the whole node at 0 and then hides its marker, also
   * at 0, with a different side. `Decoration.set(…, true)` sorts, which is the
   * only ordering that survives nesting.
   */
  const found: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  for (const span of spans) {
    tree.iterate({
      from: span.from,
      to: span.to,
      enter: (node) => {
        const blockClass = BLOCK_CLASS[node.name];
        if (blockClass !== undefined) {
          if (touchesLines(state, node.from, node.to)) return false;
          found.push(Decoration.line({ class: blockClass }).range(node.from));
          return true;
        }

        if (node.name === 'HorizontalRule') {
          if (touchesLines(state, node.from, node.to)) return false;
          found.push(rule.range(node.from, node.to));
          return false;
        }

        if (node.name === 'TaskMarker') {
          if (touchesLines(state, node.from, node.to)) return false;
          // The marker is `[ ]` or `[x]`; the character is one in from the left.
          const at = node.from + 1;
          const checked = state.doc.sliceString(at, at + 1).toLowerCase() === 'x';
          found.push(Decoration.replace({ widget: new CheckboxWidget(checked, at) }).range(node.from, node.to));
          return false;
        }

        if (node.name === 'ListMark') {
          if (touchesLines(state, node.from, node.to)) return false;
          const line = state.doc.lineAt(node.from);
          // A task's marker is its checkbox. Drawing a bullet as well would
          // give every checkbox a redundant dot in front of it.
          if (TASK_LINE.test(line.text)) {
            found.push(hide.range(node.from, throughSpace(state, node.from, node.to)));
            return false;
          }
          // An ordered list keeps its digits: `1.` already reads as a marker,
          // and replacing it would lose the number the user is counting with.
          if (!BULLET_MARK.test(state.doc.sliceString(node.from, node.to))) return false;
          found.push(bullet.range(node.from, node.to));
          return false;
        }

        if (MARKER_NODES.has(node.name)) {
          if (touches(state, node.from, node.to)) return false;
          /*
           * A HEADER or QUOTE mark takes the space after it; an emphasis or code
           * mark must not, because the character after `**` is the text.
           */
          const to =
            node.name === 'HeaderMark' || node.name === 'QuoteMark'
              ? throughSpace(state, node.from, node.to)
              : node.to;
          found.push(hide.range(node.from, to));
          return false;
        }

        /*
         * A `URL` is two different things wearing one node name.
         *
         * Inside a `Link` it is the DESTINATION of `[text](url)`, and it has to
         * be hidden — the whole point of the construct is that you see the text
         * and not the address. Standing on its own it is an autolink, where the
         * address IS the text, and hiding it would delete the line.
         */
        if (node.name === 'URL' && node.node.parent?.name === 'Link') {
          if (touches(state, node.from, node.to)) return false;
          found.push(hide.range(node.from, node.to));
          return false;
        }

        const inlineClass = INLINE_CLASS[node.name];
        if (inlineClass === undefined) return true;
        if (touches(state, node.from, node.to)) return false;
        found.push(Decoration.mark({ class: inlineClass }).range(node.from, node.to));
        return true;
      },
    });
  }

  return Decoration.set(found, true);
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state, view.visibleRanges);
    }

    update(update: ViewUpdate): void {
      // `selectionSet` is as load-bearing as `docChanged`: moving the caret is
      // what reveals and hides a construct, and nothing else reports that it
      // moved.
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.state, update.view.visibleRanges);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
    /*
     * Hidden ranges must be ATOMIC, or an arrow key steps into a zero-width
     * replaced range and the caret appears stuck.
     */
    provide: (plug) =>
      EditorView.atomicRanges.of((view) => view.plugin(plug)?.decorations ?? Decoration.none),
  },
);

export const livePreview: Extension = [plugin];
