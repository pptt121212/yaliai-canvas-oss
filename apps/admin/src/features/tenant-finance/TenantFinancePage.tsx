import { Button, Card, Drawer, Empty, Form, Input, InputNumber, Select, Space, Statistic, Table, Typography } from 'antd';
import { useMemo, useState } from 'react';
import type { AdminConsoleCatalog, CanvasUserAdminReport, TenantFinanceLedgerReport } from '../../shared/types';
import { DrawerFooter, PageHeader, StatusDot, formatCredits, formatDateTime } from '../../shared/ui';

const { Paragraph, Text } = Typography;

type TenantFinancePageProps = {
  catalog: AdminConsoleCatalog | null;
  report: TenantFinanceLedgerReport | null;
  canvasUsersReport: CanvasUserAdminReport | null;
  saving: boolean;
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

export function TenantFinancePage({ catalog, report, canvasUsersReport, saving, onAdjust }: TenantFinancePageProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState('');
  const [searchKeyword, setSearchKeyword] = useState('');
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
    return (report?.balances || []).map((item) => ({
      ...item,
      account: accountByTenantId.get(item.tenantId) || {
        username: '未绑定账户',
        email: '—',
        searchText: '',
      },
    }));
  }, [accountByTenantId, report]);

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

  const selectedAccount = searchedTenantOptions.find((item) => item.value === selectedTenantId) || null;

  return (
    <div className="page-stack">
      <PageHeader
        title="充值管理"
        desc="按账户维度管理人民币余额。列表展示完整余额流水，包含手工充值/扣费和系统自动图像消费；新增按钮仅用于手工记账。"
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
        <Table
          rowKey="id"
          size="small"
          pagination={{ pageSize: 20, showSizeChanger: false }}
          dataSource={ledgerRows}
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
              width: 100,
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
