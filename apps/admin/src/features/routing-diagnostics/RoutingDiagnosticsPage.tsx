import { Alert, Card, Descriptions, Space, Table, Tabs, Tag, Typography } from 'antd';
import type {
  RoutingDiagnosticsPreview,
  RoutingDiagnosticsPreviewPlan,
  RoutingDiagnosticsReport,
} from '../../shared/types';
import {
  EMPTY_DASH,
  EllipsisText,
  PageHeader,
  StatStrip,
  StatusDot,
  formatDateTime,
} from '../../shared/ui';

const { Text } = Typography;

type RoutingCandidate = RoutingDiagnosticsPreviewPlan['candidates'][number];

type RoutingGraphMetric = {
  label: string;
  value: string;
};

type RoutingGraphOutcome = {
  label: string;
  title: string;
  items: string[];
  tone?: 'neutral' | 'success' | 'warning';
};

function healthTone(state: string) {
  if (state === 'healthy') return 'success' as const;
  if (state === 'cooling') return 'warning' as const;
  if (state === 'degraded') return 'processing' as const;
  return 'neutral' as const;
}

function healthLabel(state: string) {
  if (state === 'healthy') return '健康';
  if (state === 'cooling') return '冷却中';
  if (state === 'degraded') return '降级';
  if (state === 'disabled') return '禁用';
  return state || EMPTY_DASH;
}

function modeTone(mode: string) {
  if (mode === 'fixed_provider') return 'warning' as const;
  return mode === 'smart_priority' ? 'processing' as const : 'neutral' as const;
}

function modeExplain(mode: string) {
  if (mode === 'fixed_provider') {
    return '固定：只允许请求密钥绑定的固定线路，不参与智能候选回退。';
  }
  return mode === 'smart_priority'
    ? '优选：使用同一套智能评分，但只请求当前排序第一的线路，不继续回退。'
    : '智能：使用同一套智能评分，首条失败后继续切换后续候选线路。';
}

function filteredOutReasonLabel(reason: string) {
  if (reason === 'disabled') return '线路被手动关闭；运行态错误不会永久禁用线路';
  if (reason === 'in_cooldown') return '线路处于冷却/熔断窗口；仅当无正常候选时才会进入临时兜底链';
  if (reason === 'auth_failed') return '上游鉴权失败，处于限时熔断窗口；到期后自动降级恢复候选，后台测试成功可立即恢复';
  if (reason === 'generation_not_supported') return '该线路未启用文生图';
  if (reason === 'edit_not_supported') return '该线路未启用图生图';
  if (reason === 'sync_not_supported') return '该线路不支持同步请求';
  if (reason === 'async_not_supported') return '该线路不支持异步请求';
  if (reason === 'reference_not_supported') return '该线路不支持参考图';
  if (reason === 'model_not_allowed') return '请求模型不在该线路允许列表中';
  if (reason.startsWith('tier_') && reason.endsWith('_not_supported')) {
    return `该线路未启用 ${reason.replace(/^tier_/, '').replace(/_not_supported$/, '').toUpperCase()} 分辨率档位`;
  }
  if (reason.startsWith('quality_') && reason.includes('_not_supported_for_')) {
    const matched = reason.match(/^quality_(auto|low|medium|high)_not_supported_for_(auto|1k|2k|4k)$/);
    if (matched) {
      return `该线路未启用 ${matched[2].toUpperCase()} 档位下的 ${matched[1]} 质量`;
    }
  }
  if (reason.startsWith('response_format_') && reason.endsWith('_not_supported')) {
    return `该线路未启用 ${reason.includes('b64_json') ? 'Base64' : 'URL'} 返回格式`;
  }
  if (reason === 'not_fixed_provider') return '固定模式下非绑定线路';
  return reason || EMPTY_DASH;
}

function candidateCompatibilityLabel(reason: string) {
  const responseFormatMatch = reason.match(/^response_format_(url|b64_json)_converted_from_(.+)$/);
  if (responseFormatMatch) {
    const requested = responseFormatMatch[1] === 'b64_json' ? 'Base64' : 'URL';
    const upstream = responseFormatMatch[2] === 'b64_json' ? 'Base64' : responseFormatMatch[2] === 'url' ? 'URL' : responseFormatMatch[2];
    return `下游要求 ${requested}，该上游原生返回 ${upstream}，平台会在中间层转换后再返回给下游`;
  }
  return '';
}

function previewContextLabel(preview: RoutingDiagnosticsPreview) {
  return [
    preview.label,
    preview.operation === 'edits' ? '图像编辑' : '图像生成',
    preview.hasReferenceImage ? '含参考图' : '',
    preview.requestedSize || '',
  ].filter(Boolean).join(' · ');
}

function previewTabLabel(preview: RoutingDiagnosticsPreview) {
  if (preview.key === 'generation_standard') return '常规文生图';
  if (preview.key === 'generation_high_res') return '高清文生图';
  if (preview.key === 'edit_with_reference') return '参考图编辑';
  return preview.label;
}

