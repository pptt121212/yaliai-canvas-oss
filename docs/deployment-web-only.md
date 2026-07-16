# 前端单独部署

适用目标：

- 只部署 `apps/web`
- 不部署 `apps/api`
- 画布默认以本地模式独立运行
- 用户在浏览器中自行填写 Images Endpoint / Chat Completions

## 1. 你会得到什么

部署完成后，你可以独立使用：

- 工作流画布编辑
- 本地模式下的文生图 / 图生图
- 用户自填 Images Endpoint
- 用户自填 Chat Completions

你不会自动获得：

- 平台租户与密钥
- 计费
- 上游接入管理
- 智能路由
- 平台后台登录体系

## 2. 必需组件

- Node.js 22+
- pnpm 11+

不需要：

- PostgreSQL
- Redis
- 本仓库后端 API

## 3. 安装依赖

```bash
pnpm install --frozen-lockfile
```

## 4. 构建前端

```bash
pnpm --filter @yali/web build
```

产物目录：

- `apps/web/dist`

## 5. 开发模式

```bash
pnpm --filter @yali/web dev
```

## 6. 生产部署

把以下目录部署到任意静态托管环境：

- `apps/web/dist`

可选托管方式：

- Nginx
- Caddy
- 宝塔静态站点
- CDN / 对象存储静态托管
- Vercel / Netlify / Cloudflare Pages

## 7. 默认行为

前端单独部署时，画布默认是：

- 本地模式
- 不主动请求本仓库后端
- 不伪造登录态
- 不默认写死 `/v1/images/*` 或 `/v1/canvas/*`

也就是说，用户首次打开后，需要自己填写：

- Images Generations Endpoint
- Images Edits Endpoint
- Images API Key
- Chat Completions Endpoint
- Chat API Key

## 8. 对上游的实际要求

前端单独部署能否正常使用，取决于用户填写的上游是否满足：

- 支持标准 Images Endpoint 或兼容格式
- 浏览器可直接访问
- 允许当前前端站点跨域访问

如果上游不允许浏览器跨域访问，即使接口本身可用，前端单独部署也无法直接调用。

## 9. 可选运行时注入

如果你仍想在“前端单独部署”基础上做轻量集成，可以在宿主页面注入：

```html
<script>
  window.yaliCanvasRuntime = {
    userControl: {
      enabled: true,
      entryMode: 'settings'
    }
  };
</script>
```

也可以继续注入自定义：

- `logoIconUrl`
- `maxReferenceImages`
- `maxReferenceImageBytes`
- `maxConcurrentGenerations`

## 10. 适合作为独立前端使用的典型场景

- 私人工具站
- 内部设计工具
- 只做浏览器本地执行的图像工作台
- 给现有系统嵌入一个不依赖本仓库后端的画布
