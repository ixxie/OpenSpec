---
"@fission-ai/openspec": minor
---

Add an opt-in experimental `lifecycle: status` mode, in which a change's lifecycle state is a field in its metadata rather than its position in the filesystem. Under `lifecycle: status` a change carries `status: proposed | shipped` in `.openspec.yaml` and never moves: `openspec sync` folds every shipped change's deltas into `openspec/specs/` idempotently, `openspec sync --check` gates the `shipped ⇒ folded` predicate deterministically for pre-commit, pre-push and CI, and `openspec ship <change>` declares and folds in one diff. `openspec list` gains a lifecycle column and `--status` filter, and `openspec archive` refuses under status mode so the two models stay disjoint. Projects that do not set `lifecycle` resolve to `archive` and are entirely unaffected.
