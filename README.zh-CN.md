# @A42Null/dsh-opencode-zen-plugin

[English](./README.md) | **简体中文**

DeepSeek Harness 插件：自动适配 [OpenCode Console (Zen) 模型目录](https://opencode.ai/v2/docs/console/models)。

- GitHub：<https://github.com/A42Null/dsh-opencode-zen-plugin>
- CNB 制品库：<https://cnb.cool/A42Null/dsh-opencode-zen-plugin>
- npm 包名：`@A42Null/dsh-opencode-zen-plugin`（安装方式见下文）

**只需在「设置 → 插件」粘贴 OpenCode Console 的 API Key，即可在 DSH 中选用 Console 提供的对话模型** —— 模型列表、上下文窗口、端点路由、推理参数自动完成。

它不做的事：不能让 `*-free` 免费模型可用（只能在 OpenCode 客户端内运行）；会跳过 `jev-*` SystemOne 模型（不支持对话）；付费模型仍需 Console 账户有余额。

## 功能特性

- **零配置模型目录**：启动时及定时（默认 300 秒）拉取 `https://opencode.ai/zen/v1/models`（该接口无需鉴权），自动出现在 DSH 模型选择器中
- **四协议自动路由**（依官方文档端点表）：
  - `gpt-*` / `grok-*` / `muse-spark*` → OpenAI Responses API（`/zen/v1/responses`）
  - `claude-*` 及 `qwen3.8-flash` / `qwen3.7-max` / `qwen3.7-plus` / `qwen3.6-plus` / `qwen3.5-plus` → Anthropic Messages（`/zen/v1/messages`）
  - `gemini-*` → Google GenerateContent（`/zen/v1/models/<id>:streamGenerateContent?alt=sse`）
  - `deepseek` / `glm` / `minimax` / `kimi` / `qwen3.8-max` / `big-pickle` / `*-free` → OpenAI 兼容（`/zen/v1/chat/completions`）
- **元数据自动同步**：上下文窗口、输出预算、推理档位优先取 [models.dev](https://models.dev/api.json)（7 天磁盘缓存 `~/.opencode-zen/models.dev.json`），离线时回退插件内置静态目录，永远可用
- **免费模型默认隐藏**：`*-free` 属于 OpenCode 客户端内部的免费层，经 Console API 调用会返回 `403 FreeTierError`（"free tier can only be used from within OpenCode"），因此默认不列入模型列表；需要时可在设置中开启
- **账务/权限错误可读**：余额不足（402）、模型无访问权限（403 Model access is disabled）、免费层受限（403 FreeTierError）各自映射为独立错误码并附带处理建议，不再笼统显示为"密钥无效"
- **推理参数透传**：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` 阶梯，自动映射各协议原生字段（`reasoning_effort`、`thinking.budget_tokens`、`thinkingConfig.thinkingBudget`、`reasoning.effort`）
- **完整 Harness 流协议**：文本 / 推理 / 工具调用分块流式输出、usage 计费、停止原因映射与错误分类（AUTH、QUOTA、FREE_TIER_BLOCKED、MODEL_ACCESS_DISABLED、RATE_LIMIT、INVALID_REQUEST、SERVER、TIMEOUT、TRANSPORT、CONTEXT_WINDOW_EXCEEDED、EMPTY_RESPONSE）
- **工具调用与图片输入**：vision 模型（claude- / gemini- / deepseek-v4-flash-vision 等）支持图片附件
- **流看门狗**：120 秒首包 / 300 秒空闲超时自动中止，避免挂死

## 安装

**方式一与方式二都不需要本机安装 git**；方式三（GitHub 源码）需要。

### 方式一：预构建 tarball（推荐，无需 git）

在 DSH「设置 → 插件 → 添加插件」里粘贴，或命令行执行：

```bash
dsh plugin add https://github.com/A42Null/dsh-opencode-zen-plugin/releases/latest/download/dsh-opencode-zen-plugin.tgz
```

该地址始终指向最新版本（Release 资产名不含版本号，因此不会随发版失效）。

### 方式二：CNB 制品库（无需 git）

包已发布到 <https://cnb.cool/A42Null/dsh-opencode-zen-plugin>（npm 包名 `@A42Null/dsh-opencode-zen-plugin`）：

```bash
npm config set @A42Null:registry https://npm.cnb.cool/A42Null/dsh-opencode-zen-plugin/-/packages/
dsh plugin add @A42Null/dsh-opencode-zen-plugin
```

### 方式三：GitHub 源码（一条命令最便捷；⚠️ 需要本机已安装 git 且在 PATH 中）

```bash
dsh plugin add github:A42Null/dsh-opencode-zen-plugin
```

pnpm 会调用 `git ls-remote` 解析该仓库。若机器没装 git，会报
`Command failed: git ls-remote "git+ssh://git@github.com/…"` 或 `'git' 不是内部或外部命令`——
此时请改用方式一/方式二，或先安装 [Git for Windows](https://git-scm.com/download/win)。

### 方式四：本地目录（开发调试用）

`dsh plugin add D:\DSH\插件开发\opencode-zen-dsh-plugin`，或通过插件管理器安装本地包目录。

### 通用

1. 安装后重启 DSH（或重载插件），插件自动注册 provider `opencode-zen`（可经 `cordis.patch.yml` 的 `providerId` 覆盖）

插件包内含 `dsh.bundle.patch`（`cordis.patch.yml`），安装时自动向 profile 补丁写入注册行；同时通过 `dsh.client` 提供 Web 设置卡片。

## 配置（设置 → 插件 → OpenCode Zen → 配置）

> DSH 的设置界面由插件的**客户端半部**（`lib/client.js`）贡献：本插件注册到 `plugins.row.config` 插槽（key = `<包名>#<行 id>`），因此在「设置 → 插件」里 opencode-zen 一行会出现「配置」入口。仅安装 host 半部（`lib/index.js`）时模型可用，但**不会**有任何设置界面。

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `apiKey` | OpenCode Console API Key，**必填**。在 https://opencode.ai/console 登录后获取 | 空 |
| `baseUrl` | OpenCode Zen 网关地址 | `https://opencode.ai/zen` |
| `includeFreeModels` | 是否包含免费（`*-free`）模型；**默认关闭**，因为它们只能在 OpenCode 客户端内使用 | `false` |
| `refreshSeconds` | 模型目录自动刷新间隔（秒，30–86400） | `300` |

保存后立即生效，无需重启 DSH。作为兜底，也可用环境变量 `OPENCODE_ZEN_API_KEY` 提供 Key（配置项优先）。

## 鉴权

所有端点使用 `Authorization: Bearer <apiKey>`；Anthropic 端点同时附加 `x-api-key` 与 `anthropic-version: 2023-06-01`，Google 端点同时附加 `x-goog-api-key`。模型列表接口无需鉴权，未填 Key 时也能看到模型，但实际调用会返回 AUTH 错误提示。

## 运行状态与缓存

| 路径 | 内容 |
| --- | --- |
| `~/.opencode-zen/adapter-status.json` | 目录健康快照：`status` / `total` / `updatedAt` / `lastError` |
| `~/.opencode-zen/models.dev.json` | models.dev 元数据缓存（7 天有效，tmp+rename 原子写入） |
| `~/.opencode-zen/plugin-load.json` | 最近一次插件加载标记（`build` / `loadedAt` / `pid`），用于确认运行中的是哪一版代码 |
| `~/.opencode-zen/errors.log` | 适配器失败原始记录：时间、HTTP 状态、协议、模型、错误码、响应体片段（上限 128 KB，超出自动清空） |

> 错误码命名对齐 DSH 规范：余额不足用 `QUOTA`（命中客户端"当前请求的额度已用尽"文案与全局欠费提示），密钥问题用 `AUTH`，免费层门禁用 `FREE_TIER_BLOCKED`，模型无权限用 `MODEL_ACCESS_DISABLED`（后两者在界面直接展示插件给出的中文说明）。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 安装失败：`git ls-remote` / `'git' 不是内部或外部命令` | 该机器没装 git，而 `github:` 源码安装需要它 → 改用方式一（预构建 tarball）或方式二（CNB 制品库），或先安装 Git for Windows |
| AUTH 错误 | 未填 API Key 或 Key 无效 → 在「设置 → 插件 → OpenCode Zen → 配置」粘贴；模型列表无需鉴权，故 Key 缺失时仍能看到模型 |
| FREE_TIER_BLOCKED（403 FreeTierError） | 选了 `*-free` 免费模型。免费层只能在 OpenCode 客户端内使用 → 关闭"包含免费模型"或改用付费模型 |
| QUOTA（402 Insufficient account funds） | Key 有效但 Console 账户余额不足 → 到 https://opencode.ai/console 充值 |
| MODEL_ACCESS_DISABLED（403 Model access is disabled） | 该 Console 账号没有此模型的访问权限 → 换一个模型 |
| RATE_LIMIT（429） | 调用频率超限 → 稍后重试 |
| 设置里找不到 opencode-zen | 客户端半部未被加载（旧版安装/未重启）→ 确认 `lib/client.js` 存在、`package.json` 含 `dsh.client` 与 `"./client"` 导出，然后重启 DSH 并刷新页面 |
| SERVER / TRANSPORT / TIMEOUT | 网关或网络异常 → 稍后重试；查看 `adapter-status.json` 的 `lastError` |
| CONTEXT_WINDOW_EXCEEDED | 输入超出模型上下文窗口 → 缩短会话或换更大窗口的模型 |
| 模型列表为空或陈旧 | live 列表失败时自动回退内置静态目录；检查 `adapter-status.json` |
| `jev-*` 报 INVALID_REQUEST | 该系列走 SystemOne 专用端点，不支持对话，已从目录排除 |

## 发布（维护者）

推送与 `package.json` 中 `version` 一致的标签，即自动发布到 CNB 制品库（工作流 [`.github/workflows/publish.yml`](.github/workflows/publish.yml)）：

```bash
npm version patch --no-git-tag-version   # 或手动修改 package.json 的 version
git commit -am "chore: release vX.Y.Z"
git tag vX.Y.Z
git push origin main --follow-tags
```

令牌配置（一次性）：在 GitHub 仓库 `Settings → Environments` 新建名为 **`cnb`** 的环境，并在该环境中添加 **Environment secret**：

| Secret 名 | 值 |
| --- | --- |
| `CNB_TOKEN` | CNB 访问令牌（生成时需勾选「制品库」权限） |

工作流只从该 Environment secret 读取令牌，**仓库内不保存任何令牌**；CNB 的 npm 用户名固定为 `cnb`（如需不同可在工作流的 `CNB_USERNAME` 中修改）。标签版本与 `package.json` 不一致时任务会直接失败，避免发错版本。

## 文档

- OpenCode Console 模型与端点：https://opencode.ai/v2/docs/console/models
- OpenCode Console（付费网关）：https://opencode.ai/console
