import { useEffect, useId, useRef, useState } from "react";
import type { ExtensionViewProps } from "@shepherd/sdk";
import { Button, Composer, Field, PromptField, type PromptFieldHandle } from "@shepherd/ui";
import { repoName } from "../src/model/repo-name.ts";
import type { PastedImage } from "../src/images.ts";
import { readPastedImage } from "./paste-image.ts";

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

interface DisplaySegment {
  readonly text: string;
  readonly matched: boolean;
}

interface PickedRepo {
  readonly path: string;
  readonly name: string;
}

interface RepoSuggestion extends PickedRepo {
  readonly isRepo: boolean;
  /** Where it came from. Only a filesystem row is a Tab target — see `complete`. */
  readonly source: "history" | "filesystem";
  /** The path as a person writes it — home collapsed. What the field draws. */
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
 * `isRepo` and `source` default to the SAFE reading of a provider that omits
 * them: a candidate is treated as a repo (so none is falsely accused) and as
 * history (so it can never drive Tab into a path it does not share a parent
 * with).
 */
function readSuggestions(value: unknown): readonly RepoSuggestion[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { path, isRepo, source, display, segments } = entry as {
      path?: unknown;
      isRepo?: unknown;
      source?: unknown;
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
        source: source === "filesystem" ? "filesystem" : "history",
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

export function TaskComposer({
  invoke,
  done,
}: ExtensionViewProps): React.JSX.Element {
  const [brief, setBrief] = useState("");
  // A PICKED repo is a path and a name — never a suggestion. Its match runs
  // describe a query that is over: the field has been cleared, and a chip that
  // carried them would still be painted for a search nobody is running.
  const [repos, setRepos] = useState<readonly PickedRepo[]>([]);
  const [path, setPath] = useState("");
  const [suggestions, setSuggestions] = useState<readonly RepoSuggestion[]>([]);
  const [listOpen, setListOpen] = useState(true);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<PromptFieldHandle | null>(null);
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
  // anything. Everything after that is a keystroke's; there is no debounce
  // because there is no timer here to get wrong, and the ask is one directory
  // listing (measured at ~10ms, cheaper than the keystroke that asked for it).
  useEffect(() => {
    void askForSuggestions("", "", "");
  }, []);

  // A suggestion already picked stops being offered — it is in the chips below,
  // and showing it in both places reads as two different repos with one name.
  const visible = suggestions.filter(
    (suggestion) => !repos.some((repo) => repo.path === suggestion.path),
  );
  /**
   * ONE completion — the best-ranked row the extension answered with, and only
   * once there is something for it to complete.
   *
   * The empty query is answered with the picked history (see the mount effect),
   * which was right when this was a LIST: "the repos you actually use, offered
   * before you have typed anything". As ghost text it is not — a completion of
   * nothing is an absolute path painted into an empty field, which reads as a
   * field that came pre-filled with a repo you never chose, and sits directly on
   * top of the `+ repo` placeholder the moment the field is not focused. The
   * history still arrives and still ranks; it just waits for a character.
   */
  const current = listOpen && path !== "" ? visible[0] : undefined;

  /**
   * Esc dismisses the completion, and must not close the composer with it.
   *
   * Radix's dismissable layer listens for Escape on the document in the CAPTURE
   * phase, so a React handler on the input cannot stop it — capture at the
   * document runs before anything below. A capture listener on `window` runs
   * before the document's, which is the one seam available, and Radix honours
   * `defaultPrevented` (it checks it before dismissing). Measured against
   * `@radix-ui/react-dismissable-layer`, not assumed.
   *
   * Only while the list is open and only for a keypress in this field: Esc in
   * the brief still closes the composer, which is what Esc means everywhere else
   * in the app.
   */
  useEffect(() => {
    if (!listOpen || visible.length === 0) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.target !== inputRef.current) return;
      event.preventDefault();
      setListOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listOpen, visible.length]);

  const add = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (trimmed === "") return;
    // Same repo twice is one worktree and one branch, so it is one entry.
    if (!repos.some((repo) => repo.path === trimmed)) {
      setRepos([
        ...repos,
        { path: trimmed, name: repoName(trimmed) },
      ]);
    }
    setPath("");
    setListOpen(true);
    // Back to the history, which is what an empty field asks for.
    void askForSuggestions(titleOf(brief), brief, "");
  };

  const retype = (next: string): void => {
    setPath(next);
    setListOpen(true);
    void askForSuggestions(titleOf(brief), brief, next);
  };

  /**
   * Take the completion that is on screen.
   *
   * It is whatever the field is showing, and that is the whole rule: with ONE
   * suggestion visible there is nothing else it could honestly mean. The
   * previous version completed to the common prefix of every filesystem match —
   * shell behaviour, correct when a list was on screen — and once the list went
   * away it promised `shepherd` in ghost text and gave you `she`.
   *
   * It retypes the DISPLAY text, `~` and all, so the query and what is on screen
   * agree afterwards; `expandHome` is what reads it back.
   *
   * ↹ COMPLETES, whatever the row's source. It used to take a filesystem row and
   * otherwise hand focus to the brief, on the reasoning that only a filesystem
   * row shares a parent with what you typed — but the field draws one answer and
   * that answer is takeable whatever list it came from, and a ↹ that sometimes
   * completes and sometimes leaves the field is a key you have to think about.
   *
   * It re-asks with the completed text, so the next level appears with no
   * second keystroke.
   */
  const complete = (): boolean => {
    if (current === undefined) return false;
    if (current.display === path.trim()) return false;
    retype(current.display);
    return true;
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
      ...(pasted.current.length === 0 ? {} : { images: pasted.current }),
      repos: repos.map((repo) => ({ path: repo.path, name: repo.name })),
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
    promptRef.current?.setValue("");
    pasted.current = [];
    setRepos([]);
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
      <Composer className="sh-composer">
        {/*
          ONE field. A separate title box asked the same question twice — nobody
          writes a title that is not the first sentence of the brief, and the
          empty second box was the thing that made this read as a form.
          The convention is git's: first line names it, the rest is the body.

          `bare` needs no prop of its own — the `Composer` around it re-declared
          `--sh-line` and `--sh-surface-sunken` to transparent for its whole
          subtree, so a default `bordered` field would already be borderless. It
          is passed anyway because the variant is also what removes the horizontal
          padding, and because a field that is bare BY CONTEXT reads as an
          accident when this component is mounted anywhere else.
        */}
        {/*
          Repos first, because that is the order the decision happens in: you
          pick what you are working on, THEN say what to do to it. It read
          backwards while it sat under the brief — and a field below the thing
          it scopes is a field found after the brief has already been written.

          ONE completion, inline, no dropdown: the single best match as ghost
          text behind what you typed. ↹ takes it while there is something to
          take and moves to the brief once there is not, ⏎ adds it and stays
          here, so several repos are several ⏎s and no mouse.
        */}
        <div className="sh-composer-repos">
          {/*
          The repo field: ONE completion, inline, and no dropdown.
          
          It was a labelled, bordered input over a listbox of rows, and in a card
          whose whole purpose is the brief it read louder than the brief — the
          overcorrection from "too hidden". So: no label (the placeholder says
          it), no border of its own, and the single best match rendered as ghost
          text behind what you typed. ↹ takes it, ⏎ adds it, and there is nothing
          on screen the rest of the time.
        */}
        <div className="sh-composer-repo">
          {/*
            The ghost sits UNDER the input, in the same box with the same type,
            so the completion lines up with the cursor character for character.
            A second element rather than a value the field holds: writing the
            completion into the input would mean the user's next keystroke edits
            text they did not type.
          */}
          {path === "" ? null : current === undefined ? (
            // Nothing matched. The raw query is the only honest thing left to
            // draw — going blank here would leave you typing at a field that
            // shows nothing back, with no way to see the typo you just made.
            <div className="sh-composer-repo-shown" data-testid="composer-nomatch" aria-hidden="true">
              <span className="sh-composer-repo-miss">{path}</span>
            </div>
          ) : (
            <div
              className="sh-composer-repo-shown"
              data-testid="composer-suggestion"
              data-path={current.path}
              aria-hidden="true"
            >
              {current.segments.map((run, at) => (
                <span
                  // Index, because the runs ARE positional: two runs of the same
                  // text in one path are two different places in it.
                  key={at}
                  className={run.matched ? "sh-composer-repo-hit" : undefined}
                >
                  {run.text}
                </span>
              ))}
              {current.isRepo ? null : <span className="sh-composer-repo-note">not a repo</span>}
            </div>
          )}
          <Field
            id={inputId}
            ref={inputRef}
            size="sm"
            variant="bare"
            data-testid="composer-repo-path"
            placeholder="+ repo"
            autoComplete="off"
            spellCheck={false}
            aria-label="repo path"
            value={path}
            onChange={(event) => retype(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Tab" && !event.shiftKey) {
                // ↹ completes the path, and does nothing else. It used to hand
                // focus to the brief when there was nothing to complete, which
                // made one key mean two things depending on state you cannot see
                // — and the state it fires in most often is "half a path typed".
                // With nothing to take it falls through to the browser, so focus
                // still moves rather than being trapped.
                if (!complete()) return;
                event.preventDefault();
                return;
              }
              if (event.key === "ArrowRight" && current !== undefined) {
                // At the end of the line, → takes the completion — the shell
                // gesture, and the one people try before they try Tab. Anywhere
                // else it is an ordinary cursor move.
                const target = event.currentTarget;
                if (target.selectionStart === path.length && target.selectionEnd === path.length) {
                  event.preventDefault();
                  complete();
                }
                return;
              }
              if (event.key === "Enter") {
                // Enter adds the repo rather than submitting the form: a task
                // with the repo field half-typed is a task with the wrong repos.
                event.preventDefault();
                add(current?.path ?? path);
              }
            }}
          />
        </div>

        <ul className="sh-composer-picked" data-testid="composer-picked">
            {repos.map((repo) => (
              <li
                key={repo.path}
                data-testid="composer-picked-repo"
                data-path={repo.path}
                title={repo.path}
              >
                {repo.name}
                <button
                  type="button"
                  aria-label={`remove ${repo.name}`}
                  title={`remove ${repo.name}`}
                  onClick={() =>
                    setRepos(repos.filter((r) => r.path !== repo.path))
                  }
                >
                  ×
                </button>
              </li>
            ))}
        </ul>

        </div>

        <PromptField
          ref={promptRef}
          className="sh-composer-brief"
          data-testid="composer-brief"
          aria-label="what needs doing"
          placeholder="what needs doing?"
          onChange={setBrief}
          onBlur={() => void askForSuggestions(titleOf(brief), brief, path)}
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
            // ⏎ submits and ⇧⏎ newlines — the chat convention, and the one the
            // repo field above hands you: ⏎ there adds a repo and stays, ↹
            // brings you here, ⏎ here is done. ⌘⏎ still works because it is
            // what the previous build bound and fingers remember it.
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            if (titleOf(brief) !== "") void create();
          }}
        />

        {/*
          The repo picker: a labelled input with its completions under it.

          It used to be a borderless `+ repo path` sharing a row with the create
          button, and it was too hidden to be found — which is the whole reason
          this exists. So it is a `bordered` Field with a label of its own, and
          the wrapper re-declares `--sh-line` and `--sh-surface-sunken` back on,
          which is exactly the escape hatch `composer.css` documents for "a
          control that genuinely needs an edge in here".
        */}
        {/*
          The ONE loud thing on the card (rule 3: two primary buttons means
          neither is). `busy` is the primitive's, and it is a real improvement
          over the shipped disabled-while-creating: the label is replaced by a
          braille spinner with the width pinned, so the control does not narrow
          mid-click and take the row with it.
        */}
        {/* The action row: one filled action, hard right, and nothing else. */}
        <div className="sh-composer-controls">
          <span className="sh-composer-spacer" />
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
      </Composer>
    </form>
  );
}
