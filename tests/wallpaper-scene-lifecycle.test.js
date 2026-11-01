const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(require.resolve('../public/js/modules/07-fx/03a-wallpaper-scene-runtime.js'), 'utf8');
function harness() {
  let resolve;
  const pending = new Promise(yes => { resolve = yes; });
  const calls = [];
  const listeners = {};
  const documentListeners = {};
  const posted = [];
  let fallbacks = 0;
  const rafs = [];
  const classes = { add() {}, remove() {} };
  const context = { crypto: crypto.webcrypto, Uint32Array, Array, Promise, Error,
    requestAnimationFrame(callback) { rafs.push(callback); }, cancelAnimationFrame() {}, setTimeout, clearTimeout, setInterval, clearInterval, innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
    wallpaperEngineLayerReady() {},
    wallpaperEngineCaptureFpsPreference: () => 0, wallpaperEngineResolvedCaptureFps: value => value || 240,
    startWallpaperEngineExternalBackground: async () => { fallbacks++; },
    MessageChannel: function () { this.port1 = { start() {}, close() {}, postMessage(message) { posted.push(message); } }; this.port2 = {}; },
    document: { body: { classList: classes }, addEventListener(name, fn) { documentListeners[name] = fn; }, removeEventListener(name) { delete documentListeners[name]; }, getElementById: () => ({ classList: classes, appendChild() {} }), createElement: () => ({ contentWindow: { postMessage(message) { posted.push(message); } }, setAttribute() {}, remove() { calls.push('removed'); } }) },
    window: { desktopWindow: { wallpaperSceneResources(payload) { calls.push(payload); return payload.action === 'open' ? pending : Promise.resolve({ ok: true }); } } },
    wallpaperEngineLayerToken: 1, wallpaperEngineSelection: { active: true, id: 'first' } };
  context.window.addEventListener = (name, fn) => { listeners[name] = fn; };
  context.window.removeEventListener = () => {};
  vm.createContext(context); vm.runInContext(source, context);
  return { context, calls, resolve, listeners, documentListeners, posted, rafs, fallbacks: () => fallbacks };
}

for (const frameHidden of [false, true]) for (const suspended of [false, true]) test('occluded startup counts visible time, suspended=' + suspended + ', frame=' + frameHidden, async () => {
  const h = harness(), c = h.context;
  let now = 0, tick, failure;
  c.Date = { now: () => now };
  c.setInterval = callback => { tick = callback; return 1; };
  c.clearInterval = () => {};
  c.document.hidden = !frameHidden;
  const loading = c.startWallpaperScene({ id: 'first' }, 1).catch(error => { failure = error; });
  h.resolve({ ok: true, sessionId: 'session' });
  await new Promise(setImmediate);
  let receive;
  if (frameHidden) {
    const frame = c.wallpaperSceneSession.frame;
    h.listeners.message({ source: frame.contentWindow, data: { type: 'mineradio-scene-host', nonce: new URL(frame.src, 'http://localhost').searchParams.get('nonce') } });
    receive = c.wallpaperSceneSession.port.onmessage;
    receive({ data: { type: 'frame-visibility', visible: false } });
  }
  now = 11000; if (!suspended) tick();
  await new Promise(setImmediate);
  assert.equal(failure, undefined, 'Covered window must not exhaust the first-frame timeout');
  c.document.hidden = false;
  h.documentListeners.visibilitychange();
  if (receive) receive({ data: { type: 'frame-visibility', visible: true } });
  now += 250; tick();
  await new Promise(setImmediate);
  assert.equal(failure, undefined);
  now += 10000; tick();
  await loading;
  assert.match(failure.message, /SCENE_FIRST_FRAME_TIMEOUT/);
  assert.equal(h.documentListeners.visibilitychange, undefined);
  c.stopWallpaperScene();
});
test('cancellation during resource open revokes the late session', async () => {
  const { context: c, calls, resolve } = harness();
  const loading = c.startWallpaperScene({ id: 'first' }, 1);
  c.stopWallpaperScene();
  resolve({ ok: true, sessionId: 'late' });
  await assert.rejects(loading, /SUPERSEDED/);
  assert.equal(c.wallpaperSceneSession, null);
  assert(calls.some(x => x.action === 'close' && x.sessionId === 'late'));
});
test('late failed resource open does not clear a newer session', async () => {
  const { context: c, resolve } = harness();
  const loading = c.startWallpaperScene({ id: 'first' }, 1);
  const newer = {};
  c.wallpaperSceneSession = newer;
  resolve({ ok: false, error: 'missing' });
  await assert.rejects(loading, /missing/);
  assert.equal(c.wallpaperSceneSession, newer);
});
test('embedded mount resolves vsync to the measured refresh rate', async () => {
  const { context: c, resolve, listeners, posted } = harness();
  const loading = c.startWallpaperScene({ id: 'first' }, 1).catch(error => error);
  resolve({ ok: true, sessionId: 'session' });
  await new Promise(setImmediate);
  const frame = c.wallpaperSceneSession.frame;
  listeners.message({ source: frame.contentWindow, data: { type: 'mineradio-scene-host', nonce: new URL(frame.src, 'http://localhost').searchParams.get('nonce') } });
  const fps = posted[0].config.fps;
  c.stopWallpaperScene();
  await loading;
  assert.equal(fps, 240);
});
test('error between host ready and composition starts external fallback once', async () => {
  const h = harness(), c = h.context;
  const loading = c.startWallpaperScene({ id: 'first' }, 1).catch(() => c.startWallpaperEngineExternalBackground());
  h.resolve({ ok: true, sessionId: 'session' });
  await new Promise(setImmediate);
  const frame = c.wallpaperSceneSession.frame;
  h.listeners.message({ source: frame.contentWindow, data: { type: 'mineradio-scene-host', nonce: new URL(frame.src, 'http://localhost').searchParams.get('nonce') } });
  const receive = c.wallpaperSceneSession.port.onmessage;
  receive({ data: { type: 'ready', mountMs: 100 } });
  receive({ data: { type: 'error', message: 'context lost before composition' } });
  await loading;
  assert.equal(h.fallbacks(), 1);
  c.stopWallpaperScene();
});
for (const afterComposition of [false, true]) test('compatibility warning triggers one fallback ' + (afterComposition ? 'after composition' : 'before ready'), async () => {
  const h = harness(), c = h.context;
  const loading = c.startWallpaperScene({ id: 'first' }, 1).catch(() => c.startWallpaperEngineExternalBackground());
  h.resolve({ ok: true, sessionId: 'session' });
  await new Promise(setImmediate);
  const frame = c.wallpaperSceneSession.frame;
  h.listeners.message({ source: frame.contentWindow, data: { type: 'mineradio-scene-host', nonce: new URL(frame.src, 'http://localhost').searchParams.get('nonce') } });
  const receive = c.wallpaperSceneSession.port.onmessage;
  if (afterComposition) {
    receive({ data: { type: 'ready' } });
    for (let i = 0; i < 2; i++) { const at = h.rafs.findIndex(callback => callback.name !== 'update'); h.rafs.splice(at, 1)[0](); }
    await loading;
  }
  receive({ data: { type: 'diagnostic', level: 'warn', message: 'missing texture' } });
  receive({ data: { type: 'diagnostic', level: 'error', message: 'same failure' } });
  await loading;
  assert.equal(h.fallbacks(), 1);
  c.stopWallpaperScene();
});
