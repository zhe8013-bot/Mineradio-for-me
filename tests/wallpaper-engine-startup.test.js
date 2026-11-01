'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { WallpaperEngineRuntime } = require('../desktop/wallpaper-engine-runtime');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const turn = () => new Promise(setImmediate);

function runtimeHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-we-startup-'));
  const projectFile = path.join(root, 'project.json');
  const scenePackage = path.join(root, 'scene.pkg');
  fs.writeFileSync(projectFile, '{"type":"scene"}');
  fs.writeFileSync(scenePackage, 'PKGV0002');
  const runtime = new WallpaperEngineRuntime({
    nativeTempPath: root,
    useDesktopShellBroker: false,
    nativeSleep: async () => {},
    library: { getNativeSceneTarget: async id => ({ id, projectFile, scenePackage }) },
  });
  const engine = deferred();
  const engineStarted = deferred();
  const stage = deferred();
  const staging = deferred();
  const calls = [];
  runtime._discoverExecutable = async () => ({ available: true, executable: 'wallpaper64.exe' });
  runtime._ensureEngineReady = () => { calls.push('engine'); engineStarted.resolve(); return engine.promise; };
  runtime._prepareSilentLaunchFile = async session => {
    calls.push('stage');
    staging.resolve();
    await stage.promise;
    session.stagedProjectBaseRoot = root;
    session.stagedProjectRoot = path.join(root, session.sessionId);
    fs.mkdirSync(session.stagedProjectRoot);
    session.stagedProjectFile = path.join(session.stagedProjectRoot, 'project.json');
    fs.writeFileSync(session.stagedProjectFile, '{}');
    return session.stagedProjectFile;
  };
  runtime._openInitialSessionWindow = async session => { calls.push('open'); session.launched = true; };
  runtime._findWindowSource = async () => ({ id: 'window:4242:0' });
  runtime._muteSession = async session => { session.audioMuted = true; };
  runtime._spawnControl = async () => {};
  runtime._controlSessionWindow = async () => ({ ok: true, closed: true });
  t.after(async () => {
    engine.resolve('wallpaper64.exe');
    stage.resolve();
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, runtime, engine, engineStarted, stage, staging, calls };
}

test('engine and silent stage overlap; opening waits for both', async t => {
  const h = runtimeHarness(t);
  const start = h.runtime.start('0123456789abcdef01234567');
  await h.engineStarted.promise;
  assert.deepEqual(h.calls, ['engine', 'stage']);
  h.engine.resolve('wallpaper64.exe');
  await turn();
  assert(!h.calls.includes('open'));
  h.stage.resolve();
  const session = await start;
  assert.equal(session.active, true);
  assert.equal(h.calls.filter(call => call === 'open').length, 1);
});

test('concurrent elevation checks share one conservative probe', async t => {
  const h = runtimeHarness(t);
  const elevation = deferred();
  let probes = 0;
  h.runtime.hostElevationProbe = () => { probes++; return elevation.promise; };
  const first = h.runtime._hostIsElevated();
  const second = h.runtime._hostIsElevated();
  try { assert.equal(probes, 1); }
  finally { elevation.reject(new Error('probe unavailable')); }
  assert.equal(await first, true, 'failed elevation checks must retain the safe broker fallback');
  assert.equal(await second, true);
  assert.equal(await h.runtime._hostIsElevated(), true);
  assert.equal(probes, 1);
});

test('elevation is prepared alongside the engine without opening before verification', async t => {
  const h = runtimeHarness(t);
  const elevation = deferred();
  let probes = 0;
  h.runtime.useDesktopShellBroker = true;
  h.runtime.hostElevationProbe = () => { probes++; return elevation.promise; };
  const start = h.runtime.start('0123456789abcdef01234567');
  await h.staging.promise;
  try { assert.equal(probes, 1, 'the first control must not pay for a late elevation probe'); }
  finally { elevation.resolve(false); }
  h.engine.resolve('wallpaper64.exe');
  h.stage.resolve();
  assert.equal((await start).active, true);
  assert.equal(h.runtime.hostElevationCache, false);
});

test('engine failure waits for staging before cleanup', async t => {
  const h = runtimeHarness(t);
  const start = h.runtime.start('0123456789abcdef01234567');
  const rejected = assert.rejects(start, { code: 'ENGINE_FAILED' });
  await h.engineStarted.promise;
  assert(h.calls.includes('stage'), 'staging must run while engine readiness is pending');
  const session = h.runtime.pending;
  h.engine.reject(Object.assign(new Error('engine failed'), { code: 'ENGINE_FAILED' }));
  await turn();
  assert.equal(h.runtime.pending, session);
  h.stage.resolve();
  await rejected;
  assert.equal(h.runtime.pending, null);
  assert.equal(fs.existsSync(path.join(h.root, session.sessionId)), false);
  assert(!h.calls.includes('open'));
});

