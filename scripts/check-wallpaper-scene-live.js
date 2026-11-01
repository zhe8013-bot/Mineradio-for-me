'use strict';
// Run with Electron. Artifacts stay in ignored tmp; no installed profile is used.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf('--' + name); return i < 0 ? fallback : args[i + 1]; }
const suite = option('suite', 'library');
const variant = option('variant', 'embedded');
const appRoot = path.resolve(option('app-root', root));
const output = path.resolve(option('output', path.join(root, 'tmp/scene-acceptance')));
if (!process.versions.electron) {
  (async () => {
    fs.mkdirSync(output, { recursive: true });
    const { WallpaperEngineLibrary } = require(path.join(appRoot, 'desktop/wallpaper-engine-library'));
    const library = new WallpaperEngineLibrary({ userDataPath: path.join(output, 'discovery') });
    const scan = await library.list();
    const catalog = path.join(output, 'catalog.private.json');
    fs.writeFileSync(catalog, JSON.stringify(scan.projects.filter(item => item.enginePlayable).map(item => ({ id: item.id, title: item.title }))));
    library.dispose();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (process.platform === 'win32') env.PSModulePath = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules');
    const child = require('node:child_process').spawnSync(require('electron'), [__filename, ...args, '--catalog', catalog], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    if (child.error) throw child.error;
    process.exitCode = child.status === null ? 1 : child.status;
  })().catch(error => { console.error(error); process.exitCode = 1; });
  return;
}
const { app, session } = require('electron');
if (suite === 'soak') {
  // Stress the renderer while other test windows cover it; production keeps normal throttling.
  for (const flag of ['disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding', 'disable-background-timer-throttling']) app.commandLine.appendSwitch(flag);
}
const label = suite + '-' + variant + '-' + Date.now();
const runtimeName = 'Mineradio-scene-acceptance';
const profile = path.join(output, label);
const userData = path.join(profile, runtimeName);
fs.mkdirSync(userData, { recursive: true });
process.env.MINERADIO_RUNTIME_NAME = runtimeName;
process.env.MINERADIO_APP_USER_MODEL_ID = 'com.mineradio.scene.acceptance';
if (variant === 'default') delete process.env.MINERADIO_EMBEDDED_SCENE;
else process.env.MINERADIO_EMBEDDED_SCENE = variant === 'embedded' ? '1' : '0';
delete process.env.MINERADIO_STARTUP_QA_HIDDEN;
delete process.env.MINERADIO_STARTUP_QA_EXIT_MS;
app.setPath('appData', profile);
app.setPath('userData', userData);
fs.writeFileSync(path.join(userData, 'cache-settings.json'), JSON.stringify({ rootPath: path.join(profile, 'cache') }));
const result = { suite, variant, label, startedAt: Date.now(), cases: [], logs: [], lifecycle: {}, resources: [], nativeStarts: 0, networkAttempts: 0, ok: false,
  vendorSha256: fs.existsSync(path.join(appRoot, 'public/vendor/webwallgl/SOURCE.json')) ? JSON.parse(fs.readFileSync(path.join(appRoot, 'public/vendor/webwallgl/SOURCE.json'))).sha256 : null };
const activeResources = new Set();
const { WallpaperEngineRuntime } = require(path.join(appRoot, 'desktop/wallpaper-engine-runtime'));
const originalStart = WallpaperEngineRuntime.prototype.start;
WallpaperEngineRuntime.prototype.start = function (...values) {
  result.nativeStarts++;
  if (variant !== 'external' && suite !== 'benchmark') return Promise.reject(new Error('QA_EXTERNAL_FALLBACK_DISABLED'));
  return originalStart.apply(this, values);
};
if (fs.existsSync(path.join(appRoot, 'desktop/wallpaper-scene-resources.js'))) {
  const { SceneResources } = require(path.join(appRoot, 'desktop/wallpaper-scene-resources'));
  const open = SceneResources.prototype.open, close = SceneResources.prototype.close, closeAll = SceneResources.prototype.closeAll;
  SceneResources.prototype.open = async function (...values) {
    const value = await open.apply(this, values);
    if (option('assets', 'present') === 'missing') { this.sessions.get(value.sessionId).builtinRoot = ''; value.hasBuiltins = false; }
    activeResources.add(value.sessionId); return value;
  };
  SceneResources.prototype.close = function (id) { activeResources.delete(id); return close.call(this, id); };
  SceneResources.prototype.closeAll = function () { activeResources.clear(); return closeAll.call(this); };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, server, timer, finished = false;
const evaluate = text => win.webContents.executeJavaScript(text, true);
const snapshot = () => evaluate(`(() => ({
  selection: wallpaperEngineSelection,
  scene: typeof wallpaperSceneSession === 'undefined' || !wallpaperSceneSession ? null : {
    ready: wallpaperSceneSession.ready, composited: wallpaperSceneSession.composited,
    sessionId: wallpaperSceneSession.sessionId, mountMs: wallpaperSceneSession.mountMs,
    quality: wallpaperSceneSession.quality, visible: wallpaperSceneSession.visible
  }, active: document.body.classList.contains('wallpaper-engine-active'),
  externalSession: wallpaperEngineNativeSessionId, error: wallpaperEngineRuntimeError,
  marks: appPerfMarks, qa: window.__sceneAcceptance,
  visible: !document.hidden, viewport: [innerWidth, innerHeight, devicePixelRatio]
}))()`);
function sceneFrame() { return win.webContents.mainFrame.framesInSubtree.find(frame => /\/wallpaper-scene\.html/.test(frame.url)); }
async function waitReady(id, timeout = 16000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await snapshot();
    if (state.selection.id === id && state.active && (variant === 'external' ? state.externalSession : state.scene && state.scene.composited)) return state;
    if (state.selection.kind === 'preview' || state.error) throw new Error(state.error || 'Scene fell back to preview');
    await wait(100);
  }
  throw new Error('Scene readiness timeout');
}
async function choose(id) { await evaluate(`activateWallpaperEngineItem(${JSON.stringify(id)}); void 0;`); return waitReady(id, variant === 'external' ? 50000 : 16000); }
async function frameInfo() {
  const frame = sceneFrame();
  assert(frame, 'Scene frame missing');
  return frame.executeJavaScript(`(() => { const instance = window.__sceneAcceptanceInstance; const canvas = document.querySelector('canvas'); return {
    canvas: canvas && [canvas.width, canvas.height], dpr: devicePixelRatio,
    stats: instance && instance.stats, quality: instance && instance.getQuality()
  }; })()`);
}
async function finish(error) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  if (error) { result.ok = false; result.error = String(error.stack || error); }
  result.finishedAt = Date.now();
  result.activeResourcesBeforeExit = activeResources.size;
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, label + '.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ suite, variant, ok: result.ok, cases: result.cases.length, failed: result.cases.filter(x => !x.ok).length, error: result.error }));
  if (server) server.close();
  app.once('will-quit', () => {
    result.activeResourcesAfterExit = activeResources.size;
    if (activeResources.size) { result.ok = false; result.error = result.error || 'Scene resources leaked on exit'; }
    fs.writeFileSync(path.join(output, label + '.json'), JSON.stringify(result, null, 2));
    app.exit(result.ok ? 0 : 1);
  });
  app.quit();
}
async function security() {
  const frame = sceneFrame();
  const before = result.networkAttempts;
  result.lifecycle.sandbox = await frame.executeJavaScript(`(async () => {
    let parentDenied = false, storageDenied = false, networkDenied = false;
    try { parent.document.body; } catch (_) { parentDenied = true; }
    try { localStorage.getItem('test'); } catch (_) { storageDenied = true; }
    try { await fetch(location.origin + '/__scene_denied_fetch__'); } catch (_) { networkDenied = true; }
    return { parentDenied, storageDenied, networkDenied, nodeAbsent: typeof require === 'undefined', bridgeAbsent: typeof desktopWindow === 'undefined' };
  })()`);
  assert(Object.values(result.lifecycle.sandbox).every(Boolean), 'Sandbox isolation failed');
  const oldUrl = frame.url;
  await frame.executeJavaScript(`location.href = ${JSON.stringify('http://127.0.0.1:' + new URL(win.webContents.getURL()).port + '/__scene_denied_navigation__')}; void 0;`);
  await wait(300);
  assert.equal(frame.url, oldUrl, 'Scene navigation was allowed');
  assert.equal(result.networkAttempts, before, 'Scene sent an unauthorized request');
  const denied = await evaluate(`desktopWindow.wallpaperSceneResources({ action: 'read', sessionId: wallpaperSceneSession.sessionId, namespace: 'project', path: '../.cookie' })`);
  assert.equal(denied.ok, false);
  result.lifecycle.navigationDenied = true;
  result.lifecycle.pathDenied = true;
}
async function lifecycle(item) {
  await choose(item.id);
  await security();
  await evaluate(`fx.foregroundFpsMode='45'; syncWallpaperEngineCaptureFrameRate(); void 0;`);
  await wait(1800);
  result.lifecycle.fps45 = await frameInfo();
  assert(result.lifecycle.fps45.stats.fps >= 35 && result.lifecycle.fps45.stats.fps <= 50, 'FPS update was lost');
  win.webContents.setZoomFactor(1.25);
  await wait(1800);
  result.lifecycle.scaled = await frameInfo();
  assert(result.lifecycle.scaled.dpr > 1 && result.lifecycle.scaled.canvas[0] >= 1800, 'DPR update was lost');
  win.webContents.setZoomFactor(1);
  await wait(800);
  const identity = (await snapshot()).scene.sessionId;
  win.minimize(); await wait(800);
  result.lifecycle.minimized = await frameInfo();
  assert.equal(result.lifecycle.minimized.stats.running, false);
  win.restore(); await wait(1200);
  assert.equal((await snapshot()).scene.sessionId, identity);
  result.lifecycle.sameSessionAfterRestore = true;
  win.setFullScreen(true); await wait(900);
  assert((await frameInfo()).stats.running);
  win.setFullScreen(false); await wait(900);
  result.lifecycle.fullscreen = true;
  const cycles = Number(option('cycles', 20));
  for (let i = 0; i < cycles; i++) { await choose(item.id); assert.equal(activeResources.size, 1); }
  result.lifecycle.switches = cycles;
  await evaluate('deactivateWallpaperEngineBackground(true); void 0;');
  await wait(300); assert.equal(activeResources.size, 0);
  win.minimize(); await wait(400);
  await evaluate(`activateWallpaperEngineItem(${JSON.stringify(item.id)}); void 0;`);
  await wait(11000);
  assert.equal(result.nativeStarts, 0, 'Hidden startup triggered external fallback');
  win.restore(); await waitReady(item.id);
  result.lifecycle.hiddenStartup = true;
  await evaluate('deactivateWallpaperEngineBackground(true); void 0;');
  assert.equal(activeResources.size, 0);
  await evaluate(`activateWallpaperEngineItem(${JSON.stringify(item.id)}); void 0;`);
  await wait(50);
  await evaluate('deactivateWallpaperEngineBackground(true); void 0;');
  await wait(1000);
  assert.equal(activeResources.size, 0, 'Cancelled startup retained resources');
  result.lifecycle.cancelledStartup = true;
}
async function run(items) {
  if (suite === 'benchmark') {
    const ready = await waitReady(items[0].id, variant === 'external' ? 55000 : 20000);
    result.startup = ready;
    result.ok = true; return finish();
  }
  await wait(6500);
  await evaluate(`document.getElementById('splash')?.click(); void 0;`);
  await wait(1800);
  await evaluate('loadWallpaperEngineLibrary(false, false)');
  if (suite === 'library') {
    for (let i = 0; i < items.length; i++) {
      const item = items[i], logStart = result.logs.length;
      const row = { index: i + 1, id: item.id, ok: false };
      try {
        row.ready = await choose(item.id);
        await wait(1600);
        if (variant !== 'external') {
          row.frame = await frameInfo();
          assert(row.frame.canvas[0] >= 640 && row.frame.canvas[1] >= 360);
          const png = await sceneFrame().executeJavaScript(`document.querySelector('canvas').toDataURL('image/png')`);
          fs.writeFileSync(path.join(output, label + '-scene-' + row.index + '.png'), Buffer.from(png.split(',')[1], 'base64'));
        }
        assert(!result.logs.slice(logStart).some(log => /\[Embedded Scene\] (warn|error)/.test(log)), 'Scene emitted a compatibility warning');
        row.ok = true;
      } catch (error) { row.error = String(error.message); }
      row.logs = result.logs.slice(logStart);
      result.cases.push(row);
      console.log(JSON.stringify({ case: row.index, ok: row.ok, error: row.error }));
    }
    result.ok = result.cases.every(x => x.ok);
  } else if (suite === 'lifecycle') {
    await lifecycle(items[0]); result.ok = true;
  } else if (suite === 'fallback') {
    let failed = false;
    try { await choose(items[0].id); } catch (_) { failed = true; }
    assert(failed, 'Missing stock assets were accepted as native success');
    await wait(400);
    assert.equal(result.nativeStarts, 1, 'Fallback must run exactly once');
    assert.equal(activeResources.size, 0);
    result.lifecycle.missingAssetsFallback = true;
    result.ok = true;
  } else if (suite === 'soak') {
    await choose(items[0].id);
    // Keep this stress test drawing even while another acceptance window covers it.
    win.webContents.setBackgroundThrottling(false);
    const duration = Number(option('minutes', 30)) * 60000;
    const end = Date.now() + duration;
    while (Date.now() < end) {
      await wait(10000);
      win.webContents.setBackgroundThrottling(false);
      const state = await snapshot();
      assert(state.scene && state.scene.composited && !state.error);
      result.resources.push({ at: Date.now(), metrics: app.getAppMetrics(), frame: await frameInfo(), activeResources: activeResources.size });
      fs.writeFileSync(path.join(output, label + '-progress.json'), JSON.stringify({ elapsedMs: duration - (end - Date.now()), remainingMs: Math.max(0, end - Date.now()), samples: result.resources.length, last: result.resources.at(-1) }));
      if (result.resources.length % 6 === 0) console.log('soak minutes: ' + Math.round(result.resources.length / 6));
    }
    result.soakDurationMs = duration;
    result.renderingSamples = result.resources.filter(sample => sample.frame.stats.running && sample.frame.stats.fps > 20).length;
    assert(result.renderingSamples >= result.resources.length * 0.9, 'Soak did not continuously render');
    result.ok = true;
  } else throw new Error('Unknown suite');
  await evaluate('deactivateWallpaperEngineBackground(true); void 0;');
  await wait(500);
  assert.equal(activeResources.size, 0, 'Scene resources leaked after stop');
  await finish();
}
app.on('browser-window-created', (_event, window) => {
  if (win) return;
  win = window;
  win.setSize(1920, 1080);
  win.webContents.on('console-message', event => { if (result.logs.length < 5000) result.logs.push(String(event.message)); });
  win.webContents.on('did-finish-load', () => {
    if (!/^http:\/\/127\.0\.0\.1/.test(win.webContents.getURL()) || result.navigated) return;
    result.navigated = true;
    run(result.items).catch(finish);
  });
});
(async () => {
  const catalog = JSON.parse(fs.readFileSync(option('catalog', path.join(output, 'catalog.private.json')), 'utf8'));
  const ids = option('ids', '').split(',').filter(Boolean);
  const items = catalog.filter(item => !ids.length || ids.includes(item.id));
  assert(items.length, 'No playable Scene projects found');
  result.items = items.map(item => ({ id: item.id, title: item.title }));
  if (suite !== 'library') result.items = result.items.slice(0, 1);
  const restore = suite === 'benchmark' ? `localStorage.setItem('mineradio-wallpaper-engine-selection-v1', ${JSON.stringify(JSON.stringify({ version: 1, active: true, id: result.items[0].id, kind: 'engine', projectType: 'scene', mediaType: 'video', visualOpacity: 1, visualScale: 1.08 }))});` : '';
  const seed = restore + `localStorage.removeItem('mineradio-startup-fast-skip-v1'); window.__sceneAcceptance={origin:performance.timeOrigin,layerMs:null,glassMs:null,longtasks:[]};new PerformanceObserver(list=>list.getEntries().forEach(e=>__sceneAcceptance.longtasks.push({at:e.startTime,duration:e.duration}))).observe({type:'longtask',buffered:true});document.addEventListener('DOMContentLoaded',()=>{const check=()=>{const q=__sceneAcceptance;if(q.layerMs===null&&document.body.classList.contains('wallpaper-engine-active'))q.layerMs=performance.now();if(q.glassMs===null&&document.body.classList.contains('wallpaper-engine-glass-sampler-ready'))q.glassMs=performance.now();};new MutationObserver(check).observe(document.body,{attributes:true,attributeFilter:['class']});check();});\n`;
  server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Content-Type', 'application/javascript');
    if (request.url === '/wallpaper-scene-host.js') response.end(fs.readFileSync(path.join(appRoot, 'public/wallpaper-scene-host.js'), 'utf8').replace('mounted = true;', 'globalThis.__sceneAcceptanceInstance = instance; mounted = true;'));
    else response.end(seed + fs.readFileSync(path.join(appRoot, 'public/js/preload-mode.js'), 'utf8'));
  });
  server.listen(0, '127.0.0.1', () => {
    app.whenReady().then(() => {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://127.0.0.1/*'] }, (details, callback) => {
        const url = new URL(details.url);
        if (url.pathname.startsWith('/__scene_denied')) result.networkAttempts++;
        if (Number(url.port) === server.address().port) return callback({});
        if (url.pathname === '/js/preload-mode.js') callback({ redirectURL: `http://127.0.0.1:${server.address().port}/seed.js` });
        else if (url.pathname === '/wallpaper-scene-host.js') callback({ redirectURL: `http://127.0.0.1:${server.address().port}/wallpaper-scene-host.js` });
        else callback({});
      });
      timer = setTimeout(() => finish(new Error('Acceptance suite timed out')), suite === 'soak' ? (Number(option('minutes', 30)) + 2) * 60000 : 12 * 60000);
    });
    require(path.join(appRoot, 'desktop/main.js'));
  });
})().catch(finish);
