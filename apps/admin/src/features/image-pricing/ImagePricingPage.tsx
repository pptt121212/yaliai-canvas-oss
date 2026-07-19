import { Alert, Button, Card, Input, InputNumber, Popconfirm, Space, Table, Tabs, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import type {
  AdminConsoleCatalog,
  BananaImageSellPriceRow,
  BananaImageSize,
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
const bananaSizeOrder: BananaImageSize[] = ['1k', '2k', '4k'];

function normalizeRows(rows?: ImageSellPriceRow[]) {
  const byKey = new Map((rows || []).map((row) => [row.tier + ':' + row.quality, row.price]));
  return tierOrder.flatMap((tier) => qualityOrder.map((quality) => ({
    tier,
    quality,
    price: Number(byKey.get(tier + ':' + quality) || 0),
  })));
}

function normalizeBananaRows(rows?: BananaImageSellPriceRow[]) {
  const byKey = new Map((rows || []).map((row) => [`${row.model}:${row.imageSize}`, Number(row.price || 0)]));
  const models = Array.from(new Set((rows || []).map((row) => String(row.model || '').trim()).filter(Boolean))).sort();
  return models.flatMap((model) => bananaSizeOrder.map((imageSize) => ({
    model,
    imageSize,
    price: Number(byKey.get(`${model}:${imageSize}`) || 0),
  })));
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
} & Record<BananaImageSize, number>;

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
  const hasInvalidBananaModel = draftBananaRows.some((row) => !String(row.model || '').trim());
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

  function updateBananaPrice(model: string, imageSize: BananaImageSize, price: number) {
    setDraftBananaRows((current) => current.map((row) => (
      row.model === model && row.imageSize === imageSize
        ? { ...row, price: Math.max(0, Number(price || 0)) }
        : row
    )));
  }

  function renameBananaModel(model: string, nextModel: string) {
    setDraftBananaRows((current) => current.map((row) => (
      row.model === model ? { ...row, model: nextModel.trim() } : row
    )));
  }

  function addBananaModel() {
    const existing = new Set(draftBananaRows.map((row) => row.model));
    let index = 1;
    let model = `gemini-image-model-${index}`;
    while (existing.has(model)) {
      index += 1;
      model = `gemini-image-model-${index}`;
    }
    setDraftBananaRows((current) => [
      ...current,
      ...bananaSizeOrder.map((imageSize) => ({ model, imageSize, price: 0 })),
    ]);
  }

  function removeBananaModel(model: string) {
    setDraftBananaRows((current) => current.filter((row) => row.model !== model));
  }

  const tableData: PricingTableRow[] = tierOrder.map((tier) => {
    const row = { key: tier, tier } as PricingTableRow;
    for (const quality of qualityOrder) {
      row[quality] = draftRows.find((item) => item.tier === tier && item.quality === quality)?.price || 0;
    }
    return row;
  });

  const bananaTableData: BananaPricingTableRow[] = Array.from(new Set(draftBananaRows.map((row) => row.model))).map((model) => {
    const row = { key: model, model } as BananaPricingTableRow;
    for (const imageSize of bananaSizeOrder) {
      row[imageSize] = draftBananaRows.find((item) => item.model === model && item.imageSize === imageSize)?.price || 0;
    }
    return row;
  });

  return (
    <div className="page-stack">
      <PageHeader
        title="售价配置"
        desc="按下游协议维护平台统一售价。OpenAI 图像、Banana 图像和 Chat Completions 使用彼此独立的计价维度。"
        actions={(
          <Button
            type="primary"
            loading={saving}
            disabled={!isDirty || hasInvalidBananaModel}
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
        description="OpenAI 图像按档位和画质计价；Banana 图像按实际提交上游的模型名称和 imageSize（几K）计价，aspectRatio 仅用于能力过滤和审计；Chat Completions 按成功请求次数计价。"
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
                  <SectionTitle desc="每个 Banana 模型独立定价。只按 model 与 imageSize（几K）计价，不按具体像素尺寸换算，也不将比例作为价格维度。">
                    Banana 图像售价（元 / 张）
                  </SectionTitle>
                  <Button onClick={addBananaModel}>新增 Banana 模型</Button>
                  <Table
                    rowKey="key"
                    size="small"
                    pagination={false}
                    dataSource={bananaTableData}
                    locale={{ emptyText: '尚未配置 Banana 模型售价' }}
                    scroll={{ x: 760 }}
                    columns={[
                      {
                        title: '模型名称',
                        dataIndex: 'model',
                        width: 360,
                        render: (value: string) => <Input value={value} onChange={(event) => renameBananaModel(value, event.target.value)} />,
                      },
                      ...bananaSizeOrder.map((imageSize) => ({
                        title: imageSize.toUpperCase(),
                        dataIndex: imageSize,
                        width: 150,
                        render: (value: number, record: BananaPricingTableRow) => (
                          <InputNumber min={0} precision={5} step={0.00001} value={value} style={{ width: '100%' }} onChange={(next) => updateBananaPrice(record.model, imageSize, Number(next || 0))} />
                        ),
                      })),
                      {
                        title: '操作',
                        width: 100,
                        render: (_value: unknown, record: BananaPricingTableRow) => (
                          <Popconfirm title="删除该模型的全部 Banana 售价？" onConfirm={() => removeBananaModel(record.model)}>
                            <Button danger type="link">删除</Button>
                          </Popconfirm>
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
