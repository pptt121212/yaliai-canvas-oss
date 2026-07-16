# Yali Canvas OSS

## Independent Services

This OSS project is intentionally split into two deployable services:

1. `apps/api`: backend API routing, upstream provider management, tenant keys, billing, async tasks
2. `apps/web`: frontend canvas UI

They are allowed to run independently.

- If you only need the backend gateway, you can deploy `apps/api` without `apps/web`.
- If you only need the canvas UI, you can deploy `apps/web` alone. It now boots in standalone local mode by default and does not call this repository's backend unless you explicitly inject runtime config.
- The only accepted coupling is optional login-mode authorization, where the canvas uses a tenant API key or tenant session exposed by your own backend.

Open-source integration rule:

- keep provider routing, tenant auth, billing, and async orchestration in the backend
- keep workflow editing, local-mode execution, and browser-side UX in the frontend
- do not hardcode one service as the mandatory runtime of the other
 
Deployment docs:
 
- [Deployment Overview](./docs/deployment.md)
- [API Only Deployment](./docs/deployment-api-only.md)
- [Web Only Deployment](./docs/deployment-web-only.md)
- [Combined Deployment](./docs/deployment-combined.md)
 
一个面向开源场景的 AI 画布与图像 API 网关项目。

它的目标不是复刻某个特定站点的现网实现，而是提供一套可以独立部署、继续二次开发、并且便于接入不同上游 API 的通用基础设施。

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

## 开源项目默认原则

这个仓库默认遵循以下规则：

- 不内置任何真实生产域名、真实服务器路径、真实默认账号密码。
- 不默认预置任何你必须信任的第三方上游 API。
- 不把某个私有业务通道当作开箱即用默认值。
- 默认测试资源尽量使用仓库自带静态资源，而不是外部站点资源。

如果你 clone 后发现系统里没有任何上游线路，这是设计使然，不是缺失功能。

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

如果你本地没有 Redis，可以先留空 `REDIS_URL`。

说明：

- 本项目现在统一以 PostgreSQL 作为正式持久层。
- 不再建议也不再支持用本地 JSON 作为运行时正式配置存储。
- 未提供 `DATABASE_URL` 时，API 会直接拒绝启动。

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
- Redis 7+（可选但推荐）
- PM2 或 systemd

### 3. 配置生产环境变量

不要直接使用仓库中的值。至少明确设置：

- `PORT`
- `HOST`
- `DATABASE_URL`
- `REDIS_URL`（可选）
- `ADMIN_DATA_DIR`
- `PROVIDER_DATA_DIR`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `DEFAULT_TEST_REFERENCE_IMAGE_URL`

注意：

- 必须提供 `DATABASE_URL`。
- `ADMIN_DATA_DIR` / `PROVIDER_DATA_DIR` 仍可用于测试资源、临时文件、生成图片等目录，但不应该再承担正式配置持久化。

### 4. 启动 PM2

`deploy/api/ecosystem.config.cjs` 现在是通用模板，不再绑定某台固定服务器路径。

示例：

```bash
APP_CWD=/path/to/yali-canvas-oss \
PM2_APP_NAME=yali-canvas-api \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD='change-this-now' \
DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/yali_canvas' \
REDIS_URL='redis://127.0.0.1:6379' \
ADMIN_DATA_DIR='/path/to/yali-canvas-oss/data' \
PROVIDER_DATA_DIR='/path/to/yali-canvas-oss/data' \
DEFAULT_TEST_REFERENCE_IMAGE_URL='https://your-domain.example/test-assets/reference-test.png' \
pm2 start deploy/api/ecosystem.config.cjs
```

## 首次部署后你需要做什么

第一次启动后，系统不会自动给你塞一堆默认上游。

你需要按顺序完成：

1. 登录后台
2. 新增或探测上游 API
3. 在“业务通道”里决定哪些上游加入图像生成或文本处理
4. 创建租户与下游 API Key
5. 用后台测试或下游标准接口验证链路

## 默认不再内置的业务逻辑

为了更适合开源分发，仓库已经去掉或弱化了以下默认绑定：

- 不再内置真实生产后台账号密码
- 不再在 PM2 配置里写死真实生产目录
- 不再在仓库默认 provider seed 中预置某个私有上游
- 不再默认依赖真实生产域名作为测试参考图地址
- 不再把画布的登录跳转和充值跳转强绑到 `/admin/`

这些都应该由部署者自己配置。

## 文档

- [架构说明](./docs/architecture.md)
- [生产部署指南](./docs/deployment.md)
- [存储说明](./docs/storage.md)
- [集成说明](./docs/integration-guide.md)
- [上游管理说明](./docs/provider-management.md)
- [上游图像兼容性](./docs/upstream-image-compatibility.md)

## 许可协议

本项目基于 [MIT License](./LICENSE) 开源。