test('silent stage failure never opens a scene and waits for engine preparation', async t => {
  const h = runtimeHarness(t);
  const start = h.runtime.start('0123456789abcdef01234567');
  const rejected = assert.rejects(start, { code: 'WALLPAPER_ENGINE_START_FAILED' });
  await h.staging.promise;
  h.stage.reject(new Error('stage failed'));
  await turn();
  assert(h.runtime.pending);
  h.engine.resolve('wallpaper64.exe');
  await rejected;
  assert.equal(h.runtime.pending, null);
  assert(!h.calls.includes('open'));
});

test('stop waits for an in-flight silent stage and never opens the cancelled scene', async t => {
  const h = runtimeHarness(t);
  const start = h.runtime.start('0123456789abcdef01234567');
  const rejected = assert.rejects(start, { code: 'WALLPAPER_ENGINE_START_SUPERSEDED' });
  h.engine.resolve('wallpaper64.exe');
  await h.staging.promise;
  const session = h.runtime.pending;
  let stopped = false;
  const stop = h.runtime.stop(session.sessionId).then(result => { stopped = true; return result; });
  await turn();
  assert.equal(stopped, false, 'stop must not finish before late stage writes are cleaned');
  h.stage.resolve();
  assert.equal((await stop).stopped, true);
  await rejected;
  assert.equal(h.runtime.active, null);
  assert.equal(h.runtime.pending, null);
  assert.equal(fs.existsSync(path.join(h.root, session.sessionId)), false);
  assert(!h.calls.includes('open'));
});

test('dispose waits for pending preparation before returning a clean runtime', async t => {
  const h = runtimeHarness(t);
  const start = h.runtime.start('0123456789abcdef01234567');
  const rejected = assert.rejects(start, { code: 'WALLPAPER_ENGINE_START_SUPERSEDED' });
  await h.staging.promise;
  const session = h.runtime.pending;
  let disposed = false;
  const dispose = h.runtime.dispose().then(result => { disposed = true; return result; });
  await turn();
  assert.equal(disposed, false);
  h.engine.resolve('wallpaper64.exe');
  h.stage.resolve();
  assert.equal((await dispose).stopped, true);
  await rejected;
  assert.equal(fs.existsSync(path.join(h.root, session.sessionId)), false);
  assert(!h.calls.includes('open'));
});

test('cancelling preparation waits for the shared asynchronous stage deletion', async t => {
  const h = runtimeHarness(t);
  const start = h.runtime.start('0123456789abcdef01234567');
  const rejected = assert.rejects(start, { code: 'WALLPAPER_ENGINE_START_SUPERSEDED' });
  await h.staging.promise;
  const session = h.runtime.pending;
  const deleted = deferred();
  const deleting = deferred();
  const originalRm = fs.promises.rm;
  fs.promises.rm = async (target, options) => {
    if (target === path.join(h.root, session.sessionId)) {
      deleting.resolve();
      await deleted.promise;
    }
    return originalRm(target, options);
  };
  try {
    let stopped = false;
    const stop = h.runtime.stop(session.sessionId).then(result => { stopped = true; return result; });
    h.engine.resolve('wallpaper64.exe');
    h.stage.resolve();
    await deleting.promise;
    await turn();
    assert.equal(stopped, false, 'stop must join the start failure cleanup through the actual deletion');
    deleted.resolve();
    await stop;
    await rejected;
  } finally {
    deleted.resolve();
    fs.promises.rm = originalRm;
  }
});

test('a new start supersedes and cleans the old preparation without closing the new scene', async t => {
  const h = runtimeHarness(t);
  const first = h.runtime.start('0123456789abcdef01234567');
  const rejected = assert.rejects(first, { code: 'WALLPAPER_ENGINE_START_SUPERSEDED' });
  await h.staging.promise;
  const old = h.runtime.pending;
  const second = h.runtime.start('111111111111111111111111');
  h.engine.resolve('wallpaper64.exe');
  h.stage.resolve();
  const active = await second;
  await rejected;
  assert.equal(active.id, '111111111111111111111111');
  assert.equal(h.runtime.active.sessionId, active.sessionId);
  assert.equal(fs.existsSync(path.join(h.root, old.sessionId)), false);
  assert.equal(h.calls.filter(call => call === 'open').length, 1);
});

