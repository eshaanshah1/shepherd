import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ExtensionViewProps } from "@shepherd/sdk";
import { Button, Composer, Field, Row, TextArea } from "@shepherd/ui";
import { repoName } from "../src/model/repo-name.ts";
import { commonPrefix } from "../src/model/path-complete.ts";

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

interface RepoSuggestion {
  readonly path: string;
  readonly name: string;
  readonly isRepo: boolean;
  /** Where it came from. Only a filesystem row is a Tab target — see `complete`. */
  readonly source: "history" | "filesystem";
  /** Indices into `path` that the query matched. Emphasised in the row. */
  readonly matched: readonly number[];
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
 * `isRepo`, `source` and `matched` default to the SAFE reading of a provider
 * that omits them: a candidate is treated as a repo (so no row is falsely
 * accused), as history (so it can never drive Tab into a path it does not share
 * a parent with) and as having matched nothing (so nothing is falsely
 * emphasised).
 */
function readSuggestions(value: unknown): readonly RepoSuggestion[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { path, isRepo, source, matched } = entry as {
      path?: unknown;
      isRepo?: unknown;
      source?: unknown;
      matched?: unknown;
    };
    if (typeof path !== "string" || path === "" || seen.has(path)) return [];
    seen.add(path);
    return [
      {
        path,
        name: repoName(path),
        isRepo: isRepo !== false,
        source: source === "filesystem" ? "filesystem" : "history",
        matched: Array.isArray(matched)
          ? matched.filter((index): index is number => typeof index === "number")
          : [],
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
 * The path, with the matched characters emphasised.
 *
 * The positions come from the ranker, so what is bold is exactly what earned the
 * row its place. Rendered as a run of spans rather than one per character: a
 * fuzzy match on a long path is mostly contiguous, and a span per character
 * makes the browser break the line between them.
 */
function emphasise(path: string, matched: readonly number[]): ReactNode {
  if (matched.length === 0) return path;
  const hits = new Set(matched);
  const parts: ReactNode[] = [];
  let index = 0;
  while (index < path.length) {
    const isHit = hits.has(index);
    let end = index;
    while (end < path.length && hits.has(end) === isHit) end += 1;
    const text = path.slice(index, end);
    parts.push(
      isHit ? (
        <b key={index} className="sh-composer-repo-hit">
          {text}
        </b>
      ) : (
        text
      ),
    );
    index = end;
  }
  return parts;
}

export function TaskComposer({
  invoke,
  done,
}: ExtensionViewProps): React.JSX.Element {
  const [brief, setBrief] = useState("");
  const [repos, setRepos] = useState<readonly RepoSuggestion[]>([]);
  const [path, setPath] = useState("");
  const [suggestions, setSuggestions] = useState<readonly RepoSuggestion[]>([]);
  const [active, setActive] = useState(0);
  const [listOpen, setListOpen] = useState(true);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
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
    if (answer.ok && mine === asked.current) {
      setSuggestions(readSuggestions(answer.value));
      setActive(0);
    }
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
  const index = visible.length === 0 ? 0 : Math.min(active, visible.length - 1);
  const current = listOpen ? visible[index] : undefined;

  /**
   * Esc closes the LIST, and must not close the composer with it.
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
        { path: trimmed, name: repoName(trimmed), isRepo: true, source: "history", matched: [] },
      ]);
    }
    setPath("");
    setListOpen(true);
    // Back to the history, which is what an empty field asks for.
    void askForSuggestions(titleOf(brief), brief, "");
  };

  const retype = (next: string): void => {
    setPath(next);
    setActive(0);
    setListOpen(true);
    void askForSuggestions(titleOf(brief), brief, next);
  };

  /**
   * Tab completes, the way a shell does: as far as every match agrees, which for
   * a single match is that match's whole path. It does NOT submit — completing
   * to `~/Home/dev/` and carrying on typing is the whole point, and the field
   * re-asks with the new text, so the next level appears with no second
   * keystroke. Taking a SPECIFIC row is what ↓ and ⏎ are for.
   *
   * Only the FILESYSTEM rows are candidates. They are the ones that share a
   * parent by construction (one level, one `readdir`), so their common prefix is
   * always a real path; a history row can match the same query from anywhere on
   * disk, and folding it in would complete to whatever two unrelated trees
   * happen to share — usually `/Users/`.
   *
   * The completion is the ABSOLUTE path, losing a typed `~`. The rows show
   * absolute paths (which is what you asked to see), so the field agreeing with
   * them is the smaller surprise, and `expandHome` still accepts a `~` typed by
   * hand.
   */
  const complete = (): boolean => {
    const target = commonPrefix(
      visible.filter((suggestion) => suggestion.source === "filesystem").map((s) => s.path),
    );
    // No progress is not a completion: Tab then falls through and moves focus,
    // which is what it does in a field with nothing to offer.
    if (target.length <= path.length) return false;
    retype(target);
    return true;
  };

  const create = async (): Promise<void> => {
    setBusy(true);
    const result = await invoke("tasks.create", {
      title: titleOf(brief),
      brief,
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
        <TextArea
          variant="bare"
          autoGrow
          minLines={3}
          maxLines={12}
          className="sh-composer-brief"
          data-testid="composer-brief"
          aria-label="what needs doing"
          placeholder="what needs doing?"
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          onBlur={() => void askForSuggestions(titleOf(brief), brief, path)}
          onKeyDown={(event) => {
            // ⌘⏎ submits, ⏎ is a newline: this is prose, and a brief whose second
            // sentence created the task would be a brief nobody could write.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (titleOf(brief) !== "") void create();
            }
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
        <div className="sh-composer-repo">
          <label className="sh-composer-repo-label" htmlFor={inputId}>
            repo
          </label>
          <Field
            id={inputId}
            ref={inputRef}
            size="sm"
            data-testid="composer-repo-path"
            placeholder="~/dev/… — type a path, ↹ completes, ⏎ adds"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={current !== undefined}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current === undefined ? undefined : `${listId}-${index}`}
            value={path}
            onChange={(event) => retype(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setListOpen(true);
                // Wraps: a list you can arrow off the end of makes the last row
                // harder to reach than the first, for no reason.
                setActive(visible.length === 0 ? 0 : (index + 1) % visible.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setListOpen(true);
                setActive(
                  visible.length === 0 ? 0 : (index - 1 + visible.length) % visible.length,
                );
                return;
              }
              if (event.key === "Tab" && !event.shiftKey) {
                // Only swallowed when it actually completed something, so Tab
                // still moves focus out of a field with nothing to offer.
                if (complete()) event.preventDefault();
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

          {current === undefined ? null : (
            <div
              className="sh-composer-repo-list"
              id={listId}
              role="listbox"
              aria-label="repo suggestions"
            >
              {visible.map((suggestion, position) => (
                <Row
                  key={suggestion.path}
                  id={`${listId}-${position}`}
                  role="option"
                  aria-selected={position === index}
                  selected={position === index}
                  data-testid="composer-suggestion"
                  data-path={suggestion.path}
                  className="sh-composer-repo-row"
                  /*
                   * A directory with no `.git` is still offered — it is how you
                   * reach the repos inside it — so what stops it being picked by
                   * accident is that it says so.
                   */
                  meta={suggestion.isRepo ? undefined : "not a repo"}
                  /*
                   * `mousemove`, not `mouseenter`. With the pointer resting in
                   * the list, `mouseenter` never fires again — so arrowing down
                   * moves the highlight, the pointer is now over a different row,
                   * and the next jitter yanks the selection back.
                   */
                  onMouseMove={() => setActive(position)}
                  onClick={() => add(suggestion.path)}
                >
                  {emphasise(suggestion.path, suggestion.matched)}
                </Row>
              ))}
            </div>
          )}

          {/*
            The picked repos. Chips rather than rows, because a picked repo is a
            token in a sentence and an offered one is a place you might go — they
            stopped being the same object the moment the offered one became a
            path you can navigate through.

            Still the shell's CSS and NOT a primitive: there is no `Chip` in the
            fifteen, and a `Button` would gain a control treatment this cannot
            have (it carries a nested ×, which would be a button in a button).
          */}
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

        {/*
          The ONE loud thing on the card (rule 3: two primary buttons means
          neither is). `busy` is the primitive's, and it is a real improvement
          over the shipped disabled-while-creating: the label is replaced by a
          braille spinner with the width pinned, so the control does not narrow
          mid-click and take the row with it.
        */}
        <div className="sh-composer-controls">
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
