# 后端单独部署

适用目标：

- 只部署 `apps/api`
- 可选部署 `apps/admin`
- 不部署 `apps/web`
- 对外提供 OpenAI-compatible 图像 API 网关与后台管理能力

## 1. 你会得到什么

部署完成后，你可以独立使用：

- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/chat/completions`
- `GET /v1/image/tasks/:taskId`
- `GET /v1/images/generations/:taskId`
- `GET /v1/images/edits/:taskId`
- 后台上游接入、业务通道、租户与密钥、请求追踪、路由诊断

你不会自动获得：

- 画布前端
- 浏览器本地模式
- 画布登录入口

## 2. 必需组件

- Node.js 22+
- pnpm 11+
- PostgreSQL 15+

如需使用提供的 PM2 模板或画布 Worker：

- Redis 7+
- PM2
- Nginx 或 Caddy

提供的 PM2 模板默认启动两个 API 进程和一个 Worker，因此此模式必须配置 Redis。只有本地单 API 进程且不启动 Worker 时，才可以省略 Redis。

## 3. 安装依赖

```bash
pnpm install --frozen-lockfile
```

## 4. 配置环境变量

参考：

- `apps/api/.env.example`

至少要配置：

```bash
PORT=4010
HOST=0.0.0.0
DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/yaliai_canvas'
PG_SCHEMA=public
ADMIN_USERNAME=admin
ADMIN_PASSWORD='change-this-now'
ADMIN_SESSION_SECRET='replace-with-a-long-random-secret'
```

推荐同时配置：

```bash
REDIS_URL='redis://127.0.0.1:6379'
ADMIN_DATA_DIR=/opt/yaliai-canvas-oss/data
PUBLIC_API_BASE_URL='https://api.example.com'
DEFAULT_TEST_REFERENCE_IMAGE_URL='https://your-domain.example/test-assets/reference-test.png'
GENERATED_IMAGE_ACCEL_REDIRECT_TARGET_DIR=/opt/yaliai-canvas-oss/data/generated-images
```

说明：

- `DATABASE_URL` 是必需项，不提供则 API 不应启动。
- `REDIS_URL` 对 PM2 集群、Worker、异步任务和共享热状态是必需项。
- `ADMIN_DATA_DIR` 用于生成图片、临时参考图和探测预览图等文件资产。

## 5. 初始化数据库

首次部署建议执行：

```bash
pnpm --filter @yali/api build

DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/yaliai_canvas' \
PG_SCHEMA=public \
pnpm --filter @yali/api bootstrap:postgres
```

## 6. 构建后端

```bash
pnpm --filter @yali/api build
```

如果你也要后台管理前端：

```bash
pnpm --filter @yali/admin build
```

## 7. 运行方式

### 开发模式

```bash
pnpm --filter @yali/api dev
```

如果要本地打开后台：

```bash
pnpm --filter @yali/admin dev
```

### 生产模式

推荐 PM2：

```bash
export APP_CWD=/opt/yaliai-canvas-oss/app
export PM2_APP_NAME=yali-canvas-api
export PM2_WORKER_APP_NAME=yali-canvas-worker
export NODE_ENV=production
export PORT=4010
export HOST=0.0.0.0
export DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/yaliai_canvas'
export PG_SCHEMA=public
export REDIS_URL='redis://127.0.0.1:6379'
export ADMIN_DATA_DIR=/opt/yaliai-canvas-oss/data
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD='change-this-now'
export ADMIN_SESSION_SECRET='replace-with-a-long-random-secret'
export PUBLIC_API_BASE_URL='https://api.example.com'
export DEFAULT_TEST_REFERENCE_IMAGE_URL='https://your-domain.example/test-assets/reference-test.png'
export GENERATED_IMAGE_ACCEL_REDIRECT_TARGET_DIR=/opt/yaliai-canvas-oss/data/generated-images

pm2 start deploy/api/ecosystem.config.cjs
pm2 save
```

## 8. 反向代理建议

推荐：

- API 域名：`https://api.example.com`
- 后台域名：`https://api.example.com/admin/` 或独立子域名

最少需要把请求反代到：

- API 运行端口，例如 `4010`

如果部署 `apps/admin/dist`：

- 挂载路径建议为 `/admin/`

## 9. 首次初始化顺序

建议顺序：

1. 登录后台
2. 配置上游接入
3. 打开业务通道并启用可用线路
4. 创建租户与密钥
5. 用后台测试或下游标准接口验证链路

## 10. 适合作为独立后端使用的典型场景

- 给第三方系统提供统一图像 API
- 做多上游图片网关
- 独立做计费与租户管理
- 只用后端，不用本仓库画布
