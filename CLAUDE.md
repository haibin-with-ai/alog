# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

VoiceLog 是一个基于 SwiftUI 构建的 iOS 语音日记应用，允许用户录制音频条目，使用语音识别进行转录，并生成 AI 驱动的摘要。该应用包括 watchOS 支持、小组件和用于 AI 处理的 Cloudflare Workers 后端。

- iOS 部署目标：16.0+；watchOS 部署目标：9.0+
- Bundle ID：`app.haibin.voicelog`（主应用）、`.watch`（手表）、`.widget` / `.watch.widget`（小组件）
- 仓库内既有 iOS 仓库前称 `alog`（App Store 名称），代码内称 VoiceLog（产品名）— 两个名称可互换出现。

## 开发命令

### 项目设置
```bash
# 安装依赖
bundle install

# 设置环境
cp .env.example .env
# 使用你的 HMAC_KEY 更新 .env 文件

# 生成 Arkana 密钥包
bundle exec bin/arkana

# 生成 Xcode 项目（修改 project.yml 后必须重跑）
xcodegen
```

### 构建与测试（CLI）
```bash
# 通过 fastlane 跑单元测试（使用 iPhone 15 Pro 模拟器）
bundle exec fastlane tests

# 上传 TestFlight beta（需要 match 凭证 + BUILD_NUMBER 环境变量）
bundle exec fastlane beta
```
CI（`.github/workflows/run-unit-tests.yml`）只在 `release/*` 分支上运行测试。

### 本地化
```bash
# 从 CSV 生成本地化文件
rake l10n
# 或直接运行：
scripts/l10n Localizable.csv --swift Shared/Localization/LocalizedKeys.swift --root Shared/Localization
```

### 服务器部署
```bash
cd Server
npm install
npm run deploy  # 部署到 Cloudflare Workers
npm run start   # 本地开发
```

### 测试
- **VoiceLogTests**：iOS 单元测试 target（在 Xcode 内运行，或通过上面的 fastlane CLI）
- **SnapshotTests**：UI 快照测试 target，必须使用 **Snapshot** 构建配置 — 该配置定义了 `SNAPSHOT` 编译条件，应用代码会据此切换到确定性的快照夹具（详见 `Sources/App/AppDelegate+SnapshotTesting.swift`）。

## 架构

### 客户端（iOS/watchOS）
- **主应用**：基于 SwiftUI 的 iOS 应用，使用 Core Data 持久化
- **手表应用**：watchOS 伴侣应用，具有录制功能
- **小组件**：iOS 和 watchOS 小组件，用于快速访问
- **共享组件**：跨平台使用的通用代码

### 关键目录
- `Sources/App/`：主应用入口点、配置和应用级状态（`AppState`、`Config`、`Constants`、`MainView`）
- `Sources/Modules/`：按功能切分的特性模块 — `Recording`、`Timeline`、`Summary`、`Settings`、`Premium`、`Export`
- `Sources/Services/`：业务逻辑 — `Transcription/`、`OpenAI/`（`OpenAIClient`）、`IAP/`、`AudioPlayer/`、`Export/`
- `Sources/DataModel/`：Core Data（`DataModel.xcdatamodeld`、`MemoEntity`、`SummaryEntity`、`PromptEntity`、`UsageEntity`）
- `Sources/Components/`：可重用的 SwiftUI 组件
- `Sources/Models/`：枚举与值模型（`OpenAIChatModel`、`TranscriptionProvider/Model/Lang`、`ServerType`、`DarkMode`）
- `Shared/`：跨平台代码（`Recorder/`、`Connectivity.swift`、`Localization/`、`Intents/`）
- `Packages/`：本地 Swift 包（`XLog`、`XLang`）；`ArkanaKeys/` 由 arkana 生成（不入库）

### 后端（Cloudflare Workers）
- `Server/src/worker.js`：处理转录和摘要请求的主要 Worker
- 与 OpenAI API 集成，进行语音转文本和聊天补全
- 支持 HMAC 认证和请求验证

## 关键技术

### iOS/watchOS
- **SwiftUI**：UI 框架
- **Core Data**：本地持久化（MemoEntity、SummaryEntity）
- **KeychainAccess**：安全 API 密钥存储
- **DSWaveformImage**：音频可视化
- **ConfettiSwiftUI**：庆祝效果
- **TPPDF**：PDF 导出功能

### 外部服务
- **OpenAI API**：Whisper 转录和 GPT 摘要
- **Cloudflare Workers**：无服务器后端部署
- **Apple Speech Framework**：设备端转录选项

### 开发工具
- **XcodeGen**：从 YAML 配置生成项目
- **Arkana**：安全密钥管理
- **Fastlane**：iOS 部署自动化
- **Ruby/Rake**：本地化和构建脚本

