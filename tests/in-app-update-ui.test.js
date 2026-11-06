'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/modules/08-account/00-update-preview.js'), 'utf8');

function harness() {
  const nodes = Object.fromEntries(['update-btn-label', 'update-primary-btn', 'update-footnote', 'update-btn-fill', 'update-progress-ring'].map(id => [id, { textContent: '', style: {} }]));
  let downloads = 0, installs = 0, external = 0, listener;
  const desktop = {
    getUpdateState: async () => ({ supported: true, status: 'idle', percent: 0 }),
    onUpdateState: callback => { listener = callback; return () => {}; },
    downloadUpdate: async () => { downloads++; return { ok: true, supported: true, status: 'ready', percent: 100, version: '2.2.4' }; },
    installUpdate: async () => { installs++; return { ok: true }; },
    openUpdatePage: async () => { external++; return { ok: true }; },
  };
  const context = vm.createContext({
    URL, Number, Array, String, setTimeout: () => 1,
    window: { desktopWindow: desktop },
    document: { getElementById: id => nodes[id] || null, querySelector: () => null, querySelectorAll: () => [] },
    updatePreviewState: { updateAvailable: true, version: '2.2.4', releaseUrl: 'https://github.com/zhe8013-bot/Mineradio-for-me/releases/tag/v2.2.4', selectedDownloadPageIndex: 0 },
    apiJson: async () => ({ updateAvailable: true, latestVersion: '2.2.4', release: {} }),
    showToast() {}, escHtml: text => String(text),
  });
  vm.runInContext(source, context);
  return { context, desktop, nodes, emit: state => listener(state), downloads: () => downloads, installs: () => installs, external: () => external };
}

test('desktop update downloads inside the app and requires a separate restart action', async () => {
  const h = harness();
  await h.context.initDesktopUpdater();
  h.context.syncUpdatePreviewStateClass();
  assert.equal(h.nodes['update-btn-label'].textContent, '下载更新');
  await h.context.startUpdatePreviewDownload();
  assert.equal(h.downloads(), 1);
  assert.equal(h.external(), 0);
  assert.equal(h.installs(), 0);
  assert.equal(h.nodes['update-btn-label'].textContent, '重启并安装');
  await h.context.startUpdatePreviewDownload();
  assert.equal(h.installs(), 1);
});

test('progress survives closing or refreshing release information and duplicate clicks are ignored', async () => {
  const h = harness();
  await h.context.initDesktopUpdater();
  h.emit({ supported: true, status: 'downloading', percent: 37.5, version: '2.2.4' });
  h.context.applyLatestUpdateInfo({ updateAvailable: true, latestVersion: '2.2.4', release: {} });
  assert.equal(h.nodes['update-btn-fill'].style.width, '37.5%');
  assert.equal(h.nodes['update-primary-btn'].disabled, true);
  await h.context.startUpdatePreviewDownload();
  assert.equal(h.downloads(), 0);
  h.emit({ supported: true, status: 'ready', percent: 100, version: '2.2.4' });
  assert.equal(h.nodes['update-primary-btn'].disabled, false);
});

test('download failure displays a retry and never automatically opens the browser', async () => {
  const h = harness();
  await h.context.initDesktopUpdater();
  h.desktop.downloadUpdate = async () => ({ ok: false, supported: true, status: 'error', error: '网络不可用', percent: 0 });
  await h.context.startUpdatePreviewDownload();
  assert.equal(h.nodes['update-btn-label'].textContent, '重试下载');
  assert.match(h.nodes['update-footnote'].textContent, /网络不可用/);
  assert.equal(h.external(), 0);
  assert.equal(h.installs(), 0);
});

test('a ready installer remains reachable when a later release check reports no update', async () => {
  const h = harness();
  await h.context.initDesktopUpdater();
  h.emit({ supported: true, status: 'ready', percent: 100, version: '2.2.4' });
  h.context.applyLatestUpdateInfo({ updateAvailable: false, latestVersion: '2.2.3', release: {} });
  assert.equal(h.context.updatePreviewState.visible, true);
  assert.equal(h.context.updatePreviewState.version, '2.2.4');
  assert.equal(h.nodes['update-primary-btn'].disabled, false);
});
