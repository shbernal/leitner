# AGENTS.md

## Project stage

Published: `leitner` on npm, `shbernal/leitner` on GitHub, both public. It is a
`0.x` CLI with no known dependents, so there is no backwards-compatibility
obligation and no deference owed to the prior architecture: existing code, docs
and plans are context, not constraints, and the simplest coherent design for the
current direction wins. Delete rather than deprecate.

The one thing a version bump protects is the review state described below.

Two things are sticky anyway, and neither is about compatibility with a consumer:

- **Card ids.** `sha1(relativePath : slugified-heading : headingIndex)`, derived
  in `src/parser.ts`. Changing the derivation silently invalidates every review
  record on disk — a user loses their history and nothing tells them. Treat it as
  a format-level decision, not an implementation detail. `docs/format.md` is the
  only written account of the scheme; it moves with the code.
  `relativePath` is relative to the one source directory the file was found
  under, never to a common parent of the configured ones. Relativising against
  anything shared is how a second directory would rename every card in the
  first. It is also why a collision between two roots is warned about rather
  than designed away, and why nested roots are refused outright.
  `tests/parser.test.ts` holds the literal hashes; `parseDirectories` holds the
  merge.
- **The review state file.** `~/.local/share/leitner/review-state.json` is the
  user's data. A migration is fine; losing it is not.

## The rule that matters

**Markdown files are only ever read.** `leitner` conforms to Flashcard Markdown
as a *consumer*, never a producer. Nothing in `src/` may write into the notes
tree. The single exception is `e` in a review session, which hands the file to
`$EDITOR` — the editor writes it, this program does not.

Scheduling metadata goes in the state file. Never into the markdown.

## Commands

```bash
pnpm install
pnpm test         # vitest, 15 files
pnpm typecheck    # tsc --noEmit over src *and* tests
pnpm lint         # oxlint
pnpm format:check # oxfmt --check
pnpm build        # tsc -p tsconfig.build.json, src only, into a cleared dist/
```

There is no single `check` script and no pre-commit hook running them; run all
five yourself before a commit. The only hook installed is `commit-msg`, from the
shared `lefthook-rules` remote — it rejects agent-attribution trailers and
nothing else. `.github/workflows/ci.yml` runs the same five on push and pull
request, plus `npm pack --dry-run` after the build; it is the backstop, not a
substitute for running them locally.

**`pnpm format` writes.** It is `oxfmt src tests`, not a check — the inverted
naming relative to the sibling repos is a real trap. `format:check` is the
read-only one.

**`node src/cli.ts` does not work.** Type stripping does not rewrite a `.js`
specifier to the `.ts` file beside it, so a direct run dies on
`Cannot find module .../diagnostics.js`. Iterate through vitest, or through
`pnpm build` and `node dist/`.

`bin/leitner` is the development launcher: it rebuilds only when `src/` or either
tsconfig is newer than `dist/index.js`, and sends build chatter to stderr so
`list`/`stats`/`export` stdout stays parseable. It runs the build in a subshell
and `exec`s node, so the caller's cwd survives and a relative `dir` argument
resolves against it — no wrapper or env var involved.

## Releasing

`.github/workflows/publish.yml` publishes to npm through trusted publishing
(OIDC) — there is no token anywhere, and npmjs.com is configured against this
repository *and that file path*, so renaming the file breaks publishing.

A release is: bump `version` in `package.json`, commit, tag `vX.Y.Z`, then
publish a GitHub release on that tag. The `release: [published]` trigger does
the rest; `workflow_dispatch` is there for a re-run. The workflow re-runs the
five checks, refuses a tag that disagrees with `package.json`, and refuses a
version already on the registry.

**It builds explicitly before packing.** `npm publish --ignore-scripts` skips
`prepublishOnly`, and `files` ships `dist` without anything else rebuilding it,
so dropping that step publishes a tarball with no code in it. The step after it
asserts `dist/index.js` exists for the same reason.

## The conformance boundary

`src/deck.ts`, with `src/tags.ts` and `src/diagnostics.ts`, is the whole
Flashcard Markdown surface: pure, string in and parsed deck out, free of I/O.
`src/parser.ts` layers this project's own concerns on top — ids, file discovery,
resolved image paths, mtimes.

- The corpus is the `flashcard-md-spec` npm package, run as this project's own
  suite in `tests/conformance.test.ts`. `SPEC_VERSION` there pins `1.0` rather
  than tracking whatever is installed, so a corpus bump fails loudly.
