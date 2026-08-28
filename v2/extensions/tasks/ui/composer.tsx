import { useEffect, useId, useRef, useState } from "react";
import type { ExtensionViewProps } from "@shepherd/sdk";
import { Icon, Menu, PromptField, namedGlyph, type MenuEntry, type PromptFieldHandle } from "@shepherd/ui";
import { firstLine } from "../src/model/naming.ts";
import { repoName } from "../src/model/repo-name.ts";
import type { PastedImage } from "../src/images.ts";
import { readPastedImage } from "./paste-image.ts";
import { findTrigger, isUnwritten, type DisplaySegment } from "./mention.ts";
import {
  claimedVendor,
  dressPill,
  linkPill,
  readLink,
  readPatterns,
} from "./link-paste.ts";
import { TASK_COMMANDS, type PastedLinkPattern } from "../src/manifest.ts";
import { RepoPicker, rowId, type PickerRow } from "./repo-picker.tsx";

/**
 * The composer — a task, created from inside the app (sketch §4).
 *
 * It is a **consumer** of the component view kind (ADR 0033) and nothing else:
 * every line below is React and two command invocations, and the core knows
 * none of it. That is the same test P6b's task tree had to pass — if a form had
 * needed a special case in the shell, the §2b bar would have been missed, and
 * the shell would now contain the words "title", "brief" and "repo".
 *
 * Three things it deliberately does not do:
 *
 *   - It does not rank repos, and it does not read a directory. `tasks
 *     .suggestRepos` asks the extension — the side that holds the history and
 *     can touch a disk — and gets back rows that already know their order and
 *     which characters matched. A view that re-ran the matcher would be a second
 *     chance to disagree with whatever did the ordering.
 *   - It does not provision anything, or know that provisioning exists.
 *     `tasks.create` returns as soon as the record does (D12), and the worktrees
 *     land behind it; the tree reports their progress, because that is the view
 *     whose job is state.
 *   - It cannot say who it is. `invoke` carries no caller — main attributes the
 *     call to `shepherd.tasks`, which is what stops an extension's own UI from
 *     borrowing the user's unconditional trust (D14).
 */

interface PickedRepo {
  readonly path: string;
  readonly name: string;
}

/**
 * A row, as this view needs it.
 *
 * `source` — which the port also carries — is deliberately NOT read. It existed
 * to tell ↹ whether a row shared a parent directory with what you had typed, and
 * ↹ stopped asking; nothing draws it, and a field read into a shape nobody
 * renders is a field the next person has to work out is dead. The ranker has
 * already used it to order the rows, which is where it belongs.
 */
interface RepoSuggestion extends PickedRepo {
  readonly isRepo: boolean;
  /** The path as a person writes it — home collapsed. What the row draws. */
  readonly display: string;
  /** `display`, already cut into matched and unmatched runs by the ranker. */
  readonly segments: readonly DisplaySegment[];
}

/**
 * The runs, read defensively — they crossed the port from a provider this file
 * has never seen (D5), so a row that carries none is drawn as plain text rather
 * than trusted to have cut itself up correctly.
 *
 * A row whose runs do not reassemble into its own `display` is discarded for the
 * same reason: the only thing worse than no highlight is a highlight that
 * silently renames the path it is drawn over.
 */
function readSegments(value: unknown, display: string): readonly DisplaySegment[] {
  if (!Array.isArray(value)) return [{ text: display, matched: false }];
  const runs: DisplaySegment[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return [{ text: display, matched: false }];
    const { text, matched } = entry as { text?: unknown; matched?: unknown };
    if (typeof text !== "string") return [{ text: display, matched: false }];
    runs.push({ text, matched: matched === true });
  }
  const rebuilt = runs.map((run) => run.text).join("");
  return rebuilt === display ? runs : [{ text: display, matched: false }];
}

/**
 * A command's answer is `unknown`, and a cast is not a check.
 *
 * It has crossed an IPC boundary and been through a provider this file has
 * never seen — a third-party one, by design (D5). Casting the value and reading
 * `.length` off it is how a suggestion provider that answers `undefined` takes
 * the whole composer down with a `TypeError`, which is what the first run of
 * this component's own test did.
 *
 * A suggestion is reduced to its **path**, and its name is re-derived. A
 * provider may carry a name (`RepoRef` has one) and it is deliberately not
 * used: the name becomes the worktree's directory, and a provider is free to
 * answer with whatever it likes, so honouring it would let one provider's naming
 * choice follow the repo into every later task — a chip reading `api` for a repo
 * about to be provisioned as `shepherd`. One derivation, `repoName`, everywhere.
 *
 * `isRepo` defaults to the SAFE reading of a provider that omits it: a candidate
 * is treated as a repo, so none is falsely accused of not being one.
 */
/** A machine a task can start on. */
interface Machine {
  readonly id: string;
  readonly name: string;
  /** This Mac. Drawn first and selected by default. */
  readonly here: boolean;
}

/**
 * This Mac, as the fallback list.
 *
 * The picker is never empty and never absent: with no net, or with nothing
 * answering, there is still exactly one machine a task can start on and it is
 * this one. A control that disappeared when the answer was boring would be a
 * control that looks broken the one time somebody goes looking for it.
 */
const LOCAL_MACHINE: Machine = { id: "here", name: "This Mac", here: true };

/**
 * The answer to `tasks.machines`, read rather than cast.
 *
 * It has crossed the port from an extension, and `ok` says the call succeeded,
 * not that the value has a shape. This Mac is prepended if the answer somehow
 * omitted it, because a picker with no local option cannot create a local task.
 */
function readMachines(value: unknown): readonly Machine[] {
  const rows = (value as { machines?: unknown } | null)?.machines;
  if (!Array.isArray(rows)) return [LOCAL_MACHINE];
  const seen = new Set<string>();
  const read = rows.flatMap((entry: unknown): Machine[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, name, here } = entry as { id?: unknown; name?: unknown; here?: unknown };
    if (typeof id !== "string" || id === "" || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name: typeof name === "string" && name !== "" ? name : id, here: here === true }];
  });
  return read.some((machine) => machine.here) ? read : [LOCAL_MACHINE, ...read];
}

function readSuggestions(value: unknown): readonly RepoSuggestion[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { path, isRepo, display, segments } = entry as {
      path?: unknown;
      isRepo?: unknown;
      display?: unknown;
      segments?: unknown;
    };
    if (typeof path !== "string" || path === "" || seen.has(path)) return [];
    seen.add(path);
    // A provider that carries no display text is drawn by its path, which is
    // always true and never wrong — only longer than it needs to be.
    const shown = typeof display === "string" && display !== "" ? display : path;
    return [
      {
        path,
        name: repoName(path),
        isRepo: isRepo !== false,
        display: shown,
        segments: readSegments(segments, shown),
      },
    ];
  });
}

