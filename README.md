# Workbench

本地优先的个人工作台：倒计时 / 到岗打卡 / 待办 / 今日记录 / 口径库 / 便签 / 番茄钟。
一个绿色 exe，数据全部存在本地，整库加密（AES-256-GCM），不联网、不上传。

## 为什么是它

- **减负优先**：任何操作不超过 10 秒。打卡就是一个按钮，点完按钮自己消失；待办一句话入库并自动识别时间；聊天记录整段粘进来自动拆成待办 / 口径 / 回执。
- **本地且加密**：数据写在 `workbench.db.enc` 一个文件里，主密钥由 Windows 钥匙串（DPAPI）包裹。备份、迁移、打码导出都在应用内一键完成。
- **能自己改**：班表支持基础时段 + 两周交替（A/B 各自独立时段与午休）+ 逐月规则 + 法定假期 + 调休补班 + 个人例外。

## 开发

```bash
npm ci
npm run dev          # 开发模式（热更新）
npm run typecheck    # 类型检查：vue-tsc + tsc
npm test             # 单元测试（vitest）
npm run smoke        # 端到端冒烟（73 项，启动真实 Electron 窗口）
npm run verify       # 上面三件一起跑
npm run dist         # 打绿色版：release/Workbench-<version>-portable.exe
```

冒烟测试会启动真实窗口、点击真实按钮、读写真实加密库，最后把界面截图和 `logs/smoke.json` 写到数据目录。改 UI 前后各跑一次，比肉眼可靠。

## 发布与在线更新

### 打一个版本

```bash
# 1. 改 package.json 的 version
# 2. 打包并生成更新清单
npm run dist
npm run release:manifest      # 生成 release/version.json（含 sha256）

# 3. 打 tag 推上去，GitHub Actions 自动构建 + 发布
git tag v1.0.1
git push origin v1.0.1
```

`.github/workflows/release.yml` 会：跑 `npm run verify` → 打包 → 生成 `version.json` → 提交回 `main` → 创建 Release 并上传 exe 与清单。

### 更新器怎么工作

客户端不依赖 `electron-updater`（它不支持 portable 目标），更新逻辑在 `src/main/update.ts`：

1. **多节点握手探测**：并发向所有源请求 `release/version.json`（Range 只取前 32 KB），量 RTT 与吞吐，挑最快的拿到版本元数据。
2. **比版本**：本地 `app.getVersion()` 与清单里的 `version` 做语义比较。
3. **大文件再测一次速**：元数据快不代表安装包快，对每个源的 exe 做 512 KB Range 测速，选吞吐最高的那个下载。
4. **校验**：大小必须等于清单里的 `size`，`sha256` 必须一致，否则拒绝安装。
5. **替换重启**：绿色版运行时真正的 exe 路径来自 `PORTABLE_EXECUTABLE_PATH`；下载完写一个 `apply-update.bat`，退出后移动新文件覆盖原 exe 再启动。

默认节点：

| id | 说明 |
| --- | --- |
| `github` | GitHub 直连 |
| `ghfast` | ghfast.top 加速 |
| `ghproxy` | gh-proxy.com 加速 |
| `ghpnet` | ghproxy.net 加速 |
| `gitmirror` | raw 文件走 gitmirror |

自定义节点（设置项 `updateSources`，JSON）：

```json
[
  { "id": "github", "name": "GitHub 直连", "prefix": "" },
  { "id": "my", "name": "我的反代", "prefix": "https://cdn.example.com/" }
]
```

仓库地址默认 `MCxingX/workbench-desktop`，可用设置项 `updateRepo`（`owner/repo`）覆盖。

界面入口：`Ctrl+,` → **更新** 页签，能看到每个节点的握手延迟、下载速度、进度条，以及「检查更新 / 下载更新 / 重启并安装」。

启动 15 秒后会自动静默检查一次（有新版才弹系统通知）；不想要就把设置项 `updateAutoCheck` 设为 `0`。

## 数据在哪

```
%APPDATA%\Workbench\bootstrap.json     # 只记数据目录位置
%APPDATA%\Workbench\master.key         # 主密钥（Windows 钥匙串包裹）
D:\WorkbenchData\workbench.db.enc      # 加密库
D:\WorkbenchData\workbench.db.enc.bak  # 上一次成功写入
D:\WorkbenchData\backups\              # 每日自动备份（保留 7 份）
```

**`master.key` 不要删**：删了等于数据永久打不开。备份包里包含它。

## 技术栈

Electron 33 · Vue 3.5 · TypeScript 5.7 · Vite 6 · sql.js（WASM SQLite）· electron-builder
