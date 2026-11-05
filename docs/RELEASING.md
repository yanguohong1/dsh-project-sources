# 修改与发版流程

这份文档描述本仓库的日常开发、发布新版本、回滚，以及过程中容易踩的坑。
面向 Windows + DeepSeek Harness 桌面端，其他平台把命令换成对应 shell 即可。

- 仓库：https://github.com/yanguohong1/dsh-project-sources
- npm：https://www.npmjs.com/package/dsh-project-sources

---

## 0. 先搞清楚当前装的是哪一版

DSH profile 里同一个包只有两种存在方式，**二选一**：

| 模式 | profile 里的写法 | 改代码后 |
| --- | --- | --- |
| **link（开发态）** | `"dsh-project-sources": "link:E:/work/dsh-project-sources"` | 重启 Host 立即生效 |
| **npm（正式态）** | `"dsh-project-sources": "^0.1.0"` | 必须发新版本再装 |

判断方法：

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw
```

`dependencies` 里是 `link:` 还是版本号，一目了然。也可以直接看目录：

```powershell
Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-project-sources" |
  Select-Object Name, LinkType, Target
```

`LinkType = Junction` 就是开发态；空白就是 npm 版。

---

## 1. 切到开发态（改代码即时看到效果）

在 DSH 里（或让 Agent 调 `plugin_manager`）：

```text
1) 卸载现有安装（npm 版必须先卸，否则报 already-installed）
   plugin_manager remove_bundle   target: dsh-project-sources

2) 安装本地目录（link 模式）
   plugin_manager install_bundle   target: E:\work\dsh-project-sources
