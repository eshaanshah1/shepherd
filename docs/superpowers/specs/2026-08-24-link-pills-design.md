# Link pills: Slack and Jira in the composer

Date: 2026-08-24
Scope: `v2/` only.
Status: design, approved in chat. Implementation plan not yet written.

## What this is

Two more pill kinds in the task composer, beside the repo pill and the image
pill. Paste a Jira issue URL and it becomes a pill reading `SHEP-412 Retry loop
drops the last event`, with the Jira mark and Jira's blue on it. Paste a Slack
permalink and it becomes a pill reading `Slack thread · 24 Aug`, with the Slack mark and
Slack's aubergine.

The asymmetry is the whole story of this document. A Jira URL carries its issue
key in the path, and `acli` is already authenticated, so the pill can say what
the issue actually is. A Slack permalink carries an opaque channel id and a
numeric timestamp, and reading the message behind it needs a workspace app this
user cannot install. So the Slack pill is drawn and never resolved.

## What was decided

- **Paste is the only trigger.** No `#` picker entry, no conversion of a URL
  typed by hand. Autoformatting under a live caret fights the person typing.
- **Jira resolves through `acli` first and an API token second.** The same order
  and the same reasoning as `github/src/token.ts`: ask the CLI the user already
  logged into, keep the token field for the machine where that fails, and say so
  on the field itself.
- **Slack is parse-and-draw.** No token, no network, no secret. Revisit if a
  workspace app ever becomes installable.
- **The Jira fallback label is the bare key.** `SHEP-412` when `acli` cannot
  answer. `Jira task` only when the host matched and no key parsed. The key is
  free from the URL and a generic label throws it away.
- **The brand hues are not theme colours.** They belong to these two pills and
  nowhere else in the app.
- **The pill lands immediately and its label fills in afterwards.**
- **`data-token` is the URL and only ever the URL.** The resolved summary is a
  label, drawn for the person composing, and never substituted into the brief the
  agent reads. See "What the agent reads".
- **Providers claim URLs by pattern, not by host.** So a claimed URL is one the
  grammar can parse, and the composer never has to un-draw a pill.

## Colour

`pill.css:96` states that the fill, the hairline, the lit top edge and the glyph
are every one of them a role rather than a hue, "so an extension that
re-declares `--sh-sky` gets the whole treatment retinted for free". `roles.ts`
holds up that claim: `fillAccent`, `lineAccent` and `glintAccent` are all
`kind: 'wash', of: 'sky'`.

So the entire treatment follows one scoped re-declaration per vendor:

```css
.sh-ui-pill[data-link='jira']  { --sh-sky: color-mix(in srgb, #0052CC 78%, var(--sh-text)); }
.sh-ui-pill[data-link='slack'] { --sh-sky: color-mix(in srgb, #4A154B 78%, var(--sh-text)); }
```

No role, no palette entry, no generated token. `token-refs.css.test.ts` passes
because a tier-3 property declared in the sheet is one of the three sources it
sanctions, and this is that.

The `color-mix` toward `--sh-text` is load-bearing rather than decorative. Theme
mode has no CSS selector in this app: it is only the values of the variables
injected at `:root` by `renderer/theme.ts`. A rule therefore cannot branch on
light or dark, so a bare `#4A154B` cannot have a dark variant at all. Mixing the
mode's own text colour into the brand hue lifts aubergine off a near-black well
and deepens it on paper, from one literal. That is the idiom `send-button.css:40`
already uses on `sky`.

78% is a starting number, not a measured one. The implementation tunes it against
`contrast.ts` for both wells and pins the result, because aubergine on `#121212`
is the case that fails and it fails quietly.

The four border longhands stay folded up exactly as they are. `pill.css:115`
warns that jsdom's CSSOM drops a shorthand holding a `var()`, which is why they
were split in the first place; re-declaring `--sh-sky` retints them where a
`border-color` override would be invisible to the test that guards them.

Repo and image pills keep `sky` untouched. Only `[data-link]` is scoped.

## Where the code lives

A new extension, `v2/extensions/links`, id `shepherd.links`. It owns both URL
grammars and the Jira resolution chain.

Permissions: `process.exec` for `acli`, `network` for the Jira REST fallback,
`secrets` for the token. One secret declared in its manifest, which is what puts
a field on the Secrets screen before the extension has ever run:

- `links.jiraToken`, described as only needed when `acli` cannot answer, naming
  the scope and linking to `id.atlassian.com/manage-profile/security/api-tokens`.

