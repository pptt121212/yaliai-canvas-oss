import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntdApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AdminApp } from './AdminApp';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          // —— 石板控制台 Slate Console ——
          colorPrimary: '#3B5BDB',
          colorInfo: '#3B5BDB',
          colorSuccess: '#2F9E44',
          colorWarning: '#E8590C',
          colorError: '#E03131',
          colorLink: '#3B5BDB',
          colorText: '#1A2027',
          colorTextSecondary: '#6B7482',
          colorTextTertiary: '#9AA1AC',
          colorBorder: '#D5DAE0',
          colorBorderSecondary: '#E5E8EC',
          colorBgLayout: '#F7F8FA',
          colorBgContainer: '#FFFFFF',
          colorBgElevated: '#FFFFFF',
          borderRadius: 6,
          borderRadiusLG: 8,
          borderRadiusSM: 4,
          fontSize: 13,
          controlHeight: 30,
          fontFamily:
            '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
          boxShadow: '0 8px 24px rgba(16, 24, 40, 0.12)',
          boxShadowSecondary: '0 1px 3px rgba(16, 24, 40, 0.06)',
          wireframe: false,
        },
        components: {
          Layout: {
            headerBg: '#FFFFFF',
            siderBg: '#FFFFFF',
            bodyBg: '#F7F8FA',
            headerHeight: 52,
            headerPadding: '0 16px',
          },
          Menu: {
            itemHeight: 36,
            itemBorderRadius: 6,
            itemSelectedBg: '#EDF0FB',
            itemSelectedColor: '#3B5BDB',
            itemActiveBg: '#F2F4F7',
            activeBarWidth: 0,
            iconSize: 15,
            itemMarginInline: 8,
          },
          Card: {
            paddingLG: 14,
            borderRadiusLG: 6,
            headerHeight: 44,
            headerFontSize: 14,
          },
          Table: {
            cellPaddingBlockSM: 6,
            cellPaddingInlineSM: 10,
            headerBg: '#F2F4F7',
            headerColor: '#6B7482',
            headerSplitColor: 'transparent',
            rowHoverBg: '#F7F8FA',
            borderColor: '#E5E8EC',
            fontSize: 12.5,
          },
          Button: {
            controlHeightSM: 24,
            primaryShadow: 'none',
            defaultShadow: 'none',
            dangerShadow: 'none',
          },
          Input: {
            activeShadow: '0 0 0 3px #EDF0FB',
          },
          Drawer: { paddingLG: 16 },
          Modal: { borderRadiusLG: 8 },
          Tabs: { horizontalItemGutter: 20 },
          Descriptions: { labelBg: '#F2F4F7', titleMarginBottom: 8 },
          Tag: { borderRadiusSM: 4, defaultBg: '#F1F3F5', defaultColor: '#6B7482' },
          Statistic: { contentFontSize: 22, titleFontSize: 12 },
          Divider: { marginLG: 12 },
          Alert: { borderRadiusLG: 6 },
        },
      }}
    >
      <AntdApp>
        <AdminApp />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
