var wallpaperSceneSession = null;
var wallpaperSceneInputFrame = 0;
var startWallpaperSceneInput = function () {};

function stopWallpaperScene() {
  var current = wallpaperSceneSession;
  wallpaperSceneSession = null;
  cancelAnimationFrame(wallpaperSceneInputFrame);
  document.body.classList.remove('wallpaper-scene-active');
  var layer = document.getElementById('wallpaper-engine-layer');
  if (layer) layer.classList.remove('scene-preparing');
  if (!current) return;
  current.cancel();
  if (current.port) { try { current.port.postMessage({ type: 'destroy' }); } catch (_) {} }
  current.frame.remove();
  current.port && current.port.close();
  if (current.sessionId) window.desktopWindow.wallpaperSceneResources({ action: 'close', sessionId: current.sessionId }).catch(function () {});
}

async function startWallpaperScene(item, token) {
  stopWallpaperScene();
  if (Math.max(innerWidth, innerHeight) * (devicePixelRatio || 1) > 4096) throw new Error('SCENE_OUTPUT_SIZE_UNSUPPORTED');
  var api = window.desktopWindow;
  var nonce = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
  var frame = document.createElement('iframe');
  frame.id = 'wallpaper-scene-frame';
  frame.name = 'mineradio-scene';
  frame.sandbox = 'allow-scripts';
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  var current = { frame: frame, sessionId: '', port: null, ready: false, composited: false,
    visible: typeof desktopRuntimeState === 'undefined' || (!desktopRuntimeState.minimized && desktopRuntimeState.visible !== false), cancel: function () {} };
  wallpaperSceneSession = current;
  startWallpaperSceneInput();
  function valid() { return wallpaperSceneSession === current && token === wallpaperEngineLayerToken && wallpaperEngineSelection.active && wallpaperEngineSelection.id === item.id; }
  var result = await api.wallpaperSceneResources({ action: 'open', id: item.id });
  if (!result.ok) { if (valid()) stopWallpaperScene(); throw new Error(result.error); }
  current.sessionId = result.sessionId;
  if (!valid()) { await api.wallpaperSceneResources({ action: 'close', sessionId: result.sessionId }); throw new Error('WALLPAPER_ENGINE_START_SUPERSEDED'); }
  var index = await api.wallpaperSceneResources({ action: 'index', sessionId: result.sessionId });
  if (!index.ok) { if (valid()) stopWallpaperScene(); throw new Error(index.error); }
  if (!valid()) throw new Error('WALLPAPER_ENGINE_START_SUPERSEDED');
  current.displayFps = result.displayFps;
  var config = Object.assign({}, result, { builtinNames: index.names, visible: current.visible, dpr: window.devicePixelRatio || 1, fps: wallpaperSceneTargetFps(current) });
  await new Promise(function (resolve, reject) {
    var queue = [], running = 0;
    var lastTick = Date.now(), visibleMs = 0;
    function visibilityChanged() { lastTick = Date.now(); }
    document.addEventListener('visibilitychange', visibilityChanged);
    var timer = setInterval(function () {
      var now = Date.now();
      if (current.visible && !document.hidden && current.frameVisible !== false) visibleMs += now - lastTick;
      lastTick = now;
      if (visibleMs >= 10000) fail(new Error('SCENE_FIRST_FRAME_TIMEOUT'));
    }, 250);
    function finish() { clearInterval(timer); document.removeEventListener('visibilitychange', visibilityChanged); window.removeEventListener('message', connect); }
    current.cancel = function () { finish(); reject(new Error('WALLPAPER_ENGINE_START_SUPERSEDED')); };
    function fail(error) {
      if (current.failed || !valid()) return;
      current.failed = true;
      finish();
      if (!current.composited) reject(error);
      else if (valid()) {
        stopWallpaperScene();
        startWallpaperEngineExternalBackground(item, token).catch(function (e) {
          if (token !== wallpaperEngineLayerToken) return;
          wallpaperEngineRuntimeError = wallpaperEngineRuntimeErrorText(e);
          wallpaperEngineLayerFailed(item, 'engine', token);
        });
      }
    }
    current.fail = fail;
    function pump() {
      while (valid() && running < 4 && queue.length) {
        var request = queue.shift();
        running++;
        (function (request) {
          api.wallpaperSceneResources({ action: 'read', sessionId: current.sessionId, namespace: request.namespace, path: request.path }).then(function (response) {
            if (!valid()) return;
            if (current.failed) return;
            var bytes = response.bytes ? new Uint8Array(response.bytes).buffer : null;
            current.port.postMessage({ type: 'response', requestId: request.requestId, error: response.error, bytes: bytes }, bytes ? [bytes] : []);
          }).catch(function (error) { if (valid()) fail(error); }).finally(function () { running--; pump(); });
        })(request);
      }
    }
    function connect(event) {
      if (!valid() || event.source !== frame.contentWindow || !event.data || event.data.type !== 'mineradio-scene-host' || event.data.nonce !== nonce || current.port) return;
      var channel = new MessageChannel();
      current.port = channel.port1;
      current.port.onmessage = function (event) {
        if (!valid()) return;
        var message = event.data || {};
        if (message.type === 'frame-visibility') {
          current.frameVisible = message.visible === true;
          lastTick = Date.now();
        } else if (message.type === 'read') {
          if (queue.length >= 128) { fail(new Error('SCENE_REQUEST_LIMIT')); return; }
          queue.push(message); pump();
        } else if (message.type === 'diagnostic') {
          console.debug('[Embedded Scene]', message.level, String(message.message).slice(0, 1200));
          if (message.level === 'warn' || message.level === 'error') fail(new Error('SCENE_COMPATIBILITY: ' + String(message.message).slice(0, 300)));
        } else if (message.type === 'error') fail(new Error(message.message));
        else if (message.type === 'ready' && !current.ready) {
          current.ready = true;
          current.mountMs = message.mountMs;
          current.quality = message.quality;
          finish();
          requestAnimationFrame(function () { requestAnimationFrame(function () {
            if (!valid() || current.failed) return;
            wallpaperEngineLayerReady('scene', token);
            document.getElementById('wallpaper-engine-layer').classList.remove('scene-preparing');
            document.body.classList.add('wallpaper-scene-active');
            current.composited = true;
            if (typeof markAppPerf === 'function') markAppPerf('wallpaper-scene-composited');
            resolve();
          }); });
        }
      };
      current.port.start();
      frame.contentWindow.postMessage({ nonce: nonce, config: config }, '*', [channel.port2]);
    }
    window.addEventListener('message', connect);
    frame.src = 'wallpaper-scene.html?resources=native&localAssets=1&nonce=' + encodeURIComponent(nonce);
    var layer = document.getElementById('wallpaper-engine-layer');
    layer.classList.add('scene-preparing');
    layer.appendChild(frame);
  });
}

