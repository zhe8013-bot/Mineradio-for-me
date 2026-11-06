'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

function harness(options = {}) {
  const { AppUpdater } = require('../desktop/app-updater');
  const updater = new EventEmitter();
  const feeds = [];
  const transports = [];
  let transport = async () => 'cached-setup.exe';
  let downloads = 0;
  let installs = 0;
  updater.setFeedURL = value => feeds.push(value);
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '2.2.4', files: [{ url: 'Mineradio-2.2.4-Setup.exe', sha512: 'A'.repeat(86) + '==' }] } });
  updater.httpExecutor = { download: async (url, destination, options) => {
    transports.push({ url: String(url), options });
    return transport(url, destination, options);
  } };
  updater.downloadUpdate = async () => {
    downloads++;
    await updater.httpExecutor.download(new URL('https://github.com/zhe8013-bot/Mineradio-for-me/releases/latest/download/Mineradio-2.2.4-Setup.exe'), 'cached-setup.exe', { sha512: 'official-sha512' });
    updater.emit('download-progress', { percent: 42.5 });
    return ['cached-setup.exe'];
  };
  updater.quitAndInstall = (silent, restart) => { assert.equal(silent, true); assert.equal(restart, true); installs++; };
  const states = [];
  const controller = new AppUpdater({
    updater,
    config: { provider: 'github', owner: 'zhe8013-bot', repo: 'Mineradio-for-me', mirrors: ['https://mirror.example/'] },
    onState: state => states.push(state),
    ...options,
  });
  return { controller, updater, feeds, transports, states, setTransport: value => { transport = value; }, downloads: () => downloads, installs: () => installs };
}

test('explicit download uses configured feeds, reports progress and waits for install confirmation', async () => {
  const h = harness();
  assert.equal(h.updater.autoDownload, false);
  assert.equal(h.updater.autoInstallOnAppQuit, false);
  assert.equal(h.updater.allowDowngrade, false);
  assert.equal(h.updater.disableWebInstaller, true);
  assert.equal(h.controller.prepareInstall().ok, false);
  const result = await h.controller.download();
  assert.equal(result.ok, true);
  assert.equal(h.downloads(), 1);
  assert.equal(h.installs(), 0);
  assert.equal(h.controller.getState().status, 'ready');
  assert.equal(h.controller.getState().version, '2.2.4');
  assert(h.states.some(state => state.percent === 42.5));
  assert.equal(h.feeds[0].url, 'https://github.com/zhe8013-bot/Mineradio-for-me/releases/latest/download/');
  assert.match(h.transports[0].url, /^https:\/\/mirror\.example\//);
  assert.equal(h.transports[0].options.sha512, 'official-sha512');
  assert.equal(h.controller.prepareInstall().ok, true);
  assert.equal(h.installs(), 0, 'installer must wait for main-process shutdown cleanup');
  h.controller.install();
  assert.equal(h.installs(), 1);
});

test('repeated download and install actions do not start duplicate jobs', async () => {
  const h = harness();
  const results = await Promise.all([h.controller.download(), h.controller.download()]);
  assert(results.every(result => result.ok));
  await h.controller.download();
  assert.equal(h.downloads(), 1);
  assert.equal(h.controller.prepareInstall().ok, true);
  assert.equal(h.controller.prepareInstall().ok, false);
  h.controller.install();
  h.controller.install();
  assert.equal(h.installs(), 1);
});

test('installer launch failure permits a fresh explicit retry', async () => {
  const h = harness();
  await h.controller.download();
  h.controller.prepareInstall();
  h.updater.quitAndInstall = () => h.updater.emit('error', new Error('installer launch failed'));
  h.controller.install();
  assert.equal(h.controller.getState().status, 'error');
  await h.controller.download();
  assert.equal(h.controller.prepareInstall().ok, true);
  let restarted = false;
  h.updater.quitAndInstall = () => { restarted = true; };
  h.controller.install();
  assert.equal(restarted, true);
});

test('a failed mirror falls back to official installer transport without replacing official metadata', async () => {
  const h = harness();
  let attempts = 0;
  h.setTransport(async () => {
    if (++attempts === 1) throw new Error('connection reset');
    return ['cached-setup.exe'];
  });
  assert.equal((await h.controller.download()).ok, true);
  assert.equal(h.feeds.length, 1);
  assert.equal(h.transports.length, 2);
  assert.match(h.transports[1].url, /^https:\/\/github\.com\//);
  assert(h.transports.every(value => value.options.sha512 === 'official-sha512'));
});

test('checksum failure never enables install and the user can retry', async () => {
  const h = harness();
  h.updater.downloadUpdate = async () => { throw new Error('SHA512 checksum mismatch'); };
  assert.equal((await h.controller.download()).ok, false);
  assert.equal(h.controller.getState().status, 'error');
  assert.equal(h.controller.prepareInstall().ok, false);
  h.controller.install();
  assert.equal(h.installs(), 0);
  h.updater.downloadUpdate = async () => ['valid-cached-setup.exe'];
  assert.equal((await h.controller.download()).ok, true);
  assert.equal(h.controller.getState().status, 'ready');
});

test('an official feed without a newer release does not download any installer', async () => {
  const h = harness();
  h.updater.checkForUpdates = async () => ({ isUpdateAvailable: false, updateInfo: { version: '2.2.1' } });
  assert.equal((await h.controller.download()).ok, false);
  assert.equal(h.downloads(), 0);
  assert.equal(h.transports.length, 0);
  assert.equal(h.feeds.length, 1);
});

test('a mirror checksum mismatch falls back without accepting a replacement hash', async () => {
  const h = harness();
  h.setTransport(async url => {
    if (url.hostname === 'mirror.example') throw new Error('SHA512 checksum mismatch');
    return 'verified-setup.exe';
  });
  assert.equal((await h.controller.download()).ok, true);
  assert.equal(h.transports.length, 2);
  assert.equal(h.transports[0].options, h.transports[1].options);
});

test('metadata without an official SHA-512 never starts a download', async () => {
  const h = harness();
  h.updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '2.2.4', files: [{ url: 'setup.exe', sha2: 'unrelated-hash' }] } });
  assert.equal((await h.controller.download()).ok, false);
  assert.equal(h.downloads(), 0);
  assert.equal(h.controller.prepareInstall().ok, false);
});

test('development and invalid repository configurations cannot download or install', async () => {
  for (const options of [{ updater: null }, { config: { provider: 'github', owner: '../other', repo: 'repo' } }, { config: { provider: 'github', owner: 'owner', repo: 'repo', disabled: true } }]) {
    const h = harness(options);
    assert.equal(h.controller.getState().supported, false);
    assert.equal((await h.controller.download()).ok, false);
    assert.equal(h.controller.prepareInstall().ok, false);
    assert.equal(h.feeds.length, 0);
  }
});

test('download and install IPC accept only the trusted main window and no renderer-supplied paths', () => {
  const main = fs.readFileSync(path.join(__dirname, '../desktop/main.js'), 'utf8');
  for (const channel of ['mineradio-update-state', 'mineradio-update-download', 'mineradio-update-install']) {
    const start = main.indexOf("ipcMain.handle('" + channel + "'");
    assert(start >= 0, 'missing ' + channel);
    const handler = main.slice(start, main.indexOf('\n});', start));
    assert.match(handler, /isTrustedMainWindowIpc\(event\)/);
    assert.match(handler, /async \(event\) =>/);
  }
  assert.match(main, /flushMainWindowFxAutosave\('update-install'\)/);
  assert.match(main, /appQuitCleanupComplete = true;[\s\S]*?appUpdater\.install\(\)/);
});