- **A parse-rule change is a spec change.** Make it in the
  [`flashcard-md-spec`](https://github.com/shbernal/flashcard-md-spec)
  repository first — prose, corpus and version together — then follow it here.
  Do not special-case a fixture in this repo.
- The diagnostic codes in `src/diagnostics.ts` are the closed list of §8. Adding
  one here is not how a code comes into existence.
- Diagnostic *messages* are ours and no test may assert on them. Assert the code.
- Severity is a function of conformance class, so every diagnostic is a warning:
  never refuse a file because one card in it is malformed.

`tests/conformance.test.ts` holds `unresolved-image` out of the corpus loop on
purpose — whether an image resolves is a fact about the filesystem, not about the
markdown — and asserts it through a real `parseFile` read instead.

Two codes have no corpus fixture, and the same file carries what stands in for
them:

- `unrepresentable-content` is asserted by hand, and pins all three of §3.2's
  tier-3 obligations: the diagnostic is raised, the cards below the broken block
  load, and the block itself yields **no** card. The card list is asserted
  exactly rather than by containment — invalid YAML used to fabricate a card from
  the closing `---` read as a setext marker, so the count is the assertion that
  matters. `stripFrontmatterBlock` in `src/deck.ts` is what prevents it.
- `tag-sanitized` is never emitted here at all. That is why the
  `DIAGNOSTIC_CODES` guard asserts containment **one way only**: every code the
  corpus names must be in our list, not the reverse. The list is the spec's.

## Testing the CLI

`parseCli` calls `readConfigFile()` with no argument, so there is no injection
point for the config it reads. The tests set `XDG_CONFIG_HOME` to a temp
directory and write `leitner/config.json` under it — chosen over widening the
signature, because the production code gains nothing from the parameter. The
same trick covers the first-run path in `tests/onboard.test.ts`, where a temp
`XDG_CONFIG_HOME` is what makes "no config file" true.

`runInit` takes an `ask`, so onboarding is driven without a terminal — the
readline interface is only built when nothing is injected. The trigger itself
needs no injection: stdin is not a tty under vitest, so a `main()` call with no
config exercises the non-interactive refusal as it stands.

`tests/parser.test.ts` asserts **literal sha1 values** for card ids. That is the
point: `docs/format.md` calls the scheme sticky, and a hard-coded hash is what
makes "sticky" cost something. A failure there is a question about discarding
every user's review state, not an expectation to refresh.

## Testing the TUI

`tests/helpers/tui.tsx` is a hand-rolled Ink harness, not `ink-testing-library`,
because that library's fake stdout hardcodes a width, exposes no rows and cannot
resize — which is exactly what the review viewport math depends on. Keep it.

- `press`/`type`/`resize` each wait 30ms, which is what clears Ink's
  pending-escape timer so a lone ESC byte becomes a key event.
- The harness renders with `debug: true` so each render is a complete frame
  rather than incremental erase sequences; `frame()` is the last one with ANSI
  stripped, `output()` is everything including the raw kitty escapes.
- `ReviewApp` takes `openEditor` so the edit flow is driven without spawning
  `$EDITOR`. Use it rather than mocking `child_process`.

## Where documentation goes

- `README.md`: what it is, how to run it, the flags and keys. It is the manual;
  keep it accurate rather than short.
- `docs/format.md`: the conformance class, what the format leaves to an
  implementation, and the card-identity scheme. Where this and the specification
  disagree, the specification wins and the disagreement is a bug here.
- `docs/scheduling.md`: grade transitions, queue order, the state file, config
  keys, and what is deliberately absent (Anki interop, per-deck parameters).
- `FOLLOW-UPS.md`: discoveries parked out of scope, with the reason they were not
  done now. Add to it rather than letting them accumulate mid-task. It is kept
  out of the repository on purpose — `.git/info/exclude` names it — so it is a
  scratch file, not a deliverable, and it does not need to survive a fresh clone.
- `AGENTS.md`: only what an agent needs that a reader of the above does not.

Both `docs/` files state behaviour that no test pins — the identity table, the
config defaults, the degenerate-case table. Changing that behaviour without
changing the prose is how they rot.

## Conventions

- ESM throughout, `.js` specifiers in TypeScript source, Node >= 24.
- `tsconfig.json` is the checking config and covers `tests/`;
  `tsconfig.build.json` narrows to `src` so only library code reaches `dist`.
- `noUncheckedIndexedAccess` is on. Indexed reads are `T | undefined` and the
  code is written to that, hence the `?.` and the explicit `undefined` guards.
- `oxfmt` formats JSON and Markdown too, but the scripts name `src tests`, so
  `package.json` and the docs are left alone.
- Comments here carry the *reason*, not the restatement. Most of them exist
  because a rule is non-obvious or was got wrong once; that is what stops them
  being simplified away.

## Safety

- Never run a review session against a real deck directory to try something out —
  grading writes review state the user cannot get back. Use `tests/fixtures/`, or
  a temp directory with `--state` pointed somewhere disposable.
- `--state` and `--out` both expand `~`; check where a command will write before
  running it.
- Ask before creating a tag, a release, or an npm publish. Publishing a GitHub
  release **is** an npm publish now — the workflow fires on it — and a version
  cannot be unpublished after 72 hours. There is no separate confirmation step.