/**
 * Where a task's work is laid down.
 *
 * **One option today, and the control is drawn anyway.** `in-place` is the
 * obvious second and it is deliberately not here yet: it changes what lands on
 * disk, and a task running in the checkout you are on is unsafe the moment a
 * second task picks the same repo. Shipping the menu with one entry puts the
 * seam in the UI, the schema and the record now, so adding the mode later is a
 * line in this list rather than a change to the composer's shape.
 *
 * A literal list rather than a query: these are not a capability something
 * advertises, they are the shapes `provision` knows how to make.
 */
const PLACEMENTS = [{ value: 'worktree', label: 'worktree' }] as const;

/**
 * Which Claude profile the task's agents run in.
 *
 * Two options and no third, because the third would be a state to explain. The
 * DEFAULT is the one that keeps behaving as it always has: a privacy control you
 * can end up in without choosing it is one you cannot trust in either direction
 * — you would never be sure whether the last task kept its history.
 *
 * `Incognito` gives the task a config dir of its own, deleted when the task is
 * shipped or deleted, so the session starts with no skills, settings, plugins or
 * history and leaves none behind. It does not sign the agent out: the credential
 * is in the Keychain, not the profile, so the work still bills the same account.
 * The label promises privacy from the machine and nothing more.
 */
const PROFILES = [
  { value: 'default', label: 'default' },
  { value: 'incognito', label: 'incognito' },
] as const;

/**
 * One knob on the control row: a glyph, a word, and a menu under it.
 *
 * Not a `Select`, and the difference is the whole visual argument of this
 * screen. `Select` draws a bordered control with a chevron, which is right in a
 * settings `Field` and wrong on a surface built out of bare text — a row of
 * boxes under a borderless brief is two languages stacked. So the trigger draws
 * nothing at rest and takes a fill for exactly as long as its own menu is open,
 * which is the one moment an edge answers a question.
 *
 * It is not a new PRIMITIVE either: the menu is `Menu`, the glyph is `Icon`, and
 * what lives here is a trigger and a rule about ink. A primitive with one caller
 * would be a layout (`composer.tsx`'s own note in `@shepherd/ui` says so), and
 * this has one caller.
 *
 * `chosen` is the rule: ink when you decided it, the ghost step when it is the
 * default you left alone. Drawing every slot in ink would spend the ramp's
 * loudest step on facts nobody chose, and then the one knob you did turn would
 * have nothing left to be louder than.
 */
