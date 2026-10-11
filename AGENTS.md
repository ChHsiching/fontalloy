# Agent guide

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (`ChHsiching/fontalloy`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels are used unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Project pointers

- Design consensus (read before implementing): `docs/DESIGN.md`
- Implementation order: start from `core/` (the fontTools pipeline); `cli/`, `gui/`, `web/` are thin consumers.
- GUI prototype (validated, superseded): lives on the `prototype/gui` branch, never on `main`. See `docs/adr/0004-gui-split-pane-workspace.md`.

## Conventions

### Language

All project artifacts are English: docs, specs, tickets, commit messages, code comments. The only Chinese is the app's UI copy (the product serves CJK users) and the conversation with the user.

### Commits

Conventional Commits (`feat` `fix` `docs` `refactor` `test` `ci` `chore`), English subjects, one intent per commit. While the project is pre-implementation, push directly to `main`; once `core/` development starts, cross-file feature work goes through a branch + PR.
