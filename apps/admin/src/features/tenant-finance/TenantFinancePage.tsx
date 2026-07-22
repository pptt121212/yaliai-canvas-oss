import { Button, Card, Drawer, Empty, Form, Input, InputNumber, Select, Space, Statistic, Table, Tabs, Typography } from 'antd';
import { useMemo, useState } from 'react';
import type { AdminConsoleCatalog, CanvasUserAdminReport, TenantFinanceLedgerReport } from '../../shared/types';
import type { TenantFinanceLedgerQuery } from '../../shared/api';
import { DrawerFooter, PageHeader, StatusDot, formatCredits, formatDateTime } from '../../shared/ui';

const { Paragraph, Text } = Typography;

type TenantFinancePageProps = {
  catalog: AdminConsoleCatalog | null;
  report: TenantFinanceLedgerReport | null;
  canvasUsersReport: CanvasUserAdminReport | null;
  saving: boolean;
  loading: boolean;
  onQuery: (query: TenantFinanceLedgerQuery) => Promise<void>;
  onAdjust: (input: {
    tenantId: string;
    direction: 'credit' | 'debit';
    amountYuan: number;
    note: string;
  }) => Promise<void>;
};

type FinanceFormValues = {
  tenantId: string;
  direction: 'credit' | 'debit';
  amountYuan: number;
  note: string;
};

type AccountIdentity = {
  username: string;
  email: string;
  searchText: string;
};

type AccountOption = {
  value: string;
  label: string;
  searchText: string;
  username: string;
  email: string;
  tenantName: string;
  tenantCode: string;
};

function accountSearchScore(option: AccountOption, keyword: string) {
  const normalizedKeyword = String(keyword || '').trim().toLowerCase();
  const searchText = String(option.searchText || '');
  const username = String(option.username || '').toLowerCase();
  const email = String(option.email || '').toLowerCase();
  const tenantName = String(option.tenantName || '').toLowerCase();
  const tenantCode = String(option.tenantCode || '').toLowerCase();
  const tenantId = String(option.value || '').toLowerCase();
  if (!normalizedKeyword) {
    return 0;
  }
  if (username === normalizedKeyword || email === normalizedKeyword || tenantName === normalizedKeyword || tenantCode === normalizedKeyword || tenantId === normalizedKeyword) {
    return 4;
  }
  if (username.startsWith(normalizedKeyword) || email.startsWith(normalizedKeyword) || tenantName.startsWith(normalizedKeyword) || tenantCode.startsWith(normalizedKeyword) || tenantId.startsWith(normalizedKeyword)) {
    return 3;
  }
  if (searchText.includes(normalizedKeyword)) {
    return 2;
  }
  return 0;
}

function pickPrimaryAccount(users: CanvasUserAdminReport['rows'] = []): AccountIdentity {
  const primary = users.find((item) => item.status === 'active') || users[0];
  if (!primary) {
    return {
      username: '未绑定账户',
      email: '—',
      searchText: '',
    };
  }
  return {
    username: primary.username || '未命名用户',
    email: primary.email || '—',
    searchText: `${primary.username || ''} ${primary.email || ''}`.trim().toLowerCase(),
  };
}

