import { promises as fs } from 'fs';
import path from 'path';
import type { Dirent } from 'fs';
import {
  findSpecUpdates,
  buildUpdatedSpec,
  writeUpdatedSpec,
  type SpecUpdate,
} from './specs-apply.js';
import {
  readChangeMetadata,
  writeChangeMetadata,
  ChangeMetadataError,
} from '../utils/change-metadata.js';
import { resolveLifecycle } from './project-config.js';

export interface SyncOptions {
  check?: boolean;
  json?: boolean;
}

type PendingFold = {
  update: SpecUpdate;
  rebuilt: string;
  counts: { added: number; modified: number; removed: number; renamed: number };
};

export interface ChangeSyncState {
  change: string;
  state: 'folded' | 'unfolded' | 'conflict';
  /** Capability ids whose main spec does not yet reflect this change's delta. */
  pending: string[];
  error?: string;
}

export interface SyncReport {
  mode: 'archive' | 'status';
  changes: ChangeSyncState[];
  clean: boolean;
}

/**
 * Fold shipped changes' spec deltas into the main specs — the text-merge half
 * of what archive does, decoupled from any directory move so it can run at any
 * time, idempotently. Only changes declaring `status: shipped` fold; proposed
 * changes' deltas stay out of specs/, which is what keeps
 * specs/ = shipped reality when state is data instead of location.
 *
 * "Folded" is decided by regeneration, not bookkeeping: a change is in sync
 * when re-applying its delta to the current spec produces byte-identical
 * output. That makes --check a pure function of the working tree — no model,
 * no network, no VCS history — so the same command gates pre-commit, pre-push
 * and CI.
 */
export class SyncCommand {
  async execute(
    changeName: string | undefined,
    targetPath: string = '.',
    options: SyncOptions = {}
  ): Promise<void> {
    const mode = resolveLifecycle(targetPath);
    const report: SyncReport = { mode, changes: [], clean: true };

    if (mode !== 'status') {
      // Mode-aware by contract: under `lifecycle: archive` the archive command
      // owns the fold and there is no status field to gate on. Report and exit
      // 0 rather than misfiring on the default layout.
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(
          "This project uses `lifecycle: archive` (the default) — nothing to sync or gate. `openspec sync` applies under `lifecycle: status`; see openspec/config.yaml."
        );
      }
      return;
    }

    const changesDir = path.join(targetPath, 'openspec', 'changes');
    const specsDir = path.join(targetPath, 'openspec', 'specs');

    const candidates = changeName
      ? [changeName]
      : await this.shippedChanges(changesDir, targetPath, report);

    for (const name of candidates) {
      const changeDir = path.join(changesDir, name);
      const state = await this.evaluate(name, changeDir, specsDir, targetPath, options);
      if (state === null) {
        continue;
      }
      report.changes.push(state.report);
      if (state.report.state !== 'folded') {
        report.clean = false;
      }
      if (!options.check && state.report.state === 'unfolded') {
        for (const fold of state.folds) {
          await writeUpdatedSpec(fold.update, fold.rebuilt, fold.counts, {
            silent: options.json,
          });
        }
        state.report.state = 'folded';
        report.clean = report.changes.every((c) => c.state === 'folded');
      }
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      this.print(report, options);
    }

