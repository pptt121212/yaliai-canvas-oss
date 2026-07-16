# 后台设计规范 · 石板控制台（Slate Console）

> 适用范围：`apps/admin`（Yali Canvas OSS 图像 API 网关后台）
> 目标：高密度信息后台，视觉简洁、阅读轻松、交互友好，具备统一克制的设计语言。
> 技术底座：React 19 + TypeScript + Ant Design v5（已有 `ConfigProvider`）。
> 本文是"先规范、后落地"的第一份产物；所有页面改造以本文为准。

---

## 0. 设计原则（气质定调）

**石板控制台**：像一台精密仪表盘。安静、工程感，辨识度来自克制而非色彩。

1. **中性优先，色彩承载语义**：界面骨架由冷调灰阶构成；彩色只用于状态与关键动作，绝不用于装饰。
2. **描边分层，弱化阴影**：用 1px 发丝描边和背景色差建立层级，去掉消费级重阴影；只有真正浮起的层（Drawer / Modal / 下拉 / 悬浮）才允许柔和阴影。
3. **紧凑但有呼吸**：压缩控件高度与行高以容纳更多信息，但保留稳定的 4 的倍数间距节奏。
4. **数据即排版**：ID、时间、金额、数值统一等宽字体 + 等宽数字（tabular-nums），对齐、可扫、可复制。
5. **一致的骨架**：每个页面、每张卡片、每个编辑面板遵循同一套结构与交互，降低认知负担。
6. **不喧扰**：无渐变光晕、无大圆角气泡、无强投影、无高饱和大色块。

---

## 1. 设计元素（Design Tokens）

### 1.1 颜色

**中性灰阶（骨架）**

| Token | 值 | 用途 |
|---|---|---|
| `--bg-app` | `#F7F8FA` | 页面底色 |
| `--bg-surface` | `#FFFFFF` | 卡片 / 表格 / 抽屉表面 |
| `--bg-subtle` | `#F2F4F7` | 次级容器、表头、只读区、hover 底 |
| `--bg-sunken` | `#ECEEF2` | 内嵌区块、代码区浅色底 |
| `--border` | `#E5E8EC` | 发丝描边（默认分隔） |
| `--border-strong` | `#D5DAE0` | 强分隔、输入框边框 |
| `--text-primary` | `#1A2027` | 主文本 |
| `--text-secondary` | `#6B7482` | 次要文本、标签、说明 |
| `--text-tertiary` | `#9AA1AC` | 占位符、禁用、弱提示 |

**品牌强调色（靛蓝）**

| Token | 值 | 用途 |
|---|---|---|
| `--accent` | `#3B5BDB` | 主按钮、选中态、链接、聚焦 |
| `--accent-hover` | `#3450C7` | 主色悬停 |
| `--accent-active` | `#2C44A8` | 主色按下 |
| `--accent-subtle` | `#EDF0FB` | 选中行底、Tag 底、聚焦光晕 |

**语义色（仅用于状态）**

| 语义 | 主色 | 浅底 | 场景 |
|---|---|---|---|
| 成功 success | `#2F9E44` | `#EBFBEE` | 健康、启用、成功 |
| 警告 warning | `#E8590C` | `#FFF4E6` | 冷却、降级、注意 |
| 危险 danger | `#E03131` | `#FFF0F0` | 失败、删除、停用报警 |
| 处理 processing | `#3B5BDB` | `#EDF0FB` | 进行中、仅上游 |
| 中性 neutral | `#868E96` | `#F1F3F5` | 停用、未知、默认 |

> 颜色纪律：Tag / 状态点只能取上表 5 种语义，不允许出现 antd 默认的 blue/purple/cyan/gold 混用。原先 `smart_priority` 蓝、`smart_failover` 紫 → 统一改为 processing / neutral 语义。

### 1.2 字体与字号

```
--font-sans: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
--font-mono: "SFMono-Regular", "JetBrains Mono", "Cascadia Code", Consolas, "Liberation Mono", monospace;
```

