import { Alert, Button, Card, Input, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { fetchChannelPerformanceReport } from '../../shared/api';
import type {
  AdminConsoleCatalog,
  ChannelPerformanceMetric,
  ChannelPerformanceReport,
  ConsoleChannel,
  ConsoleChannelUpstreamPolicy,
  ConsoleUpstream,
  ConsoleUpstreamKind,
} from '../../shared/types';
import { EllipsisText, formatCredits, PageHeader, SectionTitle, StatusDot } from '../../shared/ui';

const { Text } = Typography;

const emptyMetric: ChannelPerformanceMetric = {
  channelId: '',
  upstreamId: '',
  healthState: 'healthy',
  healthScore: 100,
  requestCount: 0,
  eligibleRequestCount: 0,
  completedCount: 0,
  failedCount: 0,
  rejectedCount: 0,
  runningCount: 0,
  successRate: 0,
  generatedImageCount: 0,
  chargedCredits: 0,
  estimatedUpstreamCostCredits: 0,
  estimatedGrossMarginCredits: 0,
  costedImageCount: 0,
  averageDurationMs: 0,
  generationCount: 0,
  editCount: 0,
  upstreams: [],
};

function formatCurrency(value: number) {
  return formatCredits(value);
}

function formatReportCurrency(value: number) {
  return formatCredits(value);
}

function formatDuration(value: number) {
  const milliseconds = Math.max(0, Number(value || 0));
  if (!milliseconds) {
    return '-';
  }
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)} ms`;
  }
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(1)} s`;
  }
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function formatActivityTime(value?: number) {
  if (!value) {
    return '暂无活动';
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function normalizeHealthState(value?: string) {
  const normalized = String(value || '').trim();
  return normalized === 'healthy' || normalized === 'cooling' || normalized === 'degraded' || normalized === 'disabled'
    ? normalized
    : 'healthy';
}

function healthStateLabel(value?: string) {
  const normalized = normalizeHealthState(value);
  if (normalized === 'healthy') return '健康';
  if (normalized === 'cooling') return '冷却中';
  if (normalized === 'degraded') return '降级';
  return '停用';
}

function healthStateTone(value?: string) {
  const normalized = normalizeHealthState(value);
  if (normalized === 'healthy') return 'success';
  if (normalized === 'disabled') return 'neutral';
  return 'warning';
}

type ChannelsPageProps = {
  catalog: AdminConsoleCatalog | null;
  saving: boolean;
  onSave: (channel: ConsoleChannel) => Promise<void>;
  onSaveUpstream: (upstream: ConsoleUpstream) => Promise<void>;
};

const upstreamKindLabels: Record<ConsoleUpstreamKind, string> = {
  images_endpoint: 'Images Endpoint',
  responses_endpoint: 'Responses Endpoint',
  banana_endpoint: 'Banana / Gemini 图像',
  chat_completions: 'Chat Completions',
};

const fixedChannels: Record<'channel_image_generation' | 'channel_text_processing', ConsoleChannel> = {
  channel_image_generation: {
    id: 'channel_image_generation',
    name: '图像生成',
    businessType: 'image_generation',
    acceptedUpstreamKinds: ['images_endpoint', 'responses_endpoint', 'banana_endpoint'],
    upstreamIds: [],
    upstreamPolicies: [],
    enabled: true,
    displayOrder: 10,
    notes: '',
  },
  channel_text_processing: {
    id: 'channel_text_processing',
    name: '文本处理',
    businessType: 'text_processing',
    acceptedUpstreamKinds: ['chat_completions'],
    upstreamIds: [],
    upstreamPolicies: [],
    enabled: true,
    displayOrder: 20,
    notes: '',
  },
};

type ChannelDraft = {
  upstreamIds: string[];
  upstreamPolicies: ConsoleChannelUpstreamPolicy[];
};

function resolveChannel(catalog: AdminConsoleCatalog | null, id: keyof typeof fixedChannels) {
  return catalog?.channels.find((item) => item.id === id) || fixedChannels[id];
}

function defaultPolicy(upstreamId: string): ConsoleChannelUpstreamPolicy {
  return {
    upstreamId,
    pricing: {
      auto: 0,
      oneK: 0,
      twoK: 0,
      fourK: 0,
      chatUnit: 0,
    },
    notes: '',
  };
}

function syncPolicies(upstreamIds: string[], policies: ConsoleChannelUpstreamPolicy[]) {
  const byId = new Map(policies.map((item) => [item.upstreamId, item]));
  return upstreamIds.map((upstreamId) => byId.get(upstreamId) || defaultPolicy(upstreamId));
}

function sameStringArray(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

export function ChannelsPage({ catalog, saving, onSave, onSaveUpstream }: ChannelsPageProps) {
  const [drafts, setDrafts] = useState<Record<string, ChannelDraft>>({});
  const [metricDays, setMetricDays] = useState(7);
  const [performance, setPerformance] = useState<ChannelPerformanceReport | null>(null);
  const [performanceLoading, setPerformanceLoading] = useState(false);
  const [performanceError, setPerformanceError] = useState('');
  const upstreams = catalog?.upstreams || [];
  const channelIds: Array<keyof typeof fixedChannels> = ['channel_image_generation', 'channel_text_processing'];

  const loadPerformance = useCallback(async (days: number) => {
    setPerformanceLoading(true);
    setPerformanceError('');
    try {
      setPerformance(await fetchChannelPerformanceReport(days));
    } catch (error) {
      setPerformanceError(error instanceof Error ? error.message : '业务通道统计读取失败');
    } finally {
      setPerformanceLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPerformance(metricDays);
  }, [loadPerformance, metricDays]);

  useEffect(() => {
    const next: Record<string, ChannelDraft> = {};
    for (const id of channelIds) {
      const channel = resolveChannel(catalog, id);
      next[id] = {
        upstreamIds: channel.upstreamIds,
        upstreamPolicies: syncPolicies(channel.upstreamIds, channel.upstreamPolicies || []),
      };
    }
    setDrafts(next);
  }, [catalog?.channels, catalog?.upstreams]);

  function updateDraft(id: keyof typeof fixedChannels, patch: Partial<ChannelDraft>) {
    const channel = resolveChannel(catalog, id);
    setDrafts((current) => ({
      ...current,
      [id]: {
        upstreamIds: current[id]?.upstreamIds || channel.upstreamIds,
        upstreamPolicies: current[id]?.upstreamPolicies || syncPolicies(channel.upstreamIds, channel.upstreamPolicies || []),
        ...patch,
      },
    }));
  }

  async function saveChannel(id: keyof typeof fixedChannels) {
    const channel = resolveChannel(catalog, id);
    const upstreamIds = upstreams
      .filter((item) => channel.acceptedUpstreamKinds.includes(item.kind))
      .map((item) => item.id);
    const draft = drafts[id] || {
      upstreamIds,
      upstreamPolicies: syncPolicies(upstreamIds, channel.upstreamPolicies || []),
    };
    await onSave({
      ...channel,
      enabled: true,
      upstreamIds,
      upstreamPolicies: syncPolicies(upstreamIds, draft.upstreamPolicies),
    });
  }

  function renderChannelTab(id: keyof typeof fixedChannels) {
    const channel = resolveChannel(catalog, id);
    const draft = drafts[id] || {
      upstreamIds: channel.upstreamIds,
      upstreamPolicies: syncPolicies(channel.upstreamIds, channel.upstreamPolicies || []),
    };
    const availableUpstreams = upstreams.filter((item) => channel.acceptedUpstreamKinds.includes(item.kind));
    const channelUpstreamIds = availableUpstreams.map((item) => item.id);
    const selectedUpstreams = availableUpstreams;
    const enabledUpstreams = availableUpstreams.filter((item) => item.enabled);
    const metric = performance?.rows.find((item) => item.channelId === id) || { ...emptyMetric, channelId: id };
    const upstreamMetricById = new Map(metric.upstreams.map((item) => [item.upstreamId, item]));
    const getRuntimeHealthState = (upstreamId: string, fallback?: string) => normalizeHealthState(upstreamMetricById.get(upstreamId)?.healthState || fallback);
    const healthyUpstreams = enabledUpstreams.filter((item) => getRuntimeHealthState(item.id, item.healthStatus) === 'healthy');
    const policyByUpstreamId = new Map(syncPolicies(channelUpstreamIds, draft.upstreamPolicies).map((item) => [item.upstreamId, item]));
    const isDirty =
      !sameStringArray([...channel.upstreamIds].sort(), [...channelUpstreamIds].sort()) ||
      JSON.stringify(syncPolicies(channelUpstreamIds, channel.upstreamPolicies || [])) !== JSON.stringify(syncPolicies(channelUpstreamIds, draft.upstreamPolicies));
    const metricCards = [
      {
        label: '业务请求',
        value: metric.requestCount.toLocaleString(),
        note: `计入成功率 ${metric.eligibleRequestCount} / 已剔除 ${metric.rejectedCount}`,
      },
      {
        label: '生成成功率',
        value: `${(metric.successRate * 100).toFixed(1)}%`,
        note: metric.runningCount
          ? `成功 ${metric.completedCount} / 失败 ${metric.failedCount} / 进行中 ${metric.runningCount}`
          : `成功 ${metric.completedCount} / 失败 ${metric.failedCount}`,
        tone: metric.successRate >= 0.95 ? 'success' : metric.failedCount ? 'warning' : 'neutral',
      },
      {
        label: '请求剔除',
        value: metric.rejectedCount.toLocaleString(),
        note: '参数错误、内容拦截、安全或余额不足不计入成功率',
      },
      ...(channel.businessType === 'image_generation'
        ? [{
            label: '计费图片',
            value: metric.generatedImageCount.toLocaleString(),
            note: `来自已扣费流水；文生图请求 ${metric.generationCount} / 图生图请求 ${metric.editCount}`,
          }]
        : []),
      {
        label: channel.businessType === 'image_generation' ? '平均成功生图耗时' : '平均成功耗时',
        value: formatDuration(metric.averageDurationMs),
        note: channel.businessType === 'image_generation'
          ? `按下游请求进入到结果响应完成统计；最近活动：${formatActivityTime(metric.lastActivityAt)}`
          : `最近活动：${formatActivityTime(metric.lastActivityAt)}`,
      },
      {
        label: '下游消费',
        value: formatCurrency(metric.chargedCredits),
        note: '来自实际计费流水',
      },
      ...(channel.businessType === 'image_generation'
        ? [
            {
              label: '上游成本',
              value: formatReportCurrency(metric.estimatedUpstreamCostCredits),
              note: `按当前成本矩阵估算，覆盖 ${metric.costedImageCount}/${metric.generatedImageCount} 张`,
            },
            {
              label: '毛差估算',
              value: formatReportCurrency(metric.estimatedGrossMarginCredits),
              note: '下游消费减当前成本估算',
              tone: metric.estimatedGrossMarginCredits >= 0 ? 'success' : 'danger',
            },
          ]
        : []),
    ];

    const columns = [
      {
        title: '上游 API',
        key: 'upstream',
        width: 260,
        render: (_: unknown, record: AdminConsoleCatalog['upstreams'][number]) => (
          <Space direction="vertical" size={4}>
            <Text strong>{record.name}</Text>
            <EllipsisText value={record.baseUrl} />
            <Space wrap size={8}>
              <Tag>{upstreamKindLabels[record.kind]}</Tag>
              <StatusDot tone={record.enabled ? 'success' : 'neutral'}>
                {record.enabled ? '上游启用' : '上游停用'}
              </StatusDot>
              <StatusDot tone={healthStateTone(getRuntimeHealthState(record.id, record.healthStatus))}>
                {healthStateLabel(getRuntimeHealthState(record.id, record.healthStatus))}
              </StatusDot>
            </Space>
          </Space>
        ),
      },
      {
        title: '请求',
        key: 'requests',
        width: 112,
        render: (_: unknown, record: AdminConsoleCatalog['upstreams'][number]) => {
          const item = upstreamMetricById.get(record.id);
          return (
            <div className="channel-table-metric">
              <strong>{item?.requestCount || 0}</strong>
              <span>计入 {item?.eligibleRequestCount || 0}</span>
              <span>剔除 {item?.rejectedCount || 0}</span>
            </div>
          );
        },
      },
      {
        title: '生成成功率',
        key: 'successRate',
        width: 120,
        render: (_: unknown, record: AdminConsoleCatalog['upstreams'][number]) => {
          const item = upstreamMetricById.get(record.id);
          return (
            <div className="channel-table-metric">
              <strong>{((item?.successRate || 0) * 100).toFixed(1)}%</strong>
              <span>成功 {item?.completedCount || 0}</span>
              <span>{item?.runningCount ? `失败 ${item?.failedCount || 0} / 进行中 ${item.runningCount}` : `失败 ${item?.failedCount || 0}`}</span>
            </div>
          );
        },
      },
      {
        title: '计费图',
        key: 'generatedImages',
        width: 86,
        render: (_: unknown, record: AdminConsoleCatalog['upstreams'][number]) => {
          const item = upstreamMetricById.get(record.id);
          return channel.businessType === 'image_generation'
            ? (
                <div className="channel-table-metric">
                  <strong>{item?.generatedImageCount || 0}</strong>
                  <span>文 {item?.generationCount || 0} / 编 {item?.editCount || 0}</span>
                </div>
              )
            : <Text type="secondary">-</Text>;
        },
      },
      {
        title: channel.businessType === 'image_generation' ? '成功生图耗时' : '平均耗时',
        key: 'averageDuration',
        width: 104,
        render: (_: unknown, record: AdminConsoleCatalog['upstreams'][number]) => (
          <div className="channel-table-metric">
            <strong>{formatDuration(upstreamMetricById.get(record.id)?.averageDurationMs || 0)}</strong>
            <span>{formatActivityTime(upstreamMetricById.get(record.id)?.lastActivityAt)}</span>
          </div>
        ),
      },
      {
        title: '下游消费',
        key: 'chargedCredits',
        width: 108,
        render: (_: unknown, record: AdminConsoleCatalog['upstreams'][number]) => (
          <div className="channel-table-metric">
            <strong>{formatCurrency(upstreamMetricById.get(record.id)?.chargedCredits || 0)}</strong>
            <span>实际计费</span>
          </div>
        ),
      },
      {
        title: '上游成本',
        key: 'upstreamCost',
        width: 108,
        render: (_: unknown, record: AdminConsoleCatalog['upstreams'][number]) => (
          <div className="channel-table-metric">
            <strong>{formatReportCurrency(upstreamMetricById.get(record.id)?.estimatedUpstreamCostCredits || 0)}</strong>
            <span>当前配置估算</span>
          </div>
        ),
      },
      {
        title: '毛差',
        key: 'grossMargin',
        width: 108,
        render: (_: unknown, record: AdminConsoleCatalog['upstreams'][number]) => {
          const value = upstreamMetricById.get(record.id)?.estimatedGrossMarginCredits || 0;
          return (
            <div className={`channel-table-metric ${value < 0 ? 'is-negative' : 'is-positive'}`}>
              <strong>{formatReportCurrency(value)}</strong>
              <span>消费 - 成本</span>
            </div>
          );
        },
      },
      {
        title: '线路开关',
        key: 'enabled',
        width: 120,
        render: (_: unknown, record: AdminConsoleCatalog['upstreams'][number]) => (
          <Switch
            checked={record.enabled}
            loading={saving}
            checkedChildren="开启"
            unCheckedChildren="停用"
            onChange={(checked) => {
              void onSaveUpstream({ ...record, enabled: checked }).catch(() => undefined);
            }}
          />
        ),
      },
      {
        title: '通道备注',
        key: 'notes',
        width: 280,
        render: (_: unknown, record: AdminConsoleCatalog['upstreams'][number]) => {
          const selected = true;
          const policy = policyByUpstreamId.get(record.id) || defaultPolicy(record.id);
          const updatePolicy = (patch: Partial<ConsoleChannelUpstreamPolicy>) => {
            if (!selected) {
              return;
            }
            const nextPolicies = syncPolicies(draft.upstreamIds, draft.upstreamPolicies).map((item) => (
              item.upstreamId === record.id ? { ...item, ...patch } : item
            ));
            updateDraft(id, { upstreamPolicies: nextPolicies });
          };
          return (
            <Input
              disabled={!selected}
              value={policy.notes}
              placeholder={channel.businessType === 'image_generation' ? '例如：备用图像线路' : '例如：适合大模型长文本整理'}
              onChange={(event) => updatePolicy({ notes: event.target.value })}
            />
          );
        },
      },
    ];

    return (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card size="small" className="channel-summary-card">
          <div className="channel-summary-card__header">
            <div>
              <SectionTitle
                desc={channel.businessType === 'image_generation'
                  ? '所有 Images Endpoint 与 Responses Endpoint 上游会自动归属此通道；在这里控制线路启停。'
                  : '所有 Chat Completions 上游会自动归属此通道；在这里控制线路启停。上游固定成本在“上游接入”中维护。'}
              >
                {channel.name}通道
              </SectionTitle>
              <Space wrap size={8}>
                <StatusDot tone="success">通道已开放</StatusDot>
                <Tag color="blue">已接入 {selectedUpstreams.length}</Tag>
                <Tag color={healthyUpstreams.length ? 'green' : 'orange'}>健康 {healthyUpstreams.length}</Tag>
                <Tag>启用 {enabledUpstreams.length}</Tag>
              </Space>
            </div>
            <Button type="primary" loading={saving} disabled={!isDirty} onClick={() => saveChannel(id)}>
              保存通道配置
            </Button>
          </div>

          <div className={`channel-metric-grid${performanceLoading ? ' is-loading' : ''}`}>
            {metricCards.map((item) => (
              <div className={`channel-metric-card${item.tone ? ` is-${item.tone}` : ''}`} key={item.label}>
                <span className="channel-metric-card__label">{item.label}</span>
                <strong className="channel-metric-card__value">{performanceLoading ? '...' : item.value}</strong>
                <span className="channel-metric-card__note">{performanceLoading ? '正在更新统计' : item.note}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card size="small" className="channel-members-card">
          <div className="channel-members-card__header">
            <SectionTitle desc="上游保存后会自动进入对应业务通道；关闭线路后将立即退出智能路由候选池。">
              通道线路
            </SectionTitle>
            <Space wrap size={6}>
              {channel.acceptedUpstreamKinds.map((item) => (
                <Tag key={item}>{upstreamKindLabels[item]}</Tag>
              ))}
            </Space>
          </div>
          <Table
            rowKey="id"
            size="small"
            className="channel-upstream-table"
            dataSource={availableUpstreams}
            pagination={false}
            scroll={{ x: channel.businessType === 'text_processing' ? 1760 : 1540 }}
            columns={columns}
          />
        </Card>

        {availableUpstreams.length === 0 ? (
          <Card size="small">
            <Text type="secondary">当前还没有可加入该通道的上游 API，请先到“上游接入”新增对应类型。</Text>
          </Card>
        ) : null}
      </Space>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="业务通道"
        desc="上游接入会自动归属对应业务通道；在这里统一控制线路启停并查看运行质量、消费和成本。"
      />
      <Card size="small" className="channel-performance-toolbar">
        <div>
          <Text strong>经营数据窗口</Text>
          <Text type="secondary">
            业务请求 = 共享业务总请求；生成成功率 = 成功 / 计入成功率请求；参数错误、内容拦截、安全和余额不足会单列为“请求剔除”。上游成本按当前线路成本矩阵估算。
          </Text>
        </div>
        <Space wrap>
          <Select
            value={metricDays}
            style={{ width: 120 }}
            options={[
              { value: 1, label: '最近 24 小时' },
              { value: 7, label: '最近 7 天' },
              { value: 30, label: '最近 30 天' },
            ]}
            onChange={setMetricDays}
          />
          <Button loading={performanceLoading} onClick={() => void loadPerformance(metricDays)}>
            刷新数据
          </Button>
        </Space>
      </Card>
      {performanceError ? (
        <Alert type="error" showIcon message="通道统计加载失败" description={performanceError} />
      ) : null}
      <Card>
        <Tabs
          items={[
            {
              key: 'channel_image_generation',
              label: '图像生成',
              children: renderChannelTab('channel_image_generation'),
            },
            {
              key: 'channel_text_processing',
              label: '文本处理',
              children: renderChannelTab('channel_text_processing'),
            },
          ]}
        />
      </Card>
    </div>
  );
}