function wallpaperSceneTargetFps(current) {
  var requested = wallpaperEngineCaptureFpsPreference();
  var display = current.displayFps || wallpaperEngineResolvedCaptureFps(0);
  return Math.min(display, requested > 0 ? requested : display);
}

function syncWallpaperSceneRendering(refreshDisplay) {
  var current = wallpaperSceneSession;
  if (!current || !current.port) return;
  function send() {
    if (current !== wallpaperSceneSession) return;
    var dpr = window.devicePixelRatio || 1;
    if (Math.max(innerWidth, innerHeight) * dpr > 4096) { current.fail(new Error('SCENE_OUTPUT_SIZE_UNSUPPORTED')); return; }
    current.port.postMessage({ type: 'render', fps: wallpaperSceneTargetFps(current), dpr: dpr });
  }
  if (!refreshDisplay) { send(); return; }
  window.desktopWindow.wallpaperSceneResources({ action: 'display' }).then(function (result) {
    if (result.ok) current.displayFps = result.displayFps;
    send();
  }).catch(function () {});
}

(function bindWallpaperSceneInput() {
  var point = null;
  document.addEventListener('pointermove', function (event) { point = { x: event.clientX, y: event.clientY }; }, { passive: true });
  var visible = true;
  if (window.desktopWindow && window.desktopWindow.onStateChange) window.desktopWindow.onStateChange(function (state) {
    visible = state.isVisible !== false && !state.isMinimized;
    if (wallpaperSceneSession) {
      wallpaperSceneSession.visible = visible;
      if (wallpaperSceneSession.port) wallpaperSceneSession.port.postMessage({ type: 'visibility', visible: visible });
      syncWallpaperSceneRendering(true);
    }
  });
  var last = 0;
  function update(now) {
    var current = wallpaperSceneSession;
    if (visible && current && current.ready && current.port && now - last >= 30) {
      last = now;
      var raw = typeof frequencyData !== 'undefined' ? frequencyData : null;
      var playing = typeof audio !== 'undefined' && audio && !audio.paused;
      var bands = Array.from({ length: 64 }, function (_, i) { return playing && raw && raw.length ? Math.max(0, Math.min(1, Number(raw[Math.floor(i * raw.length / 64)]) / 255 || 0)) : 0; });
      current.port.postMessage({ type: 'audio', bands: bands });
      if (point) {
        var settings = wallpaperEngineVisualSettings();
        current.port.postMessage({ type: 'pointer', u: (point.x / innerWidth - 0.5 - settings.positionX) / settings.scale + 0.5, v: (point.y / innerHeight - 0.5 - settings.positionY) / settings.scale + 0.5 });
      }
    }
    if (wallpaperSceneSession) wallpaperSceneInputFrame = requestAnimationFrame(update);
  }
  startWallpaperSceneInput = function () { wallpaperSceneInputFrame = requestAnimationFrame(update); };
  window.addEventListener('resize', function () { syncWallpaperSceneRendering(true); });
  window.addEventListener('pagehide', stopWallpaperScene);
})();
