import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { discoverChanges, resolveChangeDir } from '../../src/core/change-discovery.js';
import { MigrateCommand } from '../../src/core/lifecycle-migrate.js';
import { SyncCommand } from '../../src/core/sync.js';
import { createChange } from '../../src/utils/change-utils.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const DELTA = `# Auth - Changes

## ADDED Requirements

### Requirement: Operator authentication

The system SHALL authenticate operators.

#### Scenario: Valid token
- **WHEN** a valid token is presented
- **THEN** the request is accepted
`;

describe('change discovery across layouts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-shard-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('finds flat, sharded, and mixed changes; strips the day prefix; skips archive', async () => {
    const changes = path.join(tempDir, 'changes');
    await fs.mkdir(path.join(changes, 'flat-change'), { recursive: true });
    await fs.mkdir(path.join(changes, '2026', '03', '15-old-change'), { recursive: true });
    await fs.mkdir(path.join(changes, 'archive', '2026-01-01-buried'), { recursive: true });

    const found = await discoverChanges(changes);
    expect(found.map((c) => c.id)).toEqual(['flat-change', 'old-change']);

    expect(await resolveChangeDir(changes, 'old-change')).toBe(
      path.join(changes, '2026', '03', '15-old-change')
    );
    expect(await resolveChangeDir(changes, 'flat-change')).toBe(
      path.join(changes, 'flat-change')
    );
    expect(await resolveChangeDir(changes, 'nope')).toBeNull();
  });

  it('rejects an ambiguous id present under two shard dates', async () => {
    const changes = path.join(tempDir, 'changes');
    await fs.mkdir(path.join(changes, '2026', '03', '15-dupe'), { recursive: true });
    await fs.mkdir(path.join(changes, '2026', '04', '01-dupe'), { recursive: true });

    await expect(resolveChangeDir(changes, 'dupe')).rejects.toThrow(/ambiguous/);
  });

  it('createChange shards by creation date under lifecycle: status', async () => {
    await fs.mkdir(path.join(tempDir, 'openspec'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'openspec', 'config.yaml'),
      'schema: spec-driven\nlifecycle: status\n'
    );

    const result = await createChange(tempDir, 'fresh-change');
    const rel = path.relative(path.join(tempDir, 'openspec', 'changes'), result.changeDir);
    expect(rel).toMatch(/^\d{4}[/\\]\d{2}[/\\]\d{2}-fresh-change$/);
    const metadata = await fs.readFile(path.join(result.changeDir, '.openspec.yaml'), 'utf-8');
    expect(metadata).toContain('status: proposed');
  });
});

describe('MigrateCommand', () => {
  let tempDir: string;
  let logs: string[];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-migrate-test-'));
    logs = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '));
    };
    process.exitCode = undefined;

    const openspec = path.join(tempDir, 'openspec');
    // Legacy layout: one archived change whose fold sits in specs/ exactly as
    // archive left it. Hand-writing the folded spec fails the byte-identity
    // check on whitespace canon, so generate it with the same engine archive
    // uses, via a scratch status-mode project.
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-migrate-scratch-'));
    await fs.mkdir(path.join(scratch, 'openspec', 'changes', 'seed', 'specs', 'auth'), {
      recursive: true,
    });
    await fs.mkdir(path.join(scratch, 'openspec', 'specs'), { recursive: true });
    await fs.writeFile(
      path.join(scratch, 'openspec', 'config.yaml'),
      'schema: spec-driven\nlifecycle: status\n'
    );
    await fs.writeFile(
      path.join(scratch, 'openspec', 'changes', 'seed', '.openspec.yaml'),
      'schema: spec-driven\nstatus: shipped\n'
    );
    await fs.writeFile(
      path.join(scratch, 'openspec', 'changes', 'seed', 'specs', 'auth', 'spec.md'),
      DELTA
    );
    await new SyncCommand().execute('seed', scratch, { json: true });
    const foldedSpec = await fs.readFile(
      path.join(scratch, 'openspec', 'specs', 'auth', 'spec.md'),
      'utf-8'
    );
    await fs.rm(scratch, { recursive: true, force: true });

    await fs.mkdir(path.join(openspec, 'specs', 'auth'), { recursive: true });
    await fs.writeFile(path.join(openspec, 'specs', 'auth', 'spec.md'), foldedSpec);
    await fs.writeFile(path.join(openspec, 'config.yaml'), 'schema: spec-driven\n');

    const archived = path.join(openspec, 'changes', 'archive', '2026-03-15-add-user-auth');
    await fs.mkdir(path.join(archived, 'specs', 'auth'), { recursive: true });
    await fs.writeFile(path.join(archived, 'specs', 'auth', 'spec.md'), DELTA);

    const active = path.join(openspec, 'changes', 'batch-upload');
    await fs.mkdir(path.join(active, 'specs', 'beacons'), { recursive: true });
    await fs.writeFile(
      path.join(active, '.openspec.yaml'),
      'schema: spec-driven\ncreated: 2026-08-01\n'
    );
    await fs.writeFile(
      path.join(active, 'specs', 'beacons', 'spec.md'),
      `# Beacons - Changes

