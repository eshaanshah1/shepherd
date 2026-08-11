import { useEffect, useId, useRef, useState } from "react";
import type { ExtensionViewProps } from "@shepherd/sdk";
import { Button, Composer, PromptField, type PromptFieldHandle } from "@shepherd/ui";
import { repoName } from "../src/model/repo-name.ts";
import type { PastedImage } from "../src/images.ts";
import { readPastedImage } from "./paste-image.ts";
import { findTrigger, isUnwritten, scopeLine, type DisplaySegment } from "./mention.ts";
import {
  EDGE,
  PICKER_WIDTH,
  RepoPicker,
  placePicker,
  rowId,
  type PickerRow,
} from "./repo-picker.tsx";

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
 * The task's name: the brief's first line, git-commit style.
 *
 * Trimmed and capped, because it becomes a slug, a branch name and a pane
 * title — and somebody's first line is occasionally a paragraph.
 */
function titleOf(brief: string): string {
  const first = brief.split("\n")[0]?.trim() ?? "";
  return first.length <= 72 ? first : `${first.slice(0, 71).trimEnd()}…`;
}

/**
 * The panel's own height, used only to decide whether it fits below the caret.
 *
 * A constant rather than a measurement, because the decision has to be made
 * BEFORE the panel exists — measuring it would mean rendering it somewhere first,
 * and a popover that appears and then jumps is worse than one placed from an
 * upper bound. It is the list's `max-height` plus the header and the padding, so
 * it is the tallest the panel ever gets and never under-reserves.
 */
