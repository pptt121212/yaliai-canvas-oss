import { Card, Space, Table, Tag, Typography } from 'antd';
import type { AspectResolutionAuditSummaryRow, ResolutionAuditReport, ResolutionAuditSummaryRow } from '../../shared/types';
import { PageHeader, StatStrip, formatDateTime } from '../../shared/ui';

const { Paragraph, Text } = Typography;

function renderSimpleTierBreakdown(row: { actualTierBreakdown: Record<string, number> }) {
  const entries = Object.entries(row.actualTierBreakdown || {});
  if (!entries.length) {
    return <Text type="secondary">暂无</Text>;
  }
  return (
    <Space wrap size={[6, 6]}>
      {entries.map(([tier, count]) => (
        <Tag key={tier} className="tabular">
          {tier.toUpperCase()} {count}
        </Tag>
      ))}
    </Space>
  );
}

function renderDowngradeBreakdown(row: { downgradeLevelBreakdown: Record<string, number> }) {
  const entries = Object.entries(row.downgradeLevelBreakdown || {});
  if (!entries.length) {
    return <Text type="secondary">暂无</Text>;
  }
  return (
    <Space wrap size={[6, 6]}>
      {entries.map(([level, count]) => (
        <Tag
          key={level}
          className="tabular"
          color={level === '0' ? 'success' : Number(level) >= 2 ? 'error' : 'warning'}
        >
          {level === '0' ? '未降档' : `降 ${level} 档`} {count}
        </Tag>
      ))}
    </Space>
  );
}

function renderTierTag(value: string) {
  return <Tag>{value === 'auto' ? 'AUTO' : value.toUpperCase()}</Tag>;
}

function renderOperation(value: 'generations' | 'edits') {
  return value === 'edits' ? '图生图' : '文生图';
}

function renderPercent(value: number) {
  return <span className="tabular">{value}%</span>;
}

type ResolutionAuditPageProps = {
  report: ResolutionAuditReport | null;
};

