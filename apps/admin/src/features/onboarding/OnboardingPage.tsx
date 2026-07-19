import { Alert, Button, Card, Descriptions, Form, Image, Input, InputNumber, List, Select, Space, Switch, Tag, Timeline, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { BANANA_MODELS } from '@yali/provider-core';
import { useState } from 'react';
import type {
  ImageBackgroundMode,
  ImageToolQuality,
  ModerationMode,
  OnboardingAnalysisResult,
  OnboardingAnalyzeJob,
  OnboardingAnalyzeRequest,
  OnboardingProbeLogEntry,
  OutputImageFormat,
  ResponsesInputShape,
  ResponsesToolChoiceFormat,
  ResponsesToolChoiceMode,
} from '../../shared/types';
import { PageHeader, SectionTitle, StatusDot } from '../../shared/ui';
import type { StatusTone } from '../../shared/ui';

const { Paragraph, Text } = Typography;

type KeyValueItem = {
  key: string;
  value: string;
};

type OnboardingFormValues = Omit<OnboardingAnalyzeRequest, 'targetKind'> & {
  targetKind: 'images_endpoint' | 'responses_endpoint' | 'banana_endpoint' | 'chat_completions';
  customBodyFieldsList?: KeyValueItem[];
};

type OnboardingPageProps = {
  saving: boolean;
  onAnalyze: (
    input: OnboardingAnalyzeRequest,
    onProgress?: (job: OnboardingAnalyzeJob) => void,
  ) => Promise<OnboardingAnalysisResult>;
  onAccept: (result: OnboardingAnalysisResult) => Promise<void>;
};

const kindLabelMap = {
  images_endpoint: 'Images Endpoint',
  responses_endpoint: 'Responses Endpoint',
  banana_endpoint: 'Banana / Gemini 图像',
  chat_completions: 'Chat Completions',
} as const;

const targetKindOptions = [
  { value: 'images_endpoint', label: 'Images Endpoint：文生图 / 图生图' },
  { value: 'responses_endpoint', label: 'Responses Endpoint：图像工具链路' },
  { value: 'banana_endpoint', label: 'Banana / Gemini 图像：generateContent' },
  { value: 'chat_completions', label: 'Chat Completions：文本 / 视觉理解' },
];

const defaultReferenceImageUrl = `${window.location.origin}/test-assets/reference-test.png`;
const outputFormatOptions: Array<{ value: OutputImageFormat; label: string }> = [
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WEBP' },
  { value: 'jpeg', label: 'JPEG' },
];
const imageToolQualityOptions: Array<{ value: ImageToolQuality; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'low', label: '快速' },
  { value: 'medium', label: '标准' },
  { value: 'high', label: '精细' },
];
const moderationOptions: Array<{ value: ModerationMode; label: string }> = [
  { value: 'omit', label: '不提交 moderation' },
  { value: 'auto', label: '提交 moderation=auto' },
  { value: 'low', label: '提交 moderation=low' },
];
const backgroundOptions: Array<{ value: ImageBackgroundMode; label: string }> = [
  { value: 'omit', label: '不提交 background' },
  { value: 'auto', label: '自动' },
  { value: 'transparent', label: '透明背景' },
  { value: 'opaque', label: '不透明背景' },
];
const responsesInputShapeOptions: Array<{ value: ResponsesInputShape; label: string }> = [
  { value: 'auto_standard', label: '自动' },
  { value: 'always_multimodal_message', label: '始终多模态消息' },
];
const responsesToolChoiceOptions: Array<{ value: ResponsesToolChoiceMode; label: string }> = [
  { value: 'auto', label: '不强制指定工具' },
  { value: 'image_generation', label: '指定图像工具' },
];
const responsesToolChoiceFormatOptions: Array<{ value: ResponsesToolChoiceFormat; label: string }> = [
  { value: 'typed_object', label: '对象格式' },
  { value: 'required_string', label: 'required 字符串' },
];
const imagesInputModeLabelMap = {
  unknown: '未确认 / 视为不支持参考图',
  url_only: '仅支持 JSON images[].image_url 通道',
  multipart_only: '仅支持 multipart 文件上传',
  url_or_multipart: '同时支持 JSON images[].image_url 与 multipart',
} as const;
const editReferenceModeLabelMap = {
  multipart_file_upload: 'multipart/form-data + image 文件上传',
  json_image_url: 'application/json + images[].image_url',
} as const;
const imagesEditRequestFormatLabelMap = {
  multipart: 'multipart/form-data',
  json: 'JSON body',
} as const;
const referenceImageTransportLabelMap = {
  inherit: '跟随下游原始内容',
  url: '强制转为图片 URL',
  base64: '强制转为 Base64 / data URL',
} as const;
const reservedCustomBodyFieldKeysByKind: Record<OnboardingFormValues['targetKind'], Set<string>> = {
  images_endpoint: new Set([
    'model',
    'prompt',
    'size',
    'response_format',
    'quality',
    'n',
    'user',
    'image',
    'images',
    'image_urls',
    'stream',
    'output_format',
    'output_quality',
    'output_compression',
    'background',
    'moderation',
    'partial_images',
    'async',
    'callback_url',
  ]),
  responses_endpoint: new Set([
    'model',
    'input',
    'tools',
    'tool_choice',
    'stream',
    'reasoning',
  ]),
  banana_endpoint: new Set([
    'contents',
    'generationConfig',
  ]),
  chat_completions: new Set([
    'model',
    'messages',
    'stream',
  ]),
};

