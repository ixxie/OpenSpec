## 1. Configuration

- [x] 1.1 Add the `lifecycle` field to the project config schema with `archive | status` values and `archive` as the default
- [x] 1.2 Add `resolveLifecycle(projectRoot)` and make an unreadable or invalid value fall back to the default rather than throw

## 2. Metadata

- [x] 2.1 Add the optional `status: proposed | shipped` field to the change metadata schema
- [x] 2.2 Create new changes with `status: proposed` under `lifecycle: status`, and unchanged under `lifecycle: archive`

## 3. Sync

- [x] 3.1 Implement `SyncCommand`: discover `shipped` changes, rebuild each affected spec, write only where the rebuild differs
- [x] 3.2 Decide "folded" by byte-identical regeneration so `--check` and the fold share one code path
- [x] 3.3 Implement `--check`: report without writing, and return a report whose `clean` flag drives the exit code at the CLI edge
- [x] 3.4 Report unreadable metadata as a conflict rather than skipping it, so the gate fails closed
- [x] 3.5 Report nothing to gate and exit 0 under `lifecycle: archive`

## 4. Ship

- [x] 4.1 Implement `ShipCommand`: set `status: shipped`, then delegate to `SyncCommand` so both halves land in one diff
- [x] 4.2 Make a re-ship a no-op
- [x] 4.3 Refuse under `lifecycle: archive` and point at `openspec archive`

## 5. Surfaces

- [x] 5.1 Show the lifecycle state in `openspec list` and add `--status <state>` filtering
- [x] 5.2 Reject an unknown `--status` value instead of printing an empty list
- [x] 5.3 Refuse `openspec archive` under `lifecycle: status` and point at the status workflow
- [x] 5.4 Register `sync`, `ship` and `list --status` in the completion command registry
- [x] 5.5 Reword the generated spec skeleton's Purpose line, which claimed the spec was created by archiving

## 6. Tests

- [x] 6.1 Gate is green under `lifecycle: archive` regardless of any status field
- [x] 6.2 Gate fails on a shipped change whose delta is not folded, naming the capability
- [x] 6.3 Proposed changes are not gated and their deltas stay out of `specs/`
- [x] 6.4 Fold then re-check is green, and a second fold is a byte-identical no-op
- [x] 6.5 A named non-shipped change refuses to fold
- [x] 6.6 `ship` flips and folds in one step; re-ship is a no-op; refuses under archive mode
- [x] 6.7 Unreadable metadata produces the same conflict entry whether swept or named
- [x] 6.8 `archive` refuses under `lifecycle: status`
- [x] 6.9 `list` rejects an unknown `--status` value

## 7. Release

- [x] 7.1 Add a changeset describing the new experimental mode
