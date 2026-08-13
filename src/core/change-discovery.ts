import { promises as fs } from 'fs';
import path from 'path';

export interface DiscoveredChange {
  /** The change's id — the folder name minus any `DD-` shard prefix. */
  id: string;
  /** Absolute path to the change directory. */
  dir: string;
}

const YEAR_DIR = /^\d{4}$/;
const MONTH_DIR = /^\d{2}$/;
const DAY_PREFIX = /^\d{2}-/;

/**
 * Enumerate change directories under openspec/changes/, supporting both the
 * flat layout (`changes/<name>/`) and the creation-date sharded layout used
 * by `lifecycle: status` projects (`changes/YYYY/MM/DD-<name>/`).
 *
 * The rule: `YYYY` and `MM` directories are shards to walk into; any other
 * directory is a change. Location encodes only the creation date — fixed at
 * birth — so nothing here ever needs to know a change's lifecycle state.
 * `archive/` is excluded at the top level, matching the flat layout's
 * long-standing behavior.
 */
export async function discoverChanges(changesDir: string): Promise<DiscoveredChange[]> {
  const found: DiscoveredChange[] = [];

  async function walkShard(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      // A missing changes/ dir means "no changes"; anything else (ENOTDIR,
      // EACCES, ...) is a malformed root the caller must hear about rather
      // than mistake for an empty project.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (depth === 0 && code !== 'ENOENT') {
        throw error;
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (depth === 0 && entry.name === 'archive') continue;
      if (depth === 0 && YEAR_DIR.test(entry.name)) {
        await walkShard(full, 1);
      } else if (depth === 1 && MONTH_DIR.test(entry.name)) {
        await walkShard(full, 2);
      } else {
        const id = depth === 2 ? entry.name.replace(DAY_PREFIX, '') : entry.name;
        found.push({ id, dir: full });
      }
    }
  }

  await walkShard(changesDir, 0);
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Resolve a change id to its directory in either layout. Throws when the id
 * is ambiguous — two shard dates carrying the same name — because guessing
 * would silently act on the wrong change.
 */
export async function resolveChangeDir(changesDir: string, id: string): Promise<string | null> {
  const flat = path.join(changesDir, id);
  try {
    const stat = await fs.stat(flat);
    if (stat.isDirectory()) return flat;
  } catch {
    // fall through to sharded lookup
  }

  const matches = (await discoverChanges(changesDir)).filter((c) => c.id === id);
  if (matches.length > 1) {
    throw new Error(
      `Change '${id}' is ambiguous: ${matches.map((m) => path.relative(changesDir, m.dir)).join(', ')}`
    );
  }
  return matches[0]?.dir ?? null;
}
