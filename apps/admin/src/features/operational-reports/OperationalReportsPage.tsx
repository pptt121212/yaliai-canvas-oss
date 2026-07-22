import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  InputNumber,
  Row,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useEffect } from 'react';
import type {
  AdminConsoleCatalog,
  AdminControlPlaneConfig,
  OperationalRollupReport,
  OperationalRollupTableRow,
} from '../../shared/types';
import { PageHeader, StatStrip, StatusDot, formatCredits, formatDateTime, formatReportCostCredits } from '../../shared/ui';

const { Text } = Typography;

type OperationalReportsPageProps = {
  report: OperationalRollupReport | null;
  catalog: AdminConsoleCatalog | null;
  controlPlane: AdminControlPlaneConfig | null;
  saving?: boolean;
  onSaveControlPlane?: (config: AdminControlPlaneConfig) => Promise<void>;
};

function percent(value: number) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function formatMs(value: number) {
  return `${Math.round(Number(value || 0)).toLocaleString()} ms`;
}

function channelLabel(catalog: AdminConsoleCatalog | null, id?: string) {
  const normalized = String(id || '').trim();
  if (!normalized) return '未归属通道';
  const channel = catalog?.channels.find((item) => item.id === normalized);
  return channel?.name ? `${channel.name}（${normalized}）` : normalized;
}

function upstreamLabel(catalog: AdminConsoleCatalog | null, id?: string) {
  const normalized = String(id || '').trim();
  if (!normalized) return '未归属上游';
  const upstream = catalog?.upstreams.find((item) => item.id === normalized);
  return upstream?.name ? `${upstream.name}（${normalized}）` : normalized;
}

function summarize(rows: OperationalRollupTableRow[]) {
  return rows.reduce((acc, row) => ({
    requestCount: acc.requestCount + Number(row.requestCount || 0),
    eligibleRequestCount: acc.eligibleRequestCount + Number(row.eligibleRequestCount || 0),
    completedCount: acc.completedCount + Number(row.completedCount || 0),
    failedCount: acc.failedCount + Number(row.failedCount || 0),
    rejectedCount: acc.rejectedCount + Number(row.rejectedCount || 0),
    runningCount: acc.runningCount + Number(row.runningCount || 0),
    generatedImageCount: acc.generatedImageCount + Number(row.generatedImageCount || 0),
    chatRequestCount: acc.chatRequestCount + Number(row.chatRequestCount || 0),
    chargedCredits: acc.chargedCredits + Number(row.chargedCredits || 0),
    estimatedUpstreamCostCredits: acc.estimatedUpstreamCostCredits + Number(row.estimatedUpstreamCostCredits || 0),
    estimatedGrossMarginCredits: acc.estimatedGrossMarginCredits + Number(row.estimatedGrossMarginCredits || 0),
    costedImageCount: acc.costedImageCount + Number(row.costedImageCount || 0),
    costedChatRequestCount: acc.costedChatRequestCount + Number(row.costedChatRequestCount || 0),
    generationCount: acc.generationCount + Number(row.generationCount || 0),
    editCount: acc.editCount + Number(row.editCount || 0),
    durationTotalMs: acc.durationTotalMs + Number(row.averageDurationMs || 0) * Number(row.completedCount || 0),
    durationSampleCount: acc.durationSampleCount + Number(row.completedCount || 0),
  }), {
    requestCount: 0,
    eligibleRequestCount: 0,
    completedCount: 0,
    failedCount: 0,
    rejectedCount: 0,
    runningCount: 0,
    generatedImageCount: 0,
    chatRequestCount: 0,
    chargedCredits: 0,
    estimatedUpstreamCostCredits: 0,
    estimatedGrossMarginCredits: 0,
    costedImageCount: 0,
    costedChatRequestCount: 0,
    generationCount: 0,
    editCount: 0,
    durationTotalMs: 0,
    durationSampleCount: 0,
  });
}