export function ResolutionAuditPage({ report }: ResolutionAuditPageProps) {
  if (!report) {
    return null;
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="分辨率偏差"
        desc="按「上游 + 操作 + 请求尺寸 + 比例」统计尺寸是否稳定、是否降档、比例是否正确。默认基于最近 1000 个任务样本，任务保留期内的数据是智能优选与回退的基础证据。"
      />

      <StatStrip
        items={[
          { label: '采样任务数', value: report.totals.sampleCount },
          { label: '成功测得尺寸', value: report.totals.measuredCount },
          { label: '涉及上游数', value: report.totals.upstreamCount },
          { label: '精确请求组数', value: report.totals.exactRequestGroupCount },
          { label: '同比例辅助组数', value: report.totals.aspectGroupCount },
        ]}
      />

      <Card title="分辨率与比例偏差统计">
        <Table
          rowKey="key"
          size="small"
          scroll={{ x: 1800 }}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          dataSource={report.rows}
          columns={[
            { title: '上游', dataIndex: 'upstreamName', width: 220, fixed: 'left' },
            {
              title: '操作',
              dataIndex: 'operation',
              width: 90,
              render: (value: ResolutionAuditSummaryRow['operation']) => renderOperation(value),
            },
            {
              title: '请求尺寸',
              dataIndex: 'requestedSize',
              width: 120,
              render: (value: string) => <span className="mono">{value}</span>,
            },
            { title: '请求比例', dataIndex: 'requestedAspectLabel', width: 100 },
            {
              title: '请求档位',
              dataIndex: 'requestedTier',
              width: 100,
              render: (value: ResolutionAuditSummaryRow['requestedTier']) => renderTierTag(value),
            },
            { title: '样本数', dataIndex: 'sampleCount', width: 90, align: 'right', render: renderPercentFree },
            { title: '测得尺寸', dataIndex: 'measuredCount', width: 100, align: 'right', render: renderPercentFree },
            { title: '平均比例准确率', dataIndex: 'avgAspectAccuracyPercent', width: 130, align: 'right', render: renderPercent },
            { title: '平均分辨率准确率', dataIndex: 'avgResolutionAccuracyPercent', width: 150, align: 'right', render: renderPercent },
            { title: '同档或更高', dataIndex: 'sameOrHigherTierRate', width: 120, align: 'right', render: renderPercent },
            { title: '降档率', dataIndex: 'downgradeRate', width: 100, align: 'right', render: renderPercent },
            { title: '平均降档级别', dataIndex: 'avgTierDowngradeLevels', width: 120, align: 'right', render: renderPercentFree },
            { title: '尺寸完全一致', dataIndex: 'exactSizeMatchRate', width: 120, align: 'right', render: renderPercent },
            { title: '同档位', dataIndex: 'sameTierMatchRate', width: 100, align: 'right', render: renderPercent },
            { title: '比例几乎一致', dataIndex: 'exactAspectRatioRate', width: 120, align: 'right', render: renderPercent },
            { title: '平均比例偏差', dataIndex: 'avgAspectRatioDeltaPercent', width: 120, align: 'right', render: renderPercent },
            { title: '平均最大边偏差', dataIndex: 'avgMaxSideDeltaPercent', width: 130, align: 'right', render: renderPercent },
            {
              title: '实际输出档位分布',
              key: 'actualTierBreakdown',
              width: 220,
              render: (_, row) => renderSimpleTierBreakdown(row),
            },
            {
              title: '降档分布',
              key: 'downgradeLevelBreakdown',
              width: 220,
              render: (_, row) => renderDowngradeBreakdown(row),
            },
            {
              title: '最近样本时间',
              dataIndex: 'latestSampleAt',
              width: 180,
              render: (value?: number) => <span className="mono">{formatDateTime(value)}</span>,
            },
          ]}
        />
      </Card>

      <Card title="同比例辅助视图">
        <Paragraph type="secondary" style={{ marginTop: 0 }}>
          当某个具体尺寸样本不足时，系统可退回参考同比例分组，保留「精确尺寸优先、同比例辅助」的层次感，
          又不会把所有请求混成一锅。
        </Paragraph>
        <Table
          rowKey="key"
          size="small"
          scroll={{ x: 1500 }}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          dataSource={report.aspectRows}
          columns={[
            { title: '上游', dataIndex: 'upstreamName', width: 220, fixed: 'left' },
            {
              title: '操作',
              dataIndex: 'operation',
              width: 90,
              render: (value: AspectResolutionAuditSummaryRow['operation']) => renderOperation(value),
            },
            { title: '请求比例', dataIndex: 'requestedAspectLabel', width: 100 },
            {
              title: '请求档位',
              dataIndex: 'requestedTier',
              width: 100,
              render: (value: AspectResolutionAuditSummaryRow['requestedTier']) => renderTierTag(value),
            },
            { title: '样本数', dataIndex: 'sampleCount', width: 90, align: 'right', render: renderPercentFree },
            { title: '测得尺寸', dataIndex: 'measuredCount', width: 100, align: 'right', render: renderPercentFree },
            { title: '平均比例准确率', dataIndex: 'avgAspectAccuracyPercent', width: 130, align: 'right', render: renderPercent },
            { title: '平均分辨率准确率', dataIndex: 'avgResolutionAccuracyPercent', width: 150, align: 'right', render: renderPercent },
            { title: '同档或更高', dataIndex: 'sameOrHigherTierRate', width: 120, align: 'right', render: renderPercent },
            { title: '降档率', dataIndex: 'downgradeRate', width: 100, align: 'right', render: renderPercent },
            { title: '平均降档级别', dataIndex: 'avgTierDowngradeLevels', width: 120, align: 'right', render: renderPercentFree },
            {
              title: '实际输出档位分布',
              key: 'actualTierBreakdown',
              width: 220,
              render: (_, row) => renderSimpleTierBreakdown(row),
            },
            {
              title: '最近样本时间',
              dataIndex: 'latestSampleAt',
              width: 180,
              render: (value?: number) => <span className="mono">{formatDateTime(value)}</span>,
            },
          ]}
        />
      </Card>
    </div>
  );
}

/** 裸数值右对齐（等宽） */
function renderPercentFree(value: number | string) {
  return <span className="tabular">{value}</span>;
}