const PICKER_HEIGHT = 238 + 38 + 12;

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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [spot, setSpot] = useState({ x: EDGE, y: 0 });
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * The name the model suggested, if one landed before the task was created.
   *
   * Nothing on the card draws it and nothing waits for it: the ask runs while the
   * brief is being written and its answer rides `tasks.create`, or it does not
   * arrive and the extension names the task from the brief instead.
   */
  const [suggested, setSuggested] = useState<string | null>(null);
  const listId = useId();
  const card = useRef<HTMLDivElement | null>(null);
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
   * Which ask is the newest. Every keystroke starts one and they are answered
   * out of order eventually — a `readdir` on a cold directory finishing after
   * the one for the next character is what would leave the list showing
   * completions for text nobody has on screen any more.
   */
  const asked = useRef(0);
  /** Which NAME ask is the newest — the same problem `asked` solves, one ask along. */
  const namingAsk = useRef(0);
  /** The brief the last name ask was about, so a pause with no new words asks nothing. */
  const namedFor = useRef("");

  const askForSuggestions = async (
    forTitle: string,
    forBrief: string,
    forQuery: string,
  ): Promise<void> => {
    asked.current += 1;
    const mine = asked.current;
    const answer = await invoke("tasks.suggestRepos", {
      title: forTitle,
      brief: forBrief,
      query: forQuery,
    });
    if (answer.ok && mine === asked.current) setSuggestions(readSuggestions(answer.value));
  };

  // On mount the query is empty, which the extension answers with the picked
  // history alone — the repos you actually use, offered before you have typed
  // anything, so the first `#` has rows under it with no second keystroke.
  // Everything after that is a keystroke's; there is no debounce because there
  // is no timer here to get wrong, and the ask is one directory listing
  // (measured at ~10ms, cheaper than the keystroke that asked for it).
  /**
   * Ask what this task should be called.
   *
   * On an idle pause rather than per keystroke, and thresholded on CONTENT as well
   * as time: a pause after twenty more characters is a different brief, a pause
   * after two is the same one. §7c named the user's model budget as the reason
   * `agents` is its own permission, and a per-keystroke ask would spend it several
   * times per task.
   */
  const askForName = async (forBrief: string): Promise<void> => {
    const trimmed = forBrief.trim();
    if (trimmed.length < 24) return;
    if (namedFor.current !== "" && Math.abs(trimmed.length - namedFor.current.length) < 20) return;
    namedFor.current = trimmed;
    namingAsk.current += 1;
    const mine = namingAsk.current;
    const answer = await invoke("tasks.suggestName", { brief: forBrief });
    // A newer ask has started, so this answer is about text nobody has on screen
    // any more.
    if (mine !== namingAsk.current) return;
    if (!answer.ok) return;
    const value = answer.value as { name?: unknown } | null;
    if (typeof value === "object" && value !== null && typeof value.name === "string") {
      setSuggested(value.name);
    }
  };

  useEffect(() => {
    void askForSuggestions("", "", "");
  }, []);

  /**
   * The idle pause, and the only trigger there is.
   *
   * Cleared on every change, so it fires once the typing STOPS rather than once
   * per keystroke. Keyed on the BRIEF alone, deliberately: `askForName` is a new
   * closure every render, so depending on it would clear and restart this timer on
   * each keystroke — which is the one thing an idle pause must not do.
   */
  useEffect(() => {
    if (brief.trim() === "") return undefined;
    const timer = setTimeout(() => void askForName(brief), 2_000);
    return () => clearTimeout(timer);
  }, [brief]);

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
     * VIEWPORT coordinates, because the panel is portalled to the body — see
     * `RepoPicker`: the `Modal` around this composer clips and transforms, so an
     * in-tree popover cannot hang past the card the way the design has it.
     * `placePicker` owns every rule about where it lands.
     */
    const rect = caret.rectOf(found.at);
    const box = card.current?.getBoundingClientRect();
    if (rect !== null && box !== undefined) {
      setSpot(placePicker(rect, box, window.innerHeight, PICKER_HEIGHT));
    }

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
      void askForSuggestions(titleOf(value), value, found.query);
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

  const create = async (): Promise<void> => {
    setBusy(true);
    const result = await invoke("tasks.create", {
      title: titleOf(brief),
      brief,
      // Whatever landed while this was being written. Absent is the ordinary case
      // for a brief typed and submitted in one go, and the extension names it from
      // the brief instead — nothing here waits for a model.
      ...(suggested === null ? {} : { name: suggested }),
      ...(pasted.current.length === 0 ? {} : { images: pasted.current }),
      repos: scope.map((repo) => ({ path: repo.path, name: repo.name })),
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
      `created ${typeof created.slug === "string" ? created.slug : "a task"}`,
    );
    // Cleared only on success. A failed create keeps everything typed — the
    // form is the only copy of it.
    setBrief("");
    setSuggested(null);
    namedFor.current = "";
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
    >
      {/*
        The card is the popover's positioning context, which is why it holds the
        ref: the picker is anchored to a CHARACTER inside the editor, and every
        offset it uses is measured against this box so the clamp has an edge to
        clamp to.
      */}
      <Composer className="sh-composer" ref={card}>
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
            // ⏎ submits and ⇧⏎ newlines — the chat convention.
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            if (titleOf(brief) !== "") void create();
          }}
        />

        {/*
          The action row: the `#repo` affordance and what it has collected on the
          left, one filled action hard right.
        */}
        <div className="sh-composer-controls">
          {/*
            The button exists because `#` is invisible until somebody has been
            told about it, and this is the telling — it appends a `#` at the end
            of the brief, focuses the editor and opens the picker, so the gesture
            it teaches is the gesture it performs. Same rule as the CLI's
            discoverability: an affordance nobody can find is not an affordance.
          */}
          <button
            type="button"
            className="sh-composer-hash"
            data-testid="composer-hash"
            onClick={() => promptRef.current?.appendText("#")}
          >
            <span className="sh-composer-hash-glyph" aria-hidden="true">
              #
            </span>
            repo
          </button>
          {/*
            What the sentence currently scopes, in words. It reads the derived
            scope, so it cannot disagree with the pills — and its zero case says
            where an unscoped task LANDS rather than reporting a missing field.
          */}
          <span className="sh-composer-scope" data-testid="composer-scope">
            {scopeLine(scope.map((repo) => repo.name))}
          </span>
          <span className="sh-composer-spacer" />
          {/*
            The ONE loud thing on the card (rule 3: two primary buttons means
            neither is). `busy` is the primitive's: the label is replaced by a
            braille spinner with the width pinned, so the control does not narrow
            mid-click and take the row with it.
          */}
          <Button
            variant="primary"
            type="submit"
            data-testid="composer-create"
            disabled={titleOf(brief) === ""}
            busy={busy}
          >
            create task
          </Button>
        </div>

        <output className="sh-ext-answer" data-testid="composer-status">
          {status}
        </output>

        {/*
          Last child, and inside the card: it is positioned against the card's box
          and must paint over the footer, and with no shadow to lift it (rule 2)
          the only thing separating it from what it covers is the stacking order.
        */}
        {open ? (
          <RepoPicker
            rows={rows}
            query={query}
            activeIndex={index}
            x={spot.x}
            y={spot.y}
            listId={listId}
            onHover={setActive}
            onPick={pick}
          />
        ) : null}
      </Composer>
    </form>
  );
}