```

装完：

- **Host 代码**（`index.js`、`lib/*.ps1`）：重启 DSH 生效（Host 模块在进程启动时 import，Node 的 ESM 缓存不会热更新）
- **Client 代码**（`client.js`）：刷新页面即可（bundle 每次从磁盘读取）
- **仅改样式/文案**：通常只需要刷新页面

> 提示：客户端 bundle 的 HMR 只有在 `pnpm run dev:web` 同时运行时才会免刷新；否则一律 Ctrl+R。

## 2. 本地自测

没有 DSH 运行时也能跑，两个套件都是纯 Node + mock：

```powershell
cd E:\work\dsh-project-sources
node --check index.js
node --check client.js
node test\smoke.mjs     # 配置存储 / 拦截 / 提示词 / remote API
node test\skills.mjs    # 源目录技能发现
```

或者一条命令：`npm test`。

真实环境验证清单：

- [ ] 会话头部「项目」按钮能开面板，能加/删文件夹、改别名、保存
- [ ] 添加文件夹能弹出系统对话框（Windows PowerShell / macOS osascript）
- [ ] `@别名/` 能列出该目录一层，下钻正常
- [ ] 在源目录里 `write` / `pwsh` 能成功（沙箱根被重定）
- [ ] 源目录 `.dsh/skills` 或 `.agents/skills` 里的技能出现在 `/` 菜单
- [ ] 重启后配置仍在（`~/.dsh/storages/project-sources/<workspace-key>.json`）

---

## 3. 发新版本

### 3.1 改版本号 + 写 CHANGELOG

```powershell
cd E:\work\dsh-project-sources
npm version patch        # 0.1.0 -> 0.1.1；修 bug 用 patch，加功能用 minor
```

`npm version` 会自动：改 `package.json`、打 git tag（`v0.1.1`）、生成一个 commit。

然后手动补 `CHANGELOG.md` 顶部的新版本段落（`npm version` 不会写它），再 `git commit --amend` 或单独补一次提交。

### 3.2 发布前检查

```powershell
npm pack --dry-run
```

确认：

- `total files` 与预期一致，`test/` 不进包
- `README` / `LICENSE` / `NOTICE` / `CHANGELOG` 都在
- `lib/native-picker.ps1` 在（Windows 选择器）
- 体积没有异常膨胀

还要确认这些字段没被改坏：

| 字段 | 期望 |
| --- | --- |
| `engines.dsh` | 当前 DSH 版本范围，如 `^0.2.1-rc.5`（0.2.x）；升级 DSH 后要复核 |
| `engines.node` | `>=20` |
| `dsh.bundle.patch` | `./cordis.patch.yml` |
| `dsh.client.inject` | 依赖的 4 个包名 |
| `exports["./client"]` | `./client.js` |
| `client.js` 里的模块 id | 必须等于包名 `dsh-project-sources` |

### 3.3 发布

```powershell
npm publish
```

当前账号开了 2FA / 通行密钥，流程是：

1. 终端打印 `Authenticate your account at: https://www.npmjs.com/auth/cli/...`
2. **按回车**（或手动复制 URL 到浏览器）
3. 浏览器里用 Windows Hello / Google 账号验证
4. 终端输出 `+ dsh-project-sources@0.1.1`
5. 若提示 `Your package is being processed and may take a few minutes`：这是 npm 的暂存审核，**等 1–2 分钟**，`npm view` 确认版本出现

验证：

```powershell
npm view dsh-project-sources version
npm view dsh-project-sources versions --json
```

### 3.4 推送 tag 和 Release

```powershell
git push origin main --follow-tags
```

公开 Release（附 CHANGELOG 摘要）：

```powershell
# 把说明写进临时文件，避免 PowerShell 引号地狱
gh release create v0.1.1 --title "v0.1.1" --notes-file .\release-notes.md
```

### 3.5 安装新版本

npm 版不能原地升级，先卸后装：

```text
plugin_manager remove_bundle    target: dsh-project-sources
plugin_manager install_bundle   target: dsh-project-sources@0.1.1
```

装完验证：

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw   # 版本号变了
```

以及重启 DSH 后，客户端 slot 里能看到 `project-sources`：

```text
cordis_inspect_query  client / Slots / listSubTree  { "root": "conversation.session.header.actions" }
```

---

## 4. 回滚 / 撤回

| 情况 | 做法 |
| --- | --- |
| 只是自己装错了版本 | 卸掉重装旧版本：`install_bundle target: dsh-project-sources@0.1.0` |
| 版本有严重问题，但要保留历史 | `npm deprecate dsh-project-sources@0.1.1 "suspends: 请使用 0.1.0"` |
| 发布 72 小时内且必须删除 | `npm unpublish dsh-project-sources@0.1.1`（超过 72h 只能 deprecate） |
| 整个包下线 | `npm unpublish dsh-project-sources --force`（慎用，名称会释放但用户会报错） |

回滚后记得同步：`CHANGELOG.md`、GitHub Release（可 `gh release delete v0.1.1`）、`latest` 标签。

---

## 5. 常见坑

### `EPERM: rename '...package.json.xxxx' -> '...package.json'`

卸载/安装时 profile 的 `package.json` 被占用（杀软、索引器、上一次操作没释放句柄）。

- 直接**重试一次**通常就好（实测有效）
- 仍失败：关掉 DSH 再操作，或临时关闭杀软实时扫描
- 不要手动改 `~/.dsh/profiles/desktop/package.json`，让 plugin_manager 做

### `E403 ... Two-factor authentication ... required`

npm 要求发布者具备 2FA。

- 账号没开 2FA：去 npm 设置里 Enable（通行密钥或 TOTP）
- 用 token 发布：token 必须勾 **Bypass two-factor authentication**

### `EOTP ... Authenticate your account at ...`

npm 的 WebAuthn 验证只能在**交互式终端**里完成。在 Agent/CI 的非交互环境里只会打印 URL 然后退出。

→ 自己开一个 PowerShell 窗口跑 `npm publish`，按回车完成验证。

### 刚发布完 `npm view` 只有 `0.0.0-stage`

npm 的暂存审核占位版本，`"Temporary package placeholder for staged publishing"`。等 1–2 分钟自动替换为真实版本，不用操作（`Staged Packages` 页面也可能看不到，属正常）。

### `already-installed`

同一包不能重复安装。先 `remove_bundle`，再 `install_bundle`。

### 改了代码但行为没变

- 改的是 `index.js` / `lib/*.ps1` → 需要**重启 DSH**
- 改的是 `client.js` → **刷新页面**
- npm 安装态下改本地仓库完全无效 → 切回 link 模式，或发新版本

### 卸载后 `node_modules` 里还留着 junction

不影响加载（bundle 列表已移除），但可以清掉：

```powershell
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-project-sources"
```

`rmdir`（不是 `Remove-Item -Recurse`）只删链接，不会动到 `E:\work\dsh-project-sources` 源码。

---

## 6. 安全习惯

- 不要把 **npm token**、**2FA 密钥 / 恢复码** 贴进聊天、提交进仓库、写进项目目录的 `.npmrc`
- token 只放在用户级 `~/.npmrc`（`npm config set` 默认位置）
- token 设短过期（7–30 天），发完版可删除
- 发布用一次性通行密钥验证最安全；token 方案只给 CI 用
- 仓库里永远不要出现 `*_authToken=`

---

## 7. 一页速查

```powershell
# 开发
cd E:\work\dsh-project-sources
node --check index.js; node --check client.js; npm test

# 发版
npm version patch
# 编辑 CHANGELOG.md
npm pack --dry-run
npm publish                  # 回车 -> 浏览器验证 -> 等 1~2 分钟
npm view dsh-project-sources version
git push origin main --follow-tags
gh release create v0.1.1 --title "v0.1.1" --notes-file .\release-notes.md

# 安装新版
# plugin_manager remove_bundle  -> install_bundle target: dsh-project-sources@0.1.1
```