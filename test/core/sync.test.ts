import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SyncCommand } from '../../src/core/sync.js';
import { ArchiveCommand } from '../../src/core/archive.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
}));

const DELTA = `# Auth - Changes

## ADDED Requirements

### Requirement: The system SHALL support OAuth login

#### Scenario: OAuth round trip
- **WHEN** a user signs in with a provider
- **THEN** a session is established
`;

describe('SyncCommand', () => {
  let tempDir: string;
  let logs: string[];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-sync-test-'));
    logs = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '));
    };
    process.exitCode = undefined;
  });

  afterEach(async () => {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function scaffold(options: {
    lifecycle?: 'archive' | 'status';
    status?: 'proposed' | 'applied' | 'shipped';
  }): Promise<void> {
    const openspec = path.join(tempDir, 'openspec');
    await fs.mkdir(path.join(openspec, 'specs'), { recursive: true });
    const changeDir = path.join(openspec, 'changes', 'add-oauth');
    await fs.mkdir(path.join(changeDir, 'specs', 'auth'), { recursive: true });

    const lifecycleLine = options.lifecycle ? `lifecycle: ${options.lifecycle}\n` : '';
    await fs.writeFile(
      path.join(openspec, 'config.yaml'),
      `schema: spec-driven\n${lifecycleLine}`
    );

    const statusLine = options.status ? `status: ${options.status}\n` : '';
    await fs.writeFile(
      path.join(changeDir, '.openspec.yaml'),
      `schema: spec-driven\ncreated: 2026-08-11\n${statusLine}`
    );
    await fs.writeFile(path.join(changeDir, 'specs', 'auth', 'spec.md'), DELTA);
  }

  function targetSpec(): string {
    return path.join(tempDir, 'openspec', 'specs', 'auth', 'spec.md');
  }

  it('reports nothing to gate under lifecycle: archive', async () => {
    await scaffold({ lifecycle: 'archive', status: 'shipped' });
    await new SyncCommand().execute(undefined, tempDir, { check: true });
    expect(process.exitCode).toBeUndefined();
    expect(logs.join('\n')).toContain('lifecycle: archive');
  });

  it('check fails on a shipped change whose delta is not folded', async () => {
    await scaffold({ lifecycle: 'status', status: 'shipped' });
    await new SyncCommand().execute(undefined, tempDir, { check: true });
    expect(process.exitCode).toBe(1);
    expect(logs.join('\n')).toContain('add-oauth');
    expect(logs.join('\n')).toContain('auth');
  });

  it('ignores proposed changes: their deltas stay out of specs/', async () => {
    await scaffold({ lifecycle: 'status', status: 'proposed' });
    await new SyncCommand().execute(undefined, tempDir, { check: true });
    expect(process.exitCode).toBeUndefined();
    await expect(fs.access(targetSpec())).rejects.toThrow();
  });

  it('folds a shipped change, then check passes and a re-run is a no-op', async () => {
    await scaffold({ lifecycle: 'status', status: 'shipped' });

    await new SyncCommand().execute(undefined, tempDir, {});
    expect(process.exitCode).toBeUndefined();
    const folded = await fs.readFile(targetSpec(), 'utf-8');
    expect(folded).toContain('OAuth login');

    process.exitCode = undefined;
    logs = [];
    await new SyncCommand().execute(undefined, tempDir, { check: true });
    expect(process.exitCode).toBeUndefined();

    await new SyncCommand().execute(undefined, tempDir, {});
    const refolded = await fs.readFile(targetSpec(), 'utf-8');
    expect(refolded).toBe(folded);
  });

  it('refuses to fold an explicitly named change that is not shipped', async () => {
    await scaffold({ lifecycle: 'status', status: 'applied' });
    await expect(
      new SyncCommand().execute('add-oauth', tempDir, {})
    ).rejects.toThrow(/only shipped changes fold/);
  });
});

describe('ArchiveCommand under lifecycle: status', () => {
  let tempDir: string;
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-sync-archive-test-'));
    const openspec = path.join(tempDir, 'openspec');
    await fs.mkdir(path.join(openspec, 'specs'), { recursive: true });
    await fs.mkdir(path.join(openspec, 'changes', 'add-oauth'), { recursive: true });
    await fs.writeFile(
      path.join(openspec, 'config.yaml'),
      'schema: spec-driven\nlifecycle: status\n'
    );
    await fs.writeFile(
      path.join(openspec, 'changes', 'add-oauth', '.openspec.yaml'),
      'schema: spec-driven\nstatus: shipped\n'
    );
  });

  afterEach(async () => {
    process.exitCode = originalExitCode;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('refuses to archive and points at the status workflow', async () => {
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      await expect(
        new ArchiveCommand().execute('add-oauth', { yes: true })
      ).rejects.toThrow(/lifecycle: status/);
    } finally {
      process.chdir(cwd);
    }
  });
});
