import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import type {
  AdminConsoleCatalog,
  CanvasUserAdminReport,
  CanvasUserAdminRow,
  ConsoleApiKey,
  ConsoleTenant,
} from '../../shared/types';
import { DrawerFooter, PageHeader, StatStrip, StatusDot } from '../../shared/ui';

const { Text } = Typography;

type TenantsPageProps = {
  catalog: AdminConsoleCatalog | null;
  canvasUsersReport: CanvasUserAdminReport | null;
  saving: boolean;
  onSaveTenant: (tenant: ConsoleTenant) => Promise<void>;
  onDeleteTenant: (id: string) => Promise<void>;
  onSaveApiKey: (apiKey: ConsoleApiKey) => Promise<void>;
  onDeleteApiKey: (id: string) => Promise<void>;
  onCreateKeySecret: () => Promise<{ raw: string; masked: string; hash: string }>;
};

type TenantFormValues = {
  id: string;
  name: string;
  code: string;
  status: 'active' | 'disabled';
  allowedChannelIds: string[];
  requestLimitPerMinute: number;
  notes: string;
};

type ApiKeyFormValues = {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  allowedChannelIds: string[];
  requestLimitPerMinute: number;
  maxConcurrency: number;
  imageRoutingMode: 'smart_priority' | 'smart_failover' | 'fixed_provider';
  fixedImageProviderId: string;
  fixedImageProviderIds: string[];
  fixedImageFlatPrice: number;
  maxImageQuality: 'auto' | 'low' | 'medium' | 'high';
  maskedKey: string;
  rawKey: string;
  keyHash: string;
  notes: string;
};

type TenantDetailRow = {
  tenant: ConsoleTenant;
  apiKeys: ConsoleApiKey[];
  canvasUsers: CanvasUserAdminRow[];
};

type AccountSummary = {
  username: string;
  email: string;
};

const defaultAllowedChannelIds = ['channel_image_generation', 'channel_text_processing'];

function createTenantDefaults(): TenantFormValues {
  return {
    id: '',
    name: '',
    code: '',
    status: 'active',
    allowedChannelIds: defaultAllowedChannelIds,
    requestLimitPerMinute: 120,
    notes: '',
  };
}

function createApiKeyDefaults(secret?: { raw: string; masked: string; hash: string }): ApiKeyFormValues {
  return {
    id: '',
    name: '',
    status: 'active',
    allowedChannelIds: defaultAllowedChannelIds,
    requestLimitPerMinute: 120,
    maxConcurrency: 10,
    imageRoutingMode: 'smart_failover',
    fixedImageProviderId: '',
    fixedImageProviderIds: [],
    fixedImageFlatPrice: 0,
    maxImageQuality: 'high',
    maskedKey: secret?.masked || '',
    rawKey: secret?.raw || '',
    keyHash: secret?.hash || '',
    notes: '',
  };
}

function tenantToForm(tenant: ConsoleTenant): TenantFormValues {
  return {
    id: tenant.id,
    name: tenant.name,
    code: tenant.code,
    status: tenant.status,
    allowedChannelIds: tenant.allowedChannelIds,
    requestLimitPerMinute: tenant.requestLimitPerMinute,
    notes: tenant.notes,
  };
}

function apiKeyToForm(apiKey: ConsoleApiKey): ApiKeyFormValues {
  return {
    id: apiKey.id,
    name: apiKey.name,
    status: apiKey.status,
    allowedChannelIds: apiKey.allowedChannelIds,
    requestLimitPerMinute: apiKey.requestLimitPerMinute,
    maxConcurrency: apiKey.maxConcurrency,
    imageRoutingMode: apiKey.imageRoutingMode || 'smart_failover',
    fixedImageProviderId: apiKey.fixedImageProviderId || '',
    fixedImageProviderIds: Array.from(new Set([
      ...(Array.isArray(apiKey.fixedImageProviderIds) ? apiKey.fixedImageProviderIds : []),
      apiKey.fixedImageProviderId || '',
    ].map((item) => String(item || '').trim()).filter(Boolean))),
    fixedImageFlatPrice: Math.max(0, Number(apiKey.fixedImageFlatPrice || 0)),
    maxImageQuality: apiKey.maxImageQuality || 'high',
    maskedKey: apiKey.maskedKey,
    rawKey: apiKey.rawKey || '',
    keyHash: apiKey.keyHash || '',
    notes: apiKey.notes,
  };
}