function Slot({
  glyph,
  label,
  value,
  chosen,
  busy,
  items,
  onSelect,
  onClick,
}: {
  readonly glyph: string;
  readonly label: string;
  readonly value: string;
  readonly chosen: boolean;
  readonly busy?: boolean;
  readonly items?: readonly MenuEntry[];
  readonly onSelect?: (id: string) => void;
  readonly onClick?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const trigger = (
    <button
      type="button"
      className="sh-composer-slot"
      /*
       * The fill, and the ONLY one in the row. A `data-` attribute rather than a
       * class so the stylesheet reads as one rule about state rather than two
       * class names that have to be kept in step.
       */
      data-open={open ? "" : undefined}
      data-chosen={chosen ? "" : undefined}
      /*
       * Which knob this is, for the stylesheet and for a test.
       *
       * The repo slot takes the repo's own hue when it is set, and the alternative
       * to naming the slot here is a selector reaching for the `Icon` inside it —
       * which would need `Icon` to publish the glyph it drew, and an icon that
       * announces its own name in the DOM is a primitive carrying a field for one
       * caller's stylesheet.
       */
      data-glyph={glyph}
      /*
       * The label is the accessible name and never drawn. Four labels rendered
       * beside four values is the row this design replaced — and the value alone
       * ("worktree", "Opus 5") does not say what it is FOR, which is exactly
       * what a screen reader has to be told and a sighted user reads off the
       * glyph.
       */
      aria-label={label}
      disabled={busy}
      onClick={onClick}
    >
      <Icon icon={namedGlyph(glyph)} size="sm" />
      <span>{value}</span>
    </button>
  );

  // No menu: the slot is a gesture, not a choice. The repo slot is the one, and
  // it types a `#` rather than opening a list of its own.
  if (items === undefined || onSelect === undefined) return trigger;

  return (
    <Menu
      items={items}
      trigger="click"
      /*
       * Left edge to left edge. The row's slots sit at the START of a line, so a
       * menu anchored by its right edge — `Menu`'s default, and right for a `⋯`
       * at the end of a row — opens almost entirely to the left of the word that
       * was clicked.
       */
      align="start"
      /*
       * Focus goes back to the SENTENCE, not to the slot. Every knob on this row
       * qualifies the brief, so choosing one is something you do in the middle of
       * writing — and `caretToEnd` in each handler is what puts you back.
       */
      restoreFocus={false}
      open={open}
      onOpenChange={setOpen}
      onSelect={(id) => {
        onSelect(id);
        setOpen(false);
      }}
    >
      {trigger}
    </Menu>
  );
}

export function TaskComposer({
  invoke,
  done,
}: ExtensionViewProps): React.JSX.Element {
  const [brief, setBrief] = useState("");
  /**
   * The scope, DERIVED from the pills in the editor and never set directly.
   *
   * The text is the source of truth. A separate selection array is the second
   * copy of "what is on screen" that ADR 0035 is about, and here it would be
   * wrong in a way nobody could see: Backspace over a pill removes the repo from
   * the sentence, and an array would keep scoping the task to it.
   */
  const [scope, setScope] = useState<readonly PickedRepo[]>([]);
  const [suggestions, setSuggestions] = useState<readonly RepoSuggestion[]>([]);
  /**
   * Every repo the slot's menu offers, and the reason it is a SECOND list.
   *
   * `suggestions` is the answer to what you have typed — it is replaced on every
   * keystroke after a `#`, which is exactly right for the inline picker and
   * exactly wrong for a menu. Reading it from the row's control meant the menu
   * showed whatever the last mention had narrowed to, so opening it after typing
   * `#s` offered one repo and called it the list.
   *
   * This one is asked once, with no query, and never re-asked while typing. The
   * extension answers a zero-query ask with the picked history — the repos you
   * actually use — which is the right content for "show me my repos".
   */
  const [known, setKnown] = useState<readonly RepoSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * WHICH machine this task will start on, and everything it could be.
   *
   * A task is one machine's: its repos are checkouts on a disk, its worktrees are
   * directories there, and its agents are ptys in that machine's daemon. So this
   * is not a preference applied afterwards — it decides where the whole task is
   * made, which is why the repo suggestions are asked of it too.
   *
   * `here` is the default and the first entry, always. A composer that opened on
   * another machine because that is what was picked last is a composer that
   * creates work in a place nobody looked at.
   */
  const [machines, setMachines] = useState<readonly Machine[]>([LOCAL_MACHINE]);
  const [machine, setMachine] = useState<string>(LOCAL_MACHINE.id);
  /**
   * Which model the task's agents open on, pre-filled with the resolved default.
   *
   * `null` means "not asked yet", never a choice — the select is not nullable, so
   * it cannot become one. Which model that is stays the agent layer's answer: an
   * id hardcoded here would go stale the week the vendor ships a tier (D11).
   */
  const [model, setModel] = useState<string | null>(null);
  const [models, setModels] = useState<readonly { value: string; label: string }[]>([]);

  /**
   * Where the work happens.
   *
   * `worktree` is the default and was the only behaviour until now: every repo
   * a task scopes gets a cut of its own, which is what makes several agents on
   * one repo safe. `in-place` runs in the checkout itself — right for a task you
   * want landing on the branch you are already on, and wrong the moment a second
   * task picks the same repo, which is why it is not the default.
   */
  const [placement, setPlacement] = useState<string>('worktree');
  /**
   * Which profile the task's agents run in. Creation-time only — `store.ts` says
   * why a task cannot be made incognito after it has written a transcript.
   */
  const [profile, setProfile] = useState<string>('default');

  const [pickingMachine, setPickingMachine] = useState(false);
  const listId = useId();
  const card = useRef<HTMLDivElement | null>(null);

  /**
   * What the agent layer answered FIRST, kept so the row can tell a default from
   * a decision.
   *
   * `model` alone cannot: it holds the resolved default the moment the ask lands,
   * and a value you were handed reads identically to one you picked. So the
   * first answer is stamped here and never written again — a ref rather than
   * state, because nothing re-renders when it changes and it changes once.
   */
  const defaultModel = useRef<string | null>(null);

  /**
   * The caret, on mount — which the composer now has to do for itself.
   *
   * It never used to. `surface: 'overlay'` wrapped this in Radix's `Dialog`, and
   * a focus trap autofocuses its first focusable on the way in; the composer got
   * a caret in the brief without asking and without knowing it was being given
   * one. A `screen` is a plain element with no trap, so the same component
   * mounted into a takeover that measured as correct in every unit test and
   * opened, in the real app, with the caret nowhere — you had to click the
   * sentence before you could write it.
   *
   * Caught by `smoke:m3` and by nothing else, which is the whole argument of
   * CLAUDE.md's "a green unit suite is not a working app": the tests that cover
   * this component supply their own focus, so not one of them could see it.
   *
   * Deliberately unconditional and dependency-free: this component is MOUNTED
   * when the screen opens and unmounted when it closes, so "on mount" and "when
   * it opens" are the same moment, and there is no second one to guard against.
   */
  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  /**
   * The row's words, derived here rather than in the markup.
   *
   * `shepherd +2` rather than three names: the line has to stay one line at any
   * repo count, and that is the property that lets a control be added later
   * without the row wrapping. The menu is where all three are readable.
   */
  const scopeLabel =
    scope.length === 0
      ? "Attach repo"
      : scope.length === 1
        ? (scope[0]?.name ?? "Attach repo")
        : `${scope[0]?.name ?? ""} +${scope.length - 1}`;
  const modelLabel = models.find((option) => option.value === model)?.label ?? "Model";
  const machineLabel =
    machines.find((entry) => entry.id === machine)?.name ?? LOCAL_MACHINE.name;
  const promptRef = useRef<PromptFieldHandle | null>(null);
  /**
   * How much text the pill replaces: the `#` plus whatever has been typed after
   * it. Read at insertion time from the trigger that opened the picker rather
   * than recomputed there — by then a `mousedown` has been and gone, and a
   * recomputed query is a chance to disagree with the one the rows were filtered
   * for.
   */
  const replaceBack = useRef(0);
  /**
   * The pasted images, in a ref rather than state: they are not rendered from
   * here — the pills in the contenteditable are — and putting them in state
   * would re-render the composer on every paste for no visible change.
   */
  const pasted = useRef<PastedImage[]>([]);
  /**
   * Which URLs to swallow, in a ref for `pasted`'s reason: nothing renders from
   * it, and a paste handler reads it synchronously because it has to call
   * `preventDefault`.
   *
   * Empty until the answer arrives, which is the honest state — a composer that
   * swallowed pastes before it knew what to swallow would eat a URL it could not
   * then draw.
   */
  const linkPatterns = useRef<readonly PastedLinkPattern[]>([]);
  /** Rising, so a late answer can find its own pill after the caret has moved on. */
  const linkSeq = useRef(0);
  /**
   * Which ask is the newest. Every keystroke starts one and they are answered
   * out of order eventually — a `readdir` on a cold directory finishing after
   * the one for the next character is what would leave the list showing
   * completions for text nobody has on screen any more.
   */
  const asked = useRef(0);

  /**
   * The machines, asked once on mount.
   *
   * Once rather than live: a member joining mid-brief is not worth re-rendering a
   * form somebody is typing into, and the list is re-read the next time the
   * composer opens. A member that has gone away since is caught where it matters
   * — `tasks.create` forwards to it and reports what it said.
   */
  /*
   * The model list, asked once when the composer mounts.
   *
   * `agents.listModels` — the primitive, not `quickModelChoices`. That one is
   * this list narrowed to the CHEAP tier, and asking it here would offer a menu
   * of models chosen for being cheap to a person starting real work.
   *
   * It already answers in `SelectOption`'s shape, so nothing is reshaped. A
   * failure leaves the list empty and the select shows only the default, which
   * is honest: we could not find out what else there is, and the kind's own
   * default still works.
   */
  useEffect(() => {
    let alive = true;
    void invoke('agents.listModels', {}).then((result) => {
      if (!alive || !result.ok) return;
      const value = result.value;
      if (!Array.isArray(value)) return;
      setModels(
        value.flatMap((entry) => {
          if (typeof entry !== 'object' || entry === null) return [];
          const record = entry as Record<string, unknown>;
          const id = record['value'];
          const label = record['label'];
          if (typeof id !== 'string' || typeof label !== 'string') return [];
          return [{ value: id, label }];
        }),
      );
    });
    // A second ask, because it is a different question: the list is what exists,
    // this is the user's setting resolved against it.
    void invoke('agents.defaultModel', {}).then((result) => {
      if (!alive || !result.ok) return;
      const chosen = (result.value as { model?: unknown } | null)?.model;
      if (typeof chosen !== 'string' || chosen === '') return;
      /*
       * Stamped here, and only here: this is the one moment the app knows a
       * value arrived rather than being picked. The row reads it back to decide
       * whether the model slot is a decision (ink) or a default (ghost).
       */
      defaultModel.current = chosen;
      // A pre-fill only — never over a choice already made.
      setModel((was) => was ?? chosen);
    });
    return () => {
      alive = false;
    };
  }, [invoke]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const answer = await invoke("tasks.machines", {});
      if (!live || !answer.ok) return;
      setMachines(readMachines(answer.value));
    })();
    return () => {
      live = false;
    };
  }, [invoke]);

  /**
   * Which URLs a paste should be swallowed for.
   *
   * On MOUNT, which here is on open: the shell mounts this component when the
   * composer is raised and unmounts it when it closes, so the two coincide. If
   * that ever stops being true this read has to move — the machine list gets away
   * with a stale answer because `tasks.create` reports on a machine that has gone
   * away, and a stale intercept rule has no such catch. It silently changes what
   * Cmd-V does.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      const answer = await invoke(TASK_COMMANDS.linkPatterns, {});
      if (!live || !answer.ok) return;
      linkPatterns.current = readPatterns(answer.value);
    })();
    return () => {
      live = false;
    };
  }, [invoke]);

  const askForSuggestions = async (
    forTitle: string,
    forBrief: string,
    forQuery: string,
    /**
     * WHOSE checkouts, passed explicitly rather than read from state.
     *
     * The machine picker asks again the moment the machine changes, and a closure
     * over `machine` still holds the OLD value at that point — React has not
     * re-rendered yet. So the picker would show the repos of the machine you just
     * left, which is indistinguishable from the ask not working and lands wrong
     * paths in a task that then fails to provision over there. Found by a test
     * asserting the member on the ask rather than only on the button.
     */
    forMember: string = machine,
  ): Promise<void> => {
    asked.current += 1;
    const mine = asked.current;
    const answer = await invoke("tasks.suggestRepos", {
      title: forTitle,
      brief: forBrief,
      query: forQuery,
      // Whose checkouts to offer. A repo path only means something on the machine
      // that holds it, so the picker has to ask the machine the task is for.
      member: forMember,
    });
    if (answer.ok && mine === asked.current) setSuggestions(readSuggestions(answer.value));
  };

  /**
   * The menu's list, asked with no query — separately, and deliberately not by
   * reusing the ask above.
   *
   * Sharing it would mean one answer landing in two states, and the typed one
   * has a race guard (`asked.current`) whose whole job is to drop answers that
   * arrived out of order. A menu that lost its list to a stale-response guard
   * meant for a different question would be empty for no visible reason.
   */
  const askForKnown = async (forMember: string = machine): Promise<void> => {
    const answer = await invoke("tasks.suggestRepos", { title: "", brief: "", query: "", member: forMember });
    if (answer.ok) setKnown(readSuggestions(answer.value));
  };

  // On mount the query is empty, which the extension answers with the picked
  // history alone — the repos you actually use, offered before you have typed
  // anything, so the first `#` has rows under it with no second keystroke.
  // Everything after that is a keystroke's; there is no debounce because there
  // is no timer here to get wrong, and the ask is one directory listing
  // (measured at ~10ms, cheaper than the keystroke that asked for it).
  useEffect(() => {
    void askForSuggestions("", "", "");
    // And the row's own list, which the typed one will start narrowing the
    // moment a `#` is typed. Same ask, different question.
    void askForKnown();
  }, []);

  /**
   * A repo already in the sentence stops being offered.
   *
   * This IS the "same repo twice" guard the handoff asks for, and it is a filter
   * rather than a check at insertion time on purpose: a row you cannot see is a
   * row you cannot pick, so there is no second rule to keep in step with this
   * one.
   */
  const rows: readonly PickerRow[] = suggestions.filter(
    (suggestion) => !scope.some((repo) => repo.path === suggestion.path),
  );
  /**
   * CLAMPED, not trusted. The rows are re-ranked by the extension on every
   * keystroke, so an index held over a narrowing list can point past its end,
   * and ⏎ would then insert nothing at all.
   */
  const index = rows.length === 0 ? 0 : Math.min(active, rows.length - 1);

  const close = (): void => {
    setOpen(false);
    setQuery("");
    setActive(0);
  };

  /**
   * Esc closes the picker, and must not close the composer with it.
   *
   * Radix's dismissable layer listens for Escape on the document in the CAPTURE
   * phase, so a React handler cannot stop it — capture at the document runs
   * before anything below. A capture listener on `window` runs before the
   * document's, which is the one seam available, and Radix honours
   * `defaultPrevented` (it checks it before dismissing). Measured against
   * `@radix-ui/react-dismissable-layer`, not assumed.
   *
   * Only while the picker is open, and only once something has been WRITTEN: Esc
   * with the picker closed still closes the composer, which is what Esc means
   * everywhere else in the app — and an empty field has nothing for the first
   * press to protect, so it goes the same way rather than costing two.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      close();
      if (isUnwritten(brief)) return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, brief]);

  /**
   * A mousedown outside the card closes the picker.
   *
   * `mousedown` rather than `click`, to match the rows: the pointer going down
   * is the moment the editor's selection is at risk, and a picker that waited for
   * the release would still be open over the thing you clicked.
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target === null) return;
      if (card.current?.contains(target) === true) return;
      // The panel is PORTALLED to the body, so it is not inside the card — and
      // without this a mousedown on a row would be "outside" and close the picker
      // out from under the very click that was picking a repo.
      if (target.closest('[data-testid="composer-picker"]') !== null) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  /**
   * Read the scope back out of the sentence.
   *
   * Document order, because the order the repos are named in is the order they
   * were meant in — and it is the order `tasks.create` provisions them in.
   */
  const syncScope = (): void => {
    const host = card.current;
    if (host === null) return;
    const found = [...host.querySelectorAll<HTMLElement>("[data-repo-path]")].flatMap(
      (pill) => {
        const path = pill.dataset["repoPath"];
        return path === undefined || path === ""
          ? []
          : [{ path, name: repoName(path) }];
      },
    );
    // Compared before setting: this runs on every keystroke, and a fresh array
    // each time would re-render the card for every character typed.
    setScope((was) =>
      was.length === found.length && was.every((repo, at) => repo.path === found[at]?.path)
        ? was
        : found,
    );
  };

  /**
   * Is a `#` live at the caret, and if so which one?
   *
   * The picker's whole state comes from the caret's own text node, read fresh.
   * Nothing here remembers where the `#` was, because the editor is the only
   * thing that knows what happened to the text and the caret in between.
   */
  const syncTrigger = (value: string): void => {
    const caret = promptRef.current?.caretContext() ?? null;
    const found = caret === null ? null : findTrigger(caret.text, caret.offset);
    if (caret === null || found === null) {
      if (open) close();
      return;
    }

    replaceBack.current = found.query.length + 1;
    /*
     * No placement, deliberately: the picker is FUSED to the bottom of the well
     * (see `RepoPicker`), so it has no coordinates to compute. The caret rect
     * this used to measure per keystroke, and the clamp/flip arithmetic it fed,
     * went with the popover.
     */

    /*
     * Ask when the picker OPENS or the query changes, and not merely because the
     * caret moved: a re-ask per caret move would be a directory listing for a
     * question nobody asked again. Opening always asks, because `suggestions`
     * still holds the rows for whatever was typed last time — reopening on `#`
     * without asking would draw a filtered list for a query that is gone.
     *
     * And the active row resets to the top, which is the one place this picker
     * deliberately does the opposite of `CommandPalette`. The palette filters a
     * FIXED list, so row 3 is the same command after another character and
     * holding the index is a kindness. Here the extension re-ranks on every
     * keystroke and rows arrive and leave, so row 3 is a different repo — an
     * index held across that points at something nobody aimed at.
     */
    if (!open || found.query !== query) {
      setActive(0);
      setQuery(found.query);
      void askForSuggestions(firstLine(value), value, found.query);
    }
    setOpen(true);
  };

  const onEdit = (value: string): void => {
    setBrief(value);
    syncScope();
    syncTrigger(value);
  };

  /**
   * A caret MOVE is as much a change to the trigger as an edit is.
   *
   * ←/→ and a click inside the editor deliberately pass through to normal text
   * editing while the picker is open, so without this the caret can leave the
   * mention while the popover stays up holding the query it had on arrival — and
   * ⏎ would then delete that many characters wherever the caret now is, eating
   * text somewhere else in the sentence. Re-reading the caret is the same code
   * path an edit takes, so there is one answer to "what is the trigger" rather
   * than two that can disagree.
   */
  useEffect(() => {
    if (!open) return;
    const onSelect = (): void => syncTrigger(brief);
    document.addEventListener('selectionchange', onSelect);
    return () => document.removeEventListener('selectionchange', onSelect);
  }, [open, brief, query]);

  /**
   * The repo pill, built as a DOM node for the same reason the image pill is:
   * React does not own the editor's subtree.
   *
   * `data-token` is what `readValue` returns in its place, so the brief submits
   * as `fix the retry loop in shepherd` — the sentence somebody wrote, with the
   * repo still in it. The `#` is the PICKER's, not the sentence's: it opens a
   * popover here and means nothing to an agent reading the brief, so neither the
   * token nor the label carries it. `data-repo-path` is what
   * `syncScope` reads, and it carries the PATH because a name does not identify a
   * repo: two `api` directories in different trees are the case this picker
   * exists to survive.
   */
  const repoPill = (path: string, name: string): HTMLElement => {
    const pill = document.createElement("span");
    pill.className = "sh-ui-pill sh-composer-repo-pill";
    pill.contentEditable = "false";
    pill.dataset["token"] = name;
    pill.dataset["repoPath"] = path;
    pill.title = path;
    // A folder glyph rather than the `#`, for the reason the token drops it too:
    // the `#` is the PICKER's syntax and means nothing in the finished sentence.
    // Pill's signal is its icon (see `pill.css`), so a repo says "repo" the way
    // an image says "image" — with a mark, not with punctuation.
    pill.innerHTML =
      '<svg class="sh-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/></svg>';
    pill.append(name);
    return pill;
  };

  /**
   * A repo chosen from the ROW, which is a different gesture from picking one
   * out of the inline picker and has to behave differently.
   *
   * Typing `#s` and taking a row REPLACES the trigger you typed — that is what
   * `replaceBack` is for, and the pill lands mid-sentence where the mention was.
   * Clicking the slot types nothing, so there is nothing to replace and no caret
   * to be relative to: the pill goes at the END, which is why `appendNode` had
   * to exist.
   *
   * And because the menu shows what is already scoped with a tick, selecting a
   * ticked row has to UNDO it. The pill is the scope (ADR 0035), so removing the
   * repo means removing the pill from the sentence — not clearing a second array
   * that would then disagree with the text.
   */
  const toggleRepo = (path: string, name: string): void => {
    const host = card.current;
    const existing = host?.querySelector<HTMLElement>(`[data-repo-path="${CSS.escape(path)}"]`) ?? null;
    if (existing !== null) promptRef.current?.removeNode(existing);
    else promptRef.current?.appendNode(repoPill(path, name), { trailing: "\u00A0" });
    syncScope();
    /*
     * Back into the sentence, and AFTER the menu has finished closing.
     *
     * Radix restores focus to the trigger on close, and it does that after
     * `onSelect` has run — so a caret placed during the insert was stomped a
     * beat later, and the pill was left as the selection. Chromium draws a
     * selected `contenteditable=false` span with an outline of its own, which is
     * the blue box that showed up round a repo the moment it was chosen.
     *
     * A timeout rather than a microtask: the restore is on Radix's own teardown,
     * which is a task. And the behaviour is the one you want anyway — you picked
     * a repo in order to keep writing, not in order to be left on a button.
     */
    promptRef.current?.caretToEnd();
  };

  const pick = (row: PickerRow): void => {
    promptRef.current?.insert(repoPill(row.path, row.name), {
      replaceBack: replaceBack.current,
      // A non-breaking space, so the caret lands in text rather than against the
      // pill — and so the next character is not read as part of the mention.
      trailing: "\u00A0",
    });
    close();
    syncScope();
  };

  /**
   * The pill, built as a DOM node because it is inserted into a contenteditable
   * rather than rendered by React — React does not own that subtree, by design
   * (see `PromptField`: rewriting it per keystroke is what breaks undo).
   *
   * It carries `data-token`, which is what `readValue` returns in its place and
   * what the service half swaps for a real path.
   */
  const imagePill = (index: number): HTMLElement => {
    const pill = document.createElement("span");
    pill.className = "sh-ui-pill";
    pill.contentEditable = "false";
    pill.dataset["token"] = `[Image #${index}]`;
    pill.innerHTML =
      '<svg class="sh-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
      '<path d="M15 8h.01"/><rect width="16" height="16" x="4" y="4" rx="3"/>' +
      '<path d="m4 15 4-4a3 5 0 0 1 3 0l5 5"/><path d="m14 14 1-1a3 5 0 0 1 3 0l2 2"/></svg>';
    pill.append(`Image ${index}`);
    return pill;
  };

  /**
   * Send the form.
   *
   * `opens` is the ONE thing the two gestures differ by — ⏎ starts the agent,
   * ⌘⏎ opens a terminal in the same task — so it is a parameter rather than a
   * piece of state. State would make it a MODE: a value set on Tuesday that
   * turns Thursday's carefully typed brief into a silent shell, which is the
   * kind of thing you can end up in without choosing it. The machine picker
   * already re-defaults for that reason (see `machine`), and this never has a
   * value to re-default because it never has one between keystrokes.
   */
  const create = async (opens: 'agent' | 'terminal' = 'agent'): Promise<void> => {
    setBusy(true);
    const result = await invoke("tasks.create", {
      brief,
      // Absent for the ordinary task, as `incognito` is: `agent` is the verb's
      // own default and sending it would be a second spelling of it.
      ...(opens === 'terminal' ? { open: 'terminal' } : {}),
      // Absent when the user left the default alone, so the extension's own
      // default is not overwritten by a value the composer invented.
      ...(model === null ? {} : { model }),
      ...(placement === 'worktree' ? {} : { placement }),
      // Absent for the ordinary task: `false` is a second spelling of the
      // default, and the verb's schema only ever stores `true`.
      ...(profile === 'incognito' ? { incognito: true } : {}),
      ...(pasted.current.length === 0 ? {} : { images: pasted.current }),
      repos: scope.map((repo) => ({ path: repo.path, name: repo.name })),
      member: machine,
    });
    setBusy(false);
    if (!result.ok) {
      setStatus(`${result.error.code}: ${result.error.message}`);
      return;
    }
    const created =
      typeof result.value === "object" && result.value !== null
        ? (result.value as { slug?: unknown })
        : {};
    setStatus(
      `created ${typeof created.slug === "string" ? created.slug : "a task"}` +
        // Which of the two things it did. The composer closes on `done()`, so
        // this is read in the half-second before it goes — worth spending,
        // because the two gestures are one keystroke apart and the difference is
        // whether an agent is now running.
        (opens === 'terminal' ? " — opening a terminal in it" : ""),
    );
    // Cleared only on success. A failed create keeps everything typed — the
    // form is the only copy of it.
    setBrief("");
    promptRef.current?.setValue("");
    pasted.current = [];
    // The pills went with the text, so the scope empties by being re-read rather
    // than by being cleared — same one path, even here.
    syncScope();
    // The composer's job is over; the shell decides what that means (an overlay
    // closes, a docked copy stays and is now empty).
    done();
  };

  return (
    /*
      The `<form>` is OUTSIDE the `Composer`, and it is a bare block element that
      draws nothing.

      `Composer` renders a `<div>` and has no `asChild`, so it cannot BE the form
      — and a form is worth keeping (it is what makes `type="submit"` mean
      something and what a screen reader reports as a form). Wrapping costs one
      element and no CSS, which is why this is a finding reported rather than a
      prop added: a primitive that grows an escape hatch for its first awkward
      caller grows one for every later caller too.
    */
    <form
      data-testid="task-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
      /*
        ⌘⏎ — the same form, opened on a TERMINAL instead of an agent.

        On the form rather than on the text field so the gesture works wherever
        focus is, and because there is exactly one implementation of it. A modifier
        on submit is vocabulary this card already teaches (⇧⏎ newlines), which is
        why it is this and not a second button: a button is chrome every open pays
        for, presenting a 95/5 split as two peer verbs, and a select would be a
        sticky mode.

        The same gate as ⏎, and deliberately not a looser one. A terminal task
        opened before you can say what the work is still says `#repo`, and a pill
        carries its name into the brief — so "nothing typed" is not a state this
        card can be submitted in by either gesture, and a branch for it would be
        one nothing can reach. `tasks.create` accepts a genuinely empty brief for
        the CLI's sake, and `untitled` is what names that task.
      */
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        if (!event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        if (busy || brief.trim() === "") return;
        void create('terminal');
      }}
    >
      {/*
        The card is the popover's positioning context, which is why it holds the
        ref: the picker is anchored to a CHARACTER inside the editor, and every
        offset it uses is measured against this box so the clamp has an edge to
        clamp to.
      */}
      {/*
        The column, and it is a LAYOUT rather than a `Composer`.

        `Composer` is the primitive for a writing surface, and what makes it one
        is a scoped re-declaration of `--sh-surface`, `--sh-sunken` and
        `--sh-line` — so a `Field` dropped inside gets no well and no hairline
        without being told where it is. Every part of that assumes a WELL: a
        filled box with an edge, sitting on something else.

        This screen has no box. It is text on the stage, which is the canvas
        role, and re-declaring the surface roles to values they already hold
        would be a primitive doing nothing while claiming to do something. So the
        column is a plain element and the controls inside it draw no edges
        because none of them asks for one — which is the same end state reached
        by not needing the mechanism rather than by invoking it.

        It keeps the ref: the picker is anchored to a CHARACTER inside the
        editor, and every offset it uses is measured against this box.
      */}
      <div className="sh-compose" ref={card}>
        {/*
          ROW, sentence, picker, hint — and the order is the design rather than
          the history.

          It shipped as sentence-then-row, because on a card the controls were a
          FOOTER: a strip of selects fused under the writing, which is where a
          form puts its controls. On a screen there is no footer to be at the
          bottom of, and the row stopped being a footer the moment it started
          saying what the task IS — which model, which repos, which tree. You
          read those before you write the sentence they qualify, so they go
          above it.

          The picker follows the SENTENCE, not the hint, because it is part of
          writing one: it opens on a `#` you typed mid-clause and closes when
          you have picked. Left as the last child it sat below the send line,
          detached from the text it was completing and separated from it by an
          instruction about a key.
        */}
        {/*
          The control row — one line, whatever the task.

          It was three ghost `Select`s divided by 1px rules, sitting under the
          brief inside a card. Every part of that is gone, and each for its own
          reason:

            - **No borders, no chevrons, no rules.** A row of bordered controls
              under a borderless writing surface is two design languages stacked
              one above the other. Every slot here is bare text on the stage, and
              the only edge in the row belongs to the slot whose menu is open —
              the one moment an edge answers a question ("which one am I in?").
            - **A glyph for WHICH, a word for WHAT.** Four words in a row are
              four things to read; four glyphs are one thing to scan. The word
              stays, because a glyph cannot say `Opus 5`.
            - **Ink is a decision, ghost is a default.** The two steps of the
              ramp carry the only thing worth carrying — whether you chose this
              or left it — so a row of untouched defaults recedes and the knob
              you turned is the one that reads. Nothing labels the distinction,
              and nothing needs to.
        */}
        <div className="sh-composer-controls" data-testid="composer-controls">
          {/*
            NOT `nullable`: there is no "default" model to pick, there is a model
            you get by default and it is shown selected. `busy` covers the beat
            before the asks land.
          */}
          <Slot
            glyph="robot"
            label="Model"
            value={modelLabel}
            /*
              Ghost until it differs from what the agent layer resolved. A
              default model is not a decision anyone made, and drawing it in ink
              spends the loudest step of the ramp on the least interesting fact
              in the row.
            */
            chosen={model !== null && model !== defaultModel.current}
            busy={models.length === 0}
            items={models.map((option) => ({
              id: option.value,
              label: option.label,
              ...(option.value === model ? { icon: namedGlyph("check") } : {}),
            }))}
            onSelect={(next) => {
              setModel(next);
              promptRef.current?.caretToEnd();
            }}
          />
          {/*
            The repo slot, which is a MIRROR and never a store.

            `scope` is derived from the pills in the brief (ADR 0035), so this
            control cannot hold a repo of its own — that would be the second copy
            of "what is on screen", and here the bug it causes is visible:
            backspace over a pill drops the repo from the sentence, and the array
            would go on scoping the task to it.

            So clicking it types a `#`. `appendText` exists for exactly this and
            says so — one code path whether the trigger was typed or clicked, the
            same picker, ranked by the same extension, writing the same pill.
            This slot reads the text back and writes nothing else to it.
          */}
          <Slot
            glyph="folder"
            label="Repos"
            value={scopeLabel}
            chosen={scope.length > 0}
            busy={known.length === 0}
            items={known.map((entry) => ({
              id: entry.path,
              label: entry.name,
              /*
               * `display`, not `path` — the field whose own comment says it is
               * "the path as a person writes it — home collapsed". The raw path
               * put `/Users/eshaan/…` beside a name in a menu the picker two
               * lines away was already drawing as `~/dev/…`, so the same repo
               * read as two different places depending on how you opened it.
               *
               * `name` is dropped off the end of it: the label already says the
               * repo, and the meta's job is where it is.
               */
              meta: entry.display.endsWith(`/${entry.name}`)
                ? entry.display.slice(0, -entry.name.length - 1)
                : entry.display,
              ...(scope.some((repo) => repo.path === entry.path) ? { icon: namedGlyph("check") } : {}),
            }))}
            onSelect={(path) => {
              const entry = known.find((candidate) => candidate.path === path);
              if (entry !== undefined) toggleRepo(entry.path, entry.name);
            }}
          />
          {/*
            Placement is drawn as a WORD, not a switch.

            `PLACEMENTS` holds one entry, and its comment is explicit that the
            one-item menu is deliberate — the seam for `in-place` lands before
            the behaviour does. A toggle here would be a control that cannot
            move, which is worse than a word that cannot yet be changed: the word
            reports the state, the toggle invites a gesture and then refuses it.
          */}
          <Slot
            glyph="branch"
            label="Where the work happens"
            value={placement}
            chosen={placement !== "worktree"}
            items={PLACEMENTS.map((option) => ({
              id: option.value,
              label: option.label,
              ...(option.value === placement ? { icon: namedGlyph("check") } : {}),
            }))}
            onSelect={(next) => {
              setPlacement(next);
              promptRef.current?.caretToEnd();
            }}
          />
          {/*
            Drawn only when there is a choice. One machine is not a decision, and
            a slot that always says "This Mac" is a control that teaches nothing
            and takes room in the one row that has to stay readable.
          */}
          {machines.length < 2 ? null : (
            <Slot
              glyph="dots"
              label="Which machine"
              value={machineLabel}
              chosen={machine !== LOCAL_MACHINE.id}
              items={machines.map((entry) => ({
                id: entry.id,
                label: entry.here ? `${entry.name} (here)` : entry.name,
                ...(entry.id === machine ? { icon: namedGlyph("check") } : {}),
              }))}
              onSelect={(next) => {
                setMachine(next);
                /*
                 * The repo list belongs to the machine, so it is asked again the
                 * moment the machine changes. Not merely cleared: the picker's
                 * zero-query answer is the history of repos actually used over
                 * there, which is exactly what somebody wants to see next.
                 */
                setSuggestions([]);
                void askForSuggestions(firstLine(brief), brief, "", next);
                // And the row's own list. A repo path only means something on
                // the machine that holds it, so a menu still offering the last
                // machine's checkouts offers paths that do not exist over there.
                setKnown([]);
                void askForKnown(next);
                promptRef.current?.caretToEnd();
              }}
            />
          )}
          {/*
            Incognito is a glyph and nothing else, and it does not exist until it
            is set.

            `default` written out is the row reporting that nothing happened —
            the one thing a control should never spend a slot saying. So the
            profile has no slot at its default, and when it is on, the mark IS
            the statement. Ink rather than a hue: red is a run that failed, and
            this is not a warning. It is the one choice on the line made against
            the grain, so it takes the loudest step of the ramp.

            The way out is the same mark. A state you can enter and not leave is
            what §9 calls a way in with no way out, and a privacy control is the
            worst place in the app to have one.
          */}
          <button
            type="button"
            className="sh-composer-incognito"
            data-testid="composer-incognito"
            data-on={profile === "incognito" ? "" : undefined}
            aria-pressed={profile === "incognito"}
            title={
              profile === "incognito"
                ? "Incognito — this task gets a config dir of its own, deleted when it is shipped"
                : "Run this task incognito"
            }
            onClick={() => setProfile(profile === "incognito" ? "default" : "incognito")}
          >
            <Icon icon={namedGlyph("spy")} size="sm" />
          </button>
        </div>

        {/*
          ONE field, and now it is the only one.

          A separate title box asked the same question twice, and a separate repo
          field asked a question that belongs inside the sentence — scoping a task
          is part of writing it. Both corrections land here: the brief is the
          card, `#` names a repo where you are already typing, and the pill that
          replaces it is part of the text it scopes.
        */}
        <PromptField
          ref={promptRef}
          className="sh-composer-brief"
          data-testid="composer-brief"
          aria-label="what needs doing"
          placeholder="what needs doing?"
          /*
            The combobox is the EDITOR, not a box beside it. `aria-expanded` and
            `aria-activedescendant` therefore live here, on the thing that has
            focus the whole time — which is the same reason `CommandPalette` names
            its active row instead of focusing it.
          */
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && rows.length > 0 ? rowId(listId, index) : undefined}
          onChange={onEdit}
          /*
            A pasted image becomes a Pill in the text, right where it was
            pasted, and its bytes ride along to `tasks.create`. The token in the
            text is what the service half substitutes a path for, so the pill
            carries it as `data-token` — the label says "Image", and the label
            is not what the agent should be told.
          */
          onPasteFiles={(files) => {
            const images = files.filter((file) => file.type.startsWith("image/"));
            if (images.length === 0) return false;
            void (async () => {
              for (const file of images) {
                const image = await readPastedImage(file);
                if (image === null) continue;
                const index = pasted.current.length + 1;
                pasted.current.push(image);
                promptRef.current?.insert(imagePill(index));
              }
            })();
            return true;
          }}
          /*
            A pasted Jira or Slack link becomes a Pill where it was pasted. The
            pill goes in IMMEDIATELY with the token already correct, already the
            vendor's colour and mark, and reading `Loading…`; resolving spawns a
            subprocess, and a composer that stalled on paste would be worse than
            a label that arrives a beat later.

            The vendor comes from the PATTERN that claimed the paste, which is
            why the box does not change shape when the answer lands — only the
            word does.

            Only a lone URL matching a claimed pattern. Everything else falls
            through to the plain-text paste, which is what keeps the browser's
            own undo entry for it.
          */
          onPasteText={(text) => {
            const url = text.trim();
            const vendor = claimedVendor(url, linkPatterns.current);
            if (vendor === null) return false;
            const id = `link-${(linkSeq.current += 1)}`;
            promptRef.current?.insert(linkPill(url, id, vendor), {
              // The same non-breaking space `pick` uses, and for the same
              // reason: the caret lands in text rather than against the pill.
              trailing: "\u00A0",
            });
            void (async () => {
              const answer = await invoke(TASK_COMMANDS.resolveLink, { url });
              if (!answer.ok) return;
              const link = readLink(answer.value);
              if (link === null) return;
              /*
                Found by ID rather than by position: the person kept typing while
                this was in flight, and a pill they deleted must not be
                resurrected over whatever is there now. The picker's `asked` ref
                guards the same class of bug from the other direction.
              */
              const pill = card.current?.querySelector<HTMLElement>(
                `[data-link-id="${id}"]`,
              );
              if (pill === null || pill === undefined) return;
              dressPill(pill, link);
            })();
            return true;
          }}
          onKeyDown={(event) => {
            /*
              While the picker is open it owns these five keys and nothing else
              sees them. Closed, every key here falls through to ordinary text
              editing — which is the rule that keeps ⌘A, ⌥←, ⌘⌫ and undo working,
              because `PromptField` inherits them from the OS and a handler that
              calls `preventDefault` on a key it did not need is what breaks them.
            */
            if (open) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                // Clamped, no wrap: a list that jumps from the last row back to
                // the first is a list you can arrow past without noticing.
                setActive(Math.min(index + 1, rows.length - 1));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive(Math.max(index - 1, 0));
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                const row = rows[index];
                // No rows is Enter doing NOTHING rather than submitting: the
                // picker is on screen, so ⏎ visibly belongs to it, and a submit
                // here would create a task from a half-typed mention.
                if (row !== undefined) pick(row);
                return;
              }
              // Escape is handled by the window-capture listener above, because
              // Radix would otherwise close the whole composer first.
            }
            /*
              ⏎ submits and ⇧⏎ newlines — the chat convention. ⌘⏎ is neither: it
              is handled on the FORM, so the gesture works wherever focus is
              rather than only in the text. Bailing here is what lets it get
              there — without this, a held ⌘ would submit as an agent and the
              terminal gesture would be a key that silently does the other thing.
            */
            if (event.key !== "Enter" || event.shiftKey) return;
            if (event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            if (brief.trim() !== "") void create();
          }}
        />

        {open ? (
          <RepoPicker
            rows={rows}
            query={query}
            activeIndex={index}
            listId={listId}
            onHover={setActive}
            onPick={pick}
          />
        ) : null}

        {/*
          The send affordance, and it is a sentence rather than a button.

          It was a filled sky circle — the one weighted control on the card, and
          the only round element in the product. On a card that was right: the
          composer's action is the terminus of the sentence you just wrote, and a
          circle said that. On a SCREEN it is wrong, because the surface has no
          card to be the terminus of, and a weighted control floating in a field
          of black is the only thing on it with an edge.

          What replaced it is the thing the button was competing with. ⏎ already
          sends; a button duplicating a key that always works is chrome the
          layout pays for on every open. So the line states the gesture, and
          `⌘⏎` — the terminal variant, previously taught only in a `title` nobody
          hovers — finally has somewhere to be said out loud.

          It goes GHOST when there is nothing to send, rather than disappearing:
          a hint that vanishes as you delete the last character is a hint that
          moves the layout while you are editing.
        */}
        <p className="sh-composer-send" data-testid="composer-send" aria-hidden="true">
          <span data-quiet={brief.trim() === "" ? "" : undefined}>
            Press <kbd>⏎</kbd> to send
          </span>
          <span data-quiet="">
            <kbd>⌘⏎</kbd> for a terminal
          </span>
        </p>

        <output className="sh-ext-answer" data-testid="composer-status">
          {status}
        </output>
      </div>

      {/*
        The scope rail is GONE, and this note is what replaces it.

        It was a detached bar under the card naming each repo with its identity
        mark and counting the worktrees — a statement about where the result
        would land, separated by 7px from the sentence that decided it. Both
        halves of what it said are now in the control row: `shepherd +2` is the
        scope, `worktree` is the placement, and the pills in the brief carry the
        names in the sentence that scopes them.

        Two rows saying one thing is the repetition §10 refuses, and on a surface
        whose whole argument is that the room is worth having, the answer to
        "there is space for it" is that space is not a reason.
      */}
    </form>
  );
}
