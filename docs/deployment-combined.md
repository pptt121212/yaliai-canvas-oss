# 两者联动部署

适用目标：

- 同时部署 `apps/api` 与 `apps/web`
- 通常也同时部署 `apps/admin`
- 使用完整的租户体系、业务通道、智能路由、后台接入、画布登录模式

这是本项目的完整能力部署方式。

## 1. 典型架构

推荐结构：

1. `apps/api`
   运行在 Node.js 进程中，负责 API 路由、异步任务、后台接口。
2. `apps/admin`
   作为后台静态前端，挂载到 `/admin/`。
3. `apps/web`
   作为画布静态前端，挂载到 `/` 或独立子域名。

推荐域名示例：

- API 与后台：`https://api.example.com`
- 画布：`https://canvas.example.com`

也可以同域部署：

- 画布：`https://example.com/`
- 后台：`https://example.com/admin/`
- API：`https://example.com/v1/...`

## 2. 你会得到什么

完整联动部署后，你可以使用：

- 后台上游接入与探测
- 业务通道
- 租户与密钥
- 计费与余额
- 请求追踪与路由诊断
- 画布登录模式
- 画布通过租户授权执行工作流
- 画布本地模式与登录模式切换

## 3. 必需组件

- Node.js 22+
- pnpm 11+
- PostgreSQL 15+

强烈建议：

- Redis 7+
- PM2
- Nginx 或 Caddy

## 4. 安装依赖

```bash
pnpm install --frozen-lockfile
```

## 5. 配置环境变量

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

## 6. 初始化数据库

```bash
pnpm --filter @yali/api build

DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/yaliai_canvas' \
PG_SCHEMA=public \
pnpm --filter @yali/api bootstrap:postgres
```

## 7. 构建所有需要的应用

```bash
pnpm --filter @yali/api build
pnpm --filter @yali/admin build
pnpm --filter @yali/web build
```

## 8. 启动后端

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

## 9. 部署前端静态资源

后台前端：

- 构建产物：`apps/admin/dist`
- 推荐挂载路径：`/admin/`

画布前端：

- 构建产物：`apps/web/dist`
- 推荐挂载路径：`/`

## 10. 画布如何与后端联动

联动部署时，画布通过运行时配置或宿主页面注入，拿到这些能力：

- `sessionEndpoint`
- `canvasRunStartEndpoint`
- `canvasRunStatusEndpoint`
- `canvasRunCancelEndpoint`
- `clearCanvasEndpoint`
- `packageCanvasEndpoint`
- 登录相关用户接口
- 租户 API 配置与价格信息

推荐做法：

- 让 `apps/web` 所在域名把 `/v1/*` 反代到 `apps/api`
- 或在宿主页面注入完整的 `window.yaliCanvasRuntime`

## 11. 首次初始化顺序

建议顺序：

1. 登录后台
2. 配置上游接入
3. 在业务通道中启用可用线路
4. 创建租户与密钥
5. 测试后台下游 API 是否生图正常
6. 打开画布，验证登录模式与本地模式
7. 验证画布生成是否能正确进入请求追踪、计费、路由诊断

## 12. 这种模式下的职责边界

建议长期保持：

- 后端负责：路由、计费、租户、鉴权、异步任务、上游适配
- 前端负责：画布编辑、交互、本地模式执行、登录模式入口

不要把以下逻辑写死进前端：

- 上游选择
- 成本计算
- 业务通道策略
- 智能路由
- 租户余额判断

这些都应留在后端。
