// ============================================================
// Desktop updates use a verified NSIS installer; browser downloads stay available.
// ============================================================
function isSafeUpdatePageUrl(value) {
  var raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return false;
  try {
    return new URL(raw).protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function normalizeUpdateDownloadPages(values) {
  var source = Array.isArray(values) ? values : [];
  var seen = Object.create(null);
  var pages = [];
  source.forEach(function (value, index) {
    var item = value && typeof value === 'object' ? value : { url: value };
    var url = String(item.url || item.href || item.downloadPageUrl || item.externalUrl || '').trim();
    if (!isSafeUpdatePageUrl(url) || seen[url]) return;
    var label = String(item.label || item.name || ('下载线路 ' + (index + 1)))
      .replace(/[<>|]/g, '')
      .trim()
      .slice(0, 24) || ('下载线路 ' + (index + 1));
    seen[url] = true;
    pages.push({ label: label, url: url });
  });
  return pages.slice(0, 6);
}

function currentUpdateDownloadPages() {
  return normalizeUpdateDownloadPages(updatePreviewState.downloadPages);
}

function currentUpdatePageUrl(preferredIndex) {
  var pages = currentUpdateDownloadPages();
  var index = Number.isInteger(preferredIndex)
    ? preferredIndex
    : Number(updatePreviewState.selectedDownloadPageIndex || 0);
  if (pages[index] && isSafeUpdatePageUrl(pages[index].url)) return pages[index].url;
  if (pages[0] && isSafeUpdatePageUrl(pages[0].url)) return pages[0].url;
  var candidates = [
    updatePreviewState.downloadPageUrl,
    updatePreviewState.externalUrl,
    updatePreviewState.releaseUrl
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (isSafeUpdatePageUrl(candidates[i])) return String(candidates[i]).trim();
  }
  return '';
}

function initUpdatePreview() {
  renderUpdatePreviewPanel();
  setUpdatePreviewVisible(false);
  checkLatestUpdate();
  initDesktopUpdater();
}

async function initDesktopUpdater() {
  var desktop = window.desktopWindow;
  if (!desktop || typeof desktop.getUpdateState !== 'function') return;
  desktop.onUpdateState(applyDesktopUpdateState);
  try { applyDesktopUpdateState(await desktop.getUpdateState()); }
  catch (e) { updatePreviewState.desktopUpdate = null; }
}

function applyDesktopUpdateState(state) {
  updatePreviewState.desktopUpdate = state;
  if (state.supported && state.status !== 'idle' && !updatePreviewState.visible) setUpdatePreviewVisible(true);
  if (state.supported && state.version && ['downloading', 'ready', 'installing'].includes(state.status)) {
    updatePreviewState.version = state.version;
    var version = document.getElementById('update-modal-version');
    if (version) version.textContent = 'v' + state.version;
  }
  syncUpdatePreviewStateClass();
  updateUpdatePreviewProgress(state.percent);
}

function setUpdatePreviewVisible(visible) {
  updatePreviewState.visible = !!visible;
  var entry = document.getElementById('update-entry');
  if (!entry) return;
  entry.classList.toggle('available', updatePreviewState.visible);
  if (!updatePreviewState.visible && window.gsap) {
    window.gsap.killTweensOf(entry);
    window.gsap.set(entry, { autoAlpha: 0, y: 0, clearProps: 'boxShadow,filter,scale' });
    return;
  }
  if (updatePreviewState.visible && window.gsap) {
    window.gsap.fromTo(entry,
      { autoAlpha: 0, y: -6, scale: 0.92, filter: 'blur(6px)' },
      { autoAlpha: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: 0.62, delay: 0.18, ease: 'expo.out', overwrite: true }
    );
    setTimeout(startUpdateIconBreathing, 760);
  }
}

async function checkLatestUpdate() {
  try {
    var data = await apiJson('/api/update/latest?t=' + Date.now());
    applyLatestUpdateInfo(data);
  } catch (e) {
    updatePreviewState.preview = false;
    updatePreviewState.updateAvailable = false;
    updatePreviewState.hero = '暂时无法检查更新。';
    updatePreviewState.message = (e && e.message) || 'UPDATE_CHECK_FAILED';
    renderUpdatePreviewPanel();
    var desktop = updatePreviewState.desktopUpdate;
    setUpdatePreviewVisible(!!(desktop && desktop.supported && desktop.status !== 'idle'));
  }
}

function applyLatestUpdateInfo(data) {
  data = data || {};
  var release = data.release || {};
  updatePreviewState.currentVersion = data.currentVersion || updatePreviewState.currentVersion;
  updatePreviewState.version = data.latestVersion || release.version || updatePreviewState.currentVersion;
  updatePreviewState.configured = !!data.configured;
  updatePreviewState.preview = !!data.preview;
  updatePreviewState.updateAvailable = !!data.updateAvailable;
  updatePreviewState.releaseUrl = release.htmlUrl || data.htmlUrl || '';
  var legacyExternalUrl = release.externalUrl || data.externalUrl || '';
  var explicitPages = Array.isArray(release.downloadPages)
    ? release.downloadPages
    : (Array.isArray(data.downloadPages) ? data.downloadPages : null);
  updatePreviewState.downloadPages = normalizeUpdateDownloadPages(explicitPages || []);
  if (
    explicitPages === null
    && isSafeUpdatePageUrl(legacyExternalUrl)
  ) {
    updatePreviewState.downloadPages.unshift({
      label: '网盘下载',
      url: legacyExternalUrl
    });
  }
  updatePreviewState.externalUrl = updatePreviewState.downloadPages.length
    ? updatePreviewState.downloadPages[0].url
    : '';
  if (updatePreviewState.selectedDownloadPageIndex >= updatePreviewState.downloadPages.length) {
    updatePreviewState.selectedDownloadPageIndex = 0;
  }
  updatePreviewState.downloadPageUrl = explicitPages !== null
    ? (updatePreviewState.externalUrl || updatePreviewState.releaseUrl || '')
    : (release.downloadPageUrl || data.downloadPageUrl || updatePreviewState.externalUrl || updatePreviewState.releaseUrl || '');
  updatePreviewState.status = 'idle';
  updatePreviewState.errorReason = '';
  updatePreviewState.hero = release.summary
    || (updatePreviewState.updateAvailable ? '发现新版本，建议更新。' : '当前版本已是最新。');
  updatePreviewState.notes = Array.isArray(release.notes) ? release.notes.slice(0, 4) : [];
  var desktop = updatePreviewState.desktopUpdate;
  var activeDesktopUpdate = desktop && desktop.supported && desktop.status !== 'idle';
  if (activeDesktopUpdate && desktop.version) updatePreviewState.version = desktop.version;
  renderUpdatePreviewPanel();
  setUpdatePreviewVisible(updatePreviewState.updateAvailable || updatePreviewState.preview || !!activeDesktopUpdate);
}

function startUpdateIconBreathing() {
  var entry = document.getElementById('update-entry');
  if (!entry || !updatePreviewState.visible || !window.gsap) return;
  var ring = entry.querySelector('.update-ring');
  window.gsap.killTweensOf(entry, 'y,boxShadow');
  window.gsap.set(entry, { autoAlpha: 1 });
  if (ring) window.gsap.killTweensOf(ring);
  window.gsap.to(entry, {
    y: -1.4,
    boxShadow: '0 16px 44px rgba(0,0,0,.32),0 0 24px rgba(244,210,138,.18),0 0 13px rgba(157,184,207,.06),inset 0 1px 0 rgba(255,255,255,.11)',
    duration: 2.6,
    repeat: -1,
    yoyo: true,
    ease: 'sine.inOut'
  });
  if (ring) {
    window.gsap.to(ring, {
      rotate: 18,
      duration: 3.8,
      repeat: -1,
      yoyo: true,
      ease: 'sine.inOut',
      transformOrigin: '50% 50%'
    });
  }
}

function renderUpdatePreviewPanel() {
  var version = document.getElementById('update-modal-version');
  var hero = document.getElementById('update-hero-main');
  var list = document.getElementById('update-list');
  if (version) version.textContent = 'v' + updatePreviewState.version;
  if (hero) hero.textContent = updatePreviewState.hero || '当前版本已是最新。';
  if (list) {
    var notes = Array.isArray(updatePreviewState.notes) && updatePreviewState.notes.length
      ? updatePreviewState.notes
      : ['更新检测已就绪'];
    list.innerHTML = notes.map(function (text, i) {
      return '<div class="update-item"><span class="update-item-dot" data-index="'
        + String(i + 1).padStart(2, '0')
        + '"></span><div class="update-item-text">'
        + escHtml(text)
        + '</div></div>';
    }).join('');
  }
  renderUpdateDownloadSources();
  updateUpdatePreviewProgress();
  syncUpdatePreviewStateClass();
}

function renderUpdateDownloadSources() {
  var container = document.getElementById('update-download-sources');
  if (!container) return;
  var pages = currentUpdateDownloadPages();
  container.innerHTML = '';
  container.hidden = !!(updatePreviewState.desktopUpdate && updatePreviewState.desktopUpdate.supported)
    || !updatePreviewState.updateAvailable || pages.length < 2;
  if (container.hidden) return;
  pages.forEach(function (page, index) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'update-download-source';
    button.dataset.index = String(index);
    button.textContent = page.label;
    button.title = '使用' + page.label + '下载';
    button.onclick = function () {
      openUpdateDownloadSource(index);
    };
    container.appendChild(button);
  });
}

function syncUpdatePreviewStateClass() {
  var entry = document.getElementById('update-entry');
  var modal = document.querySelector('#update-modal .update-modal');
  var isOpening = updatePreviewState.status === 'opening';
  var isOpened = updatePreviewState.status === 'opened';
  var isError = updatePreviewState.status === 'error';
  var downloadPages = currentUpdateDownloadPages();
  var selectedPage = downloadPages[Number(updatePreviewState.selectedDownloadPageIndex || 0)] || downloadPages[0] || null;
  var updateUrl = currentUpdatePageUrl();
  var desktop = updatePreviewState.desktopUpdate;
  if (desktop && desktop.supported) {
    var busy = ['checking', 'downloading', 'installing'].includes(desktop.status);
    if (entry) {
      entry.classList.toggle('downloading', busy);
      entry.classList.toggle('ready', desktop.status === 'ready');
    }
    if (modal) {
      modal.classList.toggle('ready', desktop.status === 'ready');
      modal.classList.toggle('error', desktop.status === 'error');
    }
    var desktopLabel = document.getElementById('update-btn-label');
    if (desktopLabel) desktopLabel.textContent = desktop.status === 'ready' ? '重启并安装'
      : desktop.status === 'checking' ? '正在准备更新'
      : desktop.status === 'downloading' ? '下载中 ' + Math.floor(desktop.percent || 0) + '%'
      : desktop.status === 'installing' ? '正在退出并安装'
      : desktop.status === 'error' ? '重试下载' : '下载更新';
    var desktopButton = document.getElementById('update-primary-btn');
    if (desktopButton) desktopButton.disabled = busy || (!updatePreviewState.updateAvailable && desktop.status !== 'ready');
    var desktopFoot = document.getElementById('update-footnote');
    if (desktopFoot) desktopFoot.textContent = desktop.status === 'error' ? '更新失败：' + desktop.error + '。可重试或手动下载。'
      : desktop.status === 'ready' ? '安装包已校验。点击后将退出播放器、安装更新并重新启动。'
      : desktop.status === 'installing' ? '正在保存状态并退出播放器，请稍候。'
      : '在应用内下载更新；下载完成并校验后，可点击重启安装。';
    var manualButton = document.getElementById('update-manual-btn');
    if (manualButton) manualButton.hidden = !updateUrl;
    return;
  }
  if (entry) {
    entry.classList.toggle('downloading', isOpening);
    entry.classList.toggle('ready', isOpened);
  }
  if (modal) {
    modal.classList.toggle('ready', isOpened);
    modal.classList.toggle('error', isError);
  }
  var label = document.getElementById('update-btn-label');
  if (label) {
    if (isOpening) label.textContent = '正在打开下载页';
    else if (isOpened) label.textContent = '下载页已打开';
    else if (isError) label.textContent = '重试打开';
    else if (!updatePreviewState.updateAvailable) label.textContent = '当前已是最新';
    else if (selectedPage) label.textContent = '前往' + selectedPage.label;
    else if (updatePreviewState.externalUrl) label.textContent = '前往网盘下载';
    else label.textContent = '查看更新页面';
  }
  var btn = document.getElementById('update-primary-btn');
  if (btn) {
    btn.disabled = isOpening || !updatePreviewState.updateAvailable || !updateUrl;
  }
  var sourceButtons = document.querySelectorAll('#update-download-sources .update-download-source');
  Array.prototype.forEach.call(sourceButtons, function (sourceButton) {
    var index = Number(sourceButton.dataset.index || 0);
    sourceButton.disabled = isOpening;
    sourceButton.classList.toggle('active', index === Number(updatePreviewState.selectedDownloadPageIndex || 0));
  });
  var foot = document.getElementById('update-footnote');
  if (foot) {
    if (isOpening) foot.textContent = '正在调用系统浏览器。';
    else if (isError) foot.textContent = '无法打开下载页：' + (updatePreviewState.errorReason || '请稍后重试');
    else if (!updatePreviewState.updateAvailable) foot.textContent = '当前版本已是最新。';
    else if (downloadPages.length || updatePreviewState.externalUrl) foot.textContent = '请使用本次公告中的最新网盘链接，旧收藏链接可能不是最新版。软件不会在本地下载或应用补丁。';
    else foot.textContent = '将在浏览器打开 GitHub 更新页面；软件不会在本地下载或应用补丁。';
  }
}

function updateUpdatePreviewProgress(percent) {
  var desktop = updatePreviewState.desktopUpdate;
  var progress = desktop && desktop.supported ? Math.max(0, Math.min(100, Number(percent == null ? desktop.percent : percent) || 0)) : 0;
  updatePreviewState.progress = progress;
  var fill = document.getElementById('update-btn-fill');
  if (fill) fill.style.width = progress + '%';
  var ring = document.getElementById('update-progress-ring');
  if (ring) ring.style.strokeDashoffset = String(55.29 * (1 - progress / 100));
}

function openUpdatePanel() {
  var mask = document.getElementById('update-modal');
  var entry = document.getElementById('update-entry');
  if (!mask) return;
  renderUpdatePreviewPanel();
  if (entry && window.gsap) {
    window.gsap.fromTo(entry, { scale: 0.93 }, { scale: 1, duration: 0.42, ease: 'back.out(1.7)', overwrite: 'auto' });
  }
  openGsapModal(mask);
  updatePreviewState.open = true;
  animateUpdatePanelContents();
}

function closeUpdatePanel() {
  closeGsapModal(document.getElementById('update-modal'), function () {
    updatePreviewState.open = false;
  });
}

function animateUpdatePanelContents() {
  if (!window.gsap) return;
  var modal = document.querySelector('#update-modal .update-modal');
  if (!modal) return;
  var parts = [
    modal.querySelector('.update-kicker'),
    modal.querySelector('.update-version'),
    modal.querySelector('.update-hero')
  ].filter(Boolean);
  var items = Array.prototype.slice.call(modal.querySelectorAll('.update-item'));
  var sources = Array.prototype.slice.call(modal.querySelectorAll('.update-download-source'));
  var actions = modal.querySelector('.update-actions');
  window.gsap.fromTo(parts,
    { autoAlpha: 0, x: -7, filter: 'blur(5px)' },
    { autoAlpha: 1, x: 0, filter: 'blur(0px)', duration: 0.50, ease: 'power3.out', stagger: 0.045, delay: 0.10, overwrite: true }
  );
  window.gsap.fromTo(items,
    { autoAlpha: 0, x: -8 },
    { autoAlpha: 1, x: 0, duration: 0.34, ease: 'power3.out', stagger: 0.055, delay: 0.25, overwrite: true }
  );
  if (sources.length) {
    window.gsap.fromTo(sources,
      { autoAlpha: 0, y: 6 },
      { autoAlpha: 1, y: 0, duration: 0.30, ease: 'power3.out', stagger: 0.045, delay: 0.34, overwrite: true }
    );
  }
  if (actions) {
    window.gsap.fromTo(actions,
      { autoAlpha: 0, y: 8 },
      { autoAlpha: 1, x: 0, y: 0, duration: 0.36, ease: 'power3.out', delay: 0.42, overwrite: true }
    );
  }
}

function openUpdateDownloadSource(index) {
  var pages = currentUpdateDownloadPages();
  if (!pages[index]) return;
  updatePreviewState.selectedDownloadPageIndex = index;
  syncUpdatePreviewStateClass();
  startUpdatePreviewDownload(index);
}

async function startUpdatePreviewDownload(preferredIndex) {
  var desktop = updatePreviewState.desktopUpdate;
  if (!Number.isInteger(preferredIndex) && desktop && desktop.supported) {
    if (['checking', 'downloading', 'installing'].includes(desktop.status)) return;
    if (!updatePreviewState.updateAvailable && desktop.status !== 'ready') return;
    var installing = desktop.status === 'ready';
    applyDesktopUpdateState(Object.assign({}, desktop, { status: installing ? 'installing' : 'checking', error: '' }));
    try {
      if (installing && typeof saveLastPlaybackSnapshot === 'function') saveLastPlaybackSnapshot(true, 'update-install');
      var result = installing ? await window.desktopWindow.installUpdate() : await window.desktopWindow.downloadUpdate();
      if (!result || !result.ok) throw new Error(result && result.error || '更新失败，请重试');
      if (!installing) applyDesktopUpdateState(result);
    } catch (e) {
      applyDesktopUpdateState(Object.assign({}, updatePreviewState.desktopUpdate, { status: 'error', error: e.message || '更新失败，请重试' }));
    }
    return;
  }
  if (updatePreviewState.status === 'opening') return;
  if (!updatePreviewState.updateAvailable) {
    showToast('当前版本已是最新');
    return;
  }
  if (Number.isInteger(preferredIndex)) {
    updatePreviewState.selectedDownloadPageIndex = preferredIndex;
  }
  var target = currentUpdatePageUrl(preferredIndex);
  if (!target) {
    showToast('这个版本还没有可用下载页面');
    return;
  }
  updatePreviewState.status = 'opening';
  updatePreviewState.errorReason = '';
  syncUpdatePreviewStateClass();
  try {
    if (window.desktopWindow && typeof window.desktopWindow.openUpdatePage === 'function') {
      var result = await window.desktopWindow.openUpdatePage(target);
      if (!result || result.ok === false) throw new Error((result && result.error) || 'OPEN_UPDATE_PAGE_FAILED');
    } else {
      var opened = window.open(target, '_blank', 'noopener');
      if (!opened) throw new Error('OPEN_UPDATE_PAGE_BLOCKED');
    }
    updatePreviewState.status = 'opened';
    syncUpdatePreviewStateClass();
    pulseUpdateReady();
    showToast(updatePreviewState.externalUrl ? '已在浏览器打开网盘下载页' : '已在浏览器打开更新页面');
    setTimeout(function () {
      if (updatePreviewState.status === 'opened') {
        updatePreviewState.status = 'idle';
        syncUpdatePreviewStateClass();
      }
    }, 1600);
  } catch (e) {
    updatePreviewState.status = 'error';
    updatePreviewState.errorReason = (e && e.message) || 'OPEN_UPDATE_PAGE_FAILED';
    syncUpdatePreviewStateClass();
    showToast('无法打开更新页面');
  }
}

function openManualUpdatePage() {
  var target = currentUpdatePageUrl();
  if (!target) return;
  if (window.desktopWindow && typeof window.desktopWindow.openUpdatePage === 'function') {
    window.desktopWindow.openUpdatePage(target).then(function (result) {
      if (!result || result.ok === false) showToast('无法打开下载页面');
    }).catch(function () { showToast('无法打开下载页面'); });
  } else {
    window.open(target, '_blank', 'noopener');
  }
}

function pulseUpdateReady() {
  var entry = document.getElementById('update-entry');
  var btn = document.getElementById('update-primary-btn');
  if (!window.gsap) return;
  if (entry) {
    window.gsap.fromTo(entry,
      { scale: 0.96, filter: 'brightness(1)' },
      { scale: 1.05, filter: 'brightness(1.28)', duration: 0.26, yoyo: true, repeat: 1, ease: 'power2.out', overwrite: true }
    );
  }
  if (btn) {
    window.gsap.fromTo(btn,
      { scale: 0.985 },
      { scale: 1.015, duration: 0.22, yoyo: true, repeat: 1, ease: 'sine.inOut', overwrite: true }
    );
  }
}
