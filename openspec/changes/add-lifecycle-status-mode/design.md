## Context

`archive` conflates a state transition with a text merge. The merge itself is fine; welding it to a directory move is what makes it hard to schedule. On a solo repo the two are indistinguishable. On a team with review, every possible moment to run `archive` is wrong somewhere:

| Moment | Why it breaks |
|---|---|
| During the PR | Review feedback invalidates the fold; un-archive does not exist and re-archive is not a no-op |
| After merge | A bot commit to a protected branch, racing concurrent merges |
| At approval | GitLab has no approval event (`CI_MERGE_REQUEST_APPROVED` is pre-pipeline), and pushes reset approvals |

## Goals / Non-Goals

**Goals**

- Make lifecycle state a first-class fact that merges trivially and can be edited to correct a mistake.
- Make the fold a standalone, idempotent operation that is safe to run late, twice, or never-yet.
- Make "is this repo consistent?" a pure function of the working tree, so one predicate gates pre-commit, pre-push and CI.
- Change nothing for projects that do not opt in.

**Non-Goals**

- Concurrent modification of the same requirement by two open changes (see #1669 and the parallel-merge plan).
- Replacing the archive workflow. This is an experiment with an exit; if it does not graduate, it is removed.
- Deciding where change directories live (see #1367).

## Decisions

### The state set is closed, and every state has machine consequences

`status: proposed | shipped`. Two states, because a state with no attached consequence is a comment:

- `shipped` means "these deltas belong in `specs/`" — what `sync` folds and what `--check` gates.
- `proposed` means "this change holds a live claim on the requirements it touches" — what overlap and drift tooling can reason over without inferring liveness from a directory path.

An `applied` state was prototyped and dropped: "implementation done" is already recorded by `tasks.md` checkboxes, and a duplicate record drifts. Further states are possible later — `abandoned` would release the live claim — but each must earn its place with a consequence.

### "Folded" is decided by regeneration, not bookkeeping

A change is in sync when re-applying its delta to the current spec produces byte-identical output. No lockfile, no hash sidecar, no timestamp comparison — the check rebuilds and compares.

This costs O(shipped history) per run rather than O(active changes), which is negligible for young histories and is the reason a `--changed` scope is named as future work rather than shipped here. In exchange the gate has no state of its own to corrupt, and — importantly — `--check` and the fold share one code path. A checker that reimplements the doer is how #1112 happened: `validate` passed what `archive` then refused. Here the only difference between checking and doing is whether the rebuilt bytes get written.

### The gate is a tree predicate, not a timing condition

`shipped ⇒ folded`. This is what makes the mode enforceable rather than merely conventional. A timing condition ("archive ran at the right moment") cannot be evaluated mid-PR, precisely when the invariant is supposed to be violated. A tree predicate can be evaluated on any tree by anyone:

```sh
openspec sync --check   # pre-commit · pre-push · CI — same command, same verdict
```

Hooks are advisory (`--no-verify` skips them), so CI remains the authority for the tree-level property. The one property that inverts this is atomicity: whether declaring and folding happened in the *same commit* is a history-level fact that CI, which sees only the head tree, is structurally blind to. `ship` makes the atomic path the default one, and a pre-push sweep over the pushed range can enforce it where a team cares.

### `archive` refuses rather than coexists

Under `lifecycle: status`, `openspec archive` throws and names the alternative. Two models that can both claim a change is finished would let `specs/` disagree with itself. The refusal is what keeps `specs/` = shipped reality true in both modes, which is also what makes migration between them a pure relayout: neither mode's `specs/` content differs.

## Risks / Trade-offs

- **`ls` stops being the answer to "what's active."** Once state is data, the filesystem is no longer the UI for state; `openspec list --status proposed` is. This is the honest cost of the whole design and is why the mode is opt-in.
- **The fold diff relocates, it does not disappear.** It lands wherever `sync` ran instead of in the archive commit. Deterministic output makes it reviewable the way a lockfile is: regenerate and compare.
- **Editing a delta after it was folded** re-merges over an earlier fold, which needs base snapshots to do correctly. This window pre-exists; making fold-anytime first-class means it sees more traffic. `sync --check` detects the state and fails closed rather than corrupting `specs/`. `sync` is a natural recording point for the parallel-merge plan's base snapshots when those arrive.

## Migration

None required. Adoption is a config line: existing `changes/archive/` history stays where it is with its folds already in `specs/`, so `sync --check` is green on day one. Changes authored before the flip carry no `status` field and are simply not gated until `ship` stamps them.

Leaving is the same edit in reverse, with one caveat this change does not yet address: a change shipped under status mode sits flat in `changes/` and would need to be moved into `changes/archive/` by hand. A `migrate` command covering both directions was prototyped alongside this change and is held back for a follow-up, so this PR stays one reviewable idea.