function buildTenantRows(
  catalog: AdminConsoleCatalog | null,
  canvasUsersReport: CanvasUserAdminReport | null,
): TenantDetailRow[] {
  const tenants = catalog?.tenants || [];
  const apiKeys = catalog?.apiKeys || [];
  const canvasUsers = canvasUsersReport?.rows || [];

  return tenants.map((tenant) => ({
    tenant,
    apiKeys: apiKeys.filter((item) => item.tenantId === tenant.id),
    canvasUsers: canvasUsers.filter((item) => item.tenantId === tenant.id),
  }));
}

function pickPrimaryAccount(users: CanvasUserAdminRow[]): AccountSummary {
  const primary = users.find((item) => item.status === 'active') || users[0];
  if (!primary) {
    return {
      username: '未绑定账户',
      email: '—',
    };
  }
  return {
    username: primary.username || '未命名用户',
    email: primary.email || '—',
  };
}

function publicBaseUrl() {
  if (typeof window === 'undefined') {
    return 'http://localhost:4010';
  }
  return window.location.origin;
}

function apiEndpoints() {
  const baseUrl = publicBaseUrl();
  return {
    generations: `${baseUrl}/v1/images/generations`,
    edits: `${baseUrl}/v1/images/edits`,
    generationsTask: `${baseUrl}/v1/images/generations/{task_id}`,
    editsTask: `${baseUrl}/v1/images/edits/{task_id}`,
  };
}

function imageRoutingModeLabel(mode?: 'smart_priority' | 'smart_failover' | 'fixed_provider') {
  if (mode === 'fixed_provider') {
    return '固定';
  }
  return mode === 'smart_priority' ? '优选' : '智能';
}

function imageRoutingModeHint(mode?: 'smart_priority' | 'smart_failover' | 'fixed_provider') {
  if (mode === 'fixed_provider') {
    return '只使用绑定的固定线路';
  }
  return mode === 'smart_priority'
    ? '智能优选单条线路，不做后续回退'
    : '智能优选多条线路，首条失败后继续切换';
}

function imageQualityCapLabel(value?: ConsoleApiKey['maxImageQuality']) {
  if (value === 'auto') {
    return '自动';
  }
  if (value === 'low') {
    return '低画质';
  }
  if (value === 'medium') {
    return '中画质';
  }
  return '高画质';
}

const imageQualityCapOptions = [
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低画质' },
  { value: 'medium', label: '中画质' },
  { value: 'high', label: '高画质' },
];

function renderUserModeTag(mode: CanvasUserAdminRow['upstreamPreference']['mode']) {
  return mode === 'user_supplied'
    ? <StatusDot tone="processing">用户自带上游</StatusDot>
    : <StatusDot tone="success">平台统一路由</StatusDot>;
}