| Token | 值 | 用途 |
|---|---|---|
| `--fs-page-title` | 18px / 600 | 页面主标题 |
| `--fs-section` | 14px / 600 | 卡片标题、分组标题 |
| `--fs-base` | 13px | 正文、表格、表单（紧凑基准） |
| `--fs-secondary` | 12px | 次要说明、副标题 |
| `--fs-mono` | 12.5px | ID / 代码 / JSON |
| 行高 | 1.5（正文）/ 1.4（表格） | |

**等宽 + 等宽数字**：ID、追踪号、时间戳、金额、限流数值、并发数、额度，全部 `font-variant-numeric: tabular-nums`，标识类再叠加 `--font-mono`。

### 1.3 间距（4 的倍数节奏）

`--sp-1:4 · --sp-2:8 · --sp-3:12 · --sp-4:16 · --sp-6:24 · --sp-8:32`

- 页面内容边距：16px（紧凑，原 24 → 16）
- 卡片之间：12px（原 16 → 12）
- 卡片内边距：14px（紧凑）
- 表单栅格 gutter：12px
- 表单项底距：12px

### 1.4 圆角

| Token | 值 | 用途 |
|---|---|---|
| `--radius-sm` | 4px | 输入框、按钮、Tag、小控件 |
| `--radius-md` | 6px | 卡片、抽屉内区块、代码块 |
| `--radius-lg` | 8px | 弹窗、抽屉、登录卡 |

> 全线下调（原 12–20px）。紧凑后台需要"精密"而非"圆润"。

### 1.5 阴影 / 层级

| Token | 值 | 用途 |
|---|---|---|
| `--shadow-none` | `none` | 卡片默认：只用描边 |
| `--shadow-hover` | `0 1px 3px rgba(16,24,40,.06)` | 卡片 hover / 可点区 |
| `--shadow-overlay` | `0 8px 24px rgba(16,24,40,.12)` | Drawer / Modal / 下拉 |
| `--shadow-sticky` | `0 -1px 0 var(--border)` | 抽屉底部吸底栏上缘 |

> 删除现有的 `0 24px 80px`、`0 10px 32px` 等重投影。

### 1.6 动效

- 时长：120ms（微交互）/ 200ms（面板）；缓动 `cubic-bezier(.4,0,.2,1)`。
- 只做：hover 底色、聚焦描边、抽屉/弹窗滑入淡入。不做弹跳、缩放、位移装饰动画。

---

## 2. Ant Design 主题映射（落地主抓手）

约 80% 视觉通过 `ConfigProvider` 全局 + 组件级 token 统一实现，避免逐页硬编码。

```ts
// main.tsx —— 目标配置骨架（数值以本规范为准）
theme={{
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: '#3B5BDB',
    colorInfo: '#3B5BDB',
    colorSuccess: '#2F9E44',
    colorWarning: '#E8590C',
    colorError: '#E03131',
    colorText: '#1A2027',
    colorTextSecondary: '#6B7482',
    colorBorder: '#D5DAE0',
    colorBorderSecondary: '#E5E8EC',
    colorBgLayout: '#F7F8FA',
    colorBgContainer: '#FFFFFF',
    borderRadius: 6,
    borderRadiusLG: 8,
    borderRadiusSM: 4,
    fontSize: 13,
    controlHeight: 30,        // 紧凑（默认 32）
    fontFamily: 'var(--font-sans)',
    boxShadow: '0 8px 24px rgba(16,24,40,.12)',
    boxShadowSecondary: '0 1px 3px rgba(16,24,40,.06)',
    wireframe: false,
  },
  components: {
    Layout: { headerBg: '#FFFFFF', siderBg: '#FFFFFF', bodyBg: '#F7F8FA', headerHeight: 52, headerPadding: '0 16px' },
    Menu:   { itemHeight: 36, itemBorderRadius: 6, itemSelectedBg: '#EDF0FB', itemSelectedColor: '#3B5BDB', activeBarWidth: 0, iconSize: 15 },
    Card:   { paddingLG: 14, borderRadiusLG: 6, headerHeight: 44, headerFontSize: 14 },
    Table:  { cellPaddingBlockSM: 6, cellPaddingInlineSM: 10, headerBg: '#F2F4F7', headerColor: '#6B7482', headerSplitColor: 'transparent', rowHoverBg: '#F7F8FA', borderColor: '#E5E8EC', fontSize: 12.5 },
    Button: { controlHeight: 30, controlHeightSM: 24, borderRadius: 4, primaryShadow: 'none', defaultShadow: 'none' },
    Input:  { controlHeight: 30, borderRadius: 4, activeShadow: '0 0 0 3px #EDF0FB' },
    Select: { controlHeight: 30, borderRadius: 4 },
    InputNumber: { controlHeight: 30, borderRadius: 4 },
    Drawer: { paddingLG: 16 },
    Modal:  { borderRadiusLG: 8 },
    Tabs:   { horizontalItemGutter: 20, cardBg: '#F2F4F7' },
    Descriptions: { labelBg: '#F2F4F7', titleMarginBottom: 8 },
    Tag:    { borderRadiusSM: 4, defaultBg: '#F1F3F5', defaultColor: '#6B7482' },
    Statistic: { contentFontSize: 22, titleFontSize: 12 },
    Divider: { marginLG: 12 },
  },
}}
```

