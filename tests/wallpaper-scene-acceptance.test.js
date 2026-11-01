'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('acceptance cleanup errors and exit leaks cannot report success', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/check-wallpaper-scene-live.js'), 'utf8');
  const finish = source.slice(source.indexOf('async function finish(error)'), source.indexOf('async function security()'));
  for (const [error, resources, expected] of [[null, 0, 0], [new Error('cleanup failed'), 0, 1], [null, 1, 1]]) {
    let onQuit, exitCode, saved;
    const result = { ok: true, cases: [] };
    const context = {
      finished: false, timer: null, result, suite: 'test', variant: 'default', server: null, activeResources: new Set(Array.from({ length: resources }, (_, i) => i)),
      clearInterval() {}, output: '.', label: 'test', path,
      fs: { mkdirSync() {}, writeFileSync(_file, value) { saved = JSON.parse(value); } },
      console: { log() {} }, app: { once(_event, callback) { onQuit = callback; }, quit() { onQuit(); }, exit(code) { exitCode = code; } }
    };
    vm.runInNewContext(finish, context);
    await context.finish(error);
    assert.equal(exitCode, expected);
    assert.equal(saved.ok, expected === 0);
    assert.equal(saved.activeResourcesAfterExit, resources);
  }
});