export function TenantsPage({
  catalog,
  canvasUsersReport,
  saving,
  onSaveTenant,
  onDeleteTenant,
  onSaveApiKey,
  onDeleteApiKey,
  onCreateKeySecret,
}: TenantsPageProps) {
  const { message } = App.useApp();
  const [tenantDrawerOpen, setTenantDrawerOpen] = useState(false);
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [isCreatingTenant, setIsCreatingTenant] = useState(false);
  const [editingApiKeyId, setEditingApiKeyId] = useState<string | null>(null);
  const [creatingSecret, setCreatingSecret] = useState(false);
  const [currentRawKey, setCurrentRawKey] = useState('');
  const [tenantForm] = Form.useForm<TenantFormValues>();
  const [apiKeyForm] = Form.useForm<ApiKeyFormValues>();

  const rows = useMemo(() => buildTenantRows(catalog, canvasUsersReport), [catalog, canvasUsersReport]);
  const selectedTenantRow = rows.find((item) => item.tenant.id === selectedTenantId) || null;
  const editingApiKey = selectedTenantRow?.apiKeys.find((item) => item.id === editingApiKeyId) || null;
  const channelOptions = (catalog?.channels || []).map((item) => ({ value: item.id, label: item.name }));
  const imageChannel = (catalog?.channels || []).find((item) => item.id === 'channel_image_generation');
  const imageChannelUpstreamIds = new Set(imageChannel?.upstreamIds || []);
  const fixedImageProviderOptions = (catalog?.upstreams || [])
    .filter((item) => imageChannelUpstreamIds.has(item.id))
    .filter((item) => item.kind === 'images_endpoint' || item.kind === 'responses_endpoint')
    .map((item) => ({ value: item.id, label: `${item.name}（${item.id}）` }));
  const endpoints = apiEndpoints();
  const watchedImageRoutingMode = Form.useWatch('imageRoutingMode', apiKeyForm);
  const watchedFixedImageProviderIds = Form.useWatch('fixedImageProviderIds', apiKeyForm);

  useEffect(() => {
    if (!tenantDrawerOpen) {
      return;
    }
    if (selectedTenantRow) {
      tenantForm.setFieldsValue(tenantToForm(selectedTenantRow.tenant));
      return;
    }
    if (isCreatingTenant) {
      tenantForm.setFieldsValue(createTenantDefaults());
    }
  }, [isCreatingTenant, selectedTenantRow, tenantDrawerOpen, tenantForm]);

  async function copyText(text: string, successText: string) {
    await navigator.clipboard.writeText(text);
    message.success(successText);
  }

  function openCreateTenant() {
    setIsCreatingTenant(true);
    setSelectedTenantId(null);
    tenantForm.setFieldsValue(createTenantDefaults());
    setTenantDrawerOpen(true);
  }

  function openTenantDetail(row: TenantDetailRow) {
    setIsCreatingTenant(false);
    setSelectedTenantId(row.tenant.id);
    setTenantDrawerOpen(true);
  }

  async function saveTenantForm() {
    const values = await tenantForm.validateFields();
    const tenantId = values.id || selectedTenantId || `tenant_${Date.now()}`;
    const tenant: ConsoleTenant = {
      id: tenantId,
      name: values.name,
      code: values.code,
      status: values.status,
      allowedChannelIds: values.allowedChannelIds || [],
      requestLimitPerMinute: Number(values.requestLimitPerMinute || 0),
      notes: values.notes || '',
    };
    setSelectedTenantId(tenantId);
    setIsCreatingTenant(false);
    await onSaveTenant(tenant);
  }

  async function deleteTenantRow(row: TenantDetailRow) {
    for (const apiKey of row.apiKeys) {
      await onDeleteApiKey(apiKey.id);
    }
    await onDeleteTenant(row.tenant.id);
    if (selectedTenantId === row.tenant.id) {
      setTenantDrawerOpen(false);
      setSelectedTenantId(null);
      setIsCreatingTenant(false);
    }
  }

  async function openCreateApiKey() {
    if (!selectedTenantRow) {
      message.warning('请先保存租户，再为这个租户新增下游 API Key。');
      return;
    }
    setCreatingSecret(true);
    try {
      const secret = await onCreateKeySecret();
      setEditingApiKeyId(null);
      setCurrentRawKey(secret.raw);
      apiKeyForm.setFieldsValue({
        ...createApiKeyDefaults(secret),
        name: `${selectedTenantRow.tenant.name} 默认密钥`,
        requestLimitPerMinute: selectedTenantRow.tenant.requestLimitPerMinute || 120,
      });
      setApiKeyModalOpen(true);
    } finally {
      setCreatingSecret(false);
    }
  }

  function openEditApiKey(apiKey: ConsoleApiKey) {
    setEditingApiKeyId(apiKey.id);
    setCurrentRawKey(apiKey.rawKey || '');
    apiKeyForm.setFieldsValue(apiKeyToForm(apiKey));
    setApiKeyModalOpen(true);
  }

  async function saveApiKeyForm() {
    if (!selectedTenantRow) {
      message.warning('当前租户不存在，无法保存密钥。');
      return;
    }
    const values = await apiKeyForm.validateFields();
    const fixedImageProviderIds = values.imageRoutingMode === 'fixed_provider'
      ? Array.from(new Set((values.fixedImageProviderIds || []).map((item) => String(item || '').trim()).filter(Boolean)))
      : [];
    const apiKey: ConsoleApiKey = {
      id: values.id || editingApiKey?.id || `key_${Date.now()}`,
      name: values.name,
      tenantId: selectedTenantRow.tenant.id,
      status: values.status,
      allowedChannelIds: values.allowedChannelIds || [],
      requestLimitPerMinute: Number(values.requestLimitPerMinute || 0),
      maxConcurrency: Math.max(1, Number(values.maxConcurrency || 1)),
      imageRoutingMode: values.imageRoutingMode || 'smart_failover',
      fixedImageProviderId: values.imageRoutingMode === 'fixed_provider'
        ? fixedImageProviderIds[0] || ''
        : '',
      fixedImageProviderIds,
      fixedImageFlatPrice: values.imageRoutingMode === 'fixed_provider'
        ? Math.max(0, Number(values.fixedImageFlatPrice || 0))
        : 0,
      maxImageQuality: values.maxImageQuality || 'high',
      maskedKey: values.maskedKey,
      rawKey: values.rawKey || currentRawKey || '',
      keyHash: values.keyHash,
      notes: values.notes || '',
    };
    await onSaveApiKey(apiKey);
    setApiKeyModalOpen(false);
    setEditingApiKeyId(null);
    setCurrentRawKey('');
  }

  const totalApiKeys = rows.reduce((sum, row) => sum + row.apiKeys.length, 0);
  const totalUsers = rows.reduce((sum, row) => sum + row.canvasUsers.length, 0);
  const rowAccounts = useMemo(() => {
    return new Map(rows.map((row) => [row.tenant.id, pickPrimaryAccount(row.canvasUsers)]));
  }, [rows]);

  return (
    <div className="page-stack">
      <PageHeader
        title="账户与密钥"
        desc="按账户维度统一管理 API 密钥、注册信息、调用地址与权限范围。底层仍使用 tenantId 承载计费与鉴权。"
        actions={<Button type="primary" onClick={openCreateTenant}>新增账户</Button>}
      />

      <StatStrip
        items={[
          { label: '账户数量', value: rows.length },
          { label: '下游 Key 数量', value: totalApiKeys },
          { label: '注册用户数量', value: totalUsers },
        ]}
      />

      <Card>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="统一对外接口地址"
            description={(
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Space wrap>
                  <Text>文生图：</Text>
                  <Text code className="mono">{endpoints.generations}</Text>
                  <Button size="small" onClick={() => copyText(endpoints.generations, '已复制文生图接口地址')}>复制</Button>
                </Space>
                <Space wrap>
                  <Text>图生图：</Text>
                  <Text code className="mono">{endpoints.edits}</Text>
                  <Button size="small" onClick={() => copyText(endpoints.edits, '已复制图生图接口地址')}>复制</Button>
                </Space>
                <Text type="secondary">调用方式：`Authorization: Bearer 你的下游 API Key`</Text>
              </Space>
            )}
          />

          <Table
            rowKey={(record) => record.tenant.id}
            size="small"
            dataSource={rows}
            pagination={false}
            scroll={{ x: 1200 }}
            columns={[
              {
                title: '用户名',
                width: 180,
                render: (_, record) => rowAccounts.get(record.tenant.id)?.username || '未绑定账户',
              },
              {
                title: '邮箱',
                width: 240,
                render: (_, record) => rowAccounts.get(record.tenant.id)?.email || '—',
              },
              { title: '已加入通道', width: 110, align: 'right', render: (_, record) => <span className="tabular">{record.tenant.allowedChannelIds.length}</span> },
              { title: '下游 Key 数量', width: 110, align: 'right', render: (_, record) => <span className="tabular">{record.apiKeys.length}</span> },
              { title: '注册用户数量', width: 110, align: 'right', render: (_, record) => <span className="tabular">{record.canvasUsers.length}</span> },
              { title: '账户限流', width: 120, align: 'right', render: (_, record) => <span className="tabular">{record.tenant.requestLimitPerMinute}/分钟</span> },
              {
                title: '状态',
                width: 90,
                render: (_, record) => (
                  record.tenant.status === 'active'
                    ? <StatusDot tone="success">启用</StatusDot>
                    : <StatusDot tone="neutral">停用</StatusDot>
                ),
              },
              {
                title: '操作',
                width: 170,
                fixed: 'right',
                render: (_, record) => (
                  <Space>
                    <Button size="small" type="link" onClick={() => openTenantDetail(record)}>
                      进入管理
                    </Button>
                    <Popconfirm
                      title="确认删除这个租户？"
                      description="会一并删除这个租户名下的所有下游 API Key。"
                      okText="确认删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => deleteTenantRow(record)}
                    >
                      <Button size="small" type="link" danger>删除</Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </Space>
      </Card>

      <Drawer
        title={isCreatingTenant ? '新增租户' : `租户详情${selectedTenantRow ? ` · ${selectedTenantRow.tenant.name}` : ''}`}
        open={tenantDrawerOpen}
        width={920}
        onClose={() => {
          setTenantDrawerOpen(false);
          setIsCreatingTenant(false);
          setSelectedTenantId(null);
        }}
        footer={
          <DrawerFooter>
            <Button onClick={() => {
              setTenantDrawerOpen(false);
              setIsCreatingTenant(false);
              setSelectedTenantId(null);
            }}>关闭</Button>
            <Button type="primary" loading={saving} onClick={saveTenantForm}>保存租户</Button>
          </DrawerFooter>
        }
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Alert
            type="success"
            showIcon
            message="这个页面只管理当前租户"
            description="先保存租户基础信息，再在下方为这个租户新增或维护下游 API Key。注册用户列表也会在这里集中展示。"
          />

          <Card title="租户基础信息" size="small">
            <Form form={tenantForm} layout="vertical">
              <Form.Item name="id" hidden>
                <Input />
              </Form.Item>

              <div className="tenant-detail-grid">
                <Form.Item
                  name="name"
                  label="租户名称"
                  rules={[{ required: true, message: '请输入租户名称' }]}
                >
                  <Input placeholder="例如：默认客户" />
                </Form.Item>

                <Form.Item
                  name="code"
                  label="租户标识"
                  rules={[{ required: true, message: '请输入租户标识' }]}
                >
                  <Input placeholder="例如：default_customer" />
                </Form.Item>

                <Form.Item name="status" label="租户状态">
                  <Select options={[{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用' }]} />
                </Form.Item>

                <Form.Item name="requestLimitPerMinute" label="租户每分钟限流">
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>

                <Form.Item name="allowedChannelIds" label="允许访问的业务通道">
                  <Select mode="multiple" options={channelOptions} />
                </Form.Item>
              </div>

              <Form.Item name="notes" label="租户备注" style={{ marginBottom: 0 }}>
                <Input.TextArea rows={3} />
              </Form.Item>
            </Form>
          </Card>

          {!selectedTenantRow ? (
            <Alert
              type="warning"
              showIcon
              message="请先保存租户"
              description="保存当前租户后，下面才会出现这个租户的下游 API Key 管理和注册用户列表。"
            />
          ) : (
            <>
              <Card
                size="small"
                title="下游 API Key"
                extra={<Button type="primary" loading={creatingSecret} onClick={openCreateApiKey}>新增下游 Key</Button>}
              >
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
                    <Descriptions.Item label="文生图地址">{endpoints.generations}</Descriptions.Item>
                    <Descriptions.Item label="图生图地址">{endpoints.edits}</Descriptions.Item>
                    <Descriptions.Item label="文生图任务查询">{endpoints.generationsTask}</Descriptions.Item>
                    <Descriptions.Item label="图生图任务查询">{endpoints.editsTask}</Descriptions.Item>
                  </Descriptions>

                  <Table
                    rowKey="id"
                    size="small"
                    dataSource={selectedTenantRow.apiKeys}
                    pagination={false}
                    locale={{ emptyText: <Empty description="这个租户还没有下游 API Key" /> }}
                    scroll={{ x: 960 }}
                    columns={[
                      {
                        title: '密钥名称',
                        width: 170,
                        render: (_, record) => (
                          <Space direction="vertical" size={2}>
                            <Text strong>{record.name}</Text>
                            <Text type="secondary" className="mono" style={{ fontSize: 12 }}>{record.id}</Text>
                          </Space>
                        ),
                      },
                      {
                        title: '完整密钥',
                        width: 230,
                        render: (_, record) => (
                          <Space direction="vertical" size={4}>
                            <Text code className="mono">{record.maskedKey}</Text>
                            {record.rawKey ? (
                              <Button size="small" type="link" style={{ padding: 0, height: 'auto' }} onClick={() => copyText(record.rawKey!, '已复制完整 API Key')}>
                                复制完整 Key
                              </Button>
                            ) : (
                              <Text type="secondary">当前未保存完整 Key</Text>
                            )}
                          </Space>
                        ),
                      },
                      { title: '每分钟限流', width: 105, align: 'right', render: (_, record) => <span className="tabular">{record.requestLimitPerMinute}</span> },
                      { title: '最大并发', width: 90, align: 'right', render: (_, record) => <span className="tabular">{record.maxConcurrency}</span> },
                      { title: '画质上限', width: 100, render: (_, record) => <Text>{imageQualityCapLabel(record.maxImageQuality)}</Text> },
                      {
                        title: '路由模式',
                        width: 170,
                        render: (_, record) => (
                          <Space direction="vertical" size={2}>
                            <StatusDot tone={record.imageRoutingMode === 'fixed_provider' ? 'warning' : (record.imageRoutingMode === 'smart_priority' ? 'processing' : 'neutral')}>
                              {imageRoutingModeLabel(record.imageRoutingMode)}
                            </StatusDot>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {imageRoutingModeHint(record.imageRoutingMode)}
                            </Text>
                            {record.imageRoutingMode === 'fixed_provider' ? (
                              <>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {(record.fixedImageProviderIds?.length
                                    ? record.fixedImageProviderIds
                                    : [record.fixedImageProviderId || '']
                                  ).filter(Boolean).map((providerId) => (
                                    fixedImageProviderOptions.find((item) => item.value === providerId)?.label || providerId
                                  )).join('、') || '未配置固定线路'}
                                </Text>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {Number(record.fixedImageFlatPrice || 0) > 0
                                    ? `一口价 ¥${Number(record.fixedImageFlatPrice || 0).toFixed(4)} / 张`
                                    : '未设置一口价，按共享线路价格表计费'}
                                </Text>
                              </>
                            ) : null}
                          </Space>
                        ),
                      },
                      {
                        title: '状态',
                        width: 90,
                        render: (_, record) => (
                          record.status === 'active'
                            ? <StatusDot tone="success">启用</StatusDot>
                            : <StatusDot tone="neutral">停用</StatusDot>
                        ),
                      },
                      {
                        title: '操作',
                        width: 140,
                        fixed: 'right',
                        render: (_, record) => (
                          <Space>
                            <Button size="small" type="link" onClick={() => openEditApiKey(record)}>编辑</Button>
                            <Popconfirm
                              title="确认删除这个下游 Key？"
                              okText="确认删除"
                              cancelText="取消"
                              okButtonProps={{ danger: true }}
                              onConfirm={() => onDeleteApiKey(record.id)}
                            >
                              <Button size="small" type="link" danger>删除</Button>
                            </Popconfirm>
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Space>
              </Card>

              <Card size="small" title="注册用户">
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={selectedTenantRow.canvasUsers}
                  pagination={false}
                  locale={{ emptyText: <Empty description="这个租户下还没有注册用户" /> }}
                  scroll={{ x: 1200 }}
                  columns={[
                    { title: '用户名', dataIndex: 'username', width: 140 },
                    { title: '邮箱', dataIndex: 'email', width: 220 },
                    {
                      title: '绑定下游 Key',
                      width: 220,
                      render: (_, record) => {
                        const apiKey = selectedTenantRow.apiKeys.find((item) => item.id === record.apiKeyId);
                        return (
                          <Space direction="vertical" size={2}>
                            <Text>{apiKey?.maskedKey || '未绑定'}</Text>
                            <Text type="secondary" className="mono" style={{ fontSize: 12 }}>{record.apiKeyId || '暂无'}</Text>
                          </Space>
                        );
                      },
                    },
                    {
                      title: '上游使用方式',
                      width: 140,
                      render: (_, record) => renderUserModeTag(record.upstreamPreference.mode),
                    },
                    {
                      title: 'Images 上游',
                      width: 260,
                      render: (_, record) => (
                        <Space direction="vertical" size={2}>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {record.upstreamPreference.imageApiKind === 'responses_endpoint' ? 'Responses Endpoint' : 'Images Endpoint'}
                          </Text>
                          <Text>{record.upstreamPreference.imagesBaseUrl || '未设置'}</Text>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {record.upstreamPreference.hasImagesApiKey ? '已保存密钥' : '未保存密钥'}
                          </Text>
                        </Space>
                      ),
                    },
                    {
                      title: 'Chat 上游',
                      width: 260,
                      render: (_, record) => (
                        <Space direction="vertical" size={2}>
                          <Text>{record.upstreamPreference.chatBaseUrl || '未设置'}</Text>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {record.upstreamPreference.hasChatApiKey ? '已保存密钥' : '未保存密钥'}
                            {' · '}
                            {record.upstreamPreference.chatFallbackMode === 'strict_user' ? '严格使用用户 Chat' : '允许平台兜底'}
                          </Text>
                        </Space>
                      ),
                    },
                    {
                      title: '鉴权方式',
                      width: 110,
                      render: (_, record) => (
                        record.upstreamPreference.preferredAuthMode === 'x-api-key' ? 'X-API-Key' : 'Bearer'
                      ),
                    },
                    {
                      title: '状态',
                      width: 90,
                      render: (_, record) => (
                        record.status === 'active'
                          ? <StatusDot tone="success">启用</StatusDot>
                          : <StatusDot tone="neutral">停用</StatusDot>
                      ),
                    },
                  ]}
                />
              </Card>
            </>
          )}
        </Space>
      </Drawer>

      <Modal
        title={editingApiKey ? '编辑下游 API Key' : '新增下游 API Key'}
        open={apiKeyModalOpen}
        width={640}
        onCancel={() => {
          setApiKeyModalOpen(false);
          setEditingApiKeyId(null);
          setCurrentRawKey('');
        }}
        onOk={saveApiKeyForm}
        okText="保存"
        confirmLoading={saving}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {(currentRawKey || apiKeyForm.getFieldValue('rawKey')) ? (
            <Alert
              type="warning"
              showIcon
              message="完整 Key 可随时复制"
              description={(
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Text>后台会保留完整 Key，便于后续再次复制与管理。请确保后台只对受信管理员开放。</Text>
                  <Space wrap>
                    <Button
                      type="primary"
                      onClick={() => copyText(apiKeyForm.getFieldValue('rawKey') || currentRawKey, '已复制完整 API Key')}
                    >
                      一键复制完整 API Key
                    </Button>
                    <Text code className="mono">{apiKeyForm.getFieldValue('maskedKey') || '未生成掩码'}</Text>
                  </Space>
                </Space>
              )}
            />
          ) : null}

          <Form form={apiKeyForm} layout="vertical">
            <Form.Item name="id" hidden>
              <Input />
            </Form.Item>
            <Form.Item name="rawKey" hidden>
              <Input />
            </Form.Item>
            <Form.Item name="keyHash" hidden>
              <Input />
            </Form.Item>
            <Form.Item
              name="name"
              label="密钥名称"
              rules={[{ required: true, message: '请输入密钥名称' }]}
            >
              <Input placeholder="例如：默认客户主密钥" />
            </Form.Item>

            <Form.Item name="maskedKey" label="下游 API Key">
              <Input disabled />
            </Form.Item>

            <div className="tenant-detail-grid">
              <Form.Item name="status" label="密钥状态">
                <Select options={[{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用' }]} />
              </Form.Item>

              <Form.Item name="allowedChannelIds" label="允许访问的业务通道">
                <Select mode="multiple" options={channelOptions} />
              </Form.Item>

              <Form.Item name="requestLimitPerMinute" label="密钥每分钟限流">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>

              <Form.Item name="maxConcurrency" label="密钥最大并发">
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>

              <Form.Item
                name="maxImageQuality"
                label="画质上限"
                extra="仅将明确高于上限的画质降级；未填写画质仍由上游线路默认值决定，auto 不会被提升。"
              >
                <Select options={imageQualityCapOptions} />
              </Form.Item>

              <Form.Item
                name="imageRoutingMode"
                label="密钥路由模式"
                extra="使用此密钥发起的图像请求固定采用该模式，请求参数不能覆盖。"
              >
                <Select
                  options={[
                    { value: 'smart_failover', label: '智能：智能优选多条线路，首条失败后继续切换' },
                    { value: 'smart_priority', label: '优选：智能优选单条线路，不做后续回退' },
                    { value: 'fixed_provider', label: '固定：只使用指定线路' },
                  ]}
                />
              </Form.Item>

              {watchedImageRoutingMode === 'fixed_provider' ? (
                <>
                  <Form.Item
                    name="fixedImageProviderIds"
                    label="固定线路池"
                    rules={[{ required: true, type: 'array', min: 1, message: '请至少选择一条固定线路' }]}
                    extra="仅会在这里选择的线路中进行智能排序与回退，不会使用池外线路。单选保持原有固定线路重试行为；多选时优先选择综合健康、速度和成本最优的线路。"
                  >
                    <Select
                      mode="multiple"
                      showSearch
                      optionFilterProp="label"
                      placeholder="选择业务通道中的一条或多条图像线路"
                      options={fixedImageProviderOptions}
                    />
                  </Form.Item>

                  <Form.Item
                    name="fixedImageFlatPrice"
                    label="固定线路一口价"
                    extra="仅固定模式生效。留空或填 0 时，继续按共享线路价格表计费；填入大于 0 的数值后，该密钥命中固定线路时按此价格逐张扣费，不再区分分辨率和画质。"
                  >
                    <InputNumber
                      min={0}
                      step={0.001}
                      precision={4}
                      disabled={!Array.isArray(watchedFixedImageProviderIds) || !watchedFixedImageProviderIds.length}
                      placeholder={Array.isArray(watchedFixedImageProviderIds) && watchedFixedImageProviderIds.length ? '输入固定线路池一口价' : '先选择固定线路池'}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </>
              ) : null}
            </div>

            <Form.Item name="notes" label="密钥备注" style={{ marginBottom: 0 }}>
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Space>
      </Modal>
    </div>
  );
}