function scoreColor(value: number) {
  if (value >= 80) return 'green';
  if (value >= 60) return 'blue';
  if (value >= 40) return 'gold';
  return 'red';
}

function formatScore(value: number) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(1) : EMPTY_DASH;
}

function formatPrice(value: number) {
  const price = Number(value || 0);
  return price > 0 ? price.toFixed(5) : EMPTY_DASH;
}

function costSourceLabel(source?: RoutingCandidate['costSource']) {
  if (source === 'highest_configured_fallback') return '最高已启用成本';
  if (source === 'exact') return '当前规格成本';
  return '未配置成本';
}

function formatDuration(value?: number) {
  const milliseconds = Number(value || 0);
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? `${(milliseconds / 1000).toFixed(1)} 秒`
    : EMPTY_DASH;
}

function latencySourceLabel(source?: RoutingCandidate['latencySource']) {
  if (source === 'success_ewma') return '成功出图 EWMA';
  if (source === 'legacy_ewma') return '迁移期总耗时 EWMA';
  return '候选中位数兜底';
}

function candidateUseLabel(mode: string, rank: number) {
  if (mode === 'smart_priority') {
    return rank === 1 ? '实际使用' : '仅排序参考';
  }
  if (mode === 'fixed_provider') {
    return rank === 1 ? '固定线路' : '不会使用';
  }
  return rank === 1 ? '首选线路' : `失败后第 ${rank} 候选`;
}

function candidateUseColor(mode: string, rank: number) {
  if (rank === 1) return 'green';
  return mode === 'smart_priority' ? 'default' : 'blue';
}

function modeTableTitle(plan: RoutingDiagnosticsPreviewPlan) {
  return plan.mode === 'smart_priority'
    ? '优选模式：只请求当前首选线路'
    : '智能模式：先请求首选线路，失败后继续回退';
}

function readableScoreReason(record: RoutingCandidate) {
  const compatibilityNotes = (record.reasons || [])
    .map(candidateCompatibilityLabel)
    .filter(Boolean);
  return [
    `健康 ${formatScore(record.healthScore)} 是主要依据`,
    `健康证据距今 ${formatDuration(record.healthEvidenceAgeMs)}，有效权重 ${(record.healthEvidenceFreshness * 100).toFixed(0)}%`,
    `预计成功出图 ${formatDuration(record.estimatedLatencyMs)}（成功样本 ${record.successLatencySampleCount}，延时置信 ${(record.successLatencyFreshness * 100).toFixed(0)}%）`,
    `成本 ${formatPrice(record.price)} / 中位数 ${formatPrice(record.costMedian)} / 指数 ${record.costIndex.toFixed(2)}`,
    `交付指数 ${record.deliveryValueIndex.toFixed(1)}`,
    `并发 ${record.currentConcurrency}`,
    `规格稳定 ${formatScore(record.qualityScore)} 仅低权重参考`,
    ...compatibilityNotes,
  ].join('；');
}

function renderPlanTable(plan: RoutingDiagnosticsPreviewPlan) {
  return (
    <Table
      size="small"
      rowKey={(record) => `${plan.mode}-${record?.providerId || 'unknown'}`}
      pagination={false}
      scroll={{ x: 1440 }}
      dataSource={plan.candidates}
      columns={[
        {
          title: '使用顺序',
          dataIndex: 'rank',
          width: 132,
          render: (value: number) => (
            <Space direction="vertical" size={2}>
              <Text strong>{`第 ${value} 名`}</Text>
              <Tag color={candidateUseColor(plan.mode, value)}>{candidateUseLabel(plan.mode, value)}</Tag>
            </Space>
          ),
        },
        {
          title: '线路',
          dataIndex: 'providerName',
          width: 280,
          render: (value?: string, record?: RoutingCandidate) => (
            <Space direction="vertical" size={2}>
              <EllipsisText value={value} />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {record?.protocol || EMPTY_DASH}
              </Text>
            </Space>
          ),
        },
        {
          title: '请求成本',
          dataIndex: 'price',
          width: 104,
          align: 'right',
          render: (value: number, record?: RoutingCandidate) => (
            <Space direction="vertical" size={0} align="end">
              <span className="tabular">{formatPrice(value)}</span>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {costSourceLabel(record?.costSource)}
              </Text>
            </Space>
          ),
        },
        {
          title: '预计成功出图',
          dataIndex: 'estimatedLatencyMs',
          width: 126,
          align: 'right',
          render: (value: number, record?: RoutingCandidate) => (
            <Space direction="vertical" size={0} align="end">
              <span className="tabular">{formatDuration(value)}</span>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {record?.observedLatencyMs
                  ? `${latencySourceLabel(record.latencySource)} ${formatDuration(record.observedLatencyMs)}`
                  : latencySourceLabel(record?.latencySource)}
              </Text>
            </Space>
          ),
        },
        {
          title: '成本指数',
          dataIndex: 'costIndex',
          width: 98,
          align: 'right',
          render: (value: number) => <span className="tabular">{Number(value || 0).toFixed(2)}x</span>,
        },
        {
          title: '交付指数',
          dataIndex: 'deliveryValueIndex',
          width: 104,
          align: 'right',
          render: (value: number) => <span className="tabular">{Number(value || 0).toFixed(1)}</span>,
        },
        {
          title: '综合排序分',
          dataIndex: 'score',
          width: 112,
          align: 'right',
          render: (value: number) => <Tag color={scoreColor(value)} className="tabular">{formatScore(value)}</Tag>,
        },
        {
          title: '健康分',
          dataIndex: 'healthScore',
          width: 104,
          align: 'right',
          render: (value: number) => <Tag color={scoreColor(value)} className="tabular">{formatScore(value)}</Tag>,
        },
        {
          title: '并发压力',
          dataIndex: 'currentConcurrency',
          width: 112,
          align: 'right',
          render: (value: number) => <span className="tabular">{value}</span>,
        },
        {
          title: '规格稳定',
          dataIndex: 'qualityScore',
          width: 104,
          align: 'right',
          render: (value: number) => <Text type="secondary" className="tabular">{formatScore(value)}</Text>,
        },
        {
          title: '为什么这样排',
          dataIndex: 'reasons',
          width: 300,
          render: (_: string[], record?: RoutingCandidate) => (
            <EllipsisText value={record ? readableScoreReason(record) : EMPTY_DASH} />
          ),
        },
      ]}
    />
  );
}

