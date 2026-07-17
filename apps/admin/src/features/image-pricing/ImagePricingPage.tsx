import { Alert, Button, Card, InputNumber, Space, Table, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import type {
  AdminConsoleCatalog,
  BillableResolutionTier,
  ImageQualityTier,
  ImageSellPriceRow,
} from '../../shared/types';
import { PageHeader, SectionTitle } from '../../shared/ui';

const { Text } = Typography;

type ImagePricingPageProps = {
  catalog: AdminConsoleCatalog | null;
  saving: boolean;
  onSave: (rows: ImageSellPriceRow[], chatCompletionsUnitPriceYuan: number) => Promise<void>;
};

const tierOrder: BillableResolutionTier[] = ['auto', '1k', '2k', '4k'];
const qualityOrder: ImageQualityTier[] = ['auto', 'low', 'medium', 'high'];

function normalizeRows(rows?: ImageSellPriceRow[]) {
  const byKey = new Map((rows || []).map((row) => [row.tier + ':' + row.quality, row.price]));
  return tierOrder.flatMap((tier) => qualityOrder.map((quality) => ({
    tier,
    quality,
    price: Number(byKey.get(tier + ':' + quality) || 0),
  })));
}

function qualityLabel(value: ImageQualityTier) {
  if (value === 'auto') return '自动';
  if (value === 'low') return '低';
  if (value === 'medium') return '中';
  return '高';
}

function tierLabel(value: BillableResolutionTier) {
  if (value === 'auto') return '自动';
  return value.toUpperCase();
}

export function ImagePricingPage({ catalog, saving, onSave }: ImagePricingPageProps) {
  const [draftRows, setDraftRows] = useState<ImageSellPriceRow[]>([]);
  const [chatCompletionsUnitPriceYuan, setChatCompletionsUnitPriceYuan] = useState(0);

  type PricingTableRow = {
    key: BillableResolutionTier;
    tier: BillableResolutionTier;
  } & Record<ImageQualityTier, number>;

  useEffect(() => {
    setDraftRows(normalizeRows(catalog?.imagePricingMatrix));
    const yuan = Number(catalog?.chatCompletionsUnitPriceYuan);
    setChatCompletionsUnitPriceYuan(Number.isFinite(yuan)
      ? Math.max(0, yuan)
      : Math.max(0, Number(catalog?.chatCompletionsUnitPrice || 0)) / 100);
  }, [catalog?.imagePricingMatrix, catalog?.chatCompletionsUnitPrice, catalog?.chatCompletionsUnitPriceYuan]);

  const baselineRows = useMemo(() => normalizeRows(catalog?.imagePricingMatrix), [catalog?.imagePricingMatrix]);
  const rawChatPriceYuan = Number(catalog?.chatCompletionsUnitPriceYuan);
  const baselineChatPriceYuan = Number.isFinite(rawChatPriceYuan)
    ? Math.max(0, rawChatPriceYuan)
    : Math.max(0, Number(catalog?.chatCompletionsUnitPrice || 0)) / 100;
  const isDirty = JSON.stringify(draftRows) !== JSON.stringify(baselineRows)
    || chatCompletionsUnitPriceYuan !== baselineChatPriceYuan;

  function updatePrice(tier: BillableResolutionTier, quality: ImageQualityTier, price: number) {
    setDraftRows((current) => current.map((row) => (
      row.tier === tier && row.quality === quality
        ? { ...row, price: Math.max(0, Number(price || 0)) }
        : row
    )));
  }

  const tableData: PricingTableRow[] = tierOrder.map((tier) => {
    const row = { key: tier, tier } as PricingTableRow;
    for (const quality of qualityOrder) {
      row[quality] = draftRows.find((item) => item.tier === tier && item.quality === quality)?.price || 0;
    }
    return row;
  });

  return (
    <div className="page-stack">
      <PageHeader
        title="售价配置"
        desc="这里维护共享线路的统一下游售价。图像按分辨率和画质计费，Chat Completions 按请求次数统一计费。"
        actions={(
          <Button type="primary" loading={saving} disabled={!isDirty} onClick={() => onSave(draftRows, chatCompletionsUnitPriceYuan)}>
            保存售价配置
          </Button>
        )}
      />

      <Alert
        type="info"
        showIcon
        message="这是共享线路的标准价目表，不包含图像固定线路一口价。"
        description="共享线路下，图像生成成功后按每张图片最终提交给上游的有效 size 和 quality 结算；Chat Completions 成功后按请求次数结算。若某把 API Key 绑定图像固定线路且配置了一口价，则该密钥命中固定图像线路时不再使用图像矩阵。"
      />

      <Card>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <SectionTitle desc="请求前的余额校验会按最终提交上游的有效 size 预估；真正扣费时也按该 size 档位结算。size=auto 是独立计费档位，不会被响应实际宽高覆盖。若下游未传 quality，则按“自动”质量列计价。所有售价均以人民币元填写。">
            图像生成售价（元 / 张）
          </SectionTitle>
          <Table
            rowKey="key"
            size="small"
            pagination={false}
            dataSource={tableData}
            scroll={{ x: 860 }}
            columns={[
              {
                title: '分辨率档位',
                dataIndex: 'tier',
                width: 160,
                render: (value: BillableResolutionTier) => <Text strong>{tierLabel(value)}</Text>,
              },
              ...qualityOrder.map((quality) => ({
                title: qualityLabel(quality),
                dataIndex: quality,
                width: 160,
                render: (value: number, record: PricingTableRow) => (
                  <InputNumber
                    min={0}
                    precision={5}
                    step={0.00001}
                    value={value}
                    style={{ width: '100%' }}
                    onChange={(next) => updatePrice(record.tier, quality, Number(next || 0))}
                  />
                ),
              })),
            ]}
          />
          <Text type="secondary">价格单位为人民币元；实际扣费、余额和财务流水以 0.00001 元的整数最小单位精确保存。这里的“预估”不代表最终实扣；最终实扣请以“计费流水”页中的计费尺寸、计费档位和实扣金额为准。</Text>
        </Space>
      </Card>

      <Card>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <SectionTitle desc="Chat Completions 不按 token 计费，当前版本按成功请求次数统一扣费。这里配置的是每次成功请求向下游租户收取的金额。">
            Chat Completions 售价
          </SectionTitle>
          <InputNumber
            min={0}
            precision={5}
            step={0.00001}
            value={chatCompletionsUnitPriceYuan}
            style={{ width: 240 }}
            addonAfter="元 / 次"
            onChange={(next) => setChatCompletionsUnitPriceYuan(Math.max(0, Number(next || 0)))}
          />
          <Text type="secondary">只有使用平台托管 Chat Completions 上游并且请求成功时，才会按该价格写入计费流水；用户自带 Chat API 不走平台扣费。</Text>
        </Space>
      </Card>
    </div>
  );
}
