import { Alert, Card, Descriptions, Table, Tabs, Tag, Typography } from 'antd';
import { useState } from 'react';
import type { BillingLedgerReport } from '../../shared/types';
import {
  CodeBlock,
  CompactId,
  EllipsisText,
  PageHeader,
  StatStrip,
  StatusDot,
  formatCredits,
  formatDateTime,
} from '../../shared/ui';
import type { StatusTone } from '../../shared/ui';

const { Text } = Typography;

type BillingLedgerPageProps = {
  report: BillingLedgerReport | null;
};

function renderTierTag(value?: string) {
  const tier = String(value || '').trim();
  if (!tier) {
    return <Text type="secondary">—</Text>;
  }
  return <Tag>{tier.toUpperCase()}</Tag>;
}

function renderQualityTag(value?: string) {
  const quality = String(value || '').trim();
  if (!quality) {
    return <Text type="secondary">—</Text>;
  }
  return <Tag>{quality.toUpperCase()}</Tag>;
}

function renderJson(value: unknown) {
  if (value === null || value === undefined) {
    return <Text type="secondary">—</Text>;
  }
  return <CodeBlock value={value} />;
}

function statusTone(value: string): StatusTone {
  if (value === 'charged') return 'success';
  if (value === 'voided') return 'neutral';
  return 'processing';
}

function statusLabel(value: string) {
  if (value === 'charged') return '已扣费';
  if (value === 'voided') return '已作废';
  return value;
}

function operationLabel(value: string) {
  if (value === 'edits') return '图生图';
  return '文生图';
}