Registration touches `ext-host/builtins.ts`, the manifest list in
`main/index.ts`, the workspace `package.json` and `tsconfig.json`.

## The point, and why the parser is not imported

`extensions/README.md:24` is explicit and lint-enforced in
`tooling/eslint/boundaries.js`: one extension may type-import another and may not
value-import it, because a cross-extension call is declared and gated through
`manifest.dependencies` plus `extensions.get`, and a direct value import reaches
the same code with neither.

The composer lives in `tasks`. So it cannot call the parser in `links`, and the
naive design (recognise the URL synchronously in the paste handler) is not
available.

The answer is a point, which also gets the direction of the dependency right.
`tasks` is the M3 extension that `worktree-hook`, `transcripts` and `github` all
plug into; making it depend on a links extension would invert that. A point means
`links` depends on `tasks`, like every other provider.

Declared in `tasks/src/manifest.ts`:

```ts
export const PASTED_LINK_POINT = 'tasks.pastedLink';

export interface PastedLinkProvider {
  /** Which URLs this provider claims. The composer's intercept rule. */
  readonly patterns: readonly PastedLinkPattern[];
  resolve(url: string, signal: AbortSignal): Promise<PastedLink | null>;
}

/**
 * Data, not a regex. A pattern crosses a port and is matched in the renderer, so
 * a compiled expression here would be a provider handing the composer something
 * to run. Three fields answer both vendors.
 */
export interface PastedLinkPattern {
  readonly hostSuffix: string;
  readonly pathPrefix: string;
  /** A query parameter that must be present. Absent means any query. */
  readonly query?: string;
}

export interface PastedLink {
  /** Which mark and which hue. `data-link` on the pill is this. */
  readonly vendor: 'jira' | 'slack';
  /** What the pill reads. Already the fallback when nothing resolved. */
  readonly label: string;
  /** True when a lookup actually answered. Read by tests; drives nothing. */
  readonly resolved: boolean;
}
```

Note what `PastedLink` does not carry: a token, an icon and a colour. The token is
the URL the composer already has. `vendor` is a closed two-member union, and the
composer owns the glyph and the hue the way `repoPill` and `imagePill` already do,
so no decoration crosses the port. That is the rule `CardFact` states for the card
rail, met here by having nothing to allow-list rather than by allow-listing.

`links` declares `tasks` in its `manifest.dependencies`, which is the entry that
makes registering into the point reviewable. The type-only import of
`PastedLinkProvider` is the half the lint rule permits. `manifest.test.ts` pins
the point id against `tasks`' own literal, the way `worktree-hook` does.

It clears ADR 0039's bar for a new point, which is a different subject rather
than a different moment: a pasted URL is neither a repo nor a task.

### Why patterns and not host suffixes

The intercept decision has to be synchronous, because it calls `preventDefault` on
a paste event. Providers run in the utility process and the composer runs in the
renderer, so whatever the decision reads has to be in the renderer already. The
composer therefore asks `tasks.linkPatterns` when it opens and matches against the
answer; `tasks.resolveLink` is the second command, dispatching to the point.

The patterns are host **and path** rather than host alone, and that is what makes
the flow one-way. Host alone would claim every `atlassian.net` URL, so a
Confluence page would be swallowed, resolve to nothing, and have to be put back as
text: a visible flicker on the one surface that has to stay quiet. With the path in
the pattern, a claimed URL is one the grammar can parse. Jira registers
`{'.atlassian.net', '/browse/'}` and `{'.atlassian.net', '/jira/', 'selectedIssue'}`;
Slack registers `{'.slack.com', '/archives/'}`. Confluence lives under `/wiki/`
and is never claimed.

**The composer never un-draws a pill.** A claimed URL whose grammar still fails,
`/browse/notakey`, gets the pill with its generic fallback label. That is what the
generic fallback is for, and it is one state instead of two.

On staleness: read when the composer OPENS, not once on mount. The machine list
gets away with mount-time caching because it is re-read on the next open and a
gone-away machine is caught downstream where `tasks.create` forwards to it. A
stale intercept rule has no downstream catch, so it does not get the same
latitude.

## Parsing

`links/src/parse.ts`, pure, no network, returning a union or null. Null means the
paste stays plain text, which is also what the composer does when the point
returns nothing.

Jira, host suffix `.atlassian.net`:

- `/browse/SHEP-412`
- `/jira/software/projects/SHEP/boards/1?selectedIssue=SHEP-412`

Slack, host suffix `.slack.com`:

- `/archives/C08ABCDEF/p1724500000123456`
- the same with `?thread_ts=1724499000.111111`

