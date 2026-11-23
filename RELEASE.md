# Mineradio 2.2.4 汽水扫码放大与自动更新验证

## 发布状态

- 维护版本 / Release tag：`2.2.4` / `v2.2.4`
- Release 标题：`Mineradio 2.2.4 · 汽水扫码放大与自动更新验证`
- Release 页面：https://github.com/zhe8013-bot/Mineradio-for-me/releases/tag/v2.2.4
- 发布仓库：`zhe8013-bot/Mineradio-for-me`
- 平台：Windows x64
- 安装包：`Mineradio-2.2.4-Setup.exe`
- 安装包大小：`117658574` 字节
- 安装包 SHA-256：`55223b4c4dfebdf1c5640e3f280bdf854060dac0c1848e15c819c8934d905e4e`
- About 简介：`基于 XxHuberrr 原作的 Mineradio 个人维护版。2.2.4 放大汽水登录二维码并改进扫码识别，继续支持 2.2.3 起的应用内更新；保留沉浸式播放、歌词与桌面视觉体验。`

本版本基于 XxHuberrr 的 Mineradio 2.2.0。原作设计与主要开发贡献归原作者所有，zhe8013-bot 负责个人二创修改与维护。保留原作者提交历史、版权、社区致谢与 GPL-3.0-only 授权。

## 本次修改 / Release 正文

- 汽水音乐登录二维码从 `156×156` 放大为 `280×280`，修复 Android 汽水音乐扫官方码无反应；只调整汽水登录面板，其他平台布局不变。
- Android 17 手机与汽水音乐 21.7.0 真机验证：放大后同一张官方码约 6 秒上报 `scanned`，手机确认后返回 `confirmed` 并建立网页会话。
- 汽水音乐与抖音二维码切换、同一 token 轮询、二次验证和账号同步逻辑保持不变。
- 从已安装的 2.2.3 通过 GitHub Release 实测应用内下载、安装和重启；2.2.1 / 2.2.2 首次升级仍需手动安装。

**旧版首次升级：** 2.2.1 / 2.2.2 内置的是浏览器下载流程，需手动运行一次完整安装包；从 2.2.3 起，后续正式版本可在应用内下载和安装。原作者版本首次切换到本维护版也需手动安装。

## 发布资产

Release 必须包含完整安装包、对应 `.blockmap`、构建生成的 `latest.yml` 与 `SHA256SUMS.txt`。`latest.yml` 含实际文件名、大小和 SHA-512；`docs/update/latest.yml` 与 Release 附件保持一致。用户首次安装选择 `.exe`。

- `Mineradio-2.2.4-Setup.exe`：117658574 字节，SHA-256 `55223b4c4dfebdf1c5640e3f280bdf854060dac0c1848e15c819c8934d905e4e`。
- `Mineradio-2.2.4-Setup.exe.blockmap`：124564 字节，SHA-256 `96f4b4a197d1f5e46731456841fe48e327769b066ed611bce6f778fb345f9487`。
- `latest.yml`：347 字节，SHA-256 `a5c8aefd05f8487c14cb2fb83bb60062610a13d18823988b24a99549b3e752f9`。

发布前已核对包内 `package.json`、更新源、electron-updater 6.8.9 生产依赖、EXE 文件/产品版本、二维码放大资源与更新元数据一致，并确认包内不含账号 Cookie、Token、私人壁纸、缓存与原始测试数据。

扫码排查与真机记录见 [2.2.4 汽水扫码尺寸修复](./docs/QR_LOGIN_2.2.4.md)。

## 自动更新验证

已使用本机安装的 2.2.3 正式版完成一次真实自动更新：

- 应用内检测到 2.2.4，并从 GitHub Release 下载完整 `Mineradio-2.2.4-Setup.exe`，进度到达 `ready / 100%`。
- `electron-updater` 按 `latest.yml` 完成 SHA-512 校验，点击“重启并安装”后完成 NSIS 覆盖安装并自动重启。
- 安装后 `resources\app\package.json`、`Mineradio.exe` 文件版本和 `/api/app/version` 均返回 `2.2.4`。
- 因此 `2.2.3 → 2.2.4` 的检查、下载、校验、安装和重启全链路已实测通过。

## 线上核验

发布后回读 GitHub About、README、Release 正文、`latest.yml`、安装包 SHA-256 与已安装版本，确认当前版本信息一致。
