import { promises as fs } from 'fs';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveLifecycle } from './project-config.js';

const ARCHIVE_DIR_NAME = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface MigrateOptions {
  dryRun?: boolean;
}

interface PlannedMove {
  from: string;
  to: string;
  id: string;
  status: 'proposed' | 'shipped';
  created: string;
}

/**
 * One-way migration from `lifecycle: archive` to `lifecycle: status`.
 *
 * - `changes/archive/YYYY-MM-DD-<name>/` → `changes/YYYY/MM/DD-<name>/` with
 *   `status: shipped`. The folder date's meaning shifts from archival to
 *   creation — the closest surviving record, and explicitly documented.
 * - `changes/<name>/` (active) → sharded by its metadata `created` date
 *   (today when absent) with `status: proposed` unless a status already exists.
 * - `openspec/config.yaml` gains `lifecycle: status`.
 *
 * Metadata is edited tolerantly — raw YAML keys, no strict schema round-trip —
 * because legacy archived changes predate today's metadata contract and a
 * migration that drops fields it does not understand is a migration that
 * destroys history.
 */
export class MigrateCommand {
  async execute(targetPath: string = '.', options: MigrateOptions = {}): Promise<void> {
    if (resolveLifecycle(targetPath) === 'status') {
      console.log('Already on `lifecycle: status` — nothing to migrate.');
      return;
    }

    const openspecDir = path.join(targetPath, 'openspec');
    const changesDir = path.join(openspecDir, 'changes');
    const archiveDir = path.join(changesDir, 'archive');
    const today = new Date().toISOString().slice(0, 10);

    const moves: PlannedMove[] = [];

    for (const entry of await this.dirs(archiveDir)) {
      const match = ARCHIVE_DIR_NAME.exec(entry);
      const [year, month, day, id] = match
        ? [match[1], match[2], match[3], match[4]]
        : [...today.split('-'), entry] as [string, string, string, string];
      moves.push({
        from: path.join(archiveDir, entry),
        to: path.join(changesDir, year, month, `${day}-${id}`),
        id,
        status: 'shipped',
        created: `${year}-${month}-${day}`,
      });
    }

    for (const entry of await this.dirs(changesDir)) {
      if (entry === 'archive') continue;
      const from = path.join(changesDir, entry);
      const meta = await this.readRawMetadata(from);
      const created = DATE.test(String(meta?.created ?? '')) ? String(meta?.created) : today;
      const [year, month, day] = created.split('-');
      moves.push({
        from,
        to: path.join(changesDir, year, month, `${day}-${entry}`),
        id: entry,
        status: meta?.status === 'shipped' ? 'shipped' : 'proposed',
        created,
      });
    }

    if (moves.length === 0) {
      console.log('No changes to migrate.');
    }

    for (const move of moves) {
      console.log(
        `  ${move.status === 'shipped' ? '✓' : '…'} ${move.id} → ${path.relative(targetPath, move.to)} [${move.status}]`
      );
      if (options.dryRun) continue;
      await fs.mkdir(path.dirname(move.to), { recursive: true });
      await fs.rename(move.from, move.to);
      await this.stampMetadata(move, targetPath);
    }

    if (options.dryRun) {
      console.log('Dry run — nothing written.');
      return;
    }

    if (!(await this.dirs(archiveDir)).length) {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
    await this.setLifecycle(openspecDir);

    console.log('Migrated to `lifecycle: status`.');
    console.log(
      'Verify with `openspec sync --check`. Historical changes superseded by later edits to the same requirement may report unfolded — that is the base-snapshot gap, not a migration error; resolve by reviewing the named capability.'
    );
  }

  private async dirs(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  private async readRawMetadata(changeDir: string): Promise<Record<string, unknown> | null> {
    try {
      const raw = await fs.readFile(path.join(changeDir, '.openspec.yaml'), 'utf-8');
      const parsed = parseYaml(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private async stampMetadata(move: PlannedMove, targetPath: string): Promise<void> {
    const existing = (await this.readRawMetadata(move.to)) ?? {};
    const schema = existing.schema ?? (await this.projectSchema(targetPath));
    const stamped = {
      ...existing,
      schema,
      created: existing.created ?? move.created,
      status: move.status,
    };
    await fs.writeFile(
      path.join(move.to, '.openspec.yaml'),
      stringifyYaml(stamped),
      'utf-8'
    );
  }

  private async projectSchema(targetPath: string): Promise<string> {
    const raw = await this.readRawConfig(targetPath);
    const schema = raw?.schema;
    return typeof schema === 'string' && schema.length > 0 ? schema : 'spec-driven';
  }

  private async readRawConfig(targetPath: string): Promise<Record<string, unknown> | null> {
    for (const name of ['config.yaml', 'config.yml']) {
      try {
        const raw = await fs.readFile(path.join(targetPath, 'openspec', name), 'utf-8');
        const parsed = parseYaml(raw);
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async setLifecycle(openspecDir: string): Promise<void> {
    for (const name of ['config.yaml', 'config.yml']) {
      const file = path.join(openspecDir, name);
      try {
        const raw = await fs.readFile(file, 'utf-8');
        const updated = /^lifecycle:.*$/m.test(raw)
          ? raw.replace(/^lifecycle:.*$/m, 'lifecycle: status')
          : `${raw.trimEnd()}\nlifecycle: status\n`;
        await fs.writeFile(file, updated, 'utf-8');
        return;
      } catch {
        continue;
      }
    }
    await fs.writeFile(
      path.join(openspecDir, 'config.yaml'),
      'schema: spec-driven\nlifecycle: status\n',
      'utf-8'
    );
  }
}