export function OperationalReportsPage({
  report,
  catalog,
  controlPlane,
  saving = false,
  onSaveControlPlane,
}: OperationalReportsPageProps) {
  const [form] = Form.useForm<AdminControlPlaneConfig>();

  useEffect(() => {
    if (controlPlane) {
      form.setFieldsValue(controlPlane);
    }
  }, [controlPlane, form]);

  if (!controlPlane) {
    return null;
  }

  const rows = report?.tableRows || [];
  const summary = summarize(rows);
  const successRate = summary.eligibleRequestCount
    ? (summary.completedCount / summary.eligibleRequestCount) * 100
    : 0;
  const averageDurationMs = summary.durationSampleCount
    ? summary.durationTotalMs / summary.durationSampleCount
    : 0;
  const grossMarginRate = summary.chargedCredits
    ? (summary.estimatedGrossMarginCredits / summary.chargedCredits) * 100
    : 0;
  const job = report?.jobs.channelPerformanceDaily || null;
  const enabled = Boolean(report?.enabled);
  const hardDisabledByEnv = Boolean(report?.hardDisabledByEnv);

  return (
    <div className="page-stack">
      <PageHeader
        title="经营报表"
        desc="面向长期经营分析的离线聚合报表。默认读取最近 30 天、最多 10000 条 Rollup；页面汇总仅基于当前读取范围。关闭时不扫描明细、不写入 Rollup，并在保存关闭后清理已生成的报表数据。"
      />

      <Card className="overview-card" title="长期报表 Rollup 开关">
        <Alert
          type={enabled ? 'info' : 'warning'}
          showIcon
          style={{ marginBottom: 12 }}
          message={enabled ? 'Rollup 已开启，后台会按周期生成聚合经营数据。' : 'Rollup 当前关闭，不会扫描明细表，也不会记录新的报表数据。'}
          description="关闭并保存后，服务端会立即清理该经营报表已生成的 Rollup rows 和 Job 状态。正在执行中的一轮任务会在下一个检查点停止，不再继续写入报表。"
        />
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => {
            if (!onSaveControlPlane) return;
            void onSaveControlPlane({
              ...controlPlane,
              analytics: {
                ...controlPlane.analytics,
                ...(values.analytics || {}),
              },
            });
          }}
        >
          <Row gutter={[12, 0]}>
            <Col xs={24} lg={8}>
              <Form.Item
                name={['analytics', 'operationalRollupEnabled']}
                label="启用经营报表 Rollup"
                valuePropName="checked"
                extra={hardDisabledByEnv ? '当前环境变量 OPERATIONAL_ROLLUP_ENABLED=false，后台强制禁用。' : '开启后只由后台异步任务生成，不进入下游 API 同步响应路径。'}
              >
                <Switch checkedChildren="开启" unCheckedChildren="关闭" disabled={hardDisabledByEnv} />
              </Form.Item>
            </Col>
            <Col xs={24} lg={8}>
              <Form.Item name={['analytics', 'operationalRollupIntervalMinutes']} label="生成周期（分钟）">
                <InputNumber min={15} max={24 * 60} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} lg={8}>
              <Form.Item name={['analytics', 'operationalRollupLookbackDays']} label="每轮回看天数">
                <InputNumber min={1} max={90} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Space wrap>
            <Button type="primary" htmlType="submit" loading={saving} disabled={!onSaveControlPlane}>
              保存经营报表设置
            </Button>
            <Text type="secondary">关闭保存会清理当前经营报表数据；原始任务、计费流水和请求追踪不受影响。</Text>
          </Space>
        </Form>
      </Card>

      <StatStrip
        items={[
          { label: '报表行数', value: rows.length },
          { label: '请求总数', value: summary.requestCount },
          { label: '计入成功率请求', value: summary.eligibleRequestCount },
          { label: '生成成功率', value: percent(successRate) },
          { label: '出图数', value: summary.generatedImageCount },
          { label: '聊天计费次数', value: summary.chatRequestCount },
          { label: '收益', value: formatCredits(summary.chargedCredits) },
          { label: '成本估算', value: formatReportCostCredits(summary.estimatedUpstreamCostCredits) },
          { label: '毛利估算', value: formatReportCostCredits(summary.estimatedGrossMarginCredits) },
          { label: '毛利率', value: percent(grossMarginRate) },
          { label: '成本覆盖', value: `图 ${summary.costedImageCount}/${summary.generatedImageCount} · 聊 ${summary.costedChatRequestCount}/${summary.chatRequestCount}` },
          { label: '平均成功耗时', value: formatMs(averageDurationMs) },
        ]}
      />

      <Row gutter={[12, 12]}>
        <Col xs={24} xl={12}>
          <Card title="生成任务状态">
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="当前状态">
                {enabled ? <StatusDot tone="success">已开启</StatusDot> : <StatusDot tone="neutral">已关闭</StatusDot>}
              </Descriptions.Item>
              <Descriptions.Item label="生成周期">
                <span className="tabular">{report?.intervalMinutes || controlPlane.analytics.operationalRollupIntervalMinutes} 分钟</span>
              </Descriptions.Item>
              <Descriptions.Item label="回看天数">
                <span className="tabular">{report?.lookbackDays || controlPlane.analytics.operationalRollupLookbackDays} 天</span>
              </Descriptions.Item>
              <Descriptions.Item label="最近成功">
                {job?.lastSuccessAt ? <span className="tabular">{formatDateTime(job.lastSuccessAt)}</span> : <Text type="secondary">—</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="锁定 Worker">
                {job?.lockedBy ? <span className="tabular">{job.lockedBy}</span> : <Text type="secondary">—</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="最近错误">
                {job?.lastError ? <Text type="danger">{job.lastError}</Text> : <Text type="secondary">—</Text>}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="统计口径">
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="请求/成功/失败/剔除">来自任务和追踪聚合。参数错误、内容拒绝、安全拦截、余额不足等剔除类失败不计入成功率分母。</Descriptions.Item>
              <Descriptions.Item label="收益">来自已扣费计费流水，按最终 charged 记录聚合，也就是下游实际消费。</Descriptions.Item>
              <Descriptions.Item label="成本">按当前上游接入的分辨率、质量与上游成本矩阵估算；若某组合未配置成本，会按该上游已开启的最高档成本兜底。</Descriptions.Item>
              <Descriptions.Item label="毛利">收益 - 成本估算。毛利率 = 毛利 / 收益。</Descriptions.Item>
              <Descriptions.Item label="档位/质量">来自计费明细里的 billedTier、actualTier、requestedTier 和 billedQuality。</Descriptions.Item>
              <Descriptions.Item label="平均耗时">只统计成功完成任务的耗时，按完成数量加权计算。</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>

      <Card title="每日线路经营汇总" extra={<Text type="secondary">来自持久化 Rollup，不重新扫描原始明细表</Text>}>
        <Table
          className="diagnostic-table"
          size="small"
          tableLayout="fixed"
          scroll={{ x: 2240 }}
          rowKey={(row) => `${row.bucketStart}:${row.channelId}:${row.upstreamId}`}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          dataSource={rows}
          columns={[
            {
              title: '日期',
              dataIndex: 'bucketStart',
              width: 120,
              fixed: 'left',
              render: (value: number) => new Date(value).toLocaleDateString(),
            },
            {
              title: '渠道',
              dataIndex: 'channelId',
              width: 230,
              render: (value?: string) => channelLabel(catalog, value),
            },
            {
              title: '上游线路',
              dataIndex: 'upstreamId',
              width: 260,
              render: (value?: string) => upstreamLabel(catalog, value),
            },
            {
              title: '请求',
              dataIndex: 'requestCount',
              width: 80,
              align: 'right',
              render: (value: number) => <span className="tabular">{value}</span>,
            },
            {
              title: '计入',
              dataIndex: 'eligibleRequestCount',
              width: 80,
              align: 'right',
              render: (value: number) => <span className="tabular">{value}</span>,
            },
            {
              title: '成功',
              dataIndex: 'completedCount',
              width: 80,
              align: 'right',
              render: (value: number) => <span className="tabular">{value}</span>,
            },
            {
              title: '失败',
              dataIndex: 'failedCount',
              width: 80,
              align: 'right',
              render: (value: number) => <span className="tabular">{value}</span>,
            },
            {
              title: '剔除',
              dataIndex: 'rejectedCount',
              width: 80,
              align: 'right',
              render: (value: number) => <span className="tabular">{value}</span>,
            },
            {
              title: '运行中',
              dataIndex: 'runningCount',
              width: 90,
              align: 'right',
              render: (value: number) => <span className="tabular">{value}</span>,
            },
            {
              title: '成功率',
              dataIndex: 'successRate',
              width: 95,
              align: 'right',
              render: (value: number) => <span className="tabular">{percent(value)}</span>,
            },
            {
              title: '出图数',
              dataIndex: 'generatedImageCount',
              width: 90,
              align: 'right',
              render: (value: number) => <span className="tabular">{value}</span>,
            },
            {
              title: '聊天计费',
              dataIndex: 'chatRequestCount',
              width: 100,
              align: 'right',
              render: (value: number) => <span className="tabular">{value}</span>,
            },
            {
              title: '收益',
              dataIndex: 'chargedCredits',
              width: 110,
              align: 'right',
              render: (value: number) => <span className="tabular">{formatCredits(value)}</span>,
            },
            {
              title: '成本估算',
              dataIndex: 'estimatedUpstreamCostCredits',
              width: 115,
              align: 'right',
              render: (value: number) => <span className="tabular">{formatCredits(value)}</span>,
            },
            {
              title: '毛利估算',
              dataIndex: 'estimatedGrossMarginCredits',
              width: 115,
              align: 'right',
              render: (value: number) => (
                <span className={`tabular ${Number(value || 0) < 0 ? 'is-negative' : 'is-positive'}`}>
                  {formatReportCostCredits(value)}
                </span>
              ),
            },
            {
              title: '毛利率',
              dataIndex: 'grossMarginRate',
              width: 95,
              align: 'right',
              render: (value: number) => (
                <span className={`tabular ${Number(value || 0) < 0 ? 'is-negative' : 'is-positive'}`}>
                  {percent(value)}
                </span>
              ),
            },
            {
              title: '成本覆盖',
              width: 100,
              align: 'right',
              render: (_, row) => (
                <span className="tabular">
                  图 {row.costedImageCount}/{row.generatedImageCount} · 聊 {row.costedChatRequestCount}/{row.chatRequestCount}
                </span>
              ),
            },
            {
              title: '平均耗时',
              dataIndex: 'averageDurationMs',
              width: 115,
              align: 'right',
              render: (value: number) => <span className="tabular">{formatMs(value)}</span>,
            },
            {
              title: '类型',
              width: 130,
              render: (_, row) => (
                <span className="tabular">
                  文生 {row.generationCount} / 图生 {row.editCount}
                </span>
              ),
            },
            {
              title: '档位/质量',
              width: 190,
              render: (_, row) => (
                <Space size={4} wrap>
                  {(row.tiers || []).map((item) => <Tag key={`tier:${item}`}>{item}</Tag>)}
                  {(row.qualities || []).map((item) => <Tag key={`quality:${item}`} color="blue">{item}</Tag>)}
                </Space>
              ),
            },
            {
              title: '最后活动',
              dataIndex: 'lastActivityAt',
              width: 170,
              render: (value?: number) => (value ? <span className="tabular">{formatDateTime(value)}</span> : <Text type="secondary">—</Text>),
            },
          ]}
          locale={{ emptyText: enabled ? '暂无 Rollup 数据。开启后等待后台任务生成。' : '经营报表已关闭，不会记录或展示 Rollup 数据。' }}
        />
      </Card>
    </div>
  );
}