其余 20%（外壳、状态点、代码块、吸底栏、页面头、密度微调）由 `styles.css` 用上面的 CSS 变量统一控制。

---

## 3. 组件设计语言（各类卡片 / 控件规范）

### 3.1 应用外壳 App Shell
- **侧边栏** 260px，纯白，右侧 1px 发丝描边；顶部品牌区精简为一行 Logo 文本 + 一句副标题（弱化，去掉大段落）。
- **菜单** 选中态用 `--accent-subtle` 底 + `--accent` 字，去掉左侧高亮竖条（`activeBarWidth:0`），改为整项底色；icon 15px。
- **顶栏** 高 52px，纯白 + 底部发丝线；左侧当前管理员，右侧退出。全局错误不再塞进顶栏，改由页面级 Alert / message 承载。
- **内容区** 底 `--bg-app`，边距 16px；页面之间用 12px 竖直堆叠（`page-stack`）。

### 3.2 页面头 Page Header（新增统一件）
每页顶部统一结构，替代目前"标题塞进第一张 Card.title"的做法：
```
[页面标题 18/600]        [次要操作] [主操作]
[一句灰色说明 12px，可选]
```
- 主操作（如"新增上游"）固定在右上；说明文字限一行，超出的长说明移入卡片内。

### 3.3 卡片 Card
- 白底 + `--border` 描边 + `--radius-md`，**默认无阴影**；标题区 44px 高、14/600、底部发丝线。
- 卡片内说明段用 `--text-secondary` 12px，`margin-top:0`。
- 分组用"区块标题"（见 3.8），不再用一排 `Divider` 切长内容。

### 3.4 统计条 Stat Strip（替换大统计卡）
- 现状：一排独立 `Card>Statistic`，占用大量垂直空间。
- 规范：合并为**一条**分栏卡片（等宽分栏，栏间发丝竖线）。
  - 标题 12px 次要色；数值 22px、等宽数字；可选环比/单位小字。
  - 高度紧凑（约 64px）。响应式下 2 列 / 1 列。

### 3.5 表格 Table（列表核心）
- 统一 `size="small"`、`tableLayout="fixed"`、需要时 `scroll={{x}}`。
- 表头：`--bg-subtle` 底、次要色、发丝分隔、**sticky**。
- 行：hover `--bg-app`；行高紧凑；选中行 `--accent-subtle`。
- **数值/时间/ID 列右对齐或等宽**；ID 用"紧凑 ID"组件（见 3.6）。
- **状态列**：用"状态点 + 文字"（见 3.7）替换实心 Tag，弱化色块。
- 操作列：`fixed:'right'`，小号 `link`/`text` 按钮（编辑=文本、删除=danger 文本），减少实心按钮噪声。
- 空态：统一 `Empty` 文案；加载：表格 `loading`；错误：表格上方 Alert。

### 3.6 紧凑 ID / 可复制文本 CompactId
- 中段省略：`tr_a1b2…6f`；等宽字体；hover 显示完整；点击复制 + `message.success`。
- 现有 `compact-id` / `table-ellipsis` 保留，改为等宽 + 统一交互。

