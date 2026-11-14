// -----------------------------------------------------------------------------
// /data: a write that outlives its bound is never followed by another one
// that it could overwrite afterwards.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

test('a slow write blocks the next ones until it ends; then writes go on', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ercot-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let hold;
  const fs = {
    ...fsp,
    async writeFile(path, text) {
      if (text.includes('"old"')) await new Promise((resolve) => (hold = resolve));
      return fsp.writeFile(path, text);
    },
  };
  const store = new Store({ dataDir: dir, timers: { setTimeout, clearTimeout }, timeout: 20, fs });
  assert.equal(await store.save({ v: 'old' }), false, 'beyond its bound');
  assert.equal(await store.save({ v: 'new' }), false, 'refused while the old one runs');
  hold();
  await store.slowWrite;
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).v, 'old');
  assert.equal(await store.save({ v: 'new' }), true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).v, 'new');
});
