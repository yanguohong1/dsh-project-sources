# dsh-project-sources

**中文** | [English](README.md)

> 给 DeepSeek Harness 的工作区附加多个文件夹：一个工作区、多个源目录，每个都有别名，模型可直接引用。

这是一个 DeepSeek Harness 插件 bundle。会话的 `cwd` 仍然是主工作区；被附加的文件夹在**当前沙箱模式下拥有与主工作区相同**的读写、编辑与命令执行权限，并且每个文件夹都有一个简短的**别名**。

- **项目编辑器**：会话头部的「项目」按钮，或新会话页输入框上方的「📁 项目源文件夹」。可添加文件夹、改别名、移除。
- **会话里用别名引用**：系统提示词注入「别名 → 绝对路径」映射，`@web/src/a.ts` 对模型是明确的。
- **`@` 菜单覆盖**：内置 `@` 是单根的，本插件贡献一个伴生分组，按别名、目录名或绝对路径搜索所有源目录。
- **源目录里的 skill**：`/` 能找到 `<源目录>/.dsh/skills`、`<源目录>/.agents/skills`、`<源目录>/skills` 下的技能，递归多层。
- **不新增任何工具**：`read`/`glob`/`grep` 本来就能跨目录；`write`/`edit`/`pwsh`/`bash` 命中源目录时被拦截，并把沙箱根重定到该目录。

## 环境要求

- DeepSeek Harness **0.2.1-rc.5 ～ 0.2.x**（`engines.dsh: ^0.2.1-rc.5`）
- Node.js ≥ 20

## 安装

Web 界面：**设置 → 插件 → 添加**，填 `dsh-project-sources`。

命令行：

```bash
dsh plugin --profile <profile> add dsh-project-sources@0.1.0
```

从本地目录（Agent 工具 `plugin_manager` 可以传目录）：

```text
plugin_manager install_bundle   target: D:\work\dsh-project-sources
```

改动源码后需要重启 Host（Host 模块在启动时 import）；浏览器端刷新页面即可。

## 使用

| 操作 | 位置 |
| --- | --- |
| 编辑项目 | 会话头部的「项目」按钮 |
| 发第一条消息前编辑 | 新会话页、输入框上方的「📁 项目源文件夹」 |
| 添加文件夹 | 点「添加文件夹」→ 弹出系统文件夹对话框 |
| 改别名 | 直接编辑该行的别名输入框 |
| 移除 | 该行的 `×`（工作区本身不能移除） |

别名限字母/数字/`.`/`_`/`-`，最长 48 字符；重名自动加 `-2` 后缀。

## 数据存放

`<DSH_HOME>/storages/project-sources/<workspace-key>.json`，一个工作区一个文件，放在所有 Agent 沙箱根之外。只有用户操作会写入；Agent 无法给自己加目录。

## 平台

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 文件夹选择器 | `powershell -STA` + `FolderBrowserDialog` | `osascript … choose folder` | 退回宿主 picker，再退回手动输入 |

沙箱重定根、`@` 菜单、技能发现都与平台无关。macOS 分支已实现，但尚未在 Mac 上实测。

## 已知限制

- **一条命令只能写一个根**：shell 命令只能写入其 `workdir` 指向的目录。请传源目录的**绝对** `workdir`；相对路径会按工作区解析，命令里 `git -C <源>` / `cd <源>` 也不会扩大可写根。
- 会话 `cwd` 固定：没有「主文件夹」概念，工作区仍是默认工作目录。
- 不能与另一个拦截同一工具流水线的插件（如 `dsh-multi-folder`）同时启用。
- 后台命令通过 jobs 运行时支持，但调用返回之后才发生的拒绝只能在 `job_output` 里看到。

## 开发

无构建步骤。`npm test` 不需要 DSH 运行时：

```bash
node test/smoke.mjs   # 配置存储、拦截、提示词、remote API
node test/skills.mjs  # 源目录技能发现
```

## 致谢

工具拦截与沙箱重定根的思路参考了 [dsh-multi-folder](https://github.com/AngelosZou/dsh-multi-folder)（作者 Yutong Zou，MIT），详见 `NOTICE`。

## License

MIT