export function BillingLedgerPage({ report }: BillingLedgerPageProps) {
  if (!report) {
    return null;
  }

  const [activeTab, setActiveTab] = useState<'image' | 'chat'>('image');
  const isChat = activeTab === 'chat';
  const rows = isChat ? report.chat.rows : report.image.rows;
  const chargedRows = rows.filter((row) => row.status === 'charged');
  const totalCharged = chargedRows.reduce((sum, row) => sum + Number(row.chargedCredits || 0), 0);

  const imageTable = (
    <Table
      className="diagnostic-table"
      rowKey="id"
      size="small"
      tableLayout="fixed"
      scroll={{ x: 1810 }}
      pagination={{ pageSize: 20, showSizeChanger: false }}
      dataSource={rows}
      expandable={{
        expandedRowRender: (row) => (
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="流水 ID"><CompactId value={row.id} /></Descriptions.Item>
            <Descriptions.Item label="请求 ID"><CompactId value={row.requestId} /></Descriptions.Item>
            <Descriptions.Item label="任务 ID"><CompactId value={row.taskId} /></Descriptions.Item>
            <Descriptions.Item label="租户">{row.tenantName || row.tenantId}</Descriptions.Item>
            <Descriptions.Item label="下游 Key">{row.apiKeyName || row.apiKeyId}</Descriptions.Item>
            <Descriptions.Item label="计费方式">{row.billingModeLabel || '按请求尺寸档位'}</Descriptions.Item>
            <Descriptions.Item label="请求画质">{row.requestedQuality ? renderQualityTag(row.requestedQuality) : <Text type="secondary">—</Text>}</Descriptions.Item>
            <Descriptions.Item label="计费画质">{row.billedQuality ? renderQualityTag(row.billedQuality) : <Text type="secondary">—</Text>}</Descriptions.Item>
            <Descriptions.Item label="口径说明">请求尺寸和请求画质来自实际提交给上游的参数；未传 quality 时按 AUTO。固定线路一口价不按尺寸档位和画质拆分结算。</Descriptions.Item>
            <Descriptions.Item label="计费详情">{renderJson(row.detail)}</Descriptions.Item>
          </Descriptions>
        ),
      }}
      columns={[
        { title: '时间', dataIndex: 'createdAt', width: 160, render: (value: number) => <span className="mono">{formatDateTime(value)}</span> },
        { title: '流水 ID', dataIndex: 'id', width: 170, fixed: 'left', render: (value?: string) => <CompactId value={value} /> },
        { title: '租户', dataIndex: 'tenantName', width: 140, render: (value?: string) => <EllipsisText value={value} /> },
        { title: '上游 API', dataIndex: 'upstreamName', width: 150, render: (value?: string) => <EllipsisText value={value} /> },
        { title: '类型', dataIndex: 'operation', width: 90, render: (value: string) => operationLabel(value) },
        { title: '模型', dataIndex: 'model', width: 120, render: (value?: string) => <EllipsisText value={value} /> },
        { title: '计费方式', dataIndex: 'billingModeLabel', width: 130, render: (value?: string) => <EllipsisText value={value || '按请求尺寸档位'} /> },
        { title: '请求尺寸', dataIndex: 'requestedSize', width: 120, render: (value?: string) => <span className="tabular">{value || '—'}</span> },
        { title: '请求画质', dataIndex: 'requestedQuality', width: 100, render: (value?: string) => renderQualityTag(value) },
        { title: '实际出图尺寸', dataIndex: 'actualSize', width: 130, render: (value?: string) => <span className="tabular">{value || '—'}</span> },
        { title: '结算口径', dataIndex: 'billedSize', width: 120, render: (value?: string) => <span className="tabular">{value || '—'}</span> },
        { title: '请求档位', dataIndex: 'requestedTier', width: 100, render: (value?: string) => renderTierTag(value) },
        { title: '实际出图档位', dataIndex: 'actualTier', width: 110, render: (value?: string) => renderTierTag(value) },
        { title: '最终计费档位', dataIndex: 'billedTier', width: 110, render: (value?: string) => renderTierTag(value) },
        { title: '计费画质', dataIndex: 'billedQuality', width: 100, render: (value?: string) => renderQualityTag(value) },
        { title: '实扣金额', dataIndex: 'chargedCredits', width: 110, align: 'right', render: (value: number) => <span className="tabular">{formatCredits(value)}</span> },
        { title: '状态', dataIndex: 'status', width: 100, render: (value: string) => <StatusDot tone={statusTone(value)}>{statusLabel(value)}</StatusDot> },
        { title: '请求 ID', dataIndex: 'requestId', width: 170, render: (value?: string) => <CompactId value={value} /> },
        { title: '任务 ID', dataIndex: 'taskId', width: 170, render: (value?: string) => <CompactId value={value} /> },
      ]}
    />
  );

  const chatTable = (
    <Table
      className="diagnostic-table"
      rowKey="id"
      size="small"
      tableLayout="fixed"
      scroll={{ x: 1240 }}
      pagination={{ pageSize: 20, showSizeChanger: false }}
      dataSource={rows}
      expandable={{
        expandedRowRender: (row) => (
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="流水 ID"><CompactId value={row.id} /></Descriptions.Item>
            <Descriptions.Item label="请求 ID"><CompactId value={row.requestId} /></Descriptions.Item>
            <Descriptions.Item label="租户">{row.tenantName || row.tenantId}</Descriptions.Item>
            <Descriptions.Item label="下游 Key">{row.apiKeyName || row.apiKeyId}</Descriptions.Item>
            <Descriptions.Item label="计费方式">{row.billingModeLabel || 'Chat Completions 按次计费'}</Descriptions.Item>
            <Descriptions.Item label="上游固定成本">{formatCredits(Number(row.detail?.upstreamCostCents || 0))}</Descriptions.Item>
            <Descriptions.Item label="计费详情">{renderJson(row.detail)}</Descriptions.Item>
          </Descriptions>
        ),
      }}
      columns={[
        { title: '时间', dataIndex: 'createdAt', width: 160, render: (value: number) => <span className="mono">{formatDateTime(value)}</span> },
        { title: '流水 ID', dataIndex: 'id', width: 175, fixed: 'left', render: (value?: string) => <CompactId value={value} /> },
        { title: '租户', dataIndex: 'tenantName', width: 160, render: (value?: string) => <EllipsisText value={value} /> },
        { title: '上游 API', dataIndex: 'upstreamName', width: 175, render: (value?: string) => <EllipsisText value={value} /> },
        { title: '模型', dataIndex: 'model', width: 150, render: (value?: string) => <EllipsisText value={value} /> },
        { title: '计费方式', dataIndex: 'billingModeLabel', width: 175, render: (value?: string) => <EllipsisText value={value || 'Chat Completions 按次计费'} /> },
        { title: '上游固定成本', key: 'upstreamCostCents', width: 125, align: 'right', render: (_: unknown, row: (typeof rows)[number]) => <span className="tabular">{formatCredits(Number(row.detail?.upstreamCostCents || 0))}</span> },
        { title: '实扣金额', dataIndex: 'chargedCredits', width: 115, align: 'right', render: (value: number) => <span className="tabular">{formatCredits(value)}</span> },
        { title: '状态', dataIndex: 'status', width: 100, render: (value: string) => <StatusDot tone={statusTone(value)}>{statusLabel(value)}</StatusDot> },
        { title: '请求 ID', dataIndex: 'requestId', width: 175, render: (value?: string) => <CompactId value={value} /> },
      ]}
    />
  );

  return (
    <div className="page-stack">
      <PageHeader
        title="计费流水"
        desc="这里是实际扣费审计口径。余额按租户统一扣人民币，API Key 维度仅用于归因追踪；图像与聊天按各自的实际业务字段分别审计。"
      />

      <Alert
        type="info"
        showIcon
        message={isChat ? '聊天按成功请求固定成本、固定售价结算。' : '图像流水只看最终结算，不看请求预估。'}
        description={isChat
          ? '聊天收益来自实际已扣的按次流水；上游成本取本次请求实际采用线路的固定 chatUnit，后续修改线路配置不会改写历史流水。'
          : '请求尺寸和请求画质以实际提交给上游的参数为准；实际尺寸来自成功响应。常规共享线路按请求尺寸档位和请求画质结算；固定线路一口价按张结算。'}
      />

      <StatStrip
        items={[
          { label: '流水条数', value: rows.length },
          { label: '已扣费笔数', value: chargedRows.length },
          { label: '累计实扣', value: formatCredits(totalCharged) },
        ]}
      />

      <Card className="diagnostic-card">
        <Tabs
          activeKey={activeTab}
          onChange={(value) => setActiveTab(value as 'image' | 'chat')}
          items={[
            { key: 'image', label: `图像生成 (${report.image.total})`, children: imageTable },
            { key: 'chat', label: `聊天 (${report.chat.total})`, children: chatTable },
          ]}
        />
      </Card>
    </div>
  );
}
