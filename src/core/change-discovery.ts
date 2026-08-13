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
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
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
 * would silently act on the wrong change. Ids that could never come out of
 * discovery (path separators, dot segments, hidden names, shard and archive
 * dir names) resolve to null, so the resolver and discovery agree on the
 * addressable namespace and a hostile id cannot address anything outside
 * changes/.
 */
export async function resolveChangeDir(changesDir: string, id: string): Promise<string | null> {
  if (
    !id ||
    id === 'archive' ||
    YEAR_DIR.test(id) ||
    id.startsWith('.') ||
    id.includes('/') ||
    id.includes('\\') ||
    id.includes('\0')
  ) {
    return null;
  }
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

/**
 * Derive an item's name from a file path inside it: the segment after the
 * innermost `specs` or `changes` directory, minus the `DD-` prefix when the
 * path runs through a creation-date shard (`changes/YYYY/MM/DD-<name>/...`).
 * Falls back to the file name without extension.
 */
export function itemNameFromPath(filePath: string): string {
  const parts = filePath.split(/[/\\]/);

  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === 'specs' || parts[i] === 'changes') {
      if (i < parts.length - 1) {
        if (
          parts[i] === 'changes' &&
          YEAR_DIR.test(parts[i + 1] ?? '') &&
          MONTH_DIR.test(parts[i + 2] ?? '') &&
          DAY_PREFIX.test(parts[i + 3] ?? '')
        ) {
          return parts[i + 3].replace(DAY_PREFIX, '');
        }
        return parts[i + 1];
      }
    }
  }

  const fileName = parts[parts.length - 1] ?? '';
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
}