function modelDefaultsForKind(kind: OnboardingFormValues['targetKind']) {
  if (kind === 'banana_endpoint') {
    return {
      model: BANANA_MODELS[0].id,
      imageModel: undefined,
    };
  }
  if (kind === 'responses_endpoint') {
    return {
      model: 'gpt-5.4-mini',
      imageModel: 'gpt-image-2',
    };
  }
  if (kind === 'chat_completions') {
    return {
      model: 'gpt-4.1-mini',
      imageModel: undefined,
    };
  }
  return {
    model: 'gpt-image-2',
    imageModel: undefined,
  };
}

function parseTypedValue(input: string) {
  const raw = String(input ?? '').trim();
  if (!raw) {
    return '';
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  if (raw === 'null') {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function fromKeyValueList(list?: KeyValueItem[]) {
  const result: Record<string, unknown> = {};
  for (const item of list || []) {
    const key = String(item.key || '').trim();
    if (!key) {
      continue;
    }
    result[key] = parseTypedValue(item.value);
  }
  return result;
}

function sanitizeCustomBodyFields(
  kind: OnboardingFormValues['targetKind'],
  fields: Record<string, unknown>,
) {
  const reserved = reservedCustomBodyFieldKeysByKind[kind];
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || reserved.has(normalizedKey)) {
      continue;
    }
    sanitized[normalizedKey] = value;
  }
  return sanitized;
}

function KeyValueEditor({
  value = [],
  onChange,
}: {
  value?: KeyValueItem[];
  onChange?: (next: KeyValueItem[]) => void;
}) {
  const list = value || [];

  function update(next: KeyValueItem[]) {
    onChange?.(next);
  }

  return (
    <div className="kv-editor">
      {list.map((item, index) => (
        <div className="kv-row" key={`${item.key}_${index}`}>
          <Input
            placeholder="字段名，例如 force_firefly"
            value={item.key}
            onChange={(event) => {
              const next = [...list];
              next[index] = { ...next[index], key: event.target.value };
              update(next);
            }}
          />
          <Input
            placeholder="字段值，例如 true"
            value={item.value}
            onChange={(event) => {
              const next = [...list];
              next[index] = { ...next[index], value: event.target.value };
              update(next);
            }}
          />
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            aria-label="删除该行"
            onClick={() => {
              update(list.filter((_, currentIndex) => currentIndex !== index));
            }}
          />
        </div>
      ))}
      <Button type="dashed" icon={<PlusOutlined />} block onClick={() => update([...(list || []), { key: '', value: '' }])}>
        新增一行
      </Button>
    </div>
  );
}

function logColor(status: OnboardingProbeLogEntry['status']) {
  if (status === 'success') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'warning') return 'orange';
  return 'blue';
}

function logTone(status: OnboardingProbeLogEntry['status']): StatusTone {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'warning') return 'warning';
  return 'processing';
}