## 配置

### 应用配置
- `Config.swift`：使用 @AppStorage 的集中式应用设置
- `Constants.swift`：API 端点、限制和应用元数据
- 环境变量存储在 `.env` 文件中

### 服务器配置
- `wrangler.toml`：Cloudflare Workers 配置
- 在 Cloudflare 仪表板中设置的环境变量：
  - `OPENAI_KEY`：OpenAI API 密钥（必需，逗号分隔多 key 时随机轮询）
  - `HMAC_KEY`：认证密钥（可选）
  - `AI_MODEL`：默认 AI 模型（可选）
  - `DISCORD_WEBHOOK_URL`：可选；设置后 `/v1/audio/transcriptions` 成功响应的转录文本会被异步转发到该 Discord webhook（`event.waitUntil` 不阻塞主响应；超 2000 字符自动分片）。**仅在客户端使用 OpenAI Whisper 转录时生效**，Apple 设备端转录不经过 Worker。

## 数据模型

### Core Data 实体
- **MemoEntity**：带有元数据的音频日记条目
- **SummaryEntity**：与备忘录关联的 AI 生成摘要

### 关键模型
- `TranscriptionProvider`：Apple vs OpenAI 转录
- `OpenAIChatModel`：GPT 模型选择
- `ServerType`：默认 vs 自定义服务器配置

### 自动转录两条触发路径（不能互相重复）
- **前台路径**：`TimelineViewModel.contextDidSave` 监听 Core Data 插入，触发 `Transcription.shared.transcribe(memo)`。仅在 TimelineView 实例化时有效。
- **后台路径**（Watch 录音专用）：`DataContainer.transcribeWatchMemoInBackground(_:)` 在 `didReceiveFileFromWatch` 收到文件并 `context.save()` 之后立即触发。后台时用 `UIApplication.beginBackgroundTask` 续命，前台时不申请额外时间。
- **去重**：`Transcription.shared` 内部用 `Set<NSManagedObjectID>` 跟踪在飞任务，第二条路径的调用会被跳过；前台 ViewModel 通常先抢到，后台路径作为 Alog 未启动时的兜底。

## 构建配置

- **Debug**：开发版本。`VoiceLog` scheme 在运行时启用 `-com.apple.CoreData.ConcurrencyDebug 1` 和 `-com.apple.CoreData.SQLDebug 1`（见 `project.yml`）。
- **Snapshot**：快照测试专用，编译条件为 `[DEBUG, SNAPSHOT]`。
- **AppStore**：生产签名的发布版本。

## 本地化

- 使用基于 CSV 的本地化工作流
- `Localizable.csv` 包含英语和简体中文的翻译
- 生成的 Swift 文件提供对本地化字符串的类型安全访问

## URL Scheme

应用支持自定义 URL scheme：`voicelog://`，由 `AppState.openURL(_:)` 处理。已实现的 host：
- `voicelog://record` — 立即开始录音
- `voicelog://note` — 弹出 quickMemo（手动文字笔记）
- `voicelog://summarize` — 触发当天的 AI 摘要（需 `Config.sumEnabled`）

用于 Siri 快捷指令、小组件和首页 quick action（见 `Sources/App/QuickAction.swift` 与 `StartupOption` 中的 `record` / `create_note`）。

## 测试策略

- **单元测试**：`VoiceLogTests` 目标中的核心逻辑和工具
- **快照测试**：`SnapshotTests` 目标中的 UI 组件快照
- 使用 Snapshot 配置确保一致的测试环境

## IAP 和高级功能

- 高级产品 ID：`app.haibin.voicelog.premium`，通过 `IAPManager` 服务管理。
- 高级用户每日字符上限提升 5 倍（`Constants.Limit.daily_characters` × 5）。
- ⚠️ **当前 build 默认强制开启 Premium**：`AppState.init()` 会把 `isPremium` 写为 `true` 并存到 keychain（commit `218d15b 自动打开内购`）。如果在未付费的真实购买流程上做改动，需要先回滚这段逻辑，否则测试用例会"看起来都已订阅"。

## 服务器请求路径

`Server/src/worker.js` 只接受两条路由（其它返回 404）：
- `POST /v1/audio/transcriptions` — 透传到 OpenAI Whisper
- `POST /v1/chat/completions` — 透传到 OpenAI Chat（如果设置了 `AI_MODEL`，会强制覆盖客户端模型；同时只保留 `messages[0]`，丢弃其余消息）

请求大小硬上限 12 MiB；如果设置了 `HMAC_KEY`，客户端必须发送 `x-alog-request-id` 与 `x-alog-hmac` header（密钥需与 `.env` 中的 `HMAC_KEY` 一致）。`OPENAI_KEY` 支持以英文逗号分隔的多个 key，每次请求随机选一个。