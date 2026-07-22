import { Alert, Button, Card, Descriptions, Popconfirm, Spin, Table, Typography } from 'antd';
import { useState } from 'react';
import { fetchRequestTraceDetail } from '../../shared/api';
import type { RequestTraceDetail, RequestTraceReport, RequestTraceRow } from '../../shared/types';
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
const rejectedFailureCategories = new Set([
  'terminal_invalid_request',
  'terminal_user_content',
  'terminal_safety',
  'terminal_billing',
]);

function renderJson(value: unknown) {
  if (value === null || value === undefined) {
    return <Text type="secondary">—</Text>;
  }
  return <CodeBlock value={value} />;
}

function renderFailureSummary(value: RequestTraceDetail) {
  const error = value.errorPayload as Record<string, unknown> | null | undefined;
  if (!error) {
    return <Text type="secondary">—</Text>;
  }
  const errorCode = String(error.error || error.code || '').trim();
  const statusCode = Number(error.status_code || value.statusCode || 0);
  const category = String(error.failure_category || value.failureCategory || '').trim();
  const upstream = error.upstream as Record<string, unknown> | undefined;
  const providerName = String(upstream?.providerName || upstream?.providerId || '').trim();
  const summary = [
    errorCode || 'error',
    statusCode ? `HTTP ${statusCode}` : '',
    category ? `分类 ${category}` : '',
    providerName ? `上游 ${providerName}` : '',
  ].filter(Boolean).join(' · ');
  return <Text>{summary || '—'}</Text>;
}

function sourceLabel(value: RequestTraceRow['source']) {
  if (value === 'onboarding_probe') return '接入向导探测';
  if (value === 'admin_upstream_test') return '上游调试测试';
  if (value === 'tenant_runtime_async_submit') return '租户异步提交';
  if (value === 'tenant_runtime_async_complete') return '租户异步完成';
  return '租户同步请求';
}

function statusTone(status: RequestTraceRow['status']): StatusTone {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'danger';
  return 'processing';
}

function statusLabel(status: RequestTraceRow['status']) {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  return '进行中';
}

type RequestTracesPageProps = {
  report: RequestTraceReport | null;
  saving?: boolean;
  onClear?: () => Promise<void>;
};

