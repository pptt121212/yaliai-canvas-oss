import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Progress,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useEffect } from 'react';
import type { AdminConsoleCatalog, AdminControlPlaneConfig, OverviewPayload } from '../../shared/types';
import { PageHeader, StatStrip, StatusDot } from '../../shared/ui';

const { Text } = Typography;

type OverviewPageProps = {
  overview: OverviewPayload | null;
  catalog: AdminConsoleCatalog | null;
  controlPlane: AdminControlPlaneConfig | null;
  saving?: boolean;
  onSaveControlPlane?: (config: AdminControlPlaneConfig) => Promise<void>;
};

const protocolLabelMap: Record<string, string> = {
  openai_images: 'Images Endpoint',
  openai_responses: 'Responses Endpoint',
  openai_chat: 'Chat Completions',
  gemini_generate_content: 'Gemini / Banana',
  custom_async_media: '异步媒体接口',
};

function bytes(value?: number | null) {
  const raw = Math.max(0, Number(value || 0));
  if (raw >= 1024 ** 3) return `${(raw / 1024 ** 3).toFixed(2)} GB`;
  if (raw >= 1024 ** 2) return `${(raw / 1024 ** 2).toFixed(1)} MB`;
  if (raw >= 1024) return `${(raw / 1024).toFixed(1)} KB`;
  return `${raw} B`;
}

function money(cents?: number | null) {
  return `￥${(Number(cents || 0) / 100).toFixed(2)}`;
}

