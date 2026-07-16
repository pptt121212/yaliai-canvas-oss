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
- `GET /v1/images/tasks/:id`
- 后台上游接入、业务通道、租户与密钥、请求追踪、路由诊断

你不会自动获得：

- 画布前端
- 浏览器本地模式
- 画布登录入口

## 2. 必需组件

- Node.js 22+
- pnpm 11+
- PostgreSQL 15+

强烈建议：

- Redis 7+
- PM2
- Nginx 或 Caddy

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
ADMIN_USERNAME=admin
ADMIN_PASSWORD='change-this-now'
```

推荐同时配置：

```bash
REDIS_URL='redis://127.0.0.1:6379'
ADMIN_DATA_DIR=/opt/yali-canvas-oss/data
PROVIDER_DATA_DIR=/opt/yali-canvas-oss/data
DEFAULT_TEST_REFERENCE_IMAGE_URL='https://your-domain.example/test-assets/reference-test.png'
```

说明：

- `DATABASE_URL` 是必需项，不提供则 API 不应启动。
- `REDIS_URL` 对高并发、多进程、异步任务、共享热状态非常重要。
- `ADMIN_DATA_DIR` / `PROVIDER_DATA_DIR` 用于临时图片、测试资源、生成图缓存等文件资产。

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
export APP_CWD=/opt/yali-canvas-oss
export PM2_APP_NAME=yali-canvas-api
export NODE_ENV=production
export PORT=4010
export HOST=0.0.0.0
export DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/yaliai_canvas'
export REDIS_URL='redis://127.0.0.1:6379'
export ADMIN_DATA_DIR=/opt/yali-canvas-oss/data
export PROVIDER_DATA_DIR=/opt/yali-canvas-oss/data
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD='change-this-now'
export DEFAULT_TEST_REFERENCE_IMAGE_URL='https://your-domain.example/test-assets/reference-test.png'

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