The Slack timestamp conversion is the one fiddly piece: `p1724500000123456`
becomes `1724500000.123456`, a decimal point six digits from the end. It gets its
own tests, including the malformed lengths, because the failure mode is a
plausible-looking timestamp that matches no message.

## Resolving Jira

`links/src/jira.ts`, three steps and then an honest failure.

1. `acli jira workitem view SHEP-412 --fields summary,status --json`
2. `GET /rest/api/3/issue/SHEP-412?fields=summary,status`, Basic auth over the
   stored token, only if step 1 failed and a token exists
3. give up

Step 1 has to probe for the binary the way `github/src/token.ts` probes for `gh`,
and for the same measured reason: a GUI app inherits a minimal `PATH`, so
`/opt/homebrew/bin/acli` and `/usr/local/bin/acli` are tried before the bare name
is left to `PATH`. The app harvests the login shell's `PATH` at startup, so the
bare name normally answers, but this extension has to work on the machine where
that harvest found nothing.

Giving up is a normal state, not an error. No toast, no red, no banner. The pill
keeps its fallback label and the composer says nothing, because a person pasting
a link into a brief did not ask this app to authenticate them and a warning here
would be noise on the one surface that has to stay quiet.

**The whole chain runs under a deadline**, and running out of it is one more way of
giving up. `resolve` takes an `AbortSignal`, which is sound for the reason
`TranscriptQuery` records for its own: a point's providers run in the same process,
so there is no port to flatten a real signal into a plain value. The deadline
exists because step 1 spawns a process, and ADR 0038's measured lesson is that
nothing user-facing may wait on one. The fallback label is already on screen, so a
slow answer has nothing to hold up and should lose quietly.

## Slack, deliberately unresolved

`links` still owns the Slack grammar and still claims the URL, so the pill gets
drawn and tinted. `resolve` makes no call.

The label is not a constant, though. The permalink's `p1724500000123456` is epoch
seconds with six more digits, so the date is a pure parse: `Slack thread · 24 Aug`.
It is the whole of what Slack gets and it costs nothing, which is reason enough.

What resolution would take, recorded so the next person does not re-derive it: a
user token with `channels:read` and `conversations.history`, then three calls per
link, `conversations.info` for the channel name, `conversations.history` with
`latest=<ts>&limit=1&inclusive=true` for the text and author id, and `users.info`
for the display name. It is out of scope because it needs a workspace app
installed, which is an approval this user does not have.

## The pill, and filling in late

`PromptField` gains one optional prop, mirroring `onPasteFiles` down to its
contract:

```ts
readonly onPasteText?: (text: string) => boolean;
```

Return true and the default `insertText` is suppressed for that event only. About
six lines in the shared primitive, in the handler that already branches on files
at `prompt-field.tsx:464`.

The composer's handler intercepts only when the pasted text is a single token that
parses as an http URL matching one of the cached patterns. Anything else falls
through to the plain-text paste it does today. That narrowness is deliberate:
`prompt-field.tsx:471` notes that letting text pastes through the browser is what
keeps undo intact, so the set of pastes that lose that property should be the
smallest set the feature needs.

The pill is inserted immediately with `data-token` set to the URL and its fallback
label showing, then `tasks.resolveLink` runs and the LABEL alone is swapped when it
answers. `acli` is a subprocess and takes a visible beat; a composer that stalls on
paste is worse than a label that arrives a moment later. The pill is a DOM node the
composer owns rather than something React renders, so the swap is a `textContent`
assignment on a `contentEditable=false` node, with no re-render, no undo entry and
nothing written near the caret.

The token is never rewritten, which means a resolve that never answers cannot
leave the brief in a worse state than a resolve that was never started.

Late answers need the guard the picker already has at `composer.tsx:259`. Each
pill carries an id, and the swap is keyed to that node rather than to a document
position, because the person keeps typing while the answer is in flight. An answer
whose pill has since been deleted is dropped.

The answer arrives as `unknown` over the invoke bus and gets read the way
`readMachines` and `readSegments` already read theirs. A `vendor` outside the union
draws no pill at all rather than an untinted one, on the `CardFact` principle that
a malformed contribution should be invisible rather than a box.

## What the agent reads

The URL. That is the whole of it, for both vendors, resolved or not:

```
https://browserstack.atlassian.net/browse/SHEP-412
https://browserstack.slack.com/archives/C08ABCDEF/p1724500000123456
```

