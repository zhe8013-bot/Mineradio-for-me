'use strict';
(() => {
  const nonce = new URLSearchParams(location.search).get('nonce');
  let port, instance, requestId = 0, disposed = false, mounted = false;
  const pending = new Map();
  let bands = new Array(64).fill(0);
  const send = data => port && port.postMessage(data);
  const read = (namespace, path) => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    send({ type: 'read', requestId: id, namespace, path });
  });
  addEventListener('message', async function connect(event) {
    if (event.source !== parent || !event.data || event.data.nonce !== nonce || !event.ports[0] || port) return;
    port = event.ports[0];
    removeEventListener('message', connect);
    const config = event.data.config;
    let visible = config.visible !== false;
    let fps = config.fps, dpr = config.dpr;
    function applyRendering() {
      if (!mounted || !instance || disposed) return;
      instance.setFps(fps);
      if (dpr !== config.dpr) { config.dpr = dpr; instance.setRenderDpr(dpr); }
    }
    port.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'response') {
        const task = pending.get(data.requestId);
        if (!task) return;
        pending.delete(data.requestId);
        if (data.error) task.reject(new Error(data.error)); else task.resolve(data.bytes);
      } else if (data.type === 'audio' && Array.isArray(data.bands) && data.bands.length === 64) bands = data.bands;
      else if (data.type === 'pointer') instance && instance.pushPointer(data.u, data.v, data.buttons || 0);
      else if (data.type === 'visibility') {
        visible = data.visible === true;
        if (mounted && instance) { if (visible) instance.resume(); else instance.pause(); }
      } else if (data.type === 'render') {
        if (Number.isFinite(data.fps) && data.fps >= 24 && data.fps <= 240) fps = data.fps;
        if (Number.isFinite(data.dpr) && data.dpr >= 0.25 && data.dpr <= 8) dpr = data.dpr;
        applyRendering();
      }
      else if (data.type === 'destroy') {
        disposed = true;
        instance && instance.destroy({ releasePkgCache: true });
        for (const task of pending.values()) task.reject(new Error('SCENE_CANCELLED'));
        pending.clear(); port.close();
      }
    };
    port.start();
    const reportVisibility = () => send({ type: 'frame-visibility', visible: !document.hidden });
    document.addEventListener('visibilitychange', reportVisibility);
    reportVisibility();
    globalThis.__mineradioAssetFetch = async url => {
      if (url === '/api/local-assets') return new Response(JSON.stringify({ ok: config.hasBuiltins, roots: [{ id: 'local' }] }));
      if (url === '/api/local-assets/local/materials/index.json') return new Response(JSON.stringify({ names: config.builtinNames }));
      const prefix = '/api/local-assets/local/';
      if (!url.startsWith(prefix)) throw new Error('SCENE_ASSET_DENIED');
      const bytes = await read('builtin', url.slice(prefix.length).split('/').map(decodeURIComponent).join('/'));
      return new Response(bytes, { status: bytes ? 200 : 404 });
    };
    try {
      const source = {
        key: config.key,
        project: async () => config.project,
        scenePkg: async () => { const bytes = await read('project', config.packagePath); if (!bytes) throw new Error('SCENE_PACKAGE_MISSING'); return bytes; }
      };
      const started = performance.now();
      instance = await WebWallGL.mount(document.body, { source, autoQuality: false, bake: false,
        renderDpr: config.dpr, videoTexScale: 1, volume: 0, fps: config.fps,
        quality: { particles: 'high', postProcessing: 'high', antiAliasing: 'off' },
        audio: { snapshot: () => ({ left: bands, right: bands }) }, media: null, mountTimeoutMs: 0,
        onDiagnostic: (message, level) => send({ type: 'diagnostic', message, level }),
        onError: error => send({ type: 'error', message: error.message }) });
      if (disposed) { instance.destroy({ releasePkgCache: true }); return; }
      mounted = true;
      applyRendering();
      if (!visible) instance.pause();
      send({ type: 'ready', mountMs: performance.now() - started, info: instance.info, quality: instance.getQuality() });
    } catch (error) {
      if (error.instance) error.instance.destroy({ releasePkgCache: true });
      if (!disposed) send({ type: 'error', message: error.message });
    }
  });
  parent.postMessage({ type: 'mineradio-scene-host', nonce }, '*');
})();
