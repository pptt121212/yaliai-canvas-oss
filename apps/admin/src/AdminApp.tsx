import {
  ApiOutlined,
  ApartmentOutlined,
  BookOutlined,
  DeploymentUnitOutlined,
  DollarOutlined,
  FileSearchOutlined,
  KeyOutlined,
  LinkOutlined,
  LineChartOutlined,
  LogoutOutlined,
  RadarChartOutlined,
  RocketOutlined,
  ShareAltOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { App, Button, Layout, Menu, Space, Spin, Typography } from 'antd';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  adjustTenantFinanceBalance,
  adminLogin,
  adminLogout,
  analyzeOnboarding,
  createNewApiKeySecret,
  clearRequestTraces,
  deleteApiKey,
  deleteTenant,
  deleteUpstream,
  fetchAdminSession,
  fetchAuditLogReport,
  fetchBillingLedgerReport,
  fetchCatalog,
  fetchControlPlane,
  fetchCanvasUsersReport,
  fetchOverview,
  fetchOperationalRollupReport,
  fetchRequestTraceReport,
  fetchRoutingDiagnosticsReport,
  fetchResolutionAuditReport,
  fetchTenantFinanceLedgerReport,
  saveControlPlane,
  saveApiKey,
  saveChannel,
  saveImagePricing,
  saveTenant,
  saveUpstream,
  testUpstreamDraft,
} from './shared/api';
import type {
  AdminConsoleCatalog,
  AdminControlPlaneConfig,
  AdminSession,
  AuditLogReport,
  BillingLedgerReport,
  CanvasUserAdminReport,
  OnboardingAnalysisResult,
  OperationalRollupReport,
  OverviewPayload,
  RequestTraceReport,
  RoutingDiagnosticsReport,
  ResolutionAuditReport,
  TenantFinanceLedgerReport,
} from './shared/types';

const { Header, Sider, Content, Footer } = Layout;
const { Title, Paragraph, Text } = Typography;

const BillingLedgerPage = lazy(() => import('./features/billing-ledger/BillingLedgerPage').then((module) => ({ default: module.BillingLedgerPage })));
const AuditLogsPage = lazy(() => import('./features/audit-logs/AuditLogsPage').then((module) => ({ default: module.AuditLogsPage })));
const ChannelsPage = lazy(() => import('./features/channels/ChannelsPage').then((module) => ({ default: module.ChannelsPage })));
const ImagePricingPage = lazy(() => import('./features/image-pricing/ImagePricingPage').then((module) => ({ default: module.ImagePricingPage })));
const OnboardingPage = lazy(() => import('./features/onboarding/OnboardingPage').then((module) => ({ default: module.OnboardingPage })));
const OperationalReportsPage = lazy(() => import('./features/operational-reports/OperationalReportsPage').then((module) => ({ default: module.OperationalReportsPage })));
const OverviewPage = lazy(() => import('./features/overview/OverviewPage').then((module) => ({ default: module.OverviewPage })));
const RequestTracesPage = lazy(() => import('./features/request-traces/RequestTracesPage').then((module) => ({ default: module.RequestTracesPage })));
const RoutingDiagnosticsPage = lazy(() => import('./features/routing-diagnostics/RoutingDiagnosticsPage').then((module) => ({ default: module.RoutingDiagnosticsPage })));
const ResolutionAuditPage = lazy(() => import('./features/resolution-audit/ResolutionAuditPage').then((module) => ({ default: module.ResolutionAuditPage })));
const TenantFinancePage = lazy(() => import('./features/tenant-finance/TenantFinancePage').then((module) => ({ default: module.TenantFinancePage })));
const TenantsPage = lazy(() => import('./features/tenants/TenantsPage').then((module) => ({ default: module.TenantsPage })));
const UpstreamsPage = lazy(() => import('./features/upstreams/UpstreamsPage').then((module) => ({ default: module.UpstreamsPage })));
const ProtocolDocsPage = lazy(() => import('./features/interface-docs/ProtocolDocsPage').then((module) => ({ default: module.ProtocolDocsPage })));

