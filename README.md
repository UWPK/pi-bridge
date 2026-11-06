# Pi Bridge

将 Codex 的有边界任务交给已安装的 Pi 执行，并返回独立验收证据。提供 **Skill、命令行和 stdio MCP** 三种入口，使用同一套运行时。

- Windows、macOS、Linux 使用相同的 Node 程序，无需 PowerShell。
- 自动查找 Pi，支持 npm 全局安装的 Pi、JS 入口和原生可执行程序。
- 默认继承 Pi 的模型、认证、代理和插件；可以显式指定 provider/model。
- 每个 Codex 聊天使用独立实例，保存任务、日志和恢复状态。
- 常驻 daemon 复用空闲 Pi worker；取消、超时、独立验收和失败恢复保持统一。

## 安装

前提：**Node.js >=22.19（推荐 24 LTS）、npm、Git、Codex，以及已配置可用模型的 Pi**。先确认 `pi --help` 与 `codex --help` 正常。

三平台均可安装预构建包：

```text
npm install -g https://github.com/UWPK/pi-bridge/releases/download/v0.3.0/uwpk-pi-bridge-0.3.0.tgz
pi-bridge check-local
```

该命令下载本仓库的构建包；npm 安装所需依赖需要网络。无需编译 TypeScript。使用自定义 npm 前缀时，确认全局 bin 目录已加入 PATH。

从源码开发：

```text
git clone https://github.com/UWPK/pi-bridge.git
cd pi-bridge
npm ci
npm run build
node bin/pi-bridge.mjs check-local
```

## 接入 Skill

```text
pi-bridge install-skill --apply
```

默认安装至当前用户的 `~/.agents/skills/pi-bridge`。已有同名目录会停止；使用 `--destination <技能目录>` 安装到独立的代理配置环境。重启或新建 Codex 聊天，然后明确调用 `$pi-bridge`。

技能运行时需要全局命令 `pi-bridge`，或由代理使用已安装包中 `bin/pi-bridge.mjs` 的绝对路径。程序保持安装后才可使用技能。

## 接入 MCP

推荐运行：

```text
pi-bridge mcp-config
```

将输出的配置片段加入目标 Codex 配置，或在界面中添加等效的 stdio 服务。输出自动使用本机 Node 和 MCP 程序的绝对路径，适合桌面应用 PATH 与终端不同的情况。程序只显示配置，不重写当前设置。

也可使用 Codex CLI 注册：

```text
codex mcp add pi_bridge -- pi-bridge-mcp
```

需要 Codex 进程可以找到 `pi-bridge-mcp`；否则使用上面的绝对路径配置。Codex MCP 配置方式见 [官方文档](https://developers.openai.com/codex/mcp/)。

### MCP 工具

| 工具 | 用途 |
| --- | --- |
| `pi_bridge_check` | 检查 Node/Pi，返回实际实例与状态目录，不请求模型 |
| `pi_bridge_up` | 启动当前实例 daemon |
| `pi_bridge_doctor` / `pi_bridge_models` | 初始化或检测 RPC worker、列举模型 |
| `pi_bridge_authorize` | 授权明确的 host 工作目录 |
| `pi_bridge_delegate` | 异步提交 schema-2.0 任务 |
| `pi_bridge_status` / `pi_bridge_logs` | 查询任务和独立验收、读取有限日志 |
| `pi_bridge_cancel` / `pi_bridge_resume` | 取消或恢复已知任务 |
| `pi_bridge_down` | 显式停止当前实例 |

每次调用填写同一聊天专属的 `instance`，例如 `chat-<Codex聊天ID>`。状态变更还需 `apply:true`。不同聊天使用不同实例；MCP 服务进程被复用时，调用仍按实例隔离。提交后持续查询 status，直到任务终止并审查验收结果。MCP 重连后使用原实例即可访问原状态。

如果只安装 MCP，在 Codex 项目说明中写明：委派给 Pi 时使用 `pi_bridge_*` 工具，每个聊天使用独立 instance，提交后轮询状态并验收 diff 和验证命令。

## 配置

| 设置 | 作用 |
| --- | --- |
| `BRIDGE_PI_CLI` | Pi 的 JS 入口或原生可执行文件绝对路径 |
| `BRIDGE_PI_PROVIDER` / `BRIDGE_PI_MODEL` | 可选模型覆盖；留空使用 Pi 默认模型 |
| `PI_BRIDGE_STATE_ROOT` / `--state-root` | Bridge 状态根目录 |
| `PI_BRIDGE_INSTANCE` / `--instance` | CLI 实例；默认从 Codex 线程环境变量读取 |

Windows 默认状态位于 LOCALAPPDATA/pi-bridge，macOS 为 ~/Library/Application Support/pi-bridge，Linux 为 XDG_STATE_HOME/pi-bridge 或 ~/.local/state/pi-bridge。与本机旧版 Bridge 使用独立目录。自定义 Pi 安装可通过环境变量指定入口；已有正确的 Pi 配置保持原样。

完整 CLI、任务 JSON 与恢复流程见 [技能运行说明](skills/pi-bridge/references/runtime.md)。

## 执行边界

运行环境使用 Pi 的现有主机权限。目录授权用于任务路由；更严格的文件和网络隔离需要运行环境提供。当前执行器接受显式 allowWrite:true、allowNetwork:true 的可信 host 整工作区任务；无法实施的只读、断网和子目录隔离要求会被拒绝。任务 constraints 表达用户的修改范围，Codex 仍需检查实际 diff。

只有独立验收命令通过才能给出 passed；worker 仅声明完成最多得到 partial。真实模型调用依赖用户自己的 Pi 服务访问和额度。本项目不修改认证或声明未经测量的额度节省。

## 验证

```text
npm test
npm run test:smoke
```

默认测试使用模拟 Pi，不请求模型。smoke 默认明确跳过真实服务；需要显式设置 BRIDGE_LIVE_TEST=1 才会尝试真实模型请求。

发布验证覆盖 Windows 上的任务状态机、取消与恢复、真实子进程、独立验收、MCP 握手与工具调用、聊天实例隔离和安装器。macOS/Linux 已按可移植 Node API 实现；尚未完成各平台实机完整模型验收。模拟 Pi 测试通过与真实模型可用性分别记录。

## 来源

由已有的本地 codex-pi-bridge 运行时整理并改进。Pi 与 MCP SDK 使用各自许可，本包未包含模型凭据、私人运行数据或 Pi 本体。
