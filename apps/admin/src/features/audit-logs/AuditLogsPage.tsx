import { Alert, Card, Descriptions, Table, Typography } from 'antd';
import type { AuditLogReport, AuditLogRow } from '../../shared/types';
import {
  CodeBlock,
  CompactId,
  EllipsisText,
  PageHeader,
  StatStrip,
  StatusDot,
  formatDateTime,
} from '../../shared/ui';
import type { StatusTone } from '../../shared/ui';

const { Text } = Typography;

type AuditLogsPageProps = {
  report: AuditLogReport | null;
};

function statusTone(value: AuditLogRow['status']): StatusTone {
  if (value === 'success') return 'success';
  if (value === 'failed') return 'danger';
  return 'processing';
}

function statusLabel(value: AuditLogRow['status']) {
  if (value === 'success') return '成功';
  if (value === 'failed') return '失败';
  return '已受理';
}

function actorLabel(value: AuditLogRow['actorType']) {
  if (value === 'admin') return '管理员';
  if (value === 'tenant_key') return '租户 Key';
  return '系统';
}

function targetLabel(value: AuditLogRow['targetType']) {
  if (value === 'upstream') return '上游';
  if (value === 'channel') return '业务通道';
  if (value === 'tenant') return '租户';
  if (value === 'api_key') return 'API Key';
  if (value === 'image_request') return '图像请求';
  return '任务';
}

function renderJson(value: unknown) {
  if (value === null || value === undefined) {
    return <Text type="secondary">—</Text>;
  }
  return <CodeBlock value={value} />;
}

export function AuditLogsPage({ report }: AuditLogsPageProps) {
  if (!report) {
    return null;
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="审计日志"
        desc="这里记录后台关键配置变更和系统级动作，属于操作审计口径，不参与业务成功率、计费和路由健康统计。"
      />

      <Alert
        type="info"
        showIcon
        message="本页只看谁在什么时候做了什么。"
        description="它适合排查后台配置变更、充值记账、清理动作和系统侧关键生命周期事件。请求级上下游调试请看“请求追踪”，实际扣费请看“计费流水”。"
      />

      <StatStrip
        items={[
          { label: '日志总数', value: report.total },
          { label: '成功', value: report.summary.successCount, muted: report.summary.successCount === 0 },
          { label: '失败', value: report.summary.failedCount, muted: report.summary.failedCount === 0 },
          { label: '已受理', value: report.summary.acceptedCount, muted: report.summary.acceptedCount === 0 },
          { label: '管理员动作', value: report.summary.adminActorCount, muted: report.summary.adminActorCount === 0 },
          { label: '系统动作', value: report.summary.systemActorCount, muted: report.summary.systemActorCount === 0 },
        ]}
      />

      <Card className="diagnostic-card">
        <Table
          className="diagnostic-table"
          rowKey="id"
          size="small"
          tableLayout="fixed"
          scroll={{ x: 1520 }}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          dataSource={report.rows}
          expandable={{
            expandedRowRender: (row) => (
              <Descriptions bordered size="small" column={1}>
                <Descriptions.Item label="日志 ID"><CompactId value={row.id} /></Descriptions.Item>
                <Descriptions.Item label="动作">{row.action}</Descriptions.Item>
                <Descriptions.Item label="操作主体">{actorLabel(row.actorType)} / {row.actorId}</Descriptions.Item>
                <Descriptions.Item label="目标对象">{targetLabel(row.targetType)} / {row.targetName || row.targetId}</Descriptions.Item>
                <Descriptions.Item label="请求 ID"><CompactId value={row.requestId} /></Descriptions.Item>
                <Descriptions.Item label="消息">{row.message}</Descriptions.Item>
                <Descriptions.Item label="详细数据">{renderJson(row.detail)}</Descriptions.Item>
              </Descriptions>
            ),
          }}
          columns={[
            {
              title: '时间',
              dataIndex: 'createdAt',
              width: 160,
              render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 96,
              render: (value: AuditLogRow['status']) => <StatusDot tone={statusTone(value)}>{statusLabel(value)}</StatusDot>,
            },
            {
              title: '主体',
              width: 150,
              render: (_: unknown, row: AuditLogRow) => (
                <div>
                  <div>{actorLabel(row.actorType)}</div>
                  <Text type="secondary" className="mono">{row.actorId}</Text>
                </div>
              ),
            },
            {
              title: '动作',
              dataIndex: 'action',
              width: 220,
              render: (value?: string) => <EllipsisText value={value} />,
            },
            {
              title: '目标类型',
              dataIndex: 'targetType',
              width: 110,
              render: (value: AuditLogRow['targetType']) => targetLabel(value),
            },
            {
              title: '目标对象',
              width: 180,
              render: (_: unknown, row: AuditLogRow) => <EllipsisText value={row.targetName || row.targetId} />,
            },
            {
              title: '请求 ID',
              dataIndex: 'requestId',
              width: 170,
              render: (value?: string) => <CompactId value={value} />,
            },
            {
              title: '消息',
              dataIndex: 'message',
              width: 340,
              render: (value?: string) => <EllipsisText value={value} />,
            },
            {
              title: '日志 ID',
              dataIndex: 'id',
              width: 170,
              fixed: 'right',
              render: (value?: string) => <CompactId value={value} />,
            },
          ]}
        />
      </Card>
    </div>
  );
}
