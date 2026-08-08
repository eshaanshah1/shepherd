# The prompt field becomes a contenteditable — the editing behaviour that must survive

The user approved swapping the composer's `<textarea>` for a contenteditable so
pasted images render as inline `Pill`s where they were pasted. The whole risk of
that swap is editing behaviour a textarea gives for free, and the user named the
ones that matter:

- **⌘A** selects the whole field — and ONLY the field, not the page.
- **⌥←/→** moves by word; **⌥⌫** deletes a word.
- **⌘←/→** moves to line start/end; **⌘↑/↓** to field start/end.
- **⌘⌫** deletes to line start.
- **Cut / copy / paste** — including paste of plain text (which must NOT carry
  styling in), and cut/copy of a selection that spans a pill.
- **⌘Z / ⌘⇧Z** undo and redo, across typing AND pill insertion.
- Shift+ any of the above extends a selection rather than moving the caret.

Two implementation rules that follow, and are the difference between this
working and being a demo:

1. **Do not reimplement any of these.** contenteditable already has them from
   the OS; they break when a handler calls `preventDefault()` on a key it did
   not need to, or when the DOM is rewritten under the caret on every input.
   So: touch the DOM only on paste and on pill removal, never on plain typing,
   and let every unhandled key through untouched.
2. **A pill is one atomic character.** `contenteditable="false"` on the pill so
   the caret steps over it rather than into it, and one backspace removes the
   whole pill — not its icon, then its label.

The value read back out is the text content with each pill rendered as its
`[Image #N]` token, which is what `writePastedImages` already expects.

Verification is by hand in the running app, not by unit test: jsdom implements
neither caret movement nor `execCommand`, so a passing test here would be
asserting the harness. The list above is the checklist.