export function TenantFinancePage({ catalog, report, canvasUsersReport, saving, loading, onQuery, onAdjust }: TenantFinancePageProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState('');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [ledgerAccountKeyword, setLedgerAccountKeyword] = useState('');
  const [ledgerScope, setLedgerScope] = useState<'account_adjustment' | 'tenant_request_charge'>('account_adjustment');
  const [ledgerTenantId, setLedgerTenantId] = useState<string | undefined>();
  const [ledgerDateFrom, setLedgerDateFrom] = useState('');
  const [ledgerDateTo, setLedgerDateTo] = useState('');
  const [activeLedgerQuery, setActiveLedgerQuery] = useState<TenantFinanceLedgerQuery>({
    limit: 200,
    entryType: 'account_adjustment',
  });
  const [pageCursors, setPageCursors] = useState<Array<{ createdAt: number; id: string } | undefined>>([undefined]);
  const [form] = Form.useForm<FinanceFormValues>();
  const selectedTenantId = Form.useWatch('tenantId', form);

  const accountByTenantId = useMemo(() => {
    const map = new Map<string, AccountIdentity>();
    const usersByTenantId = new Map<string, CanvasUserAdminReport['rows']>();
    (canvasUsersReport?.rows || []).forEach((user) => {
      const current = usersByTenantId.get(user.tenantId) || [];
      current.push(user);
      usersByTenantId.set(user.tenantId, current);
    });
    (catalog?.tenants || []).forEach((tenant) => {
      map.set(tenant.id, pickPrimaryAccount(usersByTenantId.get(tenant.id) || []));
    });
    return map;
  }, [canvasUsersReport, catalog]);

  const tenantOptions = useMemo<AccountOption[]>(() => {
    return (catalog?.tenants || []).map((tenant) => {
      const account = accountByTenantId.get(tenant.id) || {
        username: '未绑定账户',
        email: '—',
        searchText: '',
      };
      return {
        value: tenant.id,
        label: `${account.username} · ${tenant.name} · ${account.email}`,
        searchText: [
          account.searchText,
          tenant.name,
          tenant.code,
          tenant.id,
        ].filter(Boolean).join(' ').trim().toLowerCase(),
        username: account.username,
        email: account.email,
        tenantName: tenant.name || tenant.id,
        tenantCode: tenant.code || tenant.id,
      };
    });
  }, [accountByTenantId, catalog]);

  const balanceRows = useMemo(() => {
    return (report?.balances || [])
      .filter((item) => !ledgerTenantId || item.tenantId === ledgerTenantId)
      .map((item) => ({
      ...item,
      account: accountByTenantId.get(item.tenantId) || {
        username: '未绑定账户',
        email: '—',
        searchText: '',
      },
      }));
  }, [accountByTenantId, ledgerTenantId, report]);

  const ledgerRows = useMemo(() => {
    return (report?.rows || []).map((item) => ({
      ...item,
      account: accountByTenantId.get(item.tenantId) || {
        username: '未绑定账户',
        email: '—',
        searchText: '',
      },
    }));
  }, [accountByTenantId, report]);

  const visibleLedgerRows = useMemo(() => {
    const keyword = ledgerAccountKeyword.trim().toLowerCase();
    if (!keyword) return ledgerRows;
    return ledgerRows.filter((item) => [
      item.account.username,
      item.account.email,
      item.tenantName,
      item.tenantId,
      item.operatorLabel,
    ].filter(Boolean).join(' ').toLowerCase().includes(keyword));
  }, [ledgerAccountKeyword, ledgerRows]);
  const accountLedgerRows = useMemo(
    () => ledgerScope === 'account_adjustment' ? visibleLedgerRows : [],
    [ledgerScope, visibleLedgerRows],
  );
  const tenantRequestChargeRows = useMemo(
    () => ledgerScope === 'tenant_request_charge' ? visibleLedgerRows : [],
    [ledgerScope, visibleLedgerRows],
  );

  const searchedTenantOptions = useMemo(() => {
    const keyword = String(searchKeyword || '').trim().toLowerCase();
    if (!keyword) {
      return [];
    }
    return tenantOptions
      .map((item) => ({
        ...item,
        score: accountSearchScore(item, keyword),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.label.localeCompare(right.label, 'zh-CN');
      });
  }, [searchKeyword, tenantOptions]);

  async function handleSubmit() {
    const values = await form.validateFields();
    await onAdjust(values);
    setDrawerOpen(false);
    form.resetFields();
  }

  function closeDrawer() {
    setDrawerOpen(false);
    setSearchDraft('');
    setSearchKeyword('');
    form.resetFields();
  }

  function openCreate() {
    form.setFieldsValue({
      tenantId: '',
      direction: 'credit',
      amountYuan: 100,
      note: '',
    });
    setSearchDraft('');
    setSearchKeyword('');
    setDrawerOpen(true);
  }

  function handleAccountSearch(value?: string) {
    const keyword = String(value ?? searchDraft).trim();
    setSearchDraft(keyword);
    setSearchKeyword(keyword);
    form.setFieldValue('tenantId', undefined);
  }

  function handleSelectAccount(tenantId: string) {
    form.setFieldValue('tenantId', tenantId);
  }

  const buildLedgerQuery = (entryType = ledgerScope): TenantFinanceLedgerQuery => ({
    limit: 200,
    tenantId: ledgerTenantId,
    entryType,
    createdAfter: ledgerDateFrom ? new Date(`${ledgerDateFrom}T00:00:00`).getTime() : undefined,
    createdBefore: ledgerDateTo ? new Date(`${ledgerDateTo}T00:00:00`).getTime() + 24 * 60 * 60 * 1000 : undefined,
  });

  const queryLedger = async (entryType = ledgerScope) => {
    const nextQuery = buildLedgerQuery(entryType);
    setLedgerScope(entryType);
    setActiveLedgerQuery(nextQuery);
    setPageCursors([undefined]);
    await onQuery(nextQuery);
  };

  const loadLedgerPage = async (cursor: { createdAt: number; id: string } | undefined, cursors: Array<{ createdAt: number; id: string } | undefined>) => {
    setPageCursors(cursors);
    await onQuery({
      ...activeLedgerQuery,
      cursorCreatedAt: cursor?.createdAt,
      cursorId: cursor?.id,
    });
  };

  const resetLedgerQuery = async () => {
    setLedgerTenantId(undefined);
    setLedgerDateFrom('');
    setLedgerDateTo('');
    setLedgerAccountKeyword('');
    const nextQuery = { limit: 200, entryType: ledgerScope } satisfies TenantFinanceLedgerQuery;
    setActiveLedgerQuery(nextQuery);
    setPageCursors([undefined]);
    await onQuery(nextQuery);
  };

  const selectedAccount = searchedTenantOptions.find((item) => item.value === selectedTenantId) || null;

  function renderLedgerTable(rows: typeof ledgerRows) {
    return (
      <Table
        rowKey="id"
        size="small"
        pagination={{ pageSize: 20, showSizeChanger: false }}
        dataSource={rows}
        columns={[
          {
            title: '时间',
            dataIndex: 'createdAt',
            width: 180,
            render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
          },
          {
            title: '用户名',
            width: 180,
            render: (_, row) => row.account.username,
          },
          {
            title: '邮箱',
            width: 240,
            render: (_, row) => row.account.email,
          },
          {
            title: '业务类型',
            dataIndex: 'sourceLabel',
            width: 160,
            render: (value: string | undefined, row) => (
              <StatusDot tone={row.direction === 'credit' ? 'success' : 'warning'}>
                {value || (row.direction === 'credit' ? '充值' : '扣费')}
              </StatusDot>
            ),
          },
          {
            title: '金额',
            dataIndex: 'amountCents',
            width: 120,
            align: 'right',
            render: (value: number) => <span className="tabular">{formatCredits(value)}</span>,
          },
          {
            title: '变动后余额',
            dataIndex: 'balanceAfterCents',
            width: 140,
            align: 'right',
            render: (value: number) => <span className="tabular">{formatCredits(value)}</span>,
          },
          {
            title: '操作来源',
            dataIndex: 'operatorLabel',
            width: 220,
            render: (value: string | undefined, row) => value || row.operatorId,
          },
          { title: '备注', dataIndex: 'note' },
        ]}
      />
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="充值管理"
        desc="按账户维度管理人民币余额。余额卡与当前账户筛选对齐；下方账本按类别、账户和日期独立分页查询，新增按钮仅用于手工记账。"
        actions={<Button type="primary" onClick={openCreate}>新增充值 / 扣费</Button>}
      />

      <div className="finance-balance-grid">
        {balanceRows.map((item) => (
          <Card key={item.tenantId} size="small" className="finance-balance-card">
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Space direction="vertical" size={2}>
                <Text strong>{item.account.username}</Text>
                <Text type="secondary">{item.account.email}</Text>
              </Space>
              <Statistic title="当前余额" value={Number(item.balanceCents || 0) / 100_000} precision={5} prefix="￥" />
              <Space wrap size={12}>
                <Text type="secondary">累计充值 <span className="tabular">{formatCredits(item.totalCreditedCents)}</span></Text>
                <Text type="secondary">累计扣费 <span className="tabular">{formatCredits(item.totalDebitedCents)}</span></Text>
              </Space>
            </Space>
          </Card>
        ))}
      </div>

      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Select
            allowClear
            showSearch
            value={ledgerTenantId}
            style={{ width: 320 }}
            placeholder="按账户筛选"
            options={tenantOptions}
            optionFilterProp="searchText"
            onChange={setLedgerTenantId}
          />
          <Input type="date" value={ledgerDateFrom} onChange={(event) => setLedgerDateFrom(event.target.value)} />
          <Input type="date" value={ledgerDateTo} onChange={(event) => setLedgerDateTo(event.target.value)} />
          <Button type="primary" loading={loading} onClick={() => void queryLedger()}>查询</Button>
          <Button disabled={loading} onClick={() => void resetLedgerQuery()}>重置</Button>
        </Space>
        <Input.Search
          allowClear
          value={ledgerAccountKeyword}
          placeholder="在当前页搜索账户 / 邮箱 / 租户 / API Key"
          style={{ maxWidth: 420, marginBottom: 16 }}
          onChange={(event) => setLedgerAccountKeyword(event.target.value)}
        />
        {report ? (
          <Space wrap style={{ marginBottom: 16 }}>
            <Text type="secondary">当前第 {pageCursors.length} 页，每页 {report.page.limit} 条。</Text>
            <Button
              disabled={loading || pageCursors.length <= 1}
              onClick={() => void loadLedgerPage(pageCursors[pageCursors.length - 2], pageCursors.slice(0, -1))}
            >
              上一页
            </Button>
            <Button
              disabled={loading || !report.page.hasMore || !report.page.nextCursor}
              onClick={() => {
                const nextCursor = report.page.nextCursor;
                if (!nextCursor) return;
                void loadLedgerPage(nextCursor, [...pageCursors, nextCursor]);
              }}
            >
              下一页
            </Button>
            {report.page.hasMore ? <Text type="secondary">仍有更早的匹配账本。</Text> : <Text type="secondary">已到达该条件下的最早账本。</Text>}
          </Space>
        ) : null}
        <Tabs
          activeKey={ledgerScope}
          onChange={(key) => void queryLedger(key as 'account_adjustment' | 'tenant_request_charge')}
          items={[
            {
              key: 'account_adjustment',
              label: `账户充值 / 人工扣费 (${accountLedgerRows.length})`,
              children: renderLedgerTable(accountLedgerRows),
            },
            {
              key: 'tenant_request_charge',
              label: `租户 API 请求扣费 (${tenantRequestChargeRows.length})`,
              children: renderLedgerTable(tenantRequestChargeRows),
            },
          ]}
        />
      </Card>

      <Drawer
        title="新增充值 / 扣费"
        open={drawerOpen}
        width={520}
        onClose={() => setDrawerOpen(false)}
        footer={(
          <DrawerFooter>
            <Button onClick={closeDrawer}>取消</Button>
            <Button type="primary" loading={saving} onClick={handleSubmit}>保存</Button>
          </DrawerFooter>
        )}
      >
        <Paragraph type="secondary" style={{ marginTop: 0 }}>
          计费单位统一为人民币。这里新增的是手工充值或人工扣费；系统自动图像消费会在请求成功后自动入账。
        </Paragraph>
        <Form form={form} layout="vertical">
          <Form.Item
            label="账户搜索"
            extra="可输入用户名、邮箱、租户名称、租户标识或 tenantId，点击搜索或按回车后选择租户。"
          >
            <Input.Search
              value={searchDraft}
              enterButton="搜索"
              allowClear
              placeholder="输入用户名 / 邮箱 / 租户名称 / 租户标识"
              onChange={(event) => setSearchDraft(event.target.value)}
              onSearch={handleAccountSearch}
            />
          </Form.Item>
          <Form.Item
            label="搜索结果"
            extra={searchKeyword ? `共找到 ${searchedTenantOptions.length} 个匹配账户` : '请先执行搜索'}
            rules={[{ required: true, message: '请选择账户' }]}
          >
            <div>
              <Form.Item name="tenantId" hidden rules={[{ required: true, message: '请选择账户' }]}>
                <Input />
              </Form.Item>
              {!searchKeyword ? (
                <div style={{ border: '1px dashed #d9d9d9', borderRadius: 10, padding: 20, background: '#fafafa' }}>
                  <Text type="secondary">请输入用户名、邮箱、租户名称、租户标识或 tenantId 后搜索。</Text>
                </div>
              ) : searchedTenantOptions.length === 0 ? (
                <div style={{ border: '1px dashed #d9d9d9', borderRadius: 10, padding: 12, background: '#fafafa' }}>
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的账户或租户" />
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 10, maxHeight: 320, overflowY: 'auto', paddingRight: 2 }}>
                  {searchedTenantOptions.map((item) => {
                    const isSelected = item.value === selectedTenantId;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => handleSelectAccount(item.value)}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          border: isSelected ? '1px solid #1677ff' : '1px solid #d9d9d9',
                          borderRadius: 10,
                          background: isSelected ? '#e6f4ff' : '#fff',
                          padding: '12px 14px',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ fontSize: 15, fontWeight: 600, color: '#1f1f1f' }}>{item.username}</div>
                        <div style={{ marginTop: 4, fontSize: 13, color: '#8c8c8c' }}>{item.email}</div>
                        <div style={{ marginTop: 4, fontSize: 12, color: '#8c8c8c' }}>
                          租户：{item.tenantName} · 标识：{item.tenantCode}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              {selectedAccount ? (
                <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: '#f6ffed', border: '1px solid #b7eb8f' }}>
                  <Text style={{ color: '#389e0d' }}>
                    已选中：{selectedAccount.tenantName} · {selectedAccount.username} · {selectedAccount.email}
                  </Text>
                </div>
              ) : null}
            </div>
          </Form.Item>
          <Form.Item name="direction" label="变动方向" rules={[{ required: true, message: '请选择变动方向' }]}>
            <Select
              options={[
                { value: 'credit', label: '充值' },
                { value: 'debit', label: '扣费' },
              ]}
            />
          </Form.Item>
          <Form.Item name="amountYuan" label="金额（元）" rules={[{ required: true, message: '请输入金额' }]}>
            <InputNumber min={0.00001} precision={5} step={0.00001} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label="备注" rules={[{ required: true, message: '请输入备注' }]}>
            <Input.TextArea rows={4} placeholder="例如：线下充值、补差价、人工扣费" />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