test('dispose also waits for preparation superseded by a newer start', async t => {
  const h = runtimeHarness(t);
  const oldStage = deferred(), entered = deferred();
  const prepare = h.runtime._prepareSilentLaunchFile;
  h.runtime._prepareSilentLaunchFile = async (...args) => {
    if (args[0].id === '0123456789abcdef01234567') { entered.resolve(); await oldStage.promise; }
    return prepare(...args);
  };
  h.engine.resolve('wallpaper64.exe');
  h.stage.resolve();
  const first = h.runtime.start('0123456789abcdef01234567');
  const rejected = assert.rejects(first, { code: 'WALLPAPER_ENGINE_START_SUPERSEDED' });
  await entered.promise;
  const old = h.runtime.pending;
  await h.runtime.start('111111111111111111111111');
  await h.runtime.stop(h.runtime.active.sessionId);
  let disposed = false;
  const dispose = h.runtime.dispose().then(result => { disposed = true; return result; });
  try {
    await turn();
    assert.equal(disposed, false, 'superseded staging still belongs to this runtime');
    assert.equal((await h.runtime.dispose()).stopped, false, 'repeated disposal must not claim an unfinished stage is clean');
  } finally { oldStage.resolve(); }
  await dispose;
  await rejected;
  assert.equal(fs.existsSync(path.join(h.root, old.sessionId)), false);
  assert.equal(h.runtime.active, null);
});

test('final mute and DWM preparation overlap; readiness waits for both', async t => {
  const h = runtimeHarness(t);
  const mute = deferred();
  const surface = deferred();
  const calls = [];
  const session = { sessionId: '0123456789abcdef01234567', audioMuted: true, windowEmbedding: { aligned: true } };
  h.runtime.active = session;
  h.runtime._applySessionMute = () => { calls.push('mute'); return mute.promise; };
  h.runtime._startSessionDwmSurface = async () => { calls.push('surface'); await surface.promise; session.dwmSurfaceReady = true; return true; };
  h.runtime._scheduleSessionMuteReassertions = () => {};
  const confirm = h.runtime.confirmCaptureReady(session.sessionId);
  await turn();
  assert.deepEqual(calls, ['mute', 'surface']);
  mute.resolve(true);
  let ready = false;
  confirm.then(value => { ready = value; });
  await turn();
  assert.equal(ready, false);
  surface.resolve();
  assert.equal(await confirm, true);
});

test('a failed final mute waits for DWM preparation before rejecting', async t => {
  const h = runtimeHarness(t);
  const mute = deferred();
  const surface = deferred();
  h.runtime.active = { sessionId: '0123456789abcdef01234567', audioMuted: true, windowEmbedding: { aligned: true } };
  h.runtime._applySessionMute = () => mute.promise;
  h.runtime._startSessionDwmSurface = () => surface.promise;
  const confirm = h.runtime.confirmCaptureReady(h.runtime.active.sessionId);
  let settled = false;
  confirm.then(() => { settled = true; }, () => { settled = true; });
  mute.reject(new Error('mute failed'));
  await turn();
  assert.equal(settled, false);
  surface.resolve(false);
  assert.equal(await confirm.catch(() => false), false);
});

test('a superseded capture confirmation cannot report the new scene ready', async t => {
  const h = runtimeHarness(t);
  const surface = deferred();
  const old = { sessionId: '0123456789abcdef01234567', audioMuted: true, windowEmbedding: { aligned: true } };
  h.runtime.active = old;
  h.runtime._applySessionMute = async () => true;
  h.runtime._startSessionDwmSurface = async () => { await surface.promise; old.dwmSurfaceReady = true; return true; };
  const confirm = h.runtime.confirmCaptureReady(old.sessionId);
  h.runtime.active = { sessionId: '111111111111111111111111' };
  surface.resolve();
  assert.equal(await confirm, false);
});

const renderer = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/07-fx/03-wallpaper-engine-library.js'), 'utf8');

function rendererHarness() {
  const request = deferred();
  let requests = 0;
  const context = vm.createContext({
    wallpaperEngineLibraryBusy: false, wallpaperEngineLibraryPromise: null,
    wallpaperEngineProjects: [], wallpaperEngineLibrarySnapshot: null,
    wallpaperEngineMediaToken: '',
    wallpaperEngineDesktopApi: () => ({ listWallpaperEngineProjects: () => { requests++; return request.promise; } }),
    updateWallpaperEngineLibraryStatus() {}, renderWallpaperEngineLibrary() {}, showToast() {},
    consumeWallpaperEngineSnapshot(snapshot) { context.wallpaperEngineProjects = snapshot.projects; context.wallpaperEngineLibrarySnapshot = snapshot; },
  });
  vm.runInContext(renderer.slice(renderer.indexOf('async function loadWallpaperEngineLibrary('), renderer.indexOf('async function openWallpaperEngineLibrary(')), context);
  return { context, request, requests: () => requests };
}

