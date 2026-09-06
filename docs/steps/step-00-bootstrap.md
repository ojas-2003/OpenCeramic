# Step 0 — Bootstrap

**Commit:** `1047c33` · **Verify:** files exist, `.env` ignored

## Delivered

| File | Purpose |
|---|---|
| `CLAUDE.md` | Stack, hard rules and layout. Read automatically by Claude Code every session. |
| `docs/DESIGN.md` | The full design document. Steps 2, 4, 5, 6, 8, 9 read numbered sections of it. |
| `.env.example` | The seven configuration variables. |
| `.gitignore` | Written before the first commit so `.env` was never trackable. |

## Design decisions

### The contracts live in the guide, not in the implementation

`CLAUDE.md` is copied verbatim from the guide rather than paraphrased. Its value
is that it is stable: later steps read it to re-derive the rules after context is
lost. Editorialising it would defeat that. The same applies to `docs/DESIGN.md`,
which is reproduced faithfully.

### `.gitignore` before anything else

`create-next-app` in Step 1 writes its own `.gitignore`, and Next's template
ignores `.env*` wholesale — which would also ignore `.env.example`. Establishing
the file first made that collision visible immediately; Step 1 re-added an
`!.env.example` negation on top of Next's version.

## Deviations

**Design document encoding.** The source document arrived with UTF-8 read as
Latin-1 throughout — `â` for `—` and `→`, `Â§` for `§`, `Î£` for `Σ`, `Ã` for `×`,
`â ` for `①`. These were restored to the intended characters. No content was
changed, and all four Mermaid diagrams plus the §2.1 decisions table and §5.1
adapter chain were preserved, since later steps quote them directly.

## Environment note

The repository already existed as an empty git repo on `main` with no commits.
No `git init` was needed.

## What Step 0 does not do

No dependencies, no scaffold, no database. `docs/DESIGN.md` §3 (schema), §5
(adapter interface) and §4.2/4.3 (planner and executor) are specifications at
this point, not code.