type ViewKey =
  | 'overview'
  | 'upstreams'
  | 'image-pricing'
  | 'channels'
  | 'tenants'
  | 'tenant-finance'
  | 'billing-ledger'
  | 'operational-reports'
  | 'audit-logs'
  | 'request-traces'
  | 'routing-diagnostics'
  | 'resolution-audit'
  | 'onboarding'
  | 'docs-responses'
  | 'docs-images'
  | 'docs-chat';

type TenantFinanceEntryScope = 'account_adjustment' | 'tenant_request_charge';
type TenantFinanceReports = Record<TenantFinanceEntryScope, TenantFinanceLedgerReport | null>;

const emptyTenantFinanceReports: TenantFinanceReports = {
  account_adjustment: null,
  tenant_request_charge: null,
};

function currentLocalDayRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return { createdAfter: start, createdBefore: start + 24 * 60 * 60 * 1000 };
}

const menuItems = [
  { key: 'overview', icon: <ApartmentOutlined />, label: '总览' },
  { key: 'upstreams', icon: <LinkOutlined />, label: '上游接入' },
  { key: 'image-pricing', icon: <DollarOutlined />, label: '售价配置' },
  { key: 'channels', icon: <DeploymentUnitOutlined />, label: '业务通道' },
  { key: 'tenants', icon: <KeyOutlined />, label: '租户与密钥' },
  { key: 'tenant-finance', icon: <WalletOutlined />, label: '充值管理' },
  { key: 'billing-ledger', icon: <DollarOutlined />, label: '计费流水' },
  { key: 'operational-reports', icon: <LineChartOutlined />, label: '经营报表' },
  { key: 'audit-logs', icon: <FileSearchOutlined />, label: '审计日志' },
  { key: 'request-traces', icon: <FileSearchOutlined />, label: '请求追踪' },
  { key: 'routing-diagnostics', icon: <ShareAltOutlined />, label: '路由诊断' },
  { key: 'resolution-audit', icon: <RadarChartOutlined />, label: '分辨率偏差' },
  { key: 'onboarding', icon: <RocketOutlined />, label: '接入向导' },
  {
    key: 'protocol-docs',
    icon: <BookOutlined />,
    label: '接口说明',
    children: [
      { key: 'docs-responses', label: 'Responses Endpoint' },
      { key: 'docs-images', label: 'Images Endpoint' },
      { key: 'docs-chat', label: 'Chat Completions' },
    ],
  },
];

function AdminFooter() {
  return (
    <div className="admin-footer">
      <span>官方域名：api.yaliai.com</span>
      <span>微信号：qn006699</span>
    </div>
  );
}