test('concurrent library callers wait for the same completed snapshot', async () => {
  const h = rendererHarness();
  const startup = h.context.loadWallpaperEngineLibrary(false, false);
  let finished = false;
  const panel = h.context.loadWallpaperEngineLibrary(false, false).then(items => { finished = true; return items; });
  await turn();
  assert.equal(finished, false, 'a busy library must not return an empty list to startup restore');
  const projects = [{ id: '0123456789abcdef01234567' }];
  h.request.resolve({ ok: true, projects });
  assert.deepEqual(await startup, projects);
  assert.deepEqual(await panel, projects);
  assert.equal(h.requests(), 1);
  assert.equal(h.context.wallpaperEngineLibraryBusy, false);
  assert.equal(h.context.wallpaperEngineLibraryPromise, null);
});

test('failed shared library load clears busy state and permits a retry', async () => {
  const h = rendererHarness();
  const first = h.context.loadWallpaperEngineLibrary(false, false);
  const second = h.context.loadWallpaperEngineLibrary(false, false);
  h.request.reject(new Error('offline'));
  assert.equal((await first).length, 0);
  assert.equal((await second).length, 0);
  await h.context.loadWallpaperEngineLibrary(false, false);
  assert.equal(h.requests(), 2);
  assert.equal(h.context.wallpaperEngineLibraryBusy, false);
});

test('initial wallpaper load clears outgoing media only once', () => {
  let clears = 0;
  let starts = 0;
  const element = { classList: { contains: () => false }, dataset: {} };
  const context = vm.createContext({
    wallpaperEngineSelection: { active: true, kind: 'engine', id: 'selected' },
    wallpaperEngineLayerToken: 0, wallpaperEngineSwitchTimer: 0,
    document: { getElementById: () => element },
    cancelWallpaperEngineSwitchTimer() {}, restoreOriginalBackgroundAfterWallpaperEngine() {},
    updateWallpaperEngineEntryUi() {}, wallpaperEngineNativeHostUnavailable: () => false,
    clearWallpaperEngineLayerMedia() { clears++; },
    startWallpaperEngineNativeBackground() { starts++; return Promise.resolve(); },
  });
  vm.runInContext(renderer.slice(renderer.indexOf('function applyWallpaperEngineBackground('), renderer.indexOf('function activateWallpaperEngineItem(')), context);
  context.applyWallpaperEngineBackground({ id: 'selected', enginePlayable: true }, true);
  assert.equal(starts, 1);
  assert.equal(clears, 1);
});

test('library scan and runtime probe start together in the trusted IPC handler', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop/main.js'), 'utf8');
  const scan = deferred(), probe = deferred();
  const calls = [];
  let handler;
  const context = vm.createContext({
    embeddedScenesEnabled: false,
    ipcMain: { handle(_name, callback) { handler = callback; } },
    isTrustedWallpaperEngineIpc: () => true,
    wallpaperEngineLibrary: { list() { calls.push('scan'); return scan.promise; } },
    wallpaperEngineRuntime: { probe() { calls.push('probe'); return probe.promise; } },
  });
  vm.runInContext(main.slice(main.indexOf("ipcMain.handle('mineradio-wallpaper-engine-list'"), main.indexOf("ipcMain.handle('mineradio-wallpaper-scene-resources'")), context);
  const result = handler({}, {});
  await turn();
  assert.deepEqual(calls, ['scan', 'probe']);
  scan.resolve({ ok: true, projects: [] });
  probe.resolve({ available: true });
  assert.equal((await result).runtime.available, true);
});

test('embedded library scan does not wait for or start an external engine probe', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop/main.js'), 'utf8');
  let handler;
  const context = vm.createContext({
    embeddedScenesEnabled: true,
    ipcMain: { handle(_name, callback) { handler = callback; } },
    isTrustedWallpaperEngineIpc: () => true,
    wallpaperEngineLibrary: { list: async () => ({ ok: true, projects: [] }) },
    wallpaperEngineRuntime: { probe() { throw new Error('external probe must not run'); } },
  });
  vm.runInContext(main.slice(main.indexOf("ipcMain.handle('mineradio-wallpaper-engine-list'"), main.indexOf("ipcMain.handle('mineradio-wallpaper-scene-resources'")), context);
  assert.equal((await handler({}, {})).runtime.embeddedScenes, true);
});
