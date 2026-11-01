const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SceneResources } = require('../desktop/wallpaper-scene-resources');
test('Scene resources restrict paths and revoke sessions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-resources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'scene.pkg'), 'PKGV0002');
  await fs.writeFile(path.join(root, 'project.json'), '\uFEFF{"type":"scene"}');
  const resources = new SceneResources({ getNativeSceneTarget: async () => ({ scenePackage: path.join(root, 'scene.pkg'), projectFile: path.join(root, 'project.json') }) }, async () => []);
  const session = await resources.open('a'.repeat(24));
  assert.equal(Buffer.from(await resources.read(session.sessionId, 'project', 'scene.pkg')).toString(), 'PKGV0002');
  for (const name of ['../scene.pkg', 'C:/scene.pkg', '//host/share', 'scene.pkg:stream', '%2e%2e/a', '.cookie', 'foo\\..\\scene.pkg']) {
    await assert.rejects(resources.read(session.sessionId, 'project', name));
  }
  assert.equal(await resources.read(session.sessionId, 'project', 'missing.tex'), null);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'secret.json'), '{}');
  await fs.symlink(outside, path.join(root, 'escape'), 'junction');
  await assert.rejects(resources.read(session.sessionId, 'project', 'escape/secret.json'), /DENIED/);
  await assert.rejects(resources.read(session.sessionId, 'invalid', 'scene.pkg'));
  resources.close(session.sessionId);
  await assert.rejects(resources.read(session.sessionId, 'project', 'scene.pkg'));
  const opening = resources.open('a'.repeat(24));
  resources.closeAll();
  await assert.rejects(opening, /CLOSED/);
  assert.equal(resources.sessions.size, 0);
});
