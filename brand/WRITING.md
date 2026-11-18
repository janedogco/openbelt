# Writing

Words on OpenBelt's own surfaces: page copy, UI labels, buttons, empty states. The look is in
[DESIGN.md](DESIGN.md).

- **Lead with what the reader gets.** Benefit first, then what OpenBelt is: "An app store for you and
  your agents." before "an open-source platform".
- **Say each thing once.** A subhead adds to its heading instead of restating it. A label doesn't
  repeat its icon's tooltip. No sentence restates the one before it.
- **Concrete and true.** Name real things ("the tools you already use", "Claude Code, Codex"), not
  hedges ("nearly everything"). Describe only what ships; plans stay in VISION.md.
- **Short.** One idea per sentence. Headings under about eight words; supporting text one sentence.
  If it needs a footnote, it belongs in the docs.
- **Helper text is eight words at most.** The small print under a heading, row or field (`sub()`,
  `.small`, `.note`, `.muted`). `bun run check` fails past that; `COPY_KEPT` in `scripts/guard.ts` lists
  the few longer ones kept on purpose, and only shrinks.
- **Plain.** Sentence case everywhere, buttons included. Address the reader as "you" and "your
  team". No em dashes or curly quotes.
- **Names.** OpenBelt is capitalised; `openbelt`, packages and paths stay lowercase in code
  formatting. What people build is an app, everywhere, names included (`deploy_app`, `/a/<app>/`). Other
  products are written the way their makers write them: Claude Code, opencode, pi, GitHub.
- **Tab titles: the specific thing first, then OpenBelt, joined by a middle dot.** `acme · OpenBelt`.
  A narrow tab keeps the part that tells tabs apart.
- **Buttons say the action.** "Self-host OpenBelt", "Deploy", "Upload". Never "Learn more" or "Click
  here".
- **Empty states name what's missing and the one action that fixes it.** "No apps yet. Ask your
  agent to build one with the OpenBelt plugin."