function duration(seconds?: number | null) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}天 ${hours}小时`;
  if (hours) return `${hours}小时 ${minutes}分钟`;
  return `${minutes}分钟`;
}

function percentTone(value: number) {
  if (value >= 85) return 'exception' as const;
  if (value >= 70) return 'active' as const;
  return 'success' as const;
}

export function OverviewPage({
  overview,
  catalog,
  controlPlane,
  saving = false,
  onSaveControlPlane,
}: OverviewPageProps) {
  const [form] = Form.useForm<AdminControlPlaneConfig>();

  useEffect(() => {
    if (controlPlane) {
      form.setFieldsValue(controlPlane);
    }
  }, [controlPlane, form]);

  if (!overview) {
    return null;
  }

  const protocolRows = Object.entries(overview.protocolStats).map(([key, count]) => ({
    key,
    name: protocolLabelMap[key] || key,
    count,
  }));
  const server = overview.server;
  const business = overview.business;
  const hotState = overview.hotState;
  const enabledChannels = (catalog?.channels || []).filter((item) => item.enabled).length;
  const enabledUpstreams = (catalog?.upstreams || []).filter((item) => item.enabled).length;

  return (
    <div className="page-stack overview-dashboard">
      <PageHeader
        title="总览"
        desc="集中查看服务器负载、业务运行、智能路由健康状态，并维护必要的全局开关。"
      />

      <StatStrip
        items={[
          { label: '健康线路', value: overview.stats.healthyProviders },
          { label: '启用上游', value: `${enabledUpstreams}/${catalog?.upstreams.length || 0}` },
          { label: '启用通道', value: `${enabledChannels}/${catalog?.channels.length || 0}` },
          { label: '租户 Key', value: catalog?.apiKeys.length || 0 },
          { label: '近 1 小时共享请求', value: business.requests1h },
          { label: '近 24 小时收入', value: money(business.charged24hCents) },
        ]}
      />

      <Row gutter={[12, 12]}>
        <Col xs={24} xl={15}>
          <Card title="服务器负载" className="overview-card">
            <div className="overview-load-grid">
              <div className="overview-load-meter">
                <Progress
                  type="dashboard"
                  percent={Math.min(100, Math.max(0, server.loadPercent1m))}
                  status={percentTone(server.loadPercent1m)}
                  format={(value) => `${Number(value || 0).toFixed(0)}%`}
                />
                <Text strong>CPU 1 分钟负载</Text>
                <Text type="secondary" className="tabular">
                  {server.loadAverage.map((item) => item.toFixed(2)).join(' / ')} · {server.cpuCount} 核
                </Text>
              </div>
              <div className="overview-load-meter">
                <Progress
                  type="dashboard"
                  percent={Math.min(100, Math.max(0, server.memory.usedPercent))}
                  status={percentTone(server.memory.usedPercent)}
                  format={(value) => `${Number(value || 0).toFixed(0)}%`}
                />
                <Text strong>系统内存</Text>
                <Text type="secondary" className="tabular">
                  {bytes(server.memory.usedBytes)} / {bytes(server.memory.totalBytes)}
                </Text>
              </div>
              <div className="overview-load-meter">
                <Progress
                  type="dashboard"
                  percent={Math.min(100, Math.max(0, server.disk?.usedPercent || 0))}
                  status={percentTone(server.disk?.usedPercent || 0)}
                  format={(value) => `${Number(value || 0).toFixed(0)}%`}
                />
                <Text strong>磁盘空间</Text>
                <Text type="secondary" className="tabular">
                  {server.disk ? `${bytes(server.disk.usedBytes)} / ${bytes(server.disk.totalBytes)}` : '无法读取'}
                </Text>
              </div>
            </div>

            <Descriptions size="small" column={{ xs: 1, md: 2 }} className="overview-descriptions">
              <Descriptions.Item label="主机">{server.hostname}</Descriptions.Item>
              <Descriptions.Item label="平台">{server.platform}</Descriptions.Item>
              <Descriptions.Item label="Node">{server.nodeVersion}</Descriptions.Item>
              <Descriptions.Item label="进程 PID"><span className="tabular">{server.pid}</span></Descriptions.Item>
              <Descriptions.Item label="服务运行">{duration(server.uptimeSeconds)}</Descriptions.Item>
              <Descriptions.Item label="系统运行">{duration(server.systemUptimeSeconds)}</Descriptions.Item>
              <Descriptions.Item label="进程 RSS">{bytes(server.processMemory.rssBytes)}</Descriptions.Item>
              <Descriptions.Item label="Heap">{bytes(server.processMemory.heapUsedBytes)} / {bytes(server.processMemory.heapTotalBytes)}</Descriptions.Item>
              <Descriptions.Item label="Redis">
                {server.redisEnabled ? <StatusDot tone="success">已启用</StatusDot> : <StatusDot tone="neutral">未启用</StatusDot>}
              </Descriptions.Item>
              <Descriptions.Item label="PostgreSQL">
                {server.databaseEnabled ? <StatusDot tone="success">已启用</StatusDot> : <StatusDot tone="neutral">未启用</StatusDot>}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>

        <Col xs={24} xl={9}>
          <Card title="业务运行" className="overview-card">
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="成功率仅统计合法请求后的实际生图结果。"
              description="已剔除参数错误、内容拒绝、安全拦截和余额不足这类请求。图像耗时按下游请求进入到结果响应完成统计，异步任务会包含排队等待时间。"
            />
            <div className="overview-business-grid">
              <div className="overview-kpi">
                <span>近 1 小时图像成功率</span>
                <strong className="tabular">{business.imageSuccessRate1h.toFixed(1)}%</strong>
                <small>成功 {business.imageSuccess1h} / 计入 {business.imageEligibleRequests1h} / 剔除 {business.imageRejected1h}</small>
              </div>
              <div className="overview-kpi">
                <span>近 24 小时图像成功率</span>
                <strong className="tabular">{business.imageSuccessRate24h.toFixed(1)}%</strong>
                <small>成功 {business.imageSuccess24h} / 计入 {business.imageEligibleRequests24h} / 剔除 {business.imageRejected24h}</small>
              </div>
              <div className="overview-kpi">
                <span>租户总余额</span>
                <strong className="tabular">{money(business.tenantBalanceTotalCents)}</strong>
                <small>{business.tenantBalanceCount} 个余额账户</small>
              </div>
              <div className="overview-kpi">
                <span>累计扣费</span>
                <strong className="tabular">{money(business.tenantDebitedTotalCents)}</strong>
                <small>按租户共享余额扣费</small>
              </div>
            </div>

            <Descriptions size="small" column={1} className="overview-descriptions">
              <Descriptions.Item label="近 24 小时共享业务请求">
                <span className="tabular">{business.requests24h}</span>
              </Descriptions.Item>
              <Descriptions.Item label="近 24 小时计入成功率">
                <span className="tabular">{business.eligibleRequests24h}</span>
              </Descriptions.Item>
              <Descriptions.Item label="近 24 小时已剔除请求">
                <span className="tabular">{business.rejected24h}</span>
              </Descriptions.Item>
              <Descriptions.Item label="近 24 小时真实失败">
                <span className="tabular">{business.failed24h}</span>
              </Descriptions.Item>
              <Descriptions.Item label="近 24 小时完成任务">
                <span className="tabular">{business.completedTasks24h}</span>
              </Descriptions.Item>
              <Descriptions.Item label="运行中任务">
                <span className="tabular">{business.runningTasksCurrent}</span>
              </Descriptions.Item>
              <Descriptions.Item label="近 24 小时平均成功生图耗时">
                <span className="tabular">{Math.round(Number(business.averageImageDuration24hMs || 0)).toLocaleString()} ms</span>
              </Descriptions.Item>
              <Descriptions.Item label="限流桶 / 并发计数">
                <span className="tabular">{hotState.rateLimitBucketCount} / {hotState.concurrencyCounterCount}</span>
              </Descriptions.Item>
              <Descriptions.Item label="热状态任务 / 工作流">
                <span className="tabular">{hotState.imageTaskCount} / {hotState.workflowRunCount}</span>
              </Descriptions.Item>
              <Descriptions.Item label="健康快照">
                <span className="tabular">{hotState.providerHealthCount}</span>
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>

      <Card title="全局设置" className="overview-card">
        <Alert
          type="info"
          showIcon
          message="这些设置会影响下游 API 入口、全局容量保护和画布入口。"
          description="建议生产环境保持 tenant_key 鉴权，租户充值余额不足时会直接拦截下游生成请求。"
          style={{ marginBottom: 12 }}
        />
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => {
            if (!controlPlane || !onSaveControlPlane) {
              return;
            }
            void onSaveControlPlane({
              ...controlPlane,
              routing: {
                ...controlPlane.routing,
                ...(values.routing || {}),
              },
              publicApi: {
                ...controlPlane.publicApi,
                ...(values.publicApi || {}),
              },
              canvas: {
                ...controlPlane.canvas,
                ...(values.canvas || {}),
              },
              maintenance: {
                ...controlPlane.maintenance,
                ...(values.maintenance || {}),
              },
              analytics: {
                ...controlPlane.analytics,
                ...(values.analytics || {}),
              },
            });
          }}
        >
          <Row gutter={[12, 0]}>
            <Col xs={24} lg={12} xl={6}>
              <Card size="small" title="下游 API" className="overview-settings-card">
                <Form.Item name={['publicApi', 'enabled']} label="开放下游 API" valuePropName="checked">
                  <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                </Form.Item>
                <Form.Item name={['publicApi', 'authMode']} label="鉴权方式">
                  <Select
                    options={[
                      { value: 'tenant_key', label: '租户 Key 鉴权（推荐）' },
                      { value: 'admin_key', label: '任意 Token 放行（兼容模式）' },
                      { value: 'disabled', label: '关闭鉴权（仅测试）' },
                    ]}
                  />
                </Form.Item>
                <Form.Item name={['publicApi', 'rateLimitPerMinute']} label="全局每分钟请求上限">
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  name={['publicApi', 'maxConcurrency']}
                  label="全局最大并发"
                  extra="限制所有租户 Key 合计正在执行的图像请求；0 表示不启用全局并发限制。"
                >
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item name={['publicApi', 'defaultResponseFormat']} label="默认返回格式">
                  <Select options={[{ value: 'url', label: 'URL' }, { value: 'b64_json', label: 'Base64' }]} />
                </Form.Item>
                <Text type="secondary">
                  默认返回格式只在下游未传 `response_format` 时生效；下游明确传 `url` 或 `b64_json` 时会按请求处理。通常推荐默认使用 `url`，响应更轻、更适合开放平台与中转场景。
                </Text>
                <Space wrap>
                  <Form.Item name={['publicApi', 'exposeGenerations']} label="文生图接口" valuePropName="checked">
                    <Switch checkedChildren="开放" unCheckedChildren="关闭" />
                  </Form.Item>
                  <Form.Item name={['publicApi', 'exposeEdits']} label="图生图接口" valuePropName="checked">
                    <Switch checkedChildren="开放" unCheckedChildren="关闭" />
                  </Form.Item>
                </Space>
              </Card>
            </Col>
            <Col xs={24} lg={12} xl={6}>
              <Card size="small" title="智能路由" className="overview-settings-card">
                <Form.Item name={['routing', 'allowUserSuppliedKey']} label="允许用户自带上游 Key" valuePropName="checked">
                  <Switch checkedChildren="允许" unCheckedChildren="禁止" />
                </Form.Item>
                <Form.Item
                  name={['routing', 'smartRoutingCostPriorityBaseDelta']}
                  label="成本优先分差阈值"
                  extra="当两条候选线路的基础分差不超过这个值时，智能/优选模式会优先选择更便宜的线路。值越小，越倾向先看综合分；值越大，越倾向先看成本。"
                >
                  <InputNumber min={0} max={100} style={{ width: '100%' }} />
                </Form.Item>
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label="生效维度">租户生成的 API Key</Descriptions.Item>
                  <Descriptions.Item label="智能">失败后按候选线路继续尝试</Descriptions.Item>
                  <Descriptions.Item label="优选">只请求算法选出的第一候选</Descriptions.Item>
                  <Descriptions.Item label="固定">只请求 Key 绑定的指定上游 API</Descriptions.Item>
                </Descriptions>
                <Text type="secondary">
                  下游 `/v1/images/*` 主链路不再使用旧的“健康度优先、轮询、最少使用”等全局默认模式；请在“租户与密钥”里按 Key 设置路由模式。
                </Text>
              </Card>
            </Col>
            <Col xs={24} lg={12} xl={6}>
              <Card size="small" title="画布入口" className="overview-settings-card">
                <Form.Item
                  name={['canvas', 'entryMode']}
                  label="右上角入口模式"
                  extra="登录模式下右上角只显示“登录 / 注册”或“登录设置”；本地模式下右上角只显示“本地设置”。"
                >
                  <Select
                    options={[
                      { value: 'login', label: '登录模式' },
                      { value: 'settings', label: '本地模式' },
                    ]}
                  />
                </Form.Item>
                <Form.Item name={['canvas', 'brandLogoUrl']} label="画布 LOGO 地址">
                  <Input placeholder="https://your-site.com/logo.svg" />
                </Form.Item>
              </Card>
            </Col>
            <Col xs={24} lg={12} xl={6}>
              <Card size="small" title="数据保留与清理" className="overview-settings-card">
                <Form.Item
                  name={['maintenance', 'generatedImageRetentionMinutes']}
                  label="生成图片保留时长（分钟）"
                  extra="下游 API 返回的站内图片 URL 对应文件保留时长。"
                >
                  <InputNumber min={1} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  name={['maintenance', 'canvasReferenceAssetRetentionMinutes']}
                  label="画布参考图保留时长（分钟）"
                  extra="登录模式下，用户上传到服务端的临时参考图文件保留时长。"
                >
                  <InputNumber min={1} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  name={['maintenance', 'requestTraceRetentionMinutes']}
                  label="请求追踪保留时长（分钟）"
                  extra="请求追踪页和问题排查使用的上下游请求日志保留时长。"
                >
                  <InputNumber min={1} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  name={['maintenance', 'taskRecordRetentionDays']}
                  label="任务记录保留时长（天）"
                  extra="异步任务、执行结果摘要、通道统计等依赖的任务主记录保留时长。"
                >
                  <InputNumber min={1} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  name={['maintenance', 'auditLogRetentionDays']}
                  label="审计日志保留时长（天）"
                  extra="管理员操作与系统审计日志保留时长。"
                >
                  <InputNumber min={1} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  name={['maintenance', 'billingLedgerRetentionDays']}
                  label="计费明细保留时长（天）"
                  extra="图像计费账本保留时长，不影响租户余额本身。"
                >
                  <InputNumber min={1} style={{ width: '100%' }} />
                </Form.Item>
                <Text type="secondary">
                  后台会在服务启动时立即执行一次清理，之后每 5 分钟再次执行。这里仅放可自动清理的数据；租户余额、充值流水、用户账号、租户与密钥、上游与通道配置不会被自动清理。
                </Text>
              </Card>
            </Col>
          </Row>
          <Button type="primary" htmlType="submit" loading={saving} disabled={!onSaveControlPlane}>
            保存全局设置
          </Button>
        </Form>
      </Card>

      <Row gutter={[12, 12]}>
        <Col xs={24} xl={12}>
          <Card title="协议分布">
            <Table
              size="small"
              pagination={false}
              dataSource={protocolRows}
              columns={[
                { title: '协议', dataIndex: 'name' },
                {
                  title: '数量',
                  dataIndex: 'count',
                  width: 120,
                  align: 'right',
                  render: (value: number) => <span className="tabular">{value}</span>,
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="线路健康概览">
            <Space wrap>
              <Tag color="green">健康 {overview.stats.healthyProviders}</Tag>
              <Tag color="orange">冷却 {overview.stats.coolingProviders}</Tag>
              <Tag color="gold">降级 {overview.stats.degradedProviders}</Tag>
              <Tag>图像能力 {overview.stats.imageCapableProviders}</Tag>
              <Tag>总线路 {overview.stats.totalProviders}</Tag>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
