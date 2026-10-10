import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolvePiEntrypoint, run } from '../app/utils.js';

test('Pi launches through Node even with an unavailable shebang interpreter', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-launch-'));
  try {
    const entry = path.join(dir, 'cli.mjs');
    await fs.writeFile(entry, '#!/nonexistent/interpreter\nconsole.log(process.argv[2]);\n');
    await fs.symlink(entry, path.join(dir, 'pi'));
    const resolved = await resolvePiEntrypoint(`${dir}/missing${path.delimiter}${dir}`);
    assert.equal(resolved, await fs.realpath(entry));
    const result = await run(process.execPath, [resolved, '--version']);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), '--version');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('missing Pi gives an actionable error', async () => {
  await assert.rejects(resolvePiEntrypoint('/nonexistent/pi-bin'), /Pi is not installed or is not on the backend PATH/);
});