export function RequestTracesPage({ report, saving = false, onClear }: RequestTracesPageProps) {
  const [detailMap, setDetailMap] = useState<Record<string, RequestTraceDetail | undefined>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [errorMap, setErrorMap] = useState<Record<string, string>>({});

  if (!report) {
    return null;
  }

  const failedRows = report.rows.filter((row) => row.status === 'failed');
  const rejectedRows = failedRows.filter((row) => rejectedFailureCategories.has(String(row.failureCategory || '').trim()));
  const businessFailureRows = failedRows.filter((row) => !rejectedFailureCategories.has(String(row.failureCategory || '').trim()));
  const acceptedRows = report.rows.filter((row) => row.status === 'accepted');

  async function ensureDetail(traceId: string) {
    if (detailMap[traceId] || loadingMap[traceId]) {
      return;
    }
    setLoadingMap((current) => ({ ...current, [traceId]: true }));
    setErrorMap((current) => ({ ...current, [traceId]: '' }));
    try {
      const detail = await fetchRequestTraceDetail(traceId);
      setDetailMap((current) => ({ ...current, [traceId]: detail }));
    } catch (error) {
      setErrorMap((current) => ({
        ...current,
        [traceId]: error instanceof Error ? error.message : '详情加载失败',
      }));
    } finally {
      setLoadingMap((current) => ({ ...current, [traceId]: false }));
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="请求追踪"
        desc="这是请求级调试日志，默认展示最近 200 条。列表先显示轻量摘要，展开某行后才加载完整上下游输入输出；页面统计仅针对当前窗口，不直接等同于业务成功率统计。"
        actions={
          <Popconfirm
            title="清空请求追踪"
            description="会同时删除请求追踪日志以及对应生成图片，此操作不可恢复。"
            okText="确认清空"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => onClear?.()}
            disabled={!onClear}
          >
            <Button danger loading={saving} disabled={!report.rows.length || !onClear}>
              清空日志
            </Button>
          </Popconfirm>
        }
      />

      <Alert
        type="info"
        showIcon
        message="这里是调试日志口径，不是业务成功率报表。"
        description="本页的“失败”表示这条追踪最终记录为 failed。它既可能是会计入业务成功率的真实执行失败，也可能只是参数错误、内容拒绝、安全拦截或余额不足这类剔除类失败。业务成功率请以“总览”和“业务通道”页面为准。"
      />

      <StatStrip
        items={[
          { label: '当前窗口追踪', value: report.total },
          { label: '仅上游追踪', value: report.summary.upstreamOnlyCount },
          { label: '完整上下游', value: report.summary.fullChainCount },
          { label: '已受理 / 处理中', value: acceptedRows.length, muted: acceptedRows.length === 0 },
          {
            label: '剔除类失败',
            value: rejectedRows.length,
            muted: rejectedRows.length === 0,
          },
          {
            label: '真实执行失败',
            value: businessFailureRows.length,
            muted: businessFailureRows.length === 0,
          },
          {
            label: '失败追踪总数',
            value: report.summary.failedCount,
            muted: report.summary.failedCount === 0,
          },
        ]}
      />

      <Card className="diagnostic-card">
        <Table
          className="diagnostic-table"
          rowKey="traceId"
          size="small"
          tableLayout="fixed"
          scroll={{ x: 1760 }}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          dataSource={report.rows}
          expandable={{
            onExpand: (expanded, row) => {
              if (expanded) {
                void ensureDetail(row.traceId);
              }
            },
            expandedRowRender: (row) => {
              const detail = detailMap[row.traceId];
              const loading = Boolean(loadingMap[row.traceId]);
              const error = errorMap[row.traceId];
              if (loading && !detail) {
                return (
                  <div style={{ padding: '12px 0' }}>
                    <Spin size="small" /> <Text type="secondary">正在加载完整上下游详情…</Text>
                  </div>
                );
              }
              if (error && !detail) {
                return <Text type="danger">{error}</Text>;
              }
              const current = detail || row;
              return (
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label="追踪 ID"><CompactId value={current.traceId} /></Descriptions.Item>
                  <Descriptions.Item label="请求 ID"><CompactId value={current.requestId} /></Descriptions.Item>
                  <Descriptions.Item label="任务 ID"><CompactId value={current.taskId} /></Descriptions.Item>
                  <Descriptions.Item label="概要">{current.summary}</Descriptions.Item>
                  <Descriptions.Item label="下游请求">{renderJson(current.downstreamRequest)}</Descriptions.Item>
                  <Descriptions.Item label="下游响应">{renderJson(current.downstreamResponse)}</Descriptions.Item>
                  <Descriptions.Item label="上游请求">{renderJson(current.upstreamRequest)}</Descriptions.Item>
                  <Descriptions.Item label="上游响应">{renderJson(current.upstreamResponse)}</Descriptions.Item>
                  <Descriptions.Item label="错误摘要">{renderFailureSummary(current)}</Descriptions.Item>
                  <Descriptions.Item label="错误信息">{renderJson(current.errorPayload)}</Descriptions.Item>
                </Descriptions>
              );
            },
          }}
          columns={[
            {
              title: '时间',
              dataIndex: 'createdAt',
              width: 160,
              render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
            },
            {
              title: '来源',
              dataIndex: 'source',
              width: 140,
              render: (value: RequestTraceRow['source']) => sourceLabel(value),
            },
            {
              title: '范围',
              dataIndex: 'scope',
              width: 110,
              render: (value: RequestTraceRow['scope']) => (value === 'full_chain' ? '上下游' : '仅上游'),
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 96,
              render: (value: RequestTraceRow['status']) => (
                <StatusDot tone={statusTone(value)}>{statusLabel(value)}</StatusDot>
              ),
            },
            {
              title: '失败归类',
              dataIndex: 'failureCategory',
              width: 180,
              render: (_: string | undefined, row: RequestTraceRow) => {
                if (row.status !== 'failed') {
                  return <Text type="secondary">—</Text>;
                }
                const category = String(row.failureCategory || '').trim();
                if (rejectedFailureCategories.has(category)) {
                  return <StatusDot tone="warning">剔除类失败</StatusDot>;
                }
                return <StatusDot tone="danger">真实执行失败</StatusDot>;
              },
            },
            {
              title: '类型',
              dataIndex: 'operation',
              width: 110,
              render: (value?: string) => value || '—',
            },
            { title: '追踪 ID', dataIndex: 'traceId', width: 170, render: (value?: string) => <CompactId value={value} /> },
            { title: '请求 ID', dataIndex: 'requestId', width: 170, render: (value?: string) => <CompactId value={value} /> },
            { title: '任务 ID', dataIndex: 'taskId', width: 170, render: (value?: string) => <CompactId value={value} /> },
            { title: '租户', dataIndex: 'tenantName', width: 130, render: (value?: string) => <EllipsisText value={value} /> },
            { title: '上游', dataIndex: 'upstreamName', width: 150, render: (value?: string) => <EllipsisText value={value} /> },
            { title: '错误摘要', width: 280, render: (_: unknown, row: RequestTraceDetail) => renderFailureSummary(row) },
            { title: '基础地址', dataIndex: 'providerBaseUrl', width: 210, render: (value?: string) => <EllipsisText value={value} /> },
            { title: '摘要', dataIndex: 'summary', width: 260, render: (value?: string) => <EllipsisText value={value} /> },
          ]}
        />
      </Card>
    </div>
  );
}