function renderFilteredOutTable(plan: RoutingDiagnosticsPreviewPlan) {
  if (!plan.filteredOut.length) {
    return (
      <Alert
        type="success"
        showIcon
        style={{ marginTop: 12 }}
        message="没有被过滤的线路"
        description="当前场景下，已接入且能力匹配的线路都可以进入候选排序。"
      />
    );
  }

  return (
    <Card size="small" title="为什么有些线路没有进入候选" style={{ marginTop: 12 }}>
      <Table
        size="small"
        rowKey={(row) => row ? `${plan.mode}-${row.providerId}-${row.reason}` : `${plan.mode}-filtered-out`}
        pagination={false}
        dataSource={plan.filteredOut}
        columns={[
          {
            title: '线路',
            dataIndex: 'providerName',
            width: 260,
            render: (value?: string, record?: RoutingDiagnosticsPreviewPlan['filteredOut'][number]) => (
              <Space direction="vertical" size={0}>
                <EllipsisText value={value || record?.providerId || EMPTY_DASH} />
                <Text type="secondary" className="tabular">{record?.providerId || EMPTY_DASH}</Text>
              </Space>
            ),
          },
          {
            title: '没有参与排序的原因',
            dataIndex: 'reason',
            render: (value?: string) => <EllipsisText value={filteredOutReasonLabel(value || '')} />,
          },
        ]}
      />
    </Card>
  );
}

function renderPlanCard(plan: RoutingDiagnosticsPreviewPlan) {
  const first = plan.candidates[0];
  return (
    <div className="page-stack" style={{ gap: 12 }}>
      <Alert
        type={plan.mode === 'smart_priority' ? 'info' : 'success'}
        showIcon
        message={modeTableTitle(plan)}
        description={first
          ? `当前首选线路是「${first.providerName || first.providerId}」，候选 ${plan.candidateCount} 条，过滤 ${plan.filteredOutCount} 条。`
          : `当前没有可用候选，过滤 ${plan.filteredOutCount} 条。`}
      />
      {renderPlanTable(plan)}
      {renderFilteredOutTable(plan)}
    </div>
  );
}

function renderPreviewPanel(preview: RoutingDiagnosticsPreview) {
  return (
    <div className="page-stack" style={{ gap: 12 }}>
      <Alert
        type="info"
        showIcon
        message={previewContextLabel(preview)}
        description="这里不是分辨率统计表，而是用这个典型请求场景模拟一次真实智能路由：先过滤不匹配线路，再按可靠性基础分筛选可比较候选，最后平衡成功出图速度与成本。"
      />
      <Tabs
        type="card"
        items={preview.plans.map((plan) => ({
          key: plan.mode,
          label: plan.modeLabel,
          children: renderPlanCard(plan),
        }))}
      />
    </div>
  );
}