### 3.7 状态点 StatusDot（新增统一件）
- `● + 文字` 结构：8px 圆点取语义色 + 文字取主/次色。
- 映射：成功/健康/启用=success；失败/报警=danger；冷却/降级/注意=warning；进行中/仅上游=processing；停用/未知=neutral。
- 替换目前散落的 `<Tag color="green|red|blue|orange|purple">`。真正需要"胶囊"语义（如类型标签）时才用 Tag，且用**描边/浅底**风格而非实心。

### 3.8 区块标题 SectionTitle（新增，替代长表单 Divider）
- 结构：`小标题 13/600` + 可选一行说明；上方 12px 间距，无横线或仅极浅横线。
- 用于抽屉/长表单分组（协议能力、固定适配规则、测试预设、边改边测……），比一连串 `Divider` 更清晰、更省高度。

### 3.9 编辑抽屉 Drawer（重编辑核心）
- **结构三段式**：固定头（标题 + 关闭）／可滚动体／**固定底部操作栏**。
- **保存按钮移到底部吸底栏**（左：取消/次操作，右：保存主操作），不再放在顶部 `extra`。吸底栏白底 + 上缘发丝线（`--shadow-sticky`）。
- 体内用**区块标题分组** + `Card size="small"` 承载子表单；栅格 gutter 12、表单项底距 12。
- 宽度：复杂表单 720–900（上游 900 保留）；一般 640。
- **脏态**：有未保存改动时保存按钮高亮、关闭时二次确认（Popconfirm/Modal.confirm）。
- 内嵌"边改边测"：测试按钮组 + 结果卡片保持，但结果 JSON 用统一代码块（3.11），成功/失败用 Alert。

### 3.10 弹窗 Modal（轻量编辑）
- 用于单对象轻表单（如下游 API Key）。宽 560–640；底部标准 取消/保存。
- 三层嵌套（页面表格 → 租户抽屉 → Key 弹窗）保留，但视觉层级用阴影区分：抽屉 overlay 阴影，弹窗更高一层。

### 3.11 代码 / JSON 区块 CodeBlock
- 统一一种样式：`--bg-sunken` 浅底 + `--border` 描边 + `--font-mono` 12.5 + `--radius-md`，`max-height` 可滚动、`white-space:pre-wrap`。
- 现有深色 `.json-block`（#0f172a）与浅色 `.json-detail-block` **统一为浅色描边风**，与整体石板调一致，避免大块深色突兀。（如需强调，可给标题加"复制"按钮。）

### 3.12 键值编辑器 KeyValueEditor
- 现状：`键 | 值 | 删除` 三列，每行一个大号"删除"按钮 + 底部"新增一行"。
- 规范：删除改为行尾**图标按钮**（`DeleteOutlined` text/danger），新增改为**虚线 dashed 按钮 + `PlusOutlined`**；行距收紧到 8px；空态一行占位提示。

### 3.13 描述列表 Descriptions
- `size="small"` + `bordered`；标签列 `--bg-subtle` 底、次要色；值区主色。用于详情展示（总览路由、探测结果、接口地址）。

### 3.14 标签页 Tabs（业务通道）
- 线形 Tab（下划线用 `--accent`）；内容区沿用卡片 + 表格。表格内联编辑（Switch/价格 InputNumber）保留，价格网格用 `--bg-subtle` 卡片项。

### 3.15 时间线日志 Timeline（接入向导）
- 节点色取语义色；每条日志 = 区块标题 + 输入/输出小块（`--bg-subtle`）+ 可选 JSON（3.11）+ 图片预览。图片圆角 `--radius-md`。
- 双栏布局保留（左表单/右日志），间距收紧到 12–16。

### 3.16 按钮 Button
- 层级：主操作 = `type="primary"`（实心靛蓝，无阴影）；次操作 = 默认描边；表内/轻操作 = `text`/`link`；危险 = `danger`（文本或描边，慎用实心红）。
- 尺寸：页面级默认，表格内 `size="small"`。

