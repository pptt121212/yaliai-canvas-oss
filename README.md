# Yali Canvas OSS

面向自托管与二次开发的 AI 画布和 OpenAI 兼容图像 API 网关。项目提供画布工作流、上游协议适配、智能路由、租户与计费等可组合能力。

## 商业化运营能力

本项目可作为图像生成 API 中转与运营平台的后端基础设施，而不仅是一个画布前端。部署者可以基于它搭建面向团队、客户或 SaaS 用户的图像生成服务：

- **多上游接入与协议适配**：统一管理 `Images Endpoint`、`Responses Endpoint` 和 `Chat Completions` 上游，对下游保持 OpenAI 兼容接口。
- **智能路由与高可用**：按线路健康度、并发压力、尺寸准确率与成本评分选路；支持自动回退、冷却/熔断、时间恢复、固定线路与优选线路模式。
- **租户与渠道控制**：按租户和 API Key 授权业务通道，配置请求频率、并发上限、固定线路和可用图像质量。
- **成本、售价与余额计费**：分别维护上游成本和下游售价，记录图像与 Chat Completions 流水、租户余额及可追溯的扣费明细。
- **运营可观测性**：提供请求追踪、审计日志、线路诊断、分辨率统计和可选的经营报表，便于定位失败、核对成本与评估线路质量。
- **异步任务与画布工作流**：支持图像异步任务、可恢复的画布运行记录和后台 Worker，适合将耗时图像任务从同步请求链路中解耦。

项目不替部署者决定上游服务商、价格、内容审核或当地合规策略。运营者应自行确认所接入上游的服务条款、模型授权、数据处理与计费规则，并在后台配置相应的通道、成本和售价。

## 界面预览

以下截图使用本地脱敏演示数据生成，不包含真实租户、密钥、上游地址或生产流水。

| 画布工作流 | 画布本地接口设置 |
| --- | --- |
| ![画布工作流](./docs/assets/canvas-workflow.png) | ![画布本地接口设置](./docs/assets/canvas-settings.png) |
| 后台运营总览 | 后台上游接入 |
| ![后台运营总览](./docs/assets/admin-overview.png) | ![后台上游接入](./docs/assets/admin-upstreams.png) |

## 服务边界

核心服务可按需求独立部署：

- `apps/api`：后端网关，负责上游管理、路由、租户、计费与异步任务。
- `apps/web`：画布前端，负责工作流编辑、交互与结果展示。
- `apps/admin`：管理后台，负责运行配置与运营管理。

- 只需要 API 网关时，可以仅部署 `apps/api`。
- 只需要画布时，可以仅部署 `apps/web`；未注入运行时配置时，它以浏览器本地模式运行。
- 需要完整平台能力时，将画布通过运行时配置接入本仓库的 API，或接入你自己的兼容后端。

二次开发时建议保持以下职责边界：

- 后端处理上游选择、鉴权、计费和异步编排。
- 前端处理工作流编辑、浏览器交互与本地执行体验。
- 服务之间通过明确的运行时配置和 API 契约集成，不依赖固定域名或固定宿主应用。

## 项目组成

- `apps/web`
  画布前端，负责工作流编辑、运行状态展示、结果回显。
- `apps/admin`
  管理后台，负责上游接入、业务通道、租户与下游 API Key 管理。
- `apps/api`
  网关后端，负责统一对外 API、上游路由、异步任务状态、后台管理接口。
- `packages/provider-core`
  上游协议与适配器抽象。
- `packages/workflow-schema`
  画布工作流共享结构定义。
- `packages/billing-core`
  额度与计费相关基础契约。

## 首次配置

首次启动后，请在管理后台完成：

1. 添加并测试上游 API。
2. 在业务通道中启用图像生成或文本处理线路。
3. 创建租户与下游 API Key。
4. 使用后台测试或标准下游接口验证请求链路。

仓库不预配置第三方上游；这使部署者能够自行控制模型、密钥、成本和路由策略。

## 当前支持的上游类型

后台接入向导和上游管理当前围绕三类接口：

- `Images Endpoint`
  标准 OpenAI Images 风格接口，对应：
  - `POST /v1/images/generations`
  - `POST /v1/images/edits`
- `Responses Endpoint`
  标准 OpenAI Responses 风格接口，用于图像工具链路封装。
- `Chat Completions`
  标准文本 / 视觉理解接口。

说明：

- 上游可以是 `Images Endpoint` 或 `Responses Endpoint`，但对下游统一暴露的图像接口仍然是标准 `Images Endpoint`。
- 也就是说，上游协议和下游协议不是强绑定一一对应关系。
- 画布前台的“自带 API”支持选择图片接口类型：`Images Endpoint` 或 `Responses Endpoint`。大爆炸、电商图等高级节点还需要 `Chat Completions` 做视觉理解。
- 用户自带 API 有两种保存方式：登录后保存到后端用户配置，或在设置模式下保存到浏览器本地。登录保存时密钥不会回传前端，运行画布时由后端根据会话补齐。
- 如果用户没有配置自带 `Chat Completions`，可以选择使用平台 Chat 兜底，或选择严格模式让高级节点直接报错。

