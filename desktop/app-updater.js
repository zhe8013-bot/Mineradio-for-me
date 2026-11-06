'use strict';

class AppUpdater {
  constructor({ updater, config = {}, onState = () => {} }) {
    this.updater = updater;
    this.onState = onState;
    this.downloadPromise = null;
    this.installStarted = false;
    const supported = !!updater && !config.disabled && config.provider === 'github'
      && /^[\w.-]+$/.test(config.owner || '') && /^[\w.-]+$/.test(config.repo || '');
    this.state = { supported, status: 'idle', percent: 0, version: '', error: '' };
    if (!supported) return;
    const direct = `https://github.com/${config.owner}/${config.repo}/releases/latest/download/`;
    this.feed = direct;
    const mirrors = (config.mirrors || []).filter(value => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
      } catch (_) { return false; }
    }).map(value => value.replace(/\/?$/, '/'));
    const download = updater.httpExecutor.download.bind(updater.httpExecutor);
    updater.httpExecutor.download = async (url, destination, options) => {
      const source = new URL(url);
      const releaseRoot = `/${config.owner}/${config.repo}/releases/`;
      if (source.origin !== 'https://github.com' || !source.pathname.startsWith(releaseRoot)) {
        throw new Error('更新安装包必须来自本维护仓库');
      }
      const mirrored = mirrors.map(prefix => new URL(prefix + source.href));
      const candidates = config.preferMirrors === false ? [source, ...mirrored] : [...mirrored, source];
      let lastError;
      for (const candidate of candidates) {
        try {
          this.setState({ percent: 0 });
          // Mirrors transport bytes only; preserve the official manifest's checksum.
          return await download(candidate, destination, options);
        } catch (error) {
          if (options.cancellationToken && options.cancellationToken.cancelled) throw error;
          lastError = error;
        }
      }
      throw lastError;
    };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.disableWebInstaller = true;
    // Full NSIS installers avoid depending on a matching cached previous installer.
    updater.disableDifferentialDownload = true;
    updater.on('download-progress', progress => {
      this.setState({ status: 'downloading', percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)) });
    });
    updater.on('error', error => {
      // Download failures are retried below before surfacing an error to the user.
      if (this.state.status === 'installing') {
        this.installStarted = false;
        this.setState({ status: 'error', error: error.message || '安装启动失败' });
      }
    });
  }

  getState() {
    return { ...this.state };
  }

  setState(values) {
    Object.assign(this.state, values);
    this.onState(this.getState());
  }

  download() {
    if (!this.state.supported) return Promise.resolve({ ok: false, ...this.getState(), error: '请使用 Windows 正式安装版更新' });
    if (this.downloadPromise) return this.downloadPromise;
    if (this.state.status === 'ready' || this.state.status === 'installing') return Promise.resolve({ ok: true, ...this.getState() });
    this.downloadPromise = this.downloadLatest().finally(() => { this.downloadPromise = null; });
    return this.downloadPromise;
  }

  async downloadLatest() {
    this.setState({ status: 'checking', percent: 0, error: '' });
    try {
      this.updater.setFeedURL({ provider: 'generic', url: this.feed, useMultipleRangeRequest: false });
      const result = await this.updater.checkForUpdates();
      if (!result || !result.isUpdateAvailable) throw new Error('暂无可用的新安装包，请稍后重试');
      const installer = (result.updateInfo.files || []).find(file => /\.exe$/i.test(new URL(file.url, this.feed).pathname));
      if (!installer || !/^[A-Za-z0-9+/]{86}==$/.test(installer.sha512 || '')) throw new Error('官方发布缺少有效 SHA-512 校验信息');
      this.setState({ status: 'downloading', version: result.updateInfo.version });
      // electron-updater verifies SHA-512 before resolving or reusing its cache.
      const files = await this.updater.downloadUpdate();
      if (!files || !files.length) throw new Error('安装包下载未完成');
      this.setState({ status: 'ready', percent: 100 });
      return { ok: true, ...this.getState() };
    } catch (error) {
      this.setState({ status: 'error', percent: 0, error: error.message || '下载更新失败，请重试' });
      return { ok: false, ...this.getState() };
    }
  }

  prepareInstall() {
    if (this.state.status !== 'ready') return { ok: false, error: '安装包尚未就绪' };
    this.setState({ status: 'installing', error: '' });
    return { ok: true };
  }

  install() {
    if (this.state.status !== 'installing' || this.installStarted) return;
    this.installStarted = true;
    try { this.updater.quitAndInstall(true, true); }
    catch (error) {
      this.installStarted = false;
      this.setState({ status: 'error', error: error.message || '安装启动失败' });
    }
  }
}

module.exports = { AppUpdater };
