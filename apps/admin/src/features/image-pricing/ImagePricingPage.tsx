import { Alert, Button, Card, InputNumber, Space, Table, Tabs, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { BANANA_MODELS } from '@yali/provider-core';
import type {
  AdminConsoleCatalog,
  BananaImageSellPriceRow,
  BillableResolutionTier,
  ImageQualityTier,
  ImageSellPriceRow,
} from '../../shared/types';
import { PageHeader, SectionTitle } from '../../shared/ui';

const { Text } = Typography;

type ImagePricingPageProps = {
  catalog: AdminConsoleCatalog | null;
  saving: boolean;
  onSave: (
    rows: ImageSellPriceRow[],
    bananaRows: BananaImageSellPriceRow[],
    chatCompletionsUnitPriceYuan: number,
  ) => Promise<void>;
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

function normalizeBananaRows(rows?: BananaImageSellPriceRow[]) {
  const byModel = new Map((rows || []).map((row) => [row.model, Number(row.price || 0)]));
  return BANANA_MODELS.map((model) => ({
    model: model.id,
    price: Number(byModel.get(model.id) || 0),
  }));
}

function qualityLabel(value: ImageQualityTier) {
  if (value === 'auto') return '自动';
  if (value === 'low') return '低';
  if (value === 'medium') return '中';
  return '高';
}

function tierLabel(value: BillableResolutionTier) {
  return value === 'auto' ? '自动' : value.toUpperCase();
}

type BananaPricingTableRow = {
  key: string;
  model: string;
  price: number;
};

export function ImagePricingPage({ catalog, saving, onSave }: ImagePricingPageProps) {
  const [draftRows, setDraftRows] = useState<ImageSellPriceRow[]>([]);
  const [draftBananaRows, setDraftBananaRows] = useState<BananaImageSellPriceRow[]>([]);
  const [chatCompletionsUnitPriceYuan, setChatCompletionsUnitPriceYuan] = useState(0);

  type PricingTableRow = {
    key: BillableResolutionTier;
    tier: BillableResolutionTier;
  } & Record<ImageQualityTier, number>;

  useEffect(() => {
    setDraftRows(normalizeRows(catalog?.imagePricingMatrix));
    setDraftBananaRows(normalizeBananaRows(catalog?.bananaImagePricingMatrix));
    const yuan = Number(catalog?.chatCompletionsUnitPriceYuan);
    setChatCompletionsUnitPriceYuan(Number.isFinite(yuan)
      ? Math.max(0, yuan)
      : Math.max(0, Number(catalog?.chatCompletionsUnitPrice || 0)) / 100);
  }, [catalog?.imagePricingMatrix, catalog?.bananaImagePricingMatrix, catalog?.chatCompletionsUnitPrice, catalog?.chatCompletionsUnitPriceYuan]);

  const baselineRows = useMemo(() => normalizeRows(catalog?.imagePricingMatrix), [catalog?.imagePricingMatrix]);
  const baselineBananaRows = useMemo(() => normalizeBananaRows(catalog?.bananaImagePricingMatrix), [catalog?.bananaImagePricingMatrix]);
  const rawChatPriceYuan = Number(catalog?.chatCompletionsUnitPriceYuan);
  const baselineChatPriceYuan = Number.isFinite(rawChatPriceYuan)
    ? Math.max(0, rawChatPriceYuan)
    : Math.max(0, Number(catalog?.chatCompletionsUnitPrice || 0)) / 100;
  const isDirty = JSON.stringify(draftRows) !== JSON.stringify(baselineRows)
    || JSON.stringify(draftBananaRows) !== JSON.stringify(baselineBananaRows)
    || chatCompletionsUnitPriceYuan !== baselineChatPriceYuan;

  function updatePrice(tier: BillableResolutionTier, quality: ImageQualityTier, price: number) {
    setDraftRows((current) => current.map((row) => (
      row.tier === tier && row.quality === quality
        ? { ...row, price: Math.max(0, Number(price || 0)) }
        : row
    )));
  }

  function updateBananaPrice(model: string, price: number) {
    setDraftBananaRows((current) => current.map((row) => (
      row.model === model
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

  const bananaTableData: BananaPricingTableRow[] = BANANA_MODELS.map((modelDefinition) => ({
    key: modelDefinition.id,
    model: modelDefinition.id,
    price: draftBananaRows.find((item) => item.model === modelDefinition.id)?.price || 0,
  }));

  return (
    <div className="page-stack">
      <PageHeader
        title="售价配置"
        desc="按下游协议维护平台统一售价。OpenAI 图像、Banana 图像和 Chat Completions 使用彼此独立的计价维度。"
        actions={(
          <Button
            type="primary"
            loading={saving}
            disabled={!isDirty}
            onClick={() => onSave(draftRows, draftBananaRows, chatCompletionsUnitPriceYuan)}
          >
            保存售价配置
          </Button>
        )}
      />

      <Alert
        type="info"
        showIcon
        message="固定线路一口价优先于共享售价表"
        description="OpenAI 图像按档位和画质计价；Banana 图像只按实际提交上游的模型名称计价，K 档位与比例仅用于能力过滤和审计；Chat Completions 按成功请求次数计价。"
      />

      <Tabs
        items={[
          {
            key: 'openai-images',
            label: 'OpenAI 图像',
            children: (
              <Card>
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  <SectionTitle desc="面向 OpenAI Images 与 Responses 图像请求。最终按实际提交上游的有效档位和画质结算。">
                    OpenAI 图像售价（元 / 张）
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
                          <InputNumber min={0} precision={5} step={0.00001} value={value} style={{ width: '100%' }} onChange={(next) => updatePrice(record.tier, quality, Number(next || 0))} />
                        ),
                      })),
                    ]}
                  />
                </Space>
              </Card>
            ),
          },
          {
            key: 'banana-images',
            label: 'Banana 图像',
            children: (
              <Card>
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  <SectionTitle desc="售价模型固定为 Python 接口示例中的两个 Banana 模型。每个模型只有一个单价；K 档位和比例不参与售价计算。">
                    Banana 图像售价（元 / 张）
                  </SectionTitle>
                  <Table
                    rowKey="key"
                    size="small"
                    pagination={false}
                    dataSource={bananaTableData}
                    locale={{ emptyText: '暂无 Banana 模型售价' }}
                    scroll={{ x: 620 }}
                    columns={[
                      {
                        title: '模型名称',
                        dataIndex: 'model',
                        width: 360,
                        render: (value: string) => (
                          <Space direction="vertical" size={0}>
                            <Text>{BANANA_MODELS.find((item) => item.id === value)?.label || value}</Text>
                            <Text type="secondary" code>{value}</Text>
                          </Space>
                        ),
                      },
                      {
                        title: '售价（元 / 张）',
                        dataIndex: 'price',
                        width: 220,
                        render: (value: number, record: BananaPricingTableRow) => (
                          <InputNumber min={0} precision={5} step={0.00001} value={value} style={{ width: '100%' }} onChange={(next) => updateBananaPrice(record.model, Number(next || 0))} />
                        ),
                      },
                    ]}
                  />
                </Space>
              </Card>
            ),
          },
          {
            key: 'chat-completions',
            label: 'Chat Completions',
            children: (
              <Card>
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  <SectionTitle desc="Chat Completions 是独立的文本接口体系，当前按成功请求次数统一计费。">
                    Chat Completions 售价
                  </SectionTitle>
                  <InputNumber min={0} precision={5} step={0.00001} value={chatCompletionsUnitPriceYuan} style={{ width: 240 }} addonAfter="元 / 次" onChange={(next) => setChatCompletionsUnitPriceYuan(Math.max(0, Number(next || 0)))} />
                </Space>
              </Card>
            ),
          },
        ]}
      />
    </div>
  );
}