function renderLogEntry(entry: OnboardingProbeLogEntry) {
  return (
    <div className="onboarding-log-entry">
      <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
        <Text strong>{entry.title}</Text>
        <StatusDot tone={logTone(entry.status)}>
          {entry.status === 'success' ? '成功' : entry.status === 'failed' ? '失败' : entry.status === 'warning' ? '注意' : '信息'}
        </StatusDot>
      </Space>

      <div className="onboarding-log-block">
        <Text strong>输入</Text>
        <ul className="onboarding-log-list">
          {entry.requestLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {entry.requestBodyPreview ? (
          <pre className="onboarding-log-json">{entry.requestBodyPreview}</pre>
        ) : null}
      </div>

      <div className="onboarding-log-block">
        <Text strong>输出</Text>
        <ul className="onboarding-log-list">
          {entry.responseLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {entry.responseBodyPreview ? (
          <pre className="onboarding-log-json">{entry.responseBodyPreview}</pre>
        ) : null}
      </div>

      {entry.analysisLines?.length ? (
        <div className="onboarding-log-block">
          <Text strong>分析</Text>
          <ul className="onboarding-log-list">
            {entry.analysisLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {entry.previewImageUrl ? (
        <div className="onboarding-log-preview">
          <Text strong>生成结果预览</Text>
          <Image src={entry.previewImageUrl} alt={entry.title} />
        </div>
      ) : null}

      {entry.previewImageNote ? (
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {entry.previewImageNote}
        </Paragraph>
      ) : null}
    </div>
  );
}

function renderReportList(items: string[] | undefined, emptyText = '暂无') {
  const data = items || [];
  if (!data.length) {
    return <Paragraph type="secondary" style={{ marginBottom: 0 }}>{emptyText}</Paragraph>;
  }
  return (
    <List
      size="small"
      dataSource={data}
      renderItem={(item) => <List.Item>{item}</List.Item>}
    />
  );
}

export function OnboardingPage({ saving, onAnalyze, onAccept }: OnboardingPageProps) {
  const [form] = Form.useForm<OnboardingFormValues>();
  const [result, setResult] = useState<OnboardingAnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [liveProbeLog, setLiveProbeLog] = useState<OnboardingProbeLogEntry[]>([]);
  const [liveJobMessage, setLiveJobMessage] = useState('');

  const currentKind = Form.useWatch('targetKind', form) || 'images_endpoint';
  const displayProbeLog = result?.probeLog || liveProbeLog;

  function handleTargetKindChange(kind: OnboardingFormValues['targetKind']) {
    form.setFieldsValue({
      targetKind: kind,
      ...modelDefaultsForKind(kind),
      baseUrl: kind === 'banana_endpoint'
        ? 'https://sub.g-aisc.com/'
        : form.getFieldValue('baseUrl'),
      size: kind === 'chat_completions'
        ? undefined
        : kind === 'responses_endpoint'
          ? (form.getFieldValue('size') || 'auto')
          : kind === 'banana_endpoint'
            ? '4K'
          : (form.getFieldValue('size') || '1600x1200'),
      referenceImageUrl: kind === 'chat_completions'
        ? undefined
        : form.getFieldValue('referenceImageUrl') || defaultReferenceImageUrl,
      quality: kind === 'responses_endpoint'
        ? (form.getFieldValue('quality') || 'low')
        : kind === 'images_endpoint'
          ? (form.getFieldValue('quality') || 'auto')
          : form.getFieldValue('quality'),
      imageToolQuality: kind === 'responses_endpoint'
        ? (form.getFieldValue('imageToolQuality') || 'low')
        : form.getFieldValue('imageToolQuality'),
      imageQuality: kind === 'responses_endpoint'
        ? form.getFieldValue('imageQuality')
        : form.getFieldValue('imageQuality'),
      stream: kind === 'responses_endpoint'
        ? (form.getFieldValue('stream') ?? true)
        : form.getFieldValue('stream'),
      responsesInputShape: kind === 'responses_endpoint'
        ? (form.getFieldValue('responsesInputShape') || 'always_multimodal_message')
        : form.getFieldValue('responsesInputShape'),
      responsesToolChoice: kind === 'responses_endpoint'
        ? (form.getFieldValue('responsesToolChoice') || 'image_generation')
        : form.getFieldValue('responsesToolChoice'),
    });
  }

  async function handleAnalyze() {
    const values = await form.validateFields();
    setError('');
    setLoading(true);
    setResult(null);
    setLiveProbeLog([]);
    setLiveJobMessage('探测任务已创建，正在准备执行。');
    try {
      const next = await onAnalyze({
        name: values.name,
        baseUrl: values.baseUrl || undefined,
        apiKey: values.apiKey || undefined,
        targetKind: values.targetKind,
        model: values.model || undefined,
        imageModel: values.imageModel || undefined,
        reasoningEffort: values.reasoningEffort || undefined,
        prompt: values.prompt || undefined,
        size: values.size || undefined,
        referenceImageUrl: values.referenceImageUrl || undefined,
        imagesGenerationUrl: values.imagesGenerationUrl || undefined,
        imagesEditUrl: values.imagesEditUrl || undefined,
        quality: values.quality || undefined,
        imageToolQuality: values.imageToolQuality || undefined,
        imageQuality: values.imageQuality ?? undefined,
        outputFormat: values.outputFormat || undefined,
        outputCompression: values.outputCompression ?? undefined,
        background: values.background || undefined,
        stream: values.targetKind === 'responses_endpoint' ? true : values.stream,
        partialImages: values.partialImages ?? undefined,
        moderation: values.moderation || undefined,
        n: values.n ?? undefined,
        responsesInputShape: values.responsesInputShape || undefined,
        responsesToolChoice: values.responsesToolChoice || undefined,
        responsesToolChoiceFormat: values.responsesToolChoiceFormat || undefined,
        customBodyFields: sanitizeCustomBodyFields(
          values.targetKind,
          fromKeyValueList(values.customBodyFieldsList),
        ),
      }, (job) => {
        setLiveJobMessage(job.message || '');
        setLiveProbeLog(job.probeLog || []);
      });
      setResult(next);
      setLiveProbeLog(next.probeLog || []);
      setLiveJobMessage('探测任务已完成。');
    } catch (analysisError) {
      const timeoutJob = analysisError && typeof analysisError === 'object' && 'job' in analysisError
        ? (analysisError as Error & { job?: OnboardingAnalyzeJob }).job
        : undefined;
      if (timeoutJob?.probeLog?.length) {
        setLiveProbeLog(timeoutJob.probeLog);
      }
      if (timeoutJob?.message) {
        setLiveJobMessage(timeoutJob.message);
      }
      setError(analysisError instanceof Error ? analysisError.message : '探测失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleAccept() {
    if (!result) {
      return;
    }
    setError('');
    setLoading(true);
    try {
      await onAccept(result);
    } catch (acceptError) {
      setError(acceptError instanceof Error ? acceptError.message : '保存失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="接入向导"
        desc="填写上游真实接口后发起探测。Images Endpoint 直接使用完整地址，不再自动猜测或补全路径。"
      />
      <div className="onboarding-layout">
        <Card title="探测配置" extra={<Button type="primary" loading={loading} onClick={handleAnalyze}>开始探测</Button>}>
          <Paragraph type="secondary" style={{ marginTop: 0 }}>
            左侧负责确定本次探测的真实请求方式。系统只探测当前选定的接口类型，并记录每次真实请求与响应。
          </Paragraph>
          <Paragraph type="secondary" style={{ marginTop: -8 }}>
            `Responses Endpoint` 使用“顶层文本模型 + 图像工具模型”；`Images Endpoint` 只使用“图像模型”。
          </Paragraph>
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              name: '',
              baseUrl: '',
              apiKey: '',
              targetKind: 'images_endpoint',
              model: 'gpt-image-2',
              imageModel: undefined,
              prompt: '一只小猫，干净背景，自然光，不要文字',
              size: '1600x1200',
              referenceImageUrl: defaultReferenceImageUrl,
              imagesGenerationUrl: '',
              imagesEditUrl: '',
              quality: 'auto',
              imageToolQuality: 'medium',
              imageQuality: undefined,
              outputFormat: 'webp',
              outputCompression: undefined,
              background: 'omit',
              stream: false,
              partialImages: undefined,
              moderation: 'omit',
              n: 1,
              reasoningEffort: 'low',
              responsesInputShape: 'always_multimodal_message',
              responsesToolChoice: 'image_generation',
              responsesToolChoiceFormat: 'typed_object',
              customBodyFieldsList: [],
            }}
          >
            <Form.Item name="name" label="上游名称" rules={[{ required: true, message: '请输入一个方便识别的名称' }]}>
              <Input placeholder="例如：SuperAPI 图像主线路" />
            </Form.Item>
            <Form.Item name="targetKind" label="本次测试的接口类型" rules={[{ required: true, message: '请选择要测试的接口类型' }]}>
              <Select options={targetKindOptions} onChange={handleTargetKindChange} />
            </Form.Item>
            {currentKind !== 'images_endpoint' ? (
              <Form.Item
                name="baseUrl"
                label="接入地址"
                rules={[{ required: true, message: '请输入上游地址' }]}
                extra={currentKind === 'banana_endpoint'
                  ? '按 Python 示例填写服务根地址，例如 https://sub.g-aisc.com/。向导会固定请求 /v1beta/models/{model}:generateContent；文生图和图生图不填写两条地址。'
                  : undefined}
              >
                <Input placeholder={currentKind === 'banana_endpoint' ? '例如 https://sub.g-aisc.com/' : '请直接填写上游真实完整 URL，系统不会自动补全路径'} />
              </Form.Item>
            ) : null}
            <Form.Item name="apiKey" label="API 密钥">
              <Input.Password placeholder="不填写则只确认输入地址，不做真实探测" />
            </Form.Item>

            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              {currentKind === 'responses_endpoint' ? (
                <>
                  <SectionTitle desc="这部分决定我们向这个 Responses 上游如何组织协议结构，不属于下游标准 Images Endpoint 可直接提交的字段。">
                    上游固定适配规则
                  </SectionTitle>
                  <Form.Item name="model" label="顶层文本模型">
                    <Input placeholder="例如 gpt-5.4-mini" />
                  </Form.Item>
                  <Form.Item name="imageModel" label="图像工具模型">
                    <Input placeholder="例如 gpt-image-2，允许改成其他真实模型名" />
                  </Form.Item>
                  <Form.Item name="reasoningEffort" label="推理强度">
                    <Select allowClear options={[
                      { value: 'low', label: '低' },
                      { value: 'medium', label: '中' },
                      { value: 'high', label: '高' },
                      { value: 'xhigh', label: '极高' },
                    ]} />
                  </Form.Item>
                  <Form.Item label="上游返回模式">
                    <Input value="固定 SSE：Responses 探测统一以 stream=true 请求上游" disabled />
                  </Form.Item>
                  <Form.Item name="responsesInputShape" label="Responses 输入结构">
                    <Select allowClear options={responsesInputShapeOptions} />
                  </Form.Item>
                  <Form.Item name="responsesToolChoice" label="图像工具指定方式">
                    <Select allowClear options={responsesToolChoiceOptions} />
                  </Form.Item>
                  <Form.Item name="responsesToolChoiceFormat" label="tool_choice 提交格式">
                    <Select allowClear options={responsesToolChoiceFormatOptions} />
                  </Form.Item>

                  <SectionTitle desc="这部分是接入向导发起真实探测时采用的默认生成条件，用来验证这个上游在常见参数下是否稳定可用；它不是协议结构本身。">
                    探测与测试默认值
                  </SectionTitle>
                </>
              ) : null}
              {currentKind === 'images_endpoint' ? (
                <>
                  <SectionTitle desc="这里填写供应商真实的完整 URL。系统不会根据基础地址自动拼接路径。">
                    Images 完整接口地址
                  </SectionTitle>
                  <Form.Item
                    name="imagesGenerationUrl"
                    label="文生图完整地址"
                    rules={[
                      { required: true, message: '请填写文生图完整地址' },
                      { type: 'url', message: '请输入有效的 HTTP(S) URL' },
                    ]}
                  >
                    <Input placeholder="https://provider.example.com/v1/images/generations" />
                  </Form.Item>
                  <Form.Item
                    name="imagesEditUrl"
                    label="图生图完整地址"
                    rules={[
                      { required: true, message: '请填写图生图完整地址' },
                      { type: 'url', message: '请输入有效的 HTTP(S) URL' },
                    ]}
                  >
                    <Input placeholder="https://provider.example.com/v1/images/edits" />
                  </Form.Item>
                  <SectionTitle desc="以下字段会真实进入探测请求；系统会发起 4 次核心探测：文生图 response_format=url、图生图 multipart + b64_json、图生图 JSON images[].image_url(URL) + b64_json、图生图 JSON images[].image_url(Base64/data URL) + b64_json。默认更偏向验证 `url` 友好的下游体验，但最终仍会按下游显式 `response_format` 返回。">
                    Images 探测参数
                  </SectionTitle>
                  <Form.Item name="model" label="图像模型">
                    <Input placeholder="例如 gpt-image-2" />
                  </Form.Item>
                  <Form.Item name="prompt" label="测试提示词">
                    <Input.TextArea rows={3} placeholder="请输入用于文生图和图生图探测的提示词" />
                  </Form.Item>
                </>
              ) : null}
              {currentKind === 'chat_completions' ? (
                <Form.Item name="model" label="聊天模型">
                  <Input placeholder="例如 gpt-4.1-mini" />
                </Form.Item>
              ) : null}
              {currentKind === 'banana_endpoint' ? (
                <>
                  <SectionTitle desc="模型固定为 Python 接口示例中的两个 Banana 模型。选择后，向导会用原生 Gemini generateContent 格式探测文生图；参考图可下载时再追加 inlineData 图生图探测。">
                    Banana 探测参数
                  </SectionTitle>
                  <Form.Item name="model" label="绑定模型">
                    <Select options={BANANA_MODELS.map((item) => ({ value: item.id, label: `${item.label} (${item.id})` }))} />
                  </Form.Item>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message="文生图和图生图共用一个地址"
                    description="两类请求均使用 /v1beta/models/{model}:generateContent；图生图仅在 contents[].parts[] 中额外写入 inlineData，不存在 OpenAI Images 的 generations / edits 两条上游地址。"
                  />
                </>
              ) : null}
              {currentKind !== 'chat_completions' ? (
                <>
                  {currentKind === 'banana_endpoint' ? (
                    <Form.Item name="size" label="测试 imageSize">
                      <Select options={['1K', '2K', '4K'].map((value) => ({ value, label: value }))} />
                    </Form.Item>
                  ) : (
                    <Form.Item name="size" label="测试尺寸">
                      <Input placeholder={currentKind === 'responses_endpoint' ? '例如 auto、1536x1024 或 1024x1024' : '例如 1600x1200 或 1024x1024'} />
                    </Form.Item>
                  )}
                  <Form.Item name="referenceImageUrl" label="参考图 URL">
                    <Input placeholder="图生图探测时使用的公网图片地址" />
                  </Form.Item>
                </>
              ) : null}
              {currentKind === 'images_endpoint' ? (
                <>
                  <Form.Item name="quality" label="测试质量">
                    <Select allowClear options={[
                      { value: 'auto', label: '自动' },
                      { value: 'low', label: '快速' },
                      { value: 'medium', label: '标准' },
                      { value: 'high', label: '精细' },
                    ]} />
                  </Form.Item>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message="将执行 4 次核心探测"
                    description="系统会依次验证 Images 文生图 (url)、Images 图生图 multipart (b64_json)、Images 图生图 JSON images[].image_url(URL) (b64_json)、Images 图生图 JSON images[].image_url(Base64/data URL) (b64_json)。这里的成功/失败只表示本次探测请求是否拿到了符合预期的响应，不代表业务统计页里的生成成功率。"
                  />
                  <Form.Item name="outputFormat" label="输出图片格式">
                    <Select allowClear options={outputFormatOptions} />
                  </Form.Item>
                  <Form.Item name="outputCompression" label="输出压缩率">
                    <InputNumber min={0} max={100} style={{ width: '100%' }} placeholder="0-100；留空则不提交 output_compression" />
                  </Form.Item>
                  <Form.Item name="background" label="背景模式">
                    <Select options={backgroundOptions} />
                  </Form.Item>
                  <Form.Item name="n" label="生成数量">
                    <InputNumber min={1} max={10} precision={0} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="stream" label="是否提交 stream=true" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                  <Form.Item name="partialImages" label="中间图数量">
                    <InputNumber min={1} max={3} precision={0} style={{ width: '100%' }} placeholder="1-3；留空则不提交 partial_images" />
                  </Form.Item>
                  <Form.Item name="moderation" label="moderation 策略">
                    <Select allowClear options={moderationOptions} />
                  </Form.Item>
                </>
              ) : null}
              {currentKind === 'responses_endpoint' ? (
                <>
                  <Form.Item name="quality" label="图像工具质量">
                    <Select allowClear options={imageToolQualityOptions} />
                  </Form.Item>
                  <Form.Item name="imageQuality" label="图像压缩率">
                    <InputNumber min={0} max={100} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="outputFormat" label="输出图片格式">
                    <Select allowClear options={outputFormatOptions} />
                  </Form.Item>
                  <Form.Item name="moderation" label="moderation 策略">
                    <Select allowClear options={moderationOptions} />
                  </Form.Item>
                </>
              ) : null}
              {currentKind === 'chat_completions' ? (
                <Form.Item name="stream" label="是否流式返回" valuePropName="checked">
                  <Switch />
                </Form.Item>
              ) : null}
            </Space>

            <Form.Item name="customBodyFieldsList" label="探测时额外携带的请求字段">
              <KeyValueEditor />
            </Form.Item>
            <Paragraph type="secondary" style={{ marginTop: -8, marginBottom: 0 }}>
              高级补丁字段只用于特殊上游，例如 `force_firefly: true`。标准字段如 `stream`、`response_format`、`output_format`、`size` 会由上面的正式选项决定，不应在这里重复追加。
            </Paragraph>
          </Form>
          {error ? <Alert style={{ marginTop: 16 }} type="error" showIcon message={error} /> : null}
        </Card>

        <Card title="探测执行日志" className="onboarding-log-card">
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="这里展示的是探测执行口径"
            description="日志里的成功、失败、警告，只表示这一轮探测或某一步探测请求的执行结果。它用于判断上游兼容性，不等于业务通道或总览里的成功率统计。"
          />
          {!displayProbeLog.length && !loading ? (
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              点击“开始探测”后，右侧会按照真实执行顺序显示：地址确认、参考图校验、每一步探测请求的关键输入、关键输出，以及是否已经拿到图片结果。
            </Paragraph>
          ) : null}

          {loading || displayProbeLog.length ? (
            <Timeline
              items={(displayProbeLog.length
                ? displayProbeLog
                : [{
                    key: 'job_waiting',
                    title: '正在执行探测',
                    status: 'info' as const,
                    requestLines: ['系统正在按照当前配置真实请求上游。'],
                    responseLines: [liveJobMessage || '等待第一段探测结果返回。'],
                  }]
              ).map((entry) => ({
                color: logColor(entry.status),
                children: renderLogEntry(entry),
              }))}
            />
          ) : null}

          {(loading || error) && displayProbeLog.length ? (
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
              {error || liveJobMessage || '探测仍在继续，新的图像任务执行结果会按完成顺序持续追加。'}
            </Paragraph>
          ) : null}
        </Card>
      </div>

      {result ? (
        <Card
          title="探测结果与保存草稿"
          extra={
            <Space>
              <StatusDot tone={result.probe.ok ? 'success' : 'warning'}>
                {result.probe.ok ? '已识别' : '未完全确认'}
              </StatusDot>
              <Button type="primary" loading={saving || loading} onClick={handleAccept}>
                保存为上游接入
              </Button>
            </Space>
          }
        >
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="推荐类型">
              {result.detectedKind ? kindLabelMap[result.detectedKind] : '未识别'}
            </Descriptions.Item>
            <Descriptions.Item label="识别到的能力">
              {(result.probe.detectedKinds || []).map((item) => (
                <Tag key={item}>{kindLabelMap[item]}</Tag>
              ))}
            </Descriptions.Item>
            <Descriptions.Item label="标准化地址">
              {result.probe.normalizedBaseCandidates.join(' , ') || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="同步支持判断">{result.probe.syncSupport === 'likely_supported' ? '大概率支持' : '未确认'}</Descriptions.Item>
            <Descriptions.Item label="总结" span={2}>{result.probe.summary}</Descriptions.Item>
          </Descriptions>

          {result.warnings.length ? (
            <Alert
              style={{ marginTop: 16 }}
              type="warning"
              showIcon
              message="需要注意"
              description={
                <List
                  size="small"
                  dataSource={result.warnings}
                  renderItem={(item) => <List.Item>{item}</List.Item>}
                />
              }
            />
          ) : null}

          {result.recommendations.length ? (
            <Alert
              style={{ marginTop: 16 }}
              type="info"
              showIcon
              message="建议"
              description={
                <List
                  size="small"
                  dataSource={result.recommendations}
                  renderItem={(item) => <List.Item>{item}</List.Item>}
                />
              }
            />
          ) : null}

          {result.probeReport ? (
            <Card
              size="small"
              title={result.probeReport.title || '接入探测分析报告'}
              style={{ marginTop: 16 }}
            >
              <Paragraph type="secondary" style={{ marginTop: 0 }}>
                {result.probeReport.summary}
              </Paragraph>
              <Descriptions column={1} size="small" bordered>
                <Descriptions.Item label="已确认能力">
                  {renderReportList(result.probeReport.confirmed, '暂无已确认能力')}
                </Descriptions.Item>
                <Descriptions.Item label="需要注意">
                  {renderReportList(result.probeReport.needsAttention, '暂无明显风险')}
                </Descriptions.Item>
                <Descriptions.Item label="已提交但响应未证明">
                  {renderReportList(result.probeReport.submittedButUnverified, '暂无')}
                </Descriptions.Item>
                <Descriptions.Item label="上游响应回显">
                  {renderReportList(result.probeReport.responseEchoes, '暂无回显字段')}
                </Descriptions.Item>
                <Descriptions.Item label="图片实测诊断">
                  {renderReportList(result.probeReport.imageDiagnostics, '暂无图片实测信息')}
                </Descriptions.Item>
                <Descriptions.Item label="追踪与保存信息">
                  {renderReportList(result.probeReport.savedDiagnostics, '暂无')}
                </Descriptions.Item>
                <Descriptions.Item label="建议下一步">
                  {renderReportList(result.probeReport.suggestedNextSteps, '暂无')}
                </Descriptions.Item>
              </Descriptions>
            </Card>
          ) : null}

          <div style={{ marginTop: 16 }}>
            <Text strong>即将保存的接入草稿</Text>
            <Paragraph type="secondary" style={{ marginTop: 8 }}>
              保存后会自动加入对应业务通道，线路启停可在“业务通道”中管理。
            </Paragraph>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="上游名称">{result.upstreamDraft.name}</Descriptions.Item>
              <Descriptions.Item label="上游类型">{kindLabelMap[result.upstreamDraft.kind]}</Descriptions.Item>
              <Descriptions.Item label="基础地址" span={2}>{result.upstreamDraft.baseUrl}</Descriptions.Item>
              <Descriptions.Item label="下游请求模型匹配" span={2}>
                {result.upstreamDraft.modelHints.length ? result.upstreamDraft.modelHints.join('，') : '未填写'}
              </Descriptions.Item>
              {result.upstreamDraft.kind === 'images_endpoint' ? (
                <>
                  <Descriptions.Item label="支持的返回格式">
                    {(result.upstreamDraft.imagesConfig?.responseFormats || []).length
                      ? result.upstreamDraft.imagesConfig?.responseFormats?.map((item) => item === 'b64_json' ? 'Base64' : 'URL').join('，')
                      : '未确认'}
                  </Descriptions.Item>
                  <Descriptions.Item label="参考图输入方式">
                    {editReferenceModeLabelMap[result.upstreamDraft.imagesConfig?.editReferenceMode || 'multipart_file_upload']}
                  </Descriptions.Item>
                  <Descriptions.Item label="图生图请求格式">
                    {imagesInputModeLabelMap[result.upstreamDraft.imagesConfig?.imageInputMode || 'unknown']}
                  </Descriptions.Item>
                  <Descriptions.Item label="参考图向上游传输格式">
                    {`${imagesEditRequestFormatLabelMap[result.upstreamDraft.imagesConfig?.editRequestFormat || 'multipart']} / ${referenceImageTransportLabelMap[result.upstreamDraft.imagesConfig?.referenceImageTransport || 'base64']}`}
                  </Descriptions.Item>
                </>
              ) : null}
              <Descriptions.Item label="固定追加的请求体字段" span={2}>
                {Object.keys(result.upstreamDraft.passthrough?.injectBodyFields || {}).length
                  ? JSON.stringify(result.upstreamDraft.passthrough?.injectBodyFields || {}, null, 2)
                  : '无'}
              </Descriptions.Item>
            </Descriptions>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