## ADDED Requirements

### Requirement: Batched upload

The system SHALL accept batched readings.

#### Scenario: Replay
- **WHEN** a gateway replays a batch
- **THEN** all readings are accepted
`
    );
  });

  afterEach(async () => {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('dry run plans without writing', async () => {
    await new MigrateCommand().execute(tempDir, { dryRun: true });
    await expect(
      fs.access(path.join(tempDir, 'openspec', 'changes', 'archive', '2026-03-15-add-user-auth'))
    ).resolves.not.toThrow();
    const config = await fs.readFile(path.join(tempDir, 'openspec', 'config.yaml'), 'utf-8');
    expect(config).not.toContain('lifecycle: status');
  });

  it('migrates both eras, stamps statuses, flips the config, and the gate is green', async () => {
    await new MigrateCommand().execute(tempDir, {});

    const shipped = path.join(
      tempDir, 'openspec', 'changes', '2026', '03', '15-add-user-auth'
    );
    const shippedMeta = await fs.readFile(path.join(shipped, '.openspec.yaml'), 'utf-8');
    expect(shippedMeta).toContain('status: shipped');
    expect(shippedMeta).toContain('created: 2026-03-15');

    const proposed = path.join(tempDir, 'openspec', 'changes', '2026', '08', '01-batch-upload');
    const proposedMeta = await fs.readFile(path.join(proposed, '.openspec.yaml'), 'utf-8');
    expect(proposedMeta).toContain('status: proposed');

    await expect(
      fs.access(path.join(tempDir, 'openspec', 'changes', 'archive'))
    ).rejects.toThrow();

    const config = await fs.readFile(path.join(tempDir, 'openspec', 'config.yaml'), 'utf-8');
    expect(config).toContain('lifecycle: status');

    // The migrated shipped change re-verifies: its delta re-applied to the
    // already-folded spec is a no-op, so the gate passes.
    process.exitCode = undefined;
    await new SyncCommand().execute(undefined, tempDir, { check: true });
    expect(process.exitCode).toBeUndefined();
  });

  it('is a no-op on an already-migrated project', async () => {
    await new MigrateCommand().execute(tempDir, {});
    logs = [];
    await new MigrateCommand().execute(tempDir, {});
    expect(logs.join('\n')).toContain('Already on');
  });

  it('round-trips: migrate → migrate --to archive restores the legacy layout', async () => {
    await new MigrateCommand().execute(tempDir, {});
    await new MigrateCommand().execute(tempDir, { to: 'archive' });

    // Shipped change back in archive/ under its date; active change flat.
    const archived = path.join(
      tempDir, 'openspec', 'changes', 'archive', '2026-03-15-add-user-auth'
    );
    await expect(fs.access(archived)).resolves.not.toThrow();
    await expect(
      fs.access(path.join(tempDir, 'openspec', 'changes', 'batch-upload'))
    ).resolves.not.toThrow();

    // Location is the state again: no status key survives.
    const archivedMeta = await fs.readFile(path.join(archived, '.openspec.yaml'), 'utf-8');
    expect(archivedMeta).not.toContain('status:');
    expect(archivedMeta).toContain('created: 2026-03-15');

    // Shard dirs pruned; config back to the default mode.
    await expect(
      fs.access(path.join(tempDir, 'openspec', 'changes', '2026'))
    ).rejects.toThrow();
    const config = await fs.readFile(path.join(tempDir, 'openspec', 'config.yaml'), 'utf-8');
    expect(config).not.toContain('lifecycle:');
  });

  it('refuses --to archive while a shipped change has unfolded deltas', async () => {
    await new MigrateCommand().execute(tempDir, {});
    // Flip the proposed change to shipped WITHOUT folding: gate red.
    const meta = path.join(
      tempDir, 'openspec', 'changes', '2026', '08', '01-batch-upload', '.openspec.yaml'
    );
    await fs.writeFile(
      meta,
      (await fs.readFile(meta, 'utf-8')).replace('status: proposed', 'status: shipped')
    );

    await expect(
      new MigrateCommand().execute(tempDir, { to: 'archive' })
    ).rejects.toThrow(/unfolded deltas/);
    expect(process.exitCode).toBeUndefined();
  });
});
