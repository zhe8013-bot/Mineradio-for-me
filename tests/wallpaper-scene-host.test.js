const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../public/wallpaper-scene-host.js'), 'utf8');
function harness() {
  const parent = { postMessage() {} }, calls = [], sent = [];
  let listener, finish;
  const instance = { info: {}, getQuality: () => ({}), pause: () => calls.push('pause'), resume: () => calls.push('resume'), destroy: () => calls.push('destroy'), setFps: value => calls.push(['fps', value]), setRenderDpr: value => calls.push(['dpr', value]) };
  const pending = new Promise(resolve => { finish = () => resolve(instance); });
  const port = { postMessage: value => sent.push(value), start() {}, close() {} };
  const context = { URLSearchParams, location: { search: '?nonce=test' }, parent, performance: { now: () => 0 }, document: { body: {} }, addEventListener(_name, callback) { listener = callback; }, removeEventListener() {}, WebWallGL: { mount: () => pending } };
  vm.runInNewContext(source, context);
  const connected = listener({ source: parent, data: { nonce: 'test', config: { fps: 120, dpr: 1, visible: true, project: {} } }, ports: [port] });
  return { port, finish, connected, calls, sent };
}
test('host remembers visibility and render updates received while mounting', async () => {
  const h = harness();
  h.port.onmessage({ data: { type: 'visibility', visible: false } });
  h.port.onmessage({ data: { type: 'render', fps: 45, dpr: 2 } });
  h.finish(); await h.connected;
  assert(h.calls.includes('pause'));
  assert(h.calls.some(x => x[0] === 'fps' && x[1] === 45));
  assert(h.calls.some(x => x[0] === 'dpr' && x[1] === 2));
});
test('a destroyed host cannot resurrect after mount resolves', async () => {
  const h = harness();
  h.port.onmessage({ data: { type: 'destroy' } });
  h.finish(); await h.connected;
  assert.equal(h.calls.filter(x => x === 'destroy').length, 1);
  assert(!h.sent.some(x => x.type === 'ready'));
});