function LoginView({
  onLogin,
  saving,
  error,
}: {
  onLogin: (username: string, password: string) => Promise<void>;
  saving: boolean;
  error: string;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  return (
    <div className="login-shell">
      <div className="login-card">
        <Space direction="vertical" size={18} style={{ width: '100%' }}>
          <div>
            <Text type="secondary">Yali Canvas OSS</Text>
            <Title level={2} style={{ marginTop: 8, marginBottom: 8 }}>
              图像 API 网关后台
            </Title>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              管理上游接入、业务通道、租户密钥、充值台账、计费审计与分辨率偏差统计。
            </Paragraph>
          </div>
          <input
            className="login-input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="请输入后台用户名"
          />
          <input
            className="login-input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="请输入后台密码"
          />
          {error ? <div className="login-error">{error}</div> : null}
          <Button type="primary" size="large" loading={saving} onClick={() => onLogin(username, password)}>
            登录后台
          </Button>
        </Space>
      </div>
      <AdminFooter />
    </div>
  );
}

export function AdminApp() {
  const { message } = App.useApp();
  const [session, setSession] = useState<AdminSession | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<ViewKey>('overview');
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [catalog, setCatalog] = useState<AdminConsoleCatalog | null>(null);
  const [auditLogReport, setAuditLogReport] = useState<AuditLogReport | null>(null);
  const [billingLedgerReport, setBillingLedgerReport] = useState<BillingLedgerReport | null>(null);
  const [operationalRollupReport, setOperationalRollupReport] = useState<OperationalRollupReport | null>(null);
  const [requestTraceReport, setRequestTraceReport] = useState<RequestTraceReport | null>(null);
  const [routingDiagnosticsReport, setRoutingDiagnosticsReport] = useState<RoutingDiagnosticsReport | null>(null);
  const [resolutionAuditReport, setResolutionAuditReport] = useState<ResolutionAuditReport | null>(null);
  const [tenantFinanceReports, setTenantFinanceReports] = useState<TenantFinanceReports>(emptyTenantFinanceReports);
  const [canvasUsersReport, setCanvasUsersReport] = useState<CanvasUserAdminReport | null>(null);
  const [controlPlane, setControlPlane] = useState<AdminControlPlaneConfig | null>(null);

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    if (session?.authenticated) {
      void loadViewData(activeView);
    }
  }, [session?.authenticated, activeView]);

  async function loadSession() {
    setBootLoading(true);
    try {
      const payload = await fetchAdminSession();
      setSession(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '会话检查失败');
      setSession({ authenticated: false });
    } finally {
      setBootLoading(false);
    }
  }

  async function loadViewData(view: ViewKey) {
    setPageLoading(true);
    setError('');
    try {
      const catalogPromise = fetchCatalog().then((payload) => {
        setCatalog(payload);
        return payload;
      });
      const controlPlanePromise = fetchControlPlane().then((payload) => {
        setControlPlane(payload);
        return payload;
      });

      if (view === 'overview') {
        const [overviewPayload] = await Promise.all([fetchOverview(), catalogPromise, controlPlanePromise]);
        setOverview(overviewPayload);
      } else if (view === 'billing-ledger') {
        const today = currentLocalDayRange();
        const [report, canvasReport] = await Promise.all([
          fetchBillingLedgerReport({ limit: 20, scope: 'image', ...today }),
          fetchCanvasUsersReport(),
        ]);
        setBillingLedgerReport(report);
        setCanvasUsersReport(canvasReport);
        await Promise.all([catalogPromise, controlPlanePromise]);
      } else if (view === 'operational-reports') {
        const report = await fetchOperationalRollupReport();
        setOperationalRollupReport(report);
        await Promise.all([catalogPromise, controlPlanePromise]);
      } else if (view === 'audit-logs') {
        const report = await fetchAuditLogReport();
        setAuditLogReport(report);
        await Promise.all([catalogPromise, controlPlanePromise]);
      } else if (view === 'request-traces') {
        const report = await fetchRequestTraceReport();
        setRequestTraceReport(report);
        await Promise.all([catalogPromise, controlPlanePromise]);
      } else if (view === 'routing-diagnostics') {
        const report = await fetchRoutingDiagnosticsReport();
        setRoutingDiagnosticsReport(report);
        await Promise.all([catalogPromise, controlPlanePromise]);
      } else if (view === 'resolution-audit') {
        const report = await fetchResolutionAuditReport();
        setResolutionAuditReport(report);
        await Promise.all([catalogPromise, controlPlanePromise]);
      } else if (view === 'tenant-finance') {
        const today = currentLocalDayRange();
        const [adjustmentReport, requestChargeReport, canvasReport] = await Promise.all([
          fetchTenantFinanceLedgerReport({ limit: 20, entryType: 'account_adjustment', ...today }),
          fetchTenantFinanceLedgerReport({ limit: 20, entryType: 'tenant_request_charge', ...today }),
          fetchCanvasUsersReport(),
        ]);
        setTenantFinanceReports({
          account_adjustment: adjustmentReport,
          tenant_request_charge: requestChargeReport,
        });
        setCanvasUsersReport(canvasReport);
        await Promise.all([catalogPromise, controlPlanePromise]);
      } else if (view === 'tenants') {
        const report = await fetchCanvasUsersReport();
        setCanvasUsersReport(report);
        await Promise.all([catalogPromise, controlPlanePromise]);
      } else {
        await Promise.all([catalogPromise, controlPlanePromise]);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '后台数据加载失败');
    } finally {
      setPageLoading(false);
    }
  }

  async function refreshCurrentView() {
    await loadViewData(activeView);
  }

  async function handleLogin(username: string, password: string) {
    setSaving(true);
    setError('');
    try {
      await adminLogin(username, password);
      await loadSession();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '登录失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleLogout() {
    setSaving(true);
    try {
      await adminLogout();
      setSession({ authenticated: false });
      setOverview(null);
      setCatalog(null);
      setAuditLogReport(null);
      setBillingLedgerReport(null);
      setOperationalRollupReport(null);
      setRequestTraceReport(null);
      setRoutingDiagnosticsReport(null);
      setResolutionAuditReport(null);
      setTenantFinanceReports(emptyTenantFinanceReports);
      setCanvasUsersReport(null);
      setControlPlane(null);
    } finally {
      setSaving(false);
    }
  }

  async function wrapSave(task: () => Promise<unknown>, successText: string) {
    setSaving(true);
    setError('');
    try {
      await task();
      await refreshCurrentView();
      message.success(successText);
    } catch (taskError) {
      const nextError = taskError instanceof Error ? taskError.message : '保存失败';
      setError(nextError);
      message.error(nextError);
      throw taskError;
    } finally {
      setSaving(false);
    }
  }

  async function handleOnboardingAccept(result: OnboardingAnalysisResult) {
    await wrapSave(
      () => saveUpstream(result.upstreamDraft),
      '上游已保存并自动加入对应业务通道。',
    );
    setActiveView('upstreams');
  }

  const content = useMemo(() => {
    if (pageLoading) {
      return (
        <div className="loading-shell">
          <Spin size="large" />
        </div>
      );
    }

    if (activeView === 'overview') {
      return (
        <OverviewPage
          overview={overview}
          catalog={catalog}
          controlPlane={controlPlane}
          saving={saving}
          onSaveControlPlane={(config) => wrapSave(() => saveControlPlane(config), '画布开源配置已保存')}
        />
      );
    }

    if (activeView === 'upstreams') {
      return (
        <UpstreamsPage
          catalog={catalog}
          saving={saving}
          onSave={(upstream) => wrapSave(() => saveUpstream(upstream), '上游已保存')}
          onDelete={(id) => wrapSave(() => deleteUpstream(id), '上游已删除')}
          onTest={testUpstreamDraft}
        />
      );
    }

    if (activeView === 'channels') {
      return (
        <ChannelsPage
          catalog={catalog}
          saving={saving}
          onSave={(channel) => wrapSave(() => saveChannel(channel), '业务通道已保存')}
          onSaveUpstream={(upstream) => wrapSave(() => saveUpstream(upstream), upstream.enabled ? '线路已开启' : '线路已停用')}
        />
      );
    }

    if (activeView === 'image-pricing') {
      return (
        <ImagePricingPage
          catalog={catalog}
          saving={saving}
          onSave={(rows, bananaRows, chatCompletionsUnitPriceYuan) => wrapSave(() => saveImagePricing(rows, bananaRows, chatCompletionsUnitPriceYuan), '售价配置已保存')}
        />
      );
    }

    if (activeView === 'tenants') {
      return (
        <TenantsPage
          catalog={catalog}
          canvasUsersReport={canvasUsersReport}
          saving={saving}
          onSaveTenant={(tenant) => wrapSave(() => saveTenant(tenant), '租户已保存')}
          onDeleteTenant={(id) => wrapSave(() => deleteTenant(id), '租户已删除')}
          onSaveApiKey={(apiKey) => wrapSave(() => saveApiKey(apiKey), '下游 API Key 已保存')}
          onDeleteApiKey={(id) => wrapSave(() => deleteApiKey(id), '下游 API Key 已删除')}
          onCreateKeySecret={createNewApiKeySecret}
        />
      );
    }

    if (activeView === 'tenant-finance') {
      return (
        <TenantFinancePage
          catalog={catalog}
          reports={tenantFinanceReports}
          canvasUsersReport={canvasUsersReport}
          saving={saving}
          onQuery={async (query) => {
            const scope = query.entryType;
            if (!scope) {
              throw new Error('tenant_finance_entry_type_required');
            }
            const report = await fetchTenantFinanceLedgerReport(query);
            setTenantFinanceReports((current) => ({
              ...current,
              [scope]: report,
            }));
          }}
          onAdjust={(input) => wrapSave(
            () => adjustTenantFinanceBalance(input),
            input.direction === 'credit' ? '充值已记账' : '扣费已记账',
          )}
        />
      );
    }

    if (activeView === 'billing-ledger') {
      return (
        <BillingLedgerPage
          report={billingLedgerReport}
          catalog={catalog}
          canvasUsersReport={canvasUsersReport}
          loading={pageLoading}
          onQuery={async (query) => {
            setBillingLedgerReport(await fetchBillingLedgerReport(query));
          }}
        />
      );
    }

    if (activeView === 'operational-reports') {
      return (
        <OperationalReportsPage
          report={operationalRollupReport}
          catalog={catalog}
          controlPlane={controlPlane}
          saving={saving}
          onSaveControlPlane={(config) => wrapSave(() => saveControlPlane(config), '经营报表设置已保存')}
        />
      );
    }

    if (activeView === 'audit-logs') {
      return <AuditLogsPage report={auditLogReport} />;
    }

    if (activeView === 'request-traces') {
      return (
        <RequestTracesPage
          report={requestTraceReport}
          saving={saving}
          onClear={() => wrapSave(() => clearRequestTraces(), '请求追踪与生成图片已清空')}
        />
      );
    }

    if (activeView === 'routing-diagnostics') {
      return <RoutingDiagnosticsPage report={routingDiagnosticsReport} />;
    }

    if (activeView === 'resolution-audit') {
      return <ResolutionAuditPage report={resolutionAuditReport} />;
    }

    if (activeView === 'docs-responses') {
      return <ProtocolDocsPage kind="responses" />;
    }

    if (activeView === 'docs-images') {
      return <ProtocolDocsPage kind="images" />;
    }

    if (activeView === 'docs-chat') {
      return <ProtocolDocsPage kind="chat" />;
    }

    return <OnboardingPage saving={saving} onAnalyze={analyzeOnboarding} onAccept={handleOnboardingAccept} />;
  }, [
    activeView,
    auditLogReport,
    billingLedgerReport,
    catalog,
    overview,
    operationalRollupReport,
    pageLoading,
    requestTraceReport,
    routingDiagnosticsReport,
    resolutionAuditReport,
    saving,
    tenantFinanceReports,
    canvasUsersReport,
    controlPlane,
  ]);

  if (bootLoading && !session) {
    return (
      <div className="loading-shell">
        <Spin size="large" />
      </div>
    );
  }

  if (!session?.authenticated) {
    return <LoginView onLogin={handleLogin} saving={saving} error={error} />;
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={260} theme="light" className="app-sider">
        <div className="brand-panel">
          <div className="brand-eyebrow">Yali Canvas OSS</div>
          <div className="brand-title">图像 API 网关后台</div>
          <p className="brand-subtitle">
            对上游做接入管理，对下游提供统一图像与文本 API。
          </p>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[activeView]}
          defaultOpenKeys={['protocol-docs']}
          items={menuItems}
          onClick={(event) => setActiveView(event.key as ViewKey)}
          style={{ borderInlineEnd: 'none' }}
        />
      </Sider>
      <Layout>
        <Header className="app-header">
          <div>
            <Space align="center" size={10}>
              <ApiOutlined />
              <Text strong>当前管理员</Text>
              <Text>{session.user?.username}</Text>
            </Space>
            {error ? <div className="top-error" style={{ marginTop: 12 }}>{error}</div> : null}
          </div>
          <Button icon={<LogoutOutlined />} loading={saving} onClick={handleLogout}>
            退出登录
          </Button>
        </Header>
        <Content className="app-content">
          <Suspense fallback={<div className="loading-shell"><Spin size="large" /></div>}>
            {content}
          </Suspense>
        </Content>
        <Footer className="app-footer">
          <AdminFooter />
        </Footer>
      </Layout>
    </Layout>
  );
}
