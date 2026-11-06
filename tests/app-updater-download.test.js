'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { NsisUpdater } = require('electron-updater');
const { NodeHttpExecutor } = require('builder-util/out/nodeHttpExecutor');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const { AppUpdater } = require('../desktop/app-updater');

for (const scenario of ['valid', 'corrupt', 'mirror-corrupt']) {
  test('real NSIS download: ' + scenario, async t => {
    const parent = path.resolve(__dirname, '../tmp');
    fs.mkdirSync(parent, { recursive: true });
    const dir = fs.mkdtempSync(path.join(parent, 'update-test-'));
    t.after(() => {
      assert.equal(path.dirname(dir), parent);
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const installer = Buffer.alloc(128 * 1024, 42);
    const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
    const transportHosts = [];
    const server = http.createServer((req, res) => {
      if (req.url.split('?')[0].endsWith('/latest.yml')) {
        res.end(`version: 2.2.4\nfiles:\n  - url: Mineradio-2.2.4-Setup.exe\n    sha512: ${sha512}\n    size: ${installer.length}\npath: Mineradio-2.2.4-Setup.exe\nsha512: ${sha512}\n`);
      } else {
        transportHosts.push(req.headers['x-update-test-source']);
        res.setHeader('Content-Length', installer.length);
        const corrupt = scenario === 'corrupt' || (scenario === 'mirror-corrupt' && req.headers['x-update-test-source'] === 'mirror.example');
        res.end(corrupt ? Buffer.alloc(installer.length, 43) : installer);
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const configPath = path.join(dir, 'app-update.yml');
    fs.writeFileSync(configPath, 'updaterCacheDirName: cache\n');
    const updater = new NsisUpdater(null, {
      version: '2.2.3', name: 'MineradioUpdateTest', isPackaged: true,
      whenReady: async () => {}, userDataPath: dir, baseCachePath: dir,
      appUpdateConfigPath: configPath,
      onQuit: () => assert.fail('download must not schedule unattended installation'),
    });
    updater.logger = null;
    updater.httpExecutor = new NodeHttpExecutor();
    updater.httpExecutor.createRequest = (options, callback) => http.request({
      ...options, protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1', port: server.address().port,
      headers: { ...options.headers, 'x-update-test-source': options.hostname },
    }, callback);
    updater.httpExecutor.download = ElectronHttpExecutor.prototype.download;
    const controller = new AppUpdater({ updater, config: { provider: 'github', owner: 'zhe8013-bot', repo: 'Mineradio-for-me', mirrors: scenario === 'mirror-corrupt' ? ['https://mirror.example/'] : [] } });
    const result = await controller.download();
    const corrupt = scenario === 'corrupt';
    assert.equal(result.ok, !corrupt);
    assert.equal(controller.getState().status, corrupt ? 'error' : 'ready');
    assert.equal(controller.prepareInstall().ok, !corrupt);
    if (corrupt) assert.match(controller.getState().error, /sha512|checksum/i);
    else assert.deepEqual(fs.readFileSync(updater.installerPath), installer);
    if (scenario === 'mirror-corrupt') assert.deepEqual(transportHosts, ['mirror.example', 'github.com']);
  });
}