An earlier draft had the token carry the resolved summary too, on the grounds that
the agent would get the gist without a fetch. That is wrong twice over. It puts
text written and editable in another system into the prompt an agent reads, which
is a prompt-injection surface for a feature whose job is to draw a chip. And it
makes the brief depend on whether a subprocess answered in time, so the same paste
submits differently depending on how busy the machine was.

The summary is a label. It is drawn for the person composing, who can see the pill
and decide whether it is the issue they meant. The agent gets the fact, which is
the URL, and fetches the rest if it cares.

## Not in scope

- Slack message resolution, for the reason above.
- A `#` picker that searches Jira. The picker's row model is repo-shaped
  throughout and every keystroke would spawn an `acli`.
- Converting a URL typed by hand.
- Confluence, Linear, GitHub issue URLs. The point makes each of them a provider
  rather than an edit here, which is most of why it is a point.
- Any brand hue in `palette.ts`.

## Considered and declined

**Chipping every pasted URL.** The strongest alternative, and it is genuinely
coherent: since `readValue` substitutes a pill's token, a generic pill over a URL
token is text-identical to the plain URL, so nothing is lost and no pattern list is
needed anywhere. Declined because a pill is `contentEditable=false` and atomic. It
would make every URL anyone pastes into a brief both a chip and no longer editable,
which is a change to what paste does, for a feature that was asked to draw two
vendor pills.

**Declaring the patterns in the provider's manifest** rather than at runtime, so
the host could read them without activating anything. Declined on cost:
`contributionsOf` requires every contribution kind to be named in the type, the
schema and the copy, and `tasks` would additionally need an API to enumerate a
foreign manifest's contributions, which does not exist. That is kernel surface for
one consumer.

**Putting this in `tasks` instead of a new extension**, since `acli` alone would
run under the `process.exec` it already holds. Declined because that grant is
argued in `tasks/src/manifest.ts` as being there for git during provisioning, and
the token fallback would then want `network` and `secrets` on the extension that
already holds `storage`, `sessions`, `layout` and `agents`. `github` is the
template: a vendor plus a credential earns its own extension.

**Tinting through a role rather than a hue.** The design language's own rule, and
declined deliberately. These hues are two vendors' identity, they appear on nothing
else, and `pill.css`'s tier-3 mechanism is where a value like that belongs.

## Testing

- `parse.ts`: every URL form above, the Slack timestamp conversion including
  malformed lengths, and near-misses that must stay plain text (`C#`, a bare
  `atlassian.net` marketing page, a `/wiki/` path).
- Pattern matching: each registered pattern against the URLs it must claim and the
  ones it must not, `query` present and absent.
- The Jira chain against a fake `ProcessAPI` and a fake fetch, one case per step,
  including `acli` absent, `acli` present but logged out, token absent, token
  rejected, and the deadline firing mid-spawn.
- The label builders, resolved and every fallback.
- `PromptField`: `onPasteText` returning true suppresses the default, returning
  false does not, and a paste carrying files still reaches `onPasteFiles` first.
- Composer: paste inserts a fallback pill whose token is the URL, a late answer
  swaps the label and leaves the token alone, an answer for a deleted pill is
  dropped, an answer with an unknown `vendor` draws nothing, and a non-matching URL
  pastes as text.
- `manifest.test.ts` in `links`: the point id still equals `tasks`' literal.
- Colour: the mixed hue clears `contrast.ts` against both wells, and
  `token-refs.css.test.ts` stays green.

## Risks

**`acli` is a vendor CLI on a version treadmill.** It already prints an
out-of-date warning on every invocation on this machine, and `--json` output
shape is not a contract. The parse of its output should be defensive and a shape
it does not recognise should fall through to step 2 rather than throw.

**The pattern list is a second copy of the grammar's front door.** The provider
knows the real grammar and the composer knows the patterns, so a vendor whose URL
shape changes has two places to fix and only one of them fails loudly. Mitigated by
a test in `links` asserting that every URL its parser accepts is also claimed by
one of its own patterns, which turns the drift into a red test rather than a paste
that stops working.

**Tabler may not ship a Jira mark.** It has `IconBrandSlack`; Jira is unverified,
and the icon package cannot be reached from an extension anyway. Not really a risk,
since `repoPill` and `imagePill` both hand-roll their inline SVG at 14px and a
third would be consistent, but it is the kind of thing that surprises you an hour
in.

## Open

Nothing blocking. Two things to settle while implementing:

- The exact `color-mix` percentage per vendor, measured rather than guessed.
- Whether the Jira label shows status alongside the summary. `--fields` already
  asks for it, and a done issue reading as live in a brief is misleading, but a
  status word may not earn its room in a pill.