function renderRoutingOverviewFlow() {
  const renderMetrics = (metrics: RoutingGraphMetric[]) => (
    <div className="routing-graph__metrics">
      {metrics.map((metric) => (
        <div key={`${metric.label}-${metric.value}`} className="routing-graph__metric">
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
        </div>
      ))}
    </div>
  );

  const renderOutcome = (outcome: RoutingGraphOutcome) => (
    <div key={outcome.label + outcome.title} className={`routing-graph__outcome is-${outcome.tone || 'neutral'}`}>
      <span className="routing-graph__outcome-label">{outcome.label}</span>
      <strong>{outcome.title}</strong>
      <ul className="routing-graph__list">
        {outcome.items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );

  return (
    <Card title="智能路由完整闭环信息图">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="以下流程图对应当前线上真实代码逻辑"
        description="这不是环节概览，而是按真实执行顺序绘制的闭环信息图：包含判断节点、失败出口、评分参数、回退循环、异步分支、计费与健康状态回写。"
      />
      <div className="routing-graph">
        <section className="routing-graph__node">
          <div className="routing-graph__node-head">
            <div>
              <span className="routing-graph__eyebrow">入口</span>
              <h4>A. 请求进入与基础校验</h4>
              <p>进入 `/v1/images/generations` 或 `/v1/images/edits` 后，先做请求归一化、输入约束和入口开关检查。这里失败会直接结束，不进入路由。</p>
            </div>
            <div className="routing-graph__chips">
              <Tag>normalize payload</Tag>
              <Tag>max 6 images</Tag>
              <Tag>12MB</Tag>
              <Tag>public_api_enabled</Tag>
            </div>
          </div>
          {renderMetrics([
            { label: '接口入口', value: 'generations / edits' },
            { label: '输入图片上限', value: '6 张' },
            { label: '图片载荷上限', value: '12MB' },
            { label: '失败出口', value: '400 / 413 / 503' },
          ])}
          <div className="routing-graph__detail-grid">
            <div className="routing-graph__panel">
              <strong>执行内容</strong>
              <ul className="routing-graph__list">
                <li>统一整理 `size`、`quality`、`response_format`、`async`、`image`、`prompt` 等字段。</li>
                <li>校验公共图像 API 总开关，以及文生图 / 图生图入口是否开放。</li>
                <li>超过输入数、请求体过大或入口关闭时，直接返回标准化错误。</li>
              </ul>
            </div>
            <div className="routing-graph__panel is-warning">
              <strong>失败时不会做的事</strong>
              <ul className="routing-graph__list">
                <li>不会进入候选过滤和评分。</li>
                <li>不会占用任意并发资源。</li>
                <li>不会写入上游线路健康状态。</li>
              </ul>
            </div>
          </div>
        </section>

        <div className="routing-graph__arrow"><span>入口通过</span></div>

        <section className="routing-graph__decision">
          <div className="routing-graph__decision-head">
            <span className="routing-graph__eyebrow">鉴权与限流</span>
            <h4>B. 身份来源、画质上限与 RPM 是否通过？</h4>
            <p>这里先解析租户密钥、管理员放行或用户自带上游 Key，再按 API Key 配置收敛到画质上限，随后消耗 RPM。RPM 未通过时不会进入候选预览。</p>
          </div>
          {renderMetrics([
            { label: '鉴权模式', value: 'tenant_key / admin_key / disabled / user_supplied' },
            { label: '画质上限', value: 'low / medium / high' },
            { label: 'RPM 维度', value: 'global / tenant / api_key' },
            { label: '计数实现', value: 'Redis 原子计数优先' },
          ])}
          <div className="routing-graph__outcome-grid">
            {renderOutcome({
              label: '是',
              title: '进入候选预览',
              tone: 'success',
              items: [
                '租户密钥模式会读取图像路由模式、固定线路、画质上限、RPM 与并发配置。',
                '若请求画质为空或超出上限，会被收敛到该 Key 的画质上限。',
                'RPM 通过后才构建第一次候选预览。',
              ],
            })}
            {renderOutcome({
              label: '否',
              title: '直接标准化失败返回',
              tone: 'warning',
              items: [
                '401 / 403：鉴权失败、租户停用、通道未授权。',
                '429：全局 RPM、租户 RPM 或 API Key RPM 超限。',
                '不会写入上游线路健康，也不会占用平台并发。',
              ],
            })}
          </div>
        </section>

        <div className="routing-graph__arrow"><span>RPM 通过</span></div>

        <section className="routing-graph__node">
          <div className="routing-graph__node-head">
            <div>
              <span className="routing-graph__eyebrow">第一次候选预览</span>
              <h4>C. 路由模式判定、候选过滤、评分与请求计划适配</h4>
              <p>这是预算预览和异步首候选选择使用的第一次智能路由预览。它已经包含真实的过滤、评分和请求协议适配逻辑。</p>
            </div>
            <div className="routing-graph__chips">
              <Tag>smart_failover</Tag>
              <Tag>smart_priority</Tag>
              <Tag>fixed_provider</Tag>
              <Tag>adapt payload</Tag>
            </div>
          </div>
          {renderMetrics([
            { label: '固定模式', value: '仅绑定线路可入候选' },
            { label: '智能模式', value: '失败可继续回退' },
            { label: '优选模式', value: '仅保留第 1 候选' },
            { label: '上游异步要求', value: '平台 async 不要求原生支持' },
          ])}
          <div className="routing-graph__detail-grid routing-graph__detail-grid--triple">
            <div className="routing-graph__panel">
              <strong>1. 硬过滤</strong>
              <ul className="routing-graph__list">
                <li>能力：文生图 / 图生图 / 同步 / 参考图支持。</li>
                <li>规格：模型 allowlist、1K/2K/4K 档位、档位下画质、URL/Base64 返回格式。</li>
                <li>固定模式会额外排除非绑定 provider。</li>
              </ul>
            </div>
            <div className="routing-graph__panel is-success">
              <strong>2. 运行态与评分</strong>
              <ul className="routing-graph__list">
                <li>临时阻断：`in_cooldown`、`auth_failed`。</li>
                <li>可靠性基线：健康 60% + 并发 26.67% + 规格稳定 13.33%。</li>
                <li>可靠性接近时，按“预计成功出图耗时 × 受中位成本约束的成本指数”排序。</li>
              </ul>
            </div>
            <div className="routing-graph__panel is-warning">
              <strong>3. 请求计划适配</strong>
              <ul className="routing-graph__list">
                <li>为每条候选生成 OpenAI Images / Responses / Chat 的真实请求计划。</li>
                <li>参考图可保留 URL、转为 data URL，或组装 multipart 文件请求。</li>
                <li>自定义 headers/body 只允许注入非保留字段。</li>
              </ul>
            </div>
          </div>
        </section>

        <div className="routing-graph__arrow"><span>预览完成</span></div>

        <section className="routing-graph__decision">
          <div className="routing-graph__decision-head">
            <span className="routing-graph__eyebrow">预算与平台并发</span>
            <h4>D. 有候选且余额/平台并发通过吗？</h4>
            <p>候选预览完成后，平台按保守口径做余额预估；固定线路一口价会优先按一口价预估。余额通过后才占用 API Key 并发与全局图像并发。</p>
          </div>
          {renderMetrics([
            { label: '预估计费', value: '共享价最高档或固定一口价 × n' },
            { label: '余额校验', value: '仅 tenant_key 执行' },
            { label: 'API Key 并发', value: '默认 10，可后台设置' },
            { label: '全局并发', value: 'publicApi.maxConcurrency' },
          ])}
          <div className="routing-graph__outcome-grid">
            {renderOutcome({
              label: '是',
              title: '进入同步/异步分支',
              tone: 'success',
              items: [
                '余额足够后先占用 API Key 并发，再占用全局图像并发。',
                '此时还未请求任何上游线路。',
                '同步和异步都会基于这次预览结果继续下游流程。',
              ],
            })}
            {renderOutcome({
              label: '否',
              title: '402 / 429 直接返回',
              tone: 'warning',
              items: [
                '无候选：503 `no_provider_available`。',
                '余额不足：402 `insufficient_balance`。',
                'API Key 或全局并发占满：429，不进入上游请求。',
              ],
            })}
          </div>
        </section>

        <div className="routing-graph__arrow"><span>预算与平台并发通过</span></div>

        <section className="routing-graph__split">
          <div className="routing-graph__branch is-success">
            <div className="routing-graph__branch-head">
              <span className="routing-graph__eyebrow">异步分支</span>
              <h4>E1. async=true</h4>
            </div>
            {renderMetrics([
              { label: '首个响应', value: '202 Accepted' },
              { label: '任务 TTL', value: '15 分钟' },
              { label: '任务状态', value: 'queued → running → completed/failed' },
              { label: '轮询结果', value: '最终统一为 URL' },
            ])}
            <ul className="routing-graph__list">
              <li>先取第一次预览的第 1 候选创建任务，返回 `task_id`、`status`、`query_path`。</li>
              <li>后台 `runImageGatewayTask` 启动后，会再次进入真实执行引擎，而不是直接沿用旧结果。</li>
              <li>任务完成后写入 `result` / `error`、请求追踪、任务记录，并释放并发资源。</li>
            </ul>
          </div>
          <div className="routing-graph__branch">
            <div className="routing-graph__branch-head">
              <span className="routing-graph__eyebrow">同步分支</span>
              <h4>E2. async=false</h4>
            </div>
            {renderMetrics([
              { label: '立即执行', value: '进入上游执行引擎' },
              { label: '下游流式', value: 'extra_body.stream=true' },
              { label: 'SSE 方式', value: '完整结果到手后再标准化输出' },
              { label: '并发释放', value: '响应返回前释放' },
            ])}
            <ul className="routing-graph__list">
              <li>同步请求会立刻进入 `executeUpstreamImageRequest`。</li>
              <li>若要求 SSE，平台会在拿到完整图片结果后转为标准化 SSE 事件流输出。</li>
              <li>Images Endpoint 是否向上游发送 `stream=true`，只由上游接入里的“上游原生响应模式”决定。</li>
              <li>不会把上游原始敏感报错直接透传给下游。</li>
            </ul>
          </div>
        </section>

        <div className="routing-graph__arrow"><span>进入统一执行引擎</span></div>

        <section className="routing-graph__node">
          <div className="routing-graph__node-head">
            <div>
              <span className="routing-graph__eyebrow">执行循环</span>
              <h4>F. 逐候选执行、失败分类与回退循环</h4>
              <p>真正请求上游时会再次构建候选预览，并逐条尝试候选。每次尝试前都会单独检查 provider 并发，之后根据真实返回判断是否成功、是否冷却、是否继续回退。</p>
            </div>
            <div className="routing-graph__chips">
              <Tag>provider concurrency</Tag>
              <Tag>timeout default 180s</Tag>
              <Tag>shouldFailover</Tag>
              <Tag>provider_attempts</Tag>
            </div>
          </div>
          {renderMetrics([
            { label: 'provider 并发', value: '默认 10，可按线路配置' },
            { label: '请求超时', value: '默认 180 秒' },
            { label: '优选/单固定', value: '首条失败即停止' },
            { label: '智能/固定线路池', value: 'shouldFailover=true 时回退' },
          ])}
          <div className="routing-graph__detail-grid routing-graph__detail-grid--triple">
            <div className="routing-graph__panel">
              <strong>1. 尝试前</strong>
              <ul className="routing-graph__list">
                <li>检查该 provider 当前并发是否还有槽位。</li>
                <li>占满时记为 `retryable_overloaded`，且 `affectsHealth=false`。</li>
                <li>解除冷却且旧技术失败已衰减的线路，最多每 30 分钟获得一次真实再入验证；必须存在其他回退线路。</li>
                <li>随后按该线路配置超时发起真实上游请求。</li>
              </ul>
            </div>
            <div className="routing-graph__panel is-success">
              <strong>2. 成功判定</strong>
              <ul className="routing-graph__list">
                <li>只有 HTTP 成功且响应中存在可用图片输出才算真正成功。</li>
                <li>HTTP 成功但无图片会转成语义失败：`retryable_status`，冷却 20 秒。</li>
                <li>成功后立即结束循环，不再继续尝试后续候选。</li>
              </ul>
            </div>
            <div className="routing-graph__panel is-warning">
              <strong>3. 失败分类</strong>
              <ul className="routing-graph__list">
                <li>可回退：timeout 30s、transport 20s、gateway/status 30s、rate limit/overloaded 45s。</li>
                <li>不可回退：safety、auth、capability、config、invalid_request、user_content。</li>
                <li>每次失败都会写入 `provider_attempts`，并更新运行态健康、冷却或熔断窗口。</li>
                <li>这里的失败分类服务于线路治理，不等同于业务统计里的“是否计入成功率”。</li>
              </ul>
            </div>
          </div>
          <div className="routing-graph__loop">
            <strong>回退闭环：</strong>
            <code>smart_failover</code> 与多选固定线路池在 <code>shouldFailover = true</code> 时会回到“下一候选”；优选和单条固定线路不会进入这个循环。
          </div>
        </section>

        <div className="routing-graph__arrow"><span>执行完成</span></div>

        <section className="routing-graph__node">
          <div className="routing-graph__node-head">
            <div>
              <span className="routing-graph__eyebrow">收尾与反哺</span>
              <h4>G. 标准化返回、计费、状态回写与下一次请求闭环</h4>
              <p>执行结束后，平台把返回结果标准化、写任务和追踪、按实际图片计费，并把最新健康状态回写到热状态存储中，供下一次候选预览直接读取。</p>
            </div>
            <div className="routing-graph__chips">
              <Tag>trace</Tag>
              <Tag>runtime health</Tag>
              <Tag>billing</Tag>
              <Tag>Redis + memory</Tag>
            </div>
          </div>
          {renderMetrics([
            { label: '图片 URL 保留', value: '20 分钟' },
            { label: '请求追踪保留', value: '30 分钟' },
            { label: '异步任务 TTL', value: '15 分钟' },
            { label: '计费依据', value: '共享按实际档位；固定一口价按张' },
          ])}
          <div className="routing-graph__detail-grid routing-graph__detail-grid--triple">
            <div className="routing-graph__panel">
              <strong>1. 标准化返回</strong>
              <ul className="routing-graph__list">
                <li>Images / Responses / 二进制响应会统一为平台标准图像响应。</li>
                <li>同步失败统一走标准错误口径，不透传上游敏感细节。</li>
                <li>SSE 也由平台重新组织为 `image`、`completed`、`[DONE]` 事件。</li>
              </ul>
            </div>
            <div className="routing-graph__panel is-success">
              <strong>2. 计费与流水</strong>
              <ul className="routing-graph__list">
                <li>仅 tenant_key 成功请求计费；共享线路按实际返回图片归档到 1K / 2K / 4K，固定线路一口价按张结算。</li>
                <li>共享线路价格使用实际档位与请求画质档；固定线路一口价不再区分分辨率和画质。两者都会写入 billing charge 和租户消费流水。</li>
                <li>若实际图更大于预估，允许余额扣成负数，后续请求再统一拦截。</li>
              </ul>
            </div>
            <div className="routing-graph__panel is-warning">
              <strong>3. 健康状态回写</strong>
              <ul className="routing-graph__list">
                <li>成功率、延迟、连续失败、冷却/熔断状态会写回共享 hot state。</li>
                <li>读取候选时，旧技术失败和旧延时会按时间衰减到中性；不会产生探活请求或改写原始证据。</li>
                <li>已恢复线路通过受控真实再入成功后，才会用新数据重新获得正常排序资格。</li>
                <li>Redis 可用时共享到多进程；不可用时回退内存快照。</li>
                <li>这批运行态会直接影响下一次请求的候选过滤与排序。</li>
                <li>业务通道和总览中的生成成功率，另按“成功 / 计入成功率请求”计算，并单独剔除拒绝类失败。</li>
              </ul>
            </div>
          </div>
          <div className="routing-graph__loopback">
            <strong>最终闭环：</strong>
            本次请求写回的运行态健康、冷却窗口、并发快照与分辨率稳定度，会在下一次进入 <strong>C 节点候选预览</strong> 时被重新读取；旧证据随时间被动恢复，恢复线路再由一笔受控真实请求验证，构成完整自反馈闭环。
          </div>
        </section>
      </div>
    </Card>
  );
}

type RoutingDiagnosticsPageProps = {
  report: RoutingDiagnosticsReport | null;
};

export function RoutingDiagnosticsPage({ report }: RoutingDiagnosticsPageProps) {
  if (!report) {
    return null;
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="路由诊断"
        desc="这里展示的是线路运行态口径：当前健康状态、冷却/降级、候选排序和过滤原因。它不是下游业务成功率报表。"
      />

      <Alert
        type="info"
        showIcon
        message="本页的“成功 / 失败 / 成功率 / 延迟”都是线路运行态指标。"
        description="它们用于帮助你理解智能路由为什么会选某条线路、某条线路为何进入冷却或降级。这里的运行态累计会包含后台探测、手工线路测试和真实业务请求；近 120 分钟请求/返图列才是按真实业务任务聚合的窗口统计。业务成功率请看“总览”和“业务通道”。"
      />

      <Tabs
        type="card"
        items={[
          {
            key: 'overview',
            label: '路由总览',
            children: (
              <div className="page-stack">
                <StatStrip
                  items={[
                    { label: '线路总数', value: report.summary.providerCount },
                    { label: '健康线路', value: report.summary.healthyCount },
                    { label: '智能模式密钥', value: report.summary.smartModeCount },
                    { label: '优选模式密钥', value: report.summary.preferredModeCount },
                    { label: '固定模式密钥', value: report.summary.fixedModeCount || 0 },
                  ]}
                />
                {renderRoutingOverviewFlow()}
                <Card title="模式说明">
                  <Descriptions column={1} size="small">
                    <Descriptions.Item label="智能">
                      使用与优选相同的智能评分排序，但首条失败后会继续切换后续候选。
                    </Descriptions.Item>
                    <Descriptions.Item label="优选">
                      使用与智能相同的智能评分排序，但只请求当前首选线路，不做后续回退。
                    </Descriptions.Item>
                    <Descriptions.Item label="固定">
                      只使用密钥绑定的固定线路；单选首条失败即停止，多选固定线路池会在池内智能排序并对可回退失败继续切换，绝不使用池外线路。
                    </Descriptions.Item>
                  </Descriptions>
                </Card>
              </div>
            ),
          },
          {
            key: 'key-modes',
            label: '密钥模式',
            children: (
              <Card title="租户密钥路由模式">
                <Table
                  size="small"
                  rowKey="apiKeyId"
                  pagination={false}
                  scroll={{ x: 980 }}
                  dataSource={report.apiKeyModes}
                  columns={[
                    {
                      title: '租户',
                      dataIndex: 'tenantName',
                      width: 180,
                      render: (value?: string) => <EllipsisText value={value} />,
                    },
                    {
                      title: '密钥名称',
                      dataIndex: 'apiKeyName',
                      width: 220,
                      render: (value?: string) => <EllipsisText value={value} />,
                    },
                    {
                      title: '模式',
                      dataIndex: 'mode',
                      width: 180,
                      render: (_: string, row) => (
                        <Space direction="vertical" size={2}>
                          <StatusDot tone={modeTone(row.mode)}>{row.modeLabel}</StatusDot>
                          <Text type="secondary" style={{ fontSize: 12 }}>{modeExplain(row.mode)}</Text>
                          {row.mode === 'fixed_provider' ? (
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {row.fixedProviderName || row.fixedProviderId || '未配置固定线路'}
                            </Text>
                          ) : null}
                        </Space>
                      ),
                    },
                    {
                      title: '状态',
                      dataIndex: 'status',
                      width: 90,
                      render: (value: string) => (
                        <StatusDot tone={value === 'active' ? 'success' : 'neutral'}>
                          {value === 'active' ? '启用' : '停用'}
                        </StatusDot>
                      ),
                    },
                    {
                      title: '最大并发',
                      dataIndex: 'maxConcurrency',
                      width: 96,
                      align: 'right',
                      render: (value: number) => <span className="tabular">{value}</span>,
                    },
                    {
                      title: '每分钟限流',
                      dataIndex: 'requestLimitPerMinute',
                      width: 110,
                      align: 'right',
                      render: (value: number) => <span className="tabular">{value}</span>,
                    },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'providers',
            label: '线路状态',
            children: (
              <Card title="线路健康状态">
                <Table
                  size="small"
                  rowKey="providerId"
                  pagination={false}
                  scroll={{ x: 2080 }}
                  dataSource={report.providers}
                  columns={[
                    {
                      title: '线路名称',
                      dataIndex: 'name',
                      width: 220,
                      render: (value?: string) => <EllipsisText value={value} />,
                    },
                    { title: '协议', dataIndex: 'protocol', width: 130 },
                    { title: '类型', dataIndex: 'kind', width: 140 },
                    {
                      title: '健康状态',
                      dataIndex: 'healthState',
                      width: 110,
                      render: (value: string) => (
                        <StatusDot tone={healthTone(value)}>{healthLabel(value)}</StatusDot>
                      ),
                    },
                    {
                      title: '健康分',
                      dataIndex: 'healthScore',
                      width: 90,
                      align: 'right',
                      render: (value: number) => <span className="tabular">{value}</span>,
                    },
                    {
                      title: '当前并发',
                      dataIndex: 'currentConcurrency',
                      width: 100,
                      align: 'right',
                      render: (value: number) => <span className="tabular">{value}</span>,
                    },
                    {
                      title: '最大并发',
                      dataIndex: 'maxConcurrency',
                      width: 96,
                      align: 'right',
                      render: (value: number) => <span className="tabular">{value}</span>,
                    },
                    {
                      title: '运行态成功累计(含测试)',
                      dataIndex: 'successCount',
                      width: 110,
                      align: 'right',
                      render: (value: number) => <span className="tabular">{value}</span>,
                    },
                    {
                      title: '运行态失败累计(含测试)',
                      dataIndex: 'failureCount',
                      width: 110,
                      align: 'right',
                      render: (value: number) => <span className="tabular">{value}</span>,
                    },
                    {
                      title: `近${report.summary.diagnosticsWindowMinutes || 120}分钟成功请求`,
                      dataIndex: ['recentTaskStats', 'successCount'],
                      width: 132,
                      align: 'right',
                      render: (_: unknown, row) => <span className="tabular">{row.recentTaskStats.successCount}</span>,
                    },
                    {
                      title: `近${report.summary.diagnosticsWindowMinutes || 120}分钟失败请求`,
                      dataIndex: ['recentTaskStats', 'failedCount'],
                      width: 132,
                      align: 'right',
                      render: (_: unknown, row) => <span className="tabular">{row.recentTaskStats.failedCount}</span>,
                    },
                    {
                      title: `近${report.summary.diagnosticsWindowMinutes || 120}分钟返图张数`,
                      dataIndex: ['recentBillingStats', 'generatedImageCount'],
                      width: 132,
                      align: 'right',
                      render: (_: unknown, row) => <span className="tabular">{row.recentBillingStats.generatedImageCount}</span>,
                    },
                    {
                      title: '线路 EWMA 成功率',
                      dataIndex: 'ewmaSuccessRate',
                      width: 116,
                      align: 'right',
                      render: (value: number) => (
                        <span className="tabular">{value ? `${(value * 100).toFixed(1)}%` : EMPTY_DASH}</span>
                      ),
                    },
                    {
                      title: '线路 EWMA 延迟',
                      dataIndex: 'ewmaLatencyMs',
                      width: 110,
                      align: 'right',
                      render: (value: number) => (
                        <span className="tabular">{value ? `${Math.round(value)} ms` : EMPTY_DASH}</span>
                      ),
                    },
                    {
                      title: '支持参考图',
                      dataIndex: 'supportsReferenceImages',
                      width: 100,
                      render: (value: boolean) => (value ? '是' : '否'),
                    },
                    {
                      title: '上次成功',
                      dataIndex: 'lastSuccessAt',
                      width: 168,
                      render: (value?: number) => (
                        value ? <span className="mono">{formatDateTime(value)}</span> : <Text type="secondary">—</Text>
                      ),
                    },
                    {
                      title: '上次失败分类',
                      dataIndex: 'lastErrorCategory',
                      width: 160,
                      render: (value?: string) => <EllipsisText value={value || ''} />,
                    },
                    {
                      title: '上次错误',
                      dataIndex: 'lastErrorMessage',
                      width: 280,
                      render: (value?: string) => <EllipsisText value={value || ''} />,
                    },
                    {
                      title: '基础地址',
                      dataIndex: 'baseUrl',
                      width: 240,
                      render: (value?: string) => <EllipsisText value={value} />,
                    },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'preview',
            label: '候选预览',
            children: (
              <Card title="真实候选排序预览">
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="用于看懂智能路由当前会怎么选线"
                  description="这里展示的是某个典型请求场景下的实时候选排序，不是历史业务成功率。智能模式会把后续候选作为失败回退链；优选模式只使用排序第一的线路。"
                />
                <Tabs
                  type="card"
                  items={report.previews.map((preview) => ({
                    key: preview.key,
                    label: previewTabLabel(preview),
                    children: renderPreviewPanel(preview),
                  }))}
                />
              </Card>
            ),
          },
        ]}
      />
    </div>
  );
}
