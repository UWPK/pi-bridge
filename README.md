# Pi Bridge

将 Codex 的有边界任务交给已安装的 Pi执行，并返回独立验收证据。提供 **Skill、命令行和 stdio MCP** 三种入口，使用同一套运行时。

- Windows、macOS、Linux 使用相同的 Node 程序，无需 PowerShell。
- 自动查找所选后端，支持 Pi 的 npm 全局安装、JS 入口和原生可执行程序。
- Pi 默认继承自己的模型、认证、代理和插件，也可指定 provider/model。
- 每个 Codex 聊天使用独立实例，保存任务、日志和恢复状态。
- 常驻 daemon 复用空闲 Pi worker；取消、超时、独立验收和失败恢复保持统一。

## 安装

前提：**Node.js >=22.19（推荐 24 LTS）、npm、Git、Codex，以及已配置可用模型的 Pi**。先确认Pi 的 `pi --help` 与 `codex --help` 正常。

三平台均可安装预构建包：

```text
npm install -g https://github.com/UWPK/pi-bridge/releases/download/v0.4.3/uwpk-pi-bridge-0.4.3.tgz
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

## 首次安装与验收

已发布的 v0.4.3 支持 `pi-bridge setup --apply`。本分支进一步提供分阶段诊断与 `--verify` 模型验收，需使用源码构建；这些增强尚未包含在 v0.4.3 发布包中。

```text
node bin/pi-bridge.mjs setup --apply
node bin/pi-bridge.mjs setup --apply --verify
```

第一步检查 Git、Pi 入口、启动与工作进程参数，安装 skill 并输出完整 MCP 配置，不调用模型。默认沿用 Pi 的模型与认证；`--pi-cli PATH`、`--profile inherit|minimal`、`--destination PATH` 可指定入口、工作进程和共享技能目录。重复运行会复用一致的 skill；发现本机修改时停止并保留文件。

第二步需明确选择 `--verify`：会连接模型（可能计费），在专用临时 Git 工作区让 Pi 创建一个小文件，并由独立命令核对内容。通过后停止测试实例、删除测试文件；失败保留诊断目录与任务 ID，不自动重试，也不会影响日常实例。重新验证会创建新测试任务，先检查上一轮结果，避免重复费用。

结果区分 `installed`（依赖与安装检查通过）、`verified`（CLI 模型任务和独立验收通过）、`blocked`（安装检查未通过）、`verification-failed`（模型或验收失败）。只有真实验收通过才返回 `modelVerified: true`；这仍不代表 Codex 的 MCP 连接或未来任务的权限已经验证。

权限由宿主应用控制。Pi 首次启动可能写入自己的状态目录；Bridge 也需要保存运行状态。输出中的 `permissions` 列出预期路径与进程，用户可在宿主支持时选择保留所需授权。程序不会修改宿主权限配置、关闭审核或扩大整个用户目录的访问范围。如果宿主在命令运行前拦截，程序无法捕获该拒绝，应查看宿主给出的具体理由。自动审核拒绝后停止，用户通过正式权限入口解决后再手动重试。

复制输出中的完整 MCP 配置，接入宿主并检查连接。以后复用已选择的入口和模型；只有工作区、模型或权限范围变化时才确认新选择。

## 接入 Skill

```text
pi-bridge install-skill --apply
```

默认安装至当前用户的 `~/.agents/skills/pi-bridge`。已有同名目录会停止；使用 `--destination <技能目录>` 安装到独立的代理配置环境。重启或新建 Codex 聊天，然后明确调用 `$pi-bridge`。

技能运行时需要全局命令 `pi-bridge`，或由代理使用已安装包中 `bin/pi-bridge.mjs` 的绝对路径。程序保持安装后才可使用技能。

## 首次配置时选择模型

安装或重装时，skill 会先询问缺失的服务商、模型选择；当前聊天已给出的选择会直接沿用。复用后端现有认证，凭据在本机处理。Pi 模型选择保存到 Bridge 专用配置，日常 PiDeck 默认模型保持原样。配置完成后，以实际安装包执行一次有独立验收的小任务。详见 [首次配置说明](skills/pi-bridge/references/setup.md)。

## 接入 MCP

推荐运行：

```text
pi-bridge mcp-config
```

将输出的配置片段加入目标 Codex 配置，或在界面中添加等效的 stdio 服务。输出自动使用本机 Node 和 MCP 程序的绝对路径，并包含所选后端入口和工作进程配置的环境段，适合桌面应用 PATH 与终端不同的情况。请复制包含 `[mcp_servers.pi_bridge.env]` 的完整片段。程序只显示配置，不重写当前设置。

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
| `PI_BRIDGE_WORKER_PROFILE` | Pi 工作进程配置：inherit（默认）或 minimal |
| `PI_BRIDGE_PI_ARGS` | Pi 显式加载参数的 JSON 字符串数组 |
| `PI_BRIDGE_INSTANCE` / `--instance` | CLI 实例；默认从 Codex 线程环境变量读取 |

Windows 默认状态位于 LOCALAPPDATA/pi-bridge，macOS 为 ~/Library/Application Support/pi-bridge，Linux 为 XDG_STATE_HOME/pi-bridge 或 ~/.local/state/pi-bridge。与本机旧版 Bridge 使用独立目录。自定义 Pi 安装可通过环境变量指定入口；已有正确的 Pi 配置保持原样。

完整 CLI、任务 JSON 与恢复流程见 [技能运行说明](skills/pi-bridge/references/runtime.md)。

## 插件较多时的精简工作进程

工作进程可独立配置：默认 `inherit` 完整继承 Pi；设置 `PI_BRIDGE_WORKER_PROFILE=minimal` 后，Bridge 工作进程关闭自动扩展、MCP、技能和提示模板加载。模型、认证和日常 PiDeck 配置保持原样。

通过 `PI_BRIDGE_PI_ARGS` 的 JSON 数组显式加回必要项，例如 `--extension` 加机器规则插件的绝对路径。也可在当前实例 `bridge.config.json` 的 `pi.profile` / `pi.args` 中配置。首次启动会检查所选 Pi 是否支持所需参数；缺少必要文件或不支持的参数会明确报错。不会硬编码某台 Mac 的路径，也不需要额外 Python 包装器。

在相同环境生成 `pi-bridge mcp-config`，CLI 与 MCP 即使用相同配置。`doctor` 显示加载配置和 Pi 报告的模型、thinking level。已有 daemon 需在任务结束后只重启对应实例。

更新验收默认采用可配置的 300 秒测试期限，生产任务的期限保持原设置。`agent_end` 后继续等待 `agent_settled`，再运行独立验收；超时和插件报错会保留为失败。具体配置、机器规则保留和更新步骤见 [工作进程配置](skills/pi-bridge/references/worker-profiles.md)。

## 执行边界

运行环境使用 Pi 的现有主机权限。目录授权用于任务路由；更严格的文件和网络隔离需要运行环境提供。当前执行器接受显式 allowWrite:true、allowNetwork:true 的可信 host 整工作区任务；无法实施的只读、断网和子目录隔离要求会被拒绝。任务 constraints 表达用户的修改范围，Codex 仍需检查实际 diff。

只有独立验收命令通过才能给出 passed；worker 仅声明完成最多得到 partial。真实模型调用依赖用户所选后端的服务访问和额度。本项目不修改认证或声明未经测量的额度节省。

## 验证

```text
npm test
npm run test:smoke
```

默认测试使用模拟 Pi，不请求模型。smoke 默认明确跳过真实服务；需要显式设置 BRIDGE_LIVE_TEST=1 才会尝试真实模型请求。

## 来源

由已有的本地 codex-pi-bridge 运行时整理并改进。Pi 与 MCP SDK 使用各自许可，本包未包含模型凭据、私人运行数据或 Pi 本体。

## Windows/macOS 安装验收入口

npm 安装发布 tarball 后运行：

```text
pi-bridge setup --apply
```

该命令检查 Git、实际 Pi `--help` 和选定 worker 参数，安装技能并返回完整 MCP
配置。相同技能可重复执行；已有不同内容不会覆盖。可用 `--destination PATH` 安装
到共享技能库，`--pi-cli PATH` 指定已有 Pi 入口。插件较多时显式选用
`--profile minimal`，并通过 `PI_BRIDGE_PI_ARGS` 保留任务需要的机器策略扩展。
默认保持 inherit，避免静默移除用户插件。命令不修改 Pi 认证或 Codex MCP 配置，
不请求模型；将输出的完整 MCP 配置注册后，再做真实任务验收。

GitHub Actions 在 Windows x64、Mac Apple Silicon 和 Intel Mac 执行源码测试，
再将 npm tarball 装入全新前缀，验证实际安装包的 setup、CLI、MCP 与独立验收。
这些使用模拟 Pi，不能替代目标电脑自身的模型认证和在线任务测试。


## 文档与许可证

- [Skill 入口](skills/pi-bridge/SKILL.md)：任务委派与结果审阅。
- [首次配置](skills/pi-bridge/references/setup.md)：模型选择、认证和安装处理。
- [运行契约](skills/pi-bridge/references/runtime.md)：CLI、MCP、任务格式与恢复。
- [验证范围](VALIDATION.md)：自动化测试与真实模型验收的区别。

本项目采用 [MIT License](LICENSE)。Pi、模型服务及其商标属于各自权利人，使用时遵循对应项目和服务条款。本项目不分发模型凭据。