### 3.17 空 / 加载 / 错误状态（统一三态）
- **加载**：页面级切换用居中 `Spin`（保留）；卡片内局部用 `Skeleton`/表格 `loading`。避免整页反复闪 Spin —— 数据已加载时局部刷新只 loading 目标区。
- **空**：统一 `Empty` + 一句"下一步该做什么"引导文案。
- **错误**：页面级用顶部 Alert（可关闭）；操作级用 `message.error`；表单级用 `Alert` 贴近上下文。

### 3.18 登录页 Login
- 去掉现有径向渐变光晕背景，改为 `--bg-app` 纯净底 + 居中卡片（`--radius-lg` + `--shadow-overlay`，克制）。品牌区一行标题 + 一句副标题；输入框统一控件规范。

---

## 4. 交互约定（统一行为）

1. **保存流**：抽屉/弹窗保存 → loading → 成功 `message.success` + 关闭 + 刷新当前视图；失败 `message.error` 且**不关闭**、保留输入。（沿用现有 `wrapSave` 逻辑，仅调整反馈位置。）
2. **删除/清空等破坏性操作**：一律 `Popconfirm`（就近）或 `Modal.confirm`（影响大时），红色确认按钮，文案写清后果与不可恢复性。
3. **复制**：所有 ID、密钥、接口地址均可点击复制并 toast 反馈；完整 API Key 复制保留醒目入口。
4. **脏态离开**：抽屉/弹窗有未保存改动时关闭需二次确认。
5. **展开加载**：请求追踪的"展开行再加载详情"惰性策略保留（性能友好），加载中显示行内 Spin。
6. **响应式**：≤960px 侧栏可收起、栅格降为单列、统计条降为 2/1 列（沿用并扩展现有 media query）。
7. **可访问性**：聚焦有清晰 `--accent-subtle` 光晕；点击区≥28px；颜色不作为唯一区分（状态点始终带文字）。
8. **数据一致**：时间统一 `YYYY-MM-DD HH:mm:ss`（24h、等宽）；数值千分位；空值统一显示 `—`（em dash，次要色）。

---

## 5. 落地范围与顺序（改造计划）

> 原则：**只改视觉与结构，不动数据逻辑 / API / 类型 / 业务规则**。分阶段、每阶段可独立验证。

- **阶段一 · 地基（全局，收益最大）**
  1. `main.tsx`：写入第 2 节主题 token（全局 + 组件级）。
  2. `styles.css`：引入 CSS 变量体系（第 1 节），重写外壳/登录/代码块/间距/阴影；删除重投影与渐变。
  3. 新增少量共享件：`StatusDot`、`SectionTitle`、`CompactId`（复用现有）、`CodeBlock`、`StatStrip`、`PageHeader`。
  - 交付即可让**全后台**换上石板控制台皮肤，风险低、可回滚。

- **阶段二 · 外壳与通用列表**
  4. `AdminApp.tsx`：外壳（侧栏品牌区、顶栏、菜单选中态、错误承载位置）。
  5. `OverviewPage`：统计条 + Descriptions + 协议表规范化（样板页）。
  6. `RequestTracesPage` / `BillingLedgerPage` / `ResolutionAuditPage`：统计条 + 表格状态点 + 紧凑 ID + 代码块统一。

- **阶段三 · 重编辑面板**
  7. `UpstreamsPage`：抽屉三段式 + 吸底保存 + 区块标题替 Divider + 测试结果代码块。
  8. `TenantsPage`：列表状态点 + 抽屉/弹窗三段式 + 密钥复制区。
  9. `ChannelsPage`：Tab + 内联价格编辑网格规范化。
  10. `OnboardingPage`：双栏 + Timeline 日志 + KeyValueEditor 规范化。
  11. `ProtocolDocsPage`：Descriptions/代码块规范化。

- **验证**：每阶段本地 `pnpm --filter admin dev` 目视核对；结束 `pnpm --filter admin build` 确认无类型/构建错误。

---

## 6. 明确不做（避免过度设计）

- 不引入新 UI 框架 / 图表库 / 图标风格（沿用 antd + @ant-design/icons）。
- 不做暗色模式（本期先把亮色石板做到位；变量体系已为将来预留）。
- 不改后端接口、字段语义、路由与计费逻辑。
- 不加装饰性插画、渐变、动画。