    if (!report.clean) {
      process.exitCode = 1;
    }
  }

  private async shippedChanges(
    changesDir: string,
    projectRoot: string,
    report: SyncReport
  ): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(changesDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const shipped: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'archive') {
        continue;
      }
      try {
        const metadata = readChangeMetadata(path.join(changesDir, entry.name), projectRoot);
        if (metadata?.status === 'shipped') {
          shipped.push(entry.name);
        }
      } catch (err) {
        // Unreadable metadata cannot prove the change is NOT shipped, so the
        // gate fails closed: report it rather than skip it.
        report.changes.push({
          change: entry.name,
          state: 'conflict',
          pending: [],
          error: err instanceof ChangeMetadataError ? err.message : String(err),
        });
        report.clean = false;
      }
    }
    return shipped;
  }

  private async evaluate(
    name: string,
    changeDir: string,
    specsDir: string,
    projectRoot: string,
    options: SyncOptions
  ): Promise<{ report: ChangeSyncState; folds: PendingFold[] } | null> {
    try {
      await fs.access(changeDir);
    } catch {
      throw new Error(`Change '${name}' not found in openspec/changes/`);
    }

    // An explicitly named change must be shipped before its deltas may touch
    // specs/. In check mode a non-shipped change is simply not gated.
    const metadata = readChangeMetadata(changeDir, projectRoot);
    if (metadata?.status !== 'shipped') {
      if (options.check) {
        return null;
      }
      throw new Error(
        `Change '${name}' has status '${metadata?.status ?? 'none'}' — only shipped changes fold into specs/. Set \`status: shipped\` in its .openspec.yaml first.`
      );
    }

    const result: ChangeSyncState = { change: name, state: 'folded', pending: [] };
    const folds: PendingFold[] = [];

    let updates: SpecUpdate[];
    try {
      updates = await findSpecUpdates(changeDir, specsDir);
    } catch (err) {
      return {
        report: { ...result, state: 'conflict', error: (err as Error).message },
        folds: [],
      };
    }

    for (const update of updates) {
      try {
        const built = await buildUpdatedSpec(update, name, { silent: true });
        const current = update.exists ? await fs.readFile(update.target, 'utf-8') : null;
        if (current !== built.rebuilt) {
          result.state = 'unfolded';
          result.pending.push(update.id);
          folds.push({ update, rebuilt: built.rebuilt, counts: built.counts });
        }
      } catch (err) {
        result.state = 'conflict';
        result.error = (err as Error).message;
        return { report: result, folds: [] };
      }
    }

    return { report: result, folds };
  }

  private print(report: SyncReport, options: SyncOptions): void {
    if (report.changes.length === 0) {
      console.log('No shipped changes to sync.');
      return;
    }
    for (const change of report.changes) {
      if (change.state === 'folded') {
        console.log(`  ✓ ${change.change}`);
      } else if (change.state === 'unfolded') {
        console.log(
          `  ✗ ${change.change} — shipped but not folded into specs/: ${change.pending.join(', ')}${options.check ? ' (run `openspec sync`)' : ''}`
        );
      } else {
        console.log(`  ✗ ${change.change} — ${change.error}`);
      }
    }
  }
}

/**
 * Declare a change shipped and fold its deltas — the two halves of the old
 * archive, minus the move, emitted as one working-tree diff so the commit
 * that declares "shipped" is the same commit whose tree satisfies the
 * shipped ⇒ folded predicate. Restores archive's declare+fold atomicity as
 * a convenience instead of a mandate: `ship` is sugar over editing the
 * status field and running `sync` by hand, never the only way.
 */
export class ShipCommand {
  async execute(
    changeName: string,
    targetPath: string = '.',
    options: { json?: boolean } = {}
  ): Promise<void> {
    const mode = resolveLifecycle(targetPath);
    if (mode !== 'status') {
      throw new Error(
        'This project uses `lifecycle: archive` (the default) — finish changes with `openspec archive`. `openspec ship` applies under `lifecycle: status`; see openspec/config.yaml.'
      );
    }

    const changeDir = path.join(targetPath, 'openspec', 'changes', changeName);
    const metadata = readChangeMetadata(changeDir, targetPath);
    if (!metadata) {
      throw new Error(
        `Change '${changeName}' has no .openspec.yaml — nothing records its lifecycle state.`
      );
    }

    if (metadata.status !== 'shipped') {
      writeChangeMetadata(changeDir, { ...metadata, status: 'shipped' }, targetPath);
      if (!options.json) {
        console.log(`  ${changeName}: status → shipped`);
      }
    } else if (!options.json) {
      console.log(`  ${changeName}: already shipped`);
    }

    await new SyncCommand().execute(changeName, targetPath, { json: options.json });
  }
}
