## Why

`archive` does two unrelated jobs in one command: a **state transition** (declaring a change shipped) and a **text merge** (folding deltas into `specs/`). Encoding the transition as a directory move welds the merge to a single moment in the PR lifecycle — and on a team with review, that moment does not exist. Review feedback forces un-archive → edit → re-archive; archiving after merge means a bot commit to a protected branch; and GitLab has no approval event to hang it on.

The team-workflow docs offer both conventions and say "pick one and be consistent" — a choice of costs, not an answer.

This change adds an opt-in experimental mode where a change's lifecycle state is a **field in its metadata** rather than its position in the filesystem, so the merge becomes a standalone idempotent command that can run at any time and be checked deterministically in CI.

## What Changes

- `openspec/config.yaml` accepts `lifecycle: archive | status`. `archive` is the default and current behavior; nothing changes for existing projects.
- Under `lifecycle: status`, a change's `.openspec.yaml` carries `status: proposed | shipped`. New changes are born `proposed`.
- `openspec sync` folds every `shipped` change's deltas into `specs/`, idempotently. It is the text-merge half of archive, decoupled from any move.
- `openspec sync --check` exits 1 if any `shipped` change has unfolded deltas — a deterministic, model-free gate that runs identically at pre-commit, pre-push and in CI.
- `openspec ship <change>` sets `status: shipped` and folds in one working-tree diff, restoring archive's declare-and-fold atomicity as a convenience rather than a mandate.
- `openspec list` shows the lifecycle state and accepts `--status <state>` to filter.
- `openspec archive` refuses to run under `lifecycle: status` and points at the status workflow, so the two models can never both claim a change.

## Capabilities

### New Capabilities

- `lifecycle-status-mode`: the experimental `lifecycle: status` mode — the config flag, the `status` metadata field, the `sync`/`sync --check`/`ship` commands, the `list` surface, and the `archive` refusal that keeps the two models disjoint.

### Modified Capabilities

_None._ The mode is opt-in and inert under the default `lifecycle: archive`: `sync` and `ship` report that the project uses archive mode and exit 0, `list` renders no lifecycle column when no change declares a status, and `archive` is untouched. Existing capability specs describe archive-mode behavior, which this change does not alter.

## Impact

- `src/core/project-config.ts` — the `lifecycle` config field and its resolver
- `src/core/change-metadata/schema.ts` — the optional `status` field
- `src/core/sync.ts` — new `SyncCommand` and `ShipCommand`
- `src/core/archive.ts` — refusal guard under status mode
- `src/core/list.ts` — lifecycle column and `--status` filter
- `src/utils/change-utils.ts` — new changes are born `proposed` under status mode
- `src/cli/index.ts`, `src/core/completions/command-registry.ts` — command surface and completions
- `src/core/specs-apply.ts` — the generated skeleton's Purpose line no longer says "by archiving", since a fold can now happen without one

## Out of scope

- **Concurrent modification of the same requirement** by two open changes. This changes *when* the merge may run, not *how* it merges; it composes with the parallel-merge plan and with #1669.
- **Deriving shipped-ness from git.** Git proves a change folder landed on a branch, not that the change was implemented. Status stays an explicit declaration; git facts can cross-check it, not replace it.
- **Where changes live on disk.** Creation-date sharding was prototyped alongside this and is deliberately excluded — see the design note on #1367.