## 本地开发

### 0. 准备工具链

- **Node.js 20.11+**（推荐 22，仓库 `.nvmrc` 已固定；用 `nvm use` 即可）。
- **pnpm**：本仓库通过 `packageManager` 固定 pnpm 版本，建议用 Corepack 自动对齐：

```bash
corepack enable
```

> 仓库已在根 `package.json` 声明 `engines`，Node / pnpm 版本不符会在安装时报错，避免用错版本导致的构建意外。

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

先复制：

```bash
cp apps/api/.env.example apps/api/.env
```

至少修改以下字段：

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `DATABASE_URL`
- `ADMIN_SESSION_SECRET`

如果你本地没有 Redis，可以先留空 `REDIS_URL`。

说明：

- `pnpm dev:api` 会读取 `apps/api/.env`。
- PostgreSQL 是正式持久层；未提供 `DATABASE_URL` 时 API 会拒绝启动。
- 本地单 API 开发可以不配置 Redis；启动 PM2 集群或 Worker 时必须配置 Redis。

### 3. 启动

```bash
pnpm dev:api      # 后端网关
pnpm dev:admin    # 管理后台
pnpm dev:web      # 画布前端
```

## 构建

推荐始终从仓库根构建。得益于 TypeScript 项目引用，工作区包会按依赖拓扑顺序自动先行构建，
无需手动记忆"先建哪个包"：

```bash
pnpm install
pnpm -r build          # 或 pnpm build
```

如需单独构建某个应用，直接：

```bash
pnpm --filter @yali/api build     # 会自动先构建它依赖的 workspace 包
pnpm --filter @yali/admin build
pnpm --filter @yali/web build     # 会自动先构建它依赖的 workspace 包
```

类型检查（不产出构建物）：

```bash
pnpm -r check          # 或 pnpm check
```

> 持续集成见 `.github/workflows/ci.yml`：每次提交都会在 Node 20 与 22 上，
> 用 `--frozen-lockfile` 做一次干净安装 + 全量 check + 全量 build，保证任何人 clone 后都能稳定构建。

## 生产部署最小步骤

### 1. 构建

```bash
pnpm install --frozen-lockfile
pnpm -r build
```

### 2. 准备运行环境

建议：

- Node.js 22+
- PostgreSQL 15+
- Redis 7+（PM2 集群与 Worker 必需；单 API 本地开发可省略）
- PM2 或 systemd

### 3. 配置生产环境变量

不要直接使用仓库中的值。至少明确设置：

- `PORT`
- `HOST`
- `DATABASE_URL`
- `PG_SCHEMA`
- `REDIS_URL`
- `ADMIN_DATA_DIR`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`
- `PUBLIC_API_BASE_URL`
- `DEFAULT_TEST_REFERENCE_IMAGE_URL`

注意：

- 必须提供 `DATABASE_URL`；提供的 PM2 模板还会启动 Worker，因此也必须提供 `REDIS_URL`。
- `ADMIN_DATA_DIR` 保存生成图片、画布临时参考图和接入探测预览图；正式配置与业务记录保存在 PostgreSQL。
- 如需启用 Nginx 内部加速图片文件，`GENERATED_IMAGE_ACCEL_REDIRECT_TARGET_DIR` 必须指向 `$ADMIN_DATA_DIR/generated-images`。

### 4. 启动 PM2

`deploy/api/ecosystem.config.cjs` 现在是通用模板，不再绑定某台固定服务器路径。

示例：

```bash
APP_CWD=/path/to/yaliai-canvas-oss/app \
PM2_APP_NAME=yali-canvas-api \
PM2_WORKER_APP_NAME=yali-canvas-worker \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD='change-this-now' \
ADMIN_SESSION_SECRET='replace-with-a-long-random-secret' \
DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/yali_canvas' \
PG_SCHEMA=public \
REDIS_URL='redis://127.0.0.1:6379' \
ADMIN_DATA_DIR='/path/to/yaliai-canvas-oss/data' \
PUBLIC_API_BASE_URL='https://api.example.com' \
DEFAULT_TEST_REFERENCE_IMAGE_URL='https://your-domain.example/test-assets/reference-test.png' \
GENERATED_IMAGE_ACCEL_REDIRECT_TARGET_DIR='/path/to/yaliai-canvas-oss/data/generated-images' \
pm2 start deploy/api/ecosystem.config.cjs
```

## 文档

- [部署总览](./docs/deployment.md)
- [仅部署 API](./docs/deployment-api-only.md)
- [仅部署画布](./docs/deployment-web-only.md)
- [完整联动部署](./docs/deployment-combined.md)
- [架构说明](./docs/architecture.md)
- [存储说明](./docs/storage.md)
- [集成说明](./docs/integration-guide.md)
- [上游管理说明](./docs/provider-management.md)
- [上游图像兼容性](./docs/upstream-image-compatibility.md)

## 许可协议

本项目基于 [MIT License](./LICENSE) 开源。
