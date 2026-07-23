import { Alert, Card, Col, Descriptions, Row, Table, Typography } from 'antd';
import { PageHeader } from '../../shared/ui';

const { Paragraph, Text } = Typography;

type ProtocolKind = 'responses' | 'images' | 'chat';

type ProtocolDocsPageProps = {
  kind: ProtocolKind;
};

type FieldRow = {
  key: string;
  field: string;
  role: string;
  source: string;
  notes: string;
};

type MappingRow = {
  key: string;
  downstream: string;
  internal: string;
  upstream: string;
  notes: string;
};

type ExampleBlock = {
  key: string;
  title: string;
  requestLabel: string;
  requestBody: string;
  responseLabel: string;
  responseBody: string;
};

type SectionConfig = {
  title: string;
  summary: string;
  upstreamEndpoint: string;
  downstreamEndpoint: string;
  businessRole: string;
  onboardingDefaults: string[];
  fixedRules: string[];
  requestDefaults: string[];
  downstreamRules: string[];
  fields: FieldRow[];
  mappings: MappingRow[];
  warnings: string[];
  upstreamExamples: ExampleBlock[];
  downstreamExamples: ExampleBlock[];
};

const fieldColumns = [
  { title: '字段 / 能力', dataIndex: 'field', width: 220 },
  { title: '归类', dataIndex: 'role', width: 180 },
  { title: '来源', dataIndex: 'source', width: 200 },
  { title: '说明', dataIndex: 'notes' },
];

const mappingColumns = [
  { title: '下游字段', dataIndex: 'downstream', width: 220 },
  { title: '网关内部处理', dataIndex: 'internal', width: 280 },
  { title: '上游实际字段', dataIndex: 'upstream', width: 300 },
  { title: '说明', dataIndex: 'notes' },
];

const docsMap: Record<ProtocolKind, SectionConfig> = {
  responses: {
    title: 'Responses Endpoint 说明',
    summary: 'Responses 类型用于接入带 image_generation 工具的 Responses 上游。下游仍统一调用标准 Images 接口，网关负责把下游请求改写成 Responses 所需的多模态结构。',
    upstreamEndpoint: 'POST /v1/responses',
    downstreamEndpoint: 'POST /v1/images/generations 或 POST /v1/images/edits',
    businessRole: '用于把统一图像请求改写为 Responses 多模态输入与 image_generation 工具调用。',
    onboardingDefaults: [
      '默认会探测文生图与带参考图的 edit 场景。',
      '默认文本模型与图像工具模型由后台上游接入配置决定。',
      '探测关注的是网关能否把 Responses 原始返回标准化为统一 Images 结果。',
    ],
    fixedRules: [
      '下游不直接接触 Responses 原始 input、tools、reasoning 等结构。',
      'Responses 的模型拆分、tool_choice、returnMode 等属于后台上游适配配置，不是下游公开字段。',
      '下游仍只提交标准 Images 语义字段，例如 prompt、image、size、response_format。',
    ],
    requestDefaults: [
      '下游常用字段仍是 model、prompt、image、size、response_format、output_format。',
      '有参考图时，网关会进入 edit 语义并改写为 Responses 多模态输入。',
    ],
    downstreamRules: [
      '下游无需了解 Responses 原始事件格式。',
      '网关会把上游返回的 data URL、b64、二进制图片或 SSE 事件标准化为统一 Images 响应。',
      '如果下游请求 stream=true，网关也会统一整理为自己的标准 SSE 输出，不直接透传上游私有事件。',
      '下游看到的失败响应始终是平台统一错误文案，不直接暴露上游原始错误文本。',
    ],
    fields: [
      { key: 'responses-model', field: 'model', role: '下游正式支持', source: '下游 JSON / multipart', notes: '下游仍按 Images 模型字段提交；具体上游 text/image 模型由后台配置决定。' },
      { key: 'responses-prompt', field: 'prompt', role: '下游正式支持', source: '下游 JSON / multipart', notes: '作为图像描述文本，被包装进 Responses 输入。' },
      { key: 'responses-image', field: 'image', role: '下游正式支持', source: '下游 JSON / multipart', notes: '存在参考图时进入 edit 语义。' },
      { key: 'responses-size', field: 'size', role: '下游正式支持', source: '下游 JSON / multipart', notes: '映射到 image_generation 工具的 size。' },
      { key: 'responses-format', field: 'response_format', role: '下游正式支持', source: '下游 JSON / multipart', notes: '最终由网关统一标准化为 url 或 b64_json。' },
      { key: 'responses-stream', field: 'stream', role: '下游正式支持', source: '下游 JSON / multipart', notes: '网关可统一输出标准 SSE。' },
    ],
    mappings: [
      { key: 'responses-map-prompt', downstream: 'prompt', internal: 'buildResponsesMultimodalInput(prompt, images)', upstream: 'input[].content[].text', notes: '下游 prompt 会被包装进 Responses 输入。' },
      { key: 'responses-map-image', downstream: 'image', internal: 'referenceImages + hasReference', upstream: 'input[].content[].image_url + tools[0].action=edit', notes: '存在参考图时进入 edit 语义。' },
      { key: 'responses-map-size', downstream: 'size', internal: 'payload.size', upstream: 'tools[0].size', notes: '写入 image_generation 工具字段。' },
      { key: 'responses-map-format', downstream: 'response_format', internal: 'normalizeResponsesImageBody + rewriteImageDataItemsToRequestedFormat', upstream: 'result / b64 / data URL / binary', notes: '最终统一改写成下游要求的 url 或 b64_json。' },
      { key: 'responses-map-stream', downstream: 'stream', internal: 'wantsStreamingResponse + normalized SSE output', upstream: 'request.stream + Accept:text/event-stream', notes: '下游 SSE 始终由网关统一整理。' },
    ],
    warnings: [
      'Responses 与 Images 不是同一套上游协议，不应混淆配置。',
      'reasoning、tool_choice 等属于上游适配层，不属于下游公开契约。',
    ],
    upstreamExamples: [
      {
        key: 'responses-upstream-generate',
        title: '上游文生图：Responses + image_generation',
        requestLabel: '网关发给上游的真实请求',
        requestBody: `POST /v1/responses
Content-Type: application/json
Accept: text/event-stream

{
  "model": "gpt-5.4-mini",
  "stream": true,
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "一只小猫，干净背景，自然光，不要文字" }
      ]
    }
  ],
  "tools": [
    {
      "type": "image_generation",
      "model": "gpt-image-2",
      "action": "generate",
      "size": "auto",
      "quality": "low",
      "output_format": "jpeg"
    }
  ]
}`,
        responseLabel: '上游常见响应形态',
        responseBody: `event: response.output_image.delta
data: {
  "result": "data:image/jpeg;base64,<省略的内容>"
}`,
      },
    ],
    downstreamExamples: [
      {
        key: 'responses-downstream-generate',
        title: '下游统一调用：标准 Images 请求',
        requestLabel: '下游请求网关',
        requestBody: `POST /v1/images/generations
Content-Type: application/json

{
  "model": "gpt-image-2",
  "prompt": "一只小猫，干净背景，自然光，不要文字",
  "size": "1536x1024",
  "response_format": "url"
}`,
        responseLabel: '网关返回给下游',
        responseBody: `{
  "created": 1782870000,
  "data": [
    {
      "url": "https://api.example.com/v1/generated-images/imgsync_xxx_0.jpg"
    }
  ]
}`,
      },
    ],
  },
  images: {
    title: 'Images Endpoint 说明',
    summary: '这一页优先说明面向下游调用方公开的 Images 请求契约。网关会兼容不同上游协议形态，但下游应始终按这里列出的字段、限制和响应结构接入。',
    upstreamEndpoint: 'POST /v1/images/generations 或 POST /v1/images/edits',
    downstreamEndpoint: 'POST /v1/images/generations 或 POST /v1/images/edits',
    businessRole: '用于承接文生图与图生图请求，并把统一下游请求改写成命中上游所需的真实协议结构。',
    onboardingDefaults: [
      '接入向导默认图片模型为 gpt-image-2。',
      '当前 Images 探测固定执行 4 次核心测试：generations(url)、edits multipart(b64_json)、edits JSON image_url(URL)(b64_json)、edits JSON image_url(Base64/data URL)(b64_json)。',
      '探测关注的是下游公开字段是否能被上游正确接受，以及上游结果能否被网关标准化为统一 Images 响应。',
    ],
    fixedRules: [
      '本页优先从下游公开协议视角说明，避免把上游私有差异、后台能力配置和下游输入字段混写在一起。',
      '下游公开协议分为三类：同步 JSON 结果、同步 SSE 结果、异步任务回执与任务查询。',
      '下游只需要关心标准 Images 字段；上游 edits 协议形态、返回模式、参考图传输方式由网关和上游接入配置共同决定。',
      'Supported Edit Protocols 是上游能力筛选条件，不代表 multipart edits 与 JSON edits 可以跨协议等价互转。',
    ],
    requestDefaults: [
      '下游正式支持的主字段是：model、prompt、size、resolution、response_format、quality、n、user、image、stream、async、output_format、output_quality、output_compression、background、moderation、callback_url。',
      'size 支持直接传像素尺寸，也兼容 1:1、16:9 等比例写法；当 size 是比例且同时传 resolution=1k/2k/4k 时，网关会先映射为具体像素尺寸再进入上游请求。',
      '下游兼容的 JSON 参考图别名有：image_url、image_urls[]、reference_images[]、images[].image_url；进入网关后会统一归一化为 image。',
      '下游 multipart/form-data 也支持提交 image / image_url / image_urls / reference_images 这些参考图字段；文件会先被解析为内部图片载荷，再进入统一路由逻辑。',
      '除标准字段外，代码还支持一组平台扩展字段：provider_source、user_image_api_kind、user_api_base_url、user_images_generations_url、user_images_edits_url、user_api_key、preferred_auth_mode、routing_mode。',
      '单次请求最多 6 张输入图，单张输入图最大 12MB；超过限制会直接返回 400。',
    ],
    downstreamRules: [
      'prompt 为必填字段；当前公开 Images 契约下，文生图和图生图都要求传入非空 prompt。',
      'response_format 支持 url 与 b64_json；显式传入时严格返回对应格式，未传时默认返回可访问的 url。',
      '同步 JSON 成功时，网关返回统一 Images 响应；同步失败时，返回统一平台错误，不直接透传上游原始报错文本。',
      'stream=true 只在同步模式生效；网关会在拿到完整图片结果后，再输出标准 SSE，而不是逐 token 或逐块实时透传上游私有流。',
      '若同时传入 async=true 与 stream=true，以 async=true 为准，首次响应固定返回任务回执而不是 SSE。',
      'async=true 时，首次响应返回 202 与 task_id / status / query_path / queue_position / queue_expires_at；最终图像结果需通过任务查询接口获取。',
      '异步任务的最终 completed / failed 是任务执行状态，不等同于后台业务统计页里的“生成成功率”口径说明。',
      '异步任务查询接口支持：GET /v1/images/generations/:taskId、GET /v1/images/edits/:taskId、GET /v1/image/tasks/:taskId。',
      'callback_url 当前只作为兼容字段透传给上游；网关自身不会因为传了 callback_url 就主动回调下游。',
      '当 provider_source=user_supplied 时，网关会改用下游请求里提供的上游地址与密钥，不再走平台租户鉴权；该能力是否允许由后台 routing.allowUserSuppliedKey 控制。',
      'provider_source=user_supplied 时，可通过 user_image_api_kind、user_api_base_url、user_images_generations_url、user_images_edits_url、user_api_key、preferred_auth_mode 指定真实上游；其中 user_image_api_kind 只接受 images_endpoint 或 responses_endpoint。',
      'routing_mode 是平台扩展字段。代码层面接受 legacy 和 smart 两套枚举，但真正生效时会归并到 smart_failover、smart_priority、fixed_provider 这一套运行模式；其中 user_supplied 请求不会保留 fixed_provider，而会降为 smart_failover。',
      '当请求通过 tenant_key 鉴权进入平台共享线路时，最终路由模式优先取该 API Key 自身配置，而不是完全跟随请求体里的 routing_mode。',
      'metadata、image_quality、image_tool_quality 目前不属于 Images 下游公开契约，不应作为正式接入字段使用。',
    ],
    fields: [
      { key: 'images-model', field: 'model', role: '正式支持', source: '下游 JSON / multipart', notes: '必填。直接参与上游请求构造。' },
      { key: 'images-prompt', field: 'prompt', role: '正式支持', source: '下游 JSON / multipart', notes: '必填。当前 Images 公开契约要求非空字符串。' },
      { key: 'images-size', field: 'size', role: '正式支持', source: '下游 JSON / multipart', notes: '可选。支持具体像素尺寸，例如 1024x1024；也兼容比例写法，例如 1:1、16:9。' },
      { key: 'images-resolution', field: 'resolution', role: '兼容字段', source: '下游 JSON / multipart', notes: '可选，仅在 size 是比例写法时参与映射。支持 1k / 2k / 4k；若 size 已经是具体像素尺寸，则 resolution 不再改变上游请求尺寸。' },
      { key: 'images-response-format', field: 'response_format', role: '正式支持', source: '下游 JSON / multipart', notes: '可选，仅支持 url / b64_json。显式传入时严格返回对应格式；未传时同一 data 项同时返回 url 与 b64_json。' },
      { key: 'images-quality', field: 'quality', role: '正式支持', source: '下游 JSON / multipart', notes: '可选。用于请求画质；仍会受 API Key 画质上限约束。' },
      { key: 'images-n', field: 'n', role: '正式支持', source: '下游 JSON / multipart', notes: '可选，最大 10。表示请求图片数量。' },
      { key: 'images-user', field: 'user', role: '正式支持', source: '下游 JSON / multipart', notes: '可选。作为标准兼容字段透传给上游。' },
      { key: 'images-image', field: 'image', role: '正式支持', source: '下游 JSON / multipart', notes: '图生图参考图主字段。支持公网 URL、data URL、Base64；也支持数组形式，最多 6 张。' },
      { key: 'images-image-aliases', field: 'image_url / image_urls[] / reference_images[] / images[].image_url', role: '兼容别名', source: '下游 JSON / multipart', notes: '会先统一归一化为 image，再进入统一路由和上游改写逻辑。reference_images 是面向下游兼容的 URL 数组别名，不要求上游也使用同名字段。' },
      { key: 'images-stream', field: 'stream', role: '正式支持', source: '下游 JSON / multipart', notes: '可选布尔值。仅同步模式生效，返回网关标准化 SSE。' },
      { key: 'images-async', field: 'async', role: '正式支持', source: '下游 JSON / multipart', notes: '可选布尔值。开启后返回异步任务回执，后续通过任务查询拿结果。' },
      { key: 'images-output-format', field: 'output_format', role: '正式支持', source: '下游顶层字段或 extra_body', notes: '可选。用于期望输出格式，例如 png / jpeg / webp。' },
      { key: 'images-output-quality', field: 'output_quality', role: '正式支持', source: '下游顶层字段或 extra_body', notes: '可选。作为兼容字段透传给上游。' },
      { key: 'images-output-compression', field: 'output_compression', role: '正式支持', source: '下游顶层字段或 extra_body', notes: '可选。作为兼容字段透传给上游。' },
      { key: 'images-background', field: 'background', role: '正式支持', source: '下游顶层字段或 extra_body', notes: '可选。作为兼容字段透传给上游，并会体现在标准化结果中。' },
      { key: 'images-moderation', field: 'moderation', role: '正式支持', source: '下游顶层字段或 extra_body', notes: '可选。作为兼容字段透传给上游。' },
      { key: 'images-callback-url', field: 'callback_url', role: '兼容透传', source: '下游顶层字段或 extra_body', notes: '可选。当前仅透传给上游，不代表网关会主动回调下游。' },
      { key: 'images-extra-body', field: 'extra_body', role: '兼容容器', source: '下游 JSON', notes: '可承载 stream、output_format、output_quality、output_compression、background、moderation、callback_url 等兼容字段。' },
      { key: 'images-provider-source', field: 'provider_source', role: '平台扩展字段', source: '下游 JSON / multipart', notes: '可选。admin_managed 走平台上游；user_supplied 走下游自带上游地址与密钥。' },
      { key: 'images-user-api-kind', field: 'user_image_api_kind', role: '平台扩展字段', source: '下游 JSON / multipart', notes: '仅在 provider_source=user_supplied 时生效。可选值：images_endpoint、responses_endpoint。' },
      { key: 'images-user-api-base', field: 'user_api_base_url', role: '平台扩展字段', source: '下游 JSON / multipart', notes: '仅在 provider_source=user_supplied 时生效。用于指定用户自带上游基础地址。' },
      { key: 'images-user-generations-url', field: 'user_images_generations_url', role: '平台扩展字段', source: '下游 JSON / multipart', notes: '仅在 provider_source=user_supplied 时生效。可覆盖文生图完整地址。' },
      { key: 'images-user-edits-url', field: 'user_images_edits_url', role: '平台扩展字段', source: '下游 JSON / multipart', notes: '仅在 provider_source=user_supplied 时生效。可覆盖图生图完整地址。' },
      { key: 'images-user-api-key', field: 'user_api_key', role: '平台扩展字段', source: '下游 JSON / multipart', notes: '仅在 provider_source=user_supplied 时生效。用于用户自带上游密钥。' },
      { key: 'images-user-auth-mode', field: 'preferred_auth_mode', role: '平台扩展字段', source: '下游 JSON / multipart', notes: '仅在 provider_source=user_supplied 时生效。可选 bearer 或 x-api-key。' },
      { key: 'images-routing-mode', field: 'routing_mode', role: '平台扩展字段', source: '下游 JSON / multipart', notes: '可选。schema 接受 health_weighted_best、priority_failover、round_robin_failover、weighted_round_robin、least_recently_used、smart_priority、smart_failover、fixed_provider；运行时会归并为实际路由模式。' },
      { key: 'images-metadata', field: 'metadata', role: '当前不作为公开契约', source: '下游 JSON', notes: '网关内部会使用 metadata 存放协议提示等内部信息，不建议下游把它当作正式可用字段。' },
      { key: 'images-image-quality', field: 'image_quality / image_tool_quality', role: '当前不作为公开契约', source: '下游 JSON', notes: '这两个字段更偏 Responses 能力语义，当前 Images 下游公开协议不承诺支持。' },
      { key: 'images-mask', field: 'mask', role: '当前不作为公开契约', source: '下游 JSON / multipart', notes: '虽然内部兼容链路可解析，但当前项目不把 mask 作为正式下游文档承诺字段。' },
    ],
    mappings: [
      { key: 'images-map-model', downstream: 'model', internal: 'payload.model', upstream: 'model', notes: '固定映射。' },
      { key: 'images-map-prompt', downstream: 'prompt', internal: 'payload.prompt', upstream: 'prompt', notes: '固定映射。' },
      { key: 'images-map-size', downstream: 'size + resolution', internal: 'normalizeCompatibleOpenAIImagesBody + payload.size', upstream: 'size', notes: '若 size=比例 且 resolution=1k/2k/4k，会先转换成具体像素尺寸；若 size 已是 1024x1024 这类像素尺寸，则按 size 原值提交。' },
      { key: 'images-map-quality', downstream: 'quality', internal: 'payload.quality', upstream: 'quality', notes: '固定映射，并受租户/API Key 画质上限约束。' },
      { key: 'images-map-response-format', downstream: 'response_format', internal: 'payload.response_format + normalizeStandardImageResponseBody', upstream: 'response_format', notes: '即使上游原始返回不是下游想要的形态，网关也会标准化成 url 或 b64_json。' },
      { key: 'images-map-image', downstream: 'image / image_url / image_urls[] / reference_images[] / images[].image_url', internal: 'normalizeCompatibleOpenAIImagesBody + buildOpenAIImagesUpstreamRequest', upstream: 'multipart image(file part) 或 JSON images[].image_url', notes: '下游兼容别名会先统一为 image，再按命中的上游协议形态改写。multipart edits 与 JSON image_url edits 仍是两种不同协议，只作为路由筛选条件，不做无条件等价互转。' },
      { key: 'images-map-stream', downstream: 'stream', internal: 'normalizeOpenAIImagesPayload + wantsStreamingResponse + streamImageResultAsSse', upstream: 'stream=true 或 Accept:text/event-stream', notes: '支持下游直接传顶层 stream；网关会归一化后决定是否输出标准 SSE。' },
      { key: 'images-map-async', downstream: 'async', internal: 'createImageGatewayTask + queue dispatcher + task query endpoints', upstream: '网关内部任务层', notes: 'async 是网关自己的异步托管协议，不依赖上游必须原生支持 async。' },
      { key: 'images-map-extra-body', downstream: 'output_format / output_quality / output_compression / background / moderation / callback_url', internal: 'normalizeOpenAIImagesPayload', upstream: '同名字段', notes: '这些字段既可顶层传，也可放入 extra_body；进入网关后会统一归并。' },
      { key: 'images-map-user-supplied', downstream: 'provider_source + user_* + preferred_auth_mode', internal: 'resolveRequestAccessContext + resolveImageProviderPlan', upstream: '用户自带上游 provider 配置', notes: '当 provider_source=user_supplied 时，网关会根据下游提供的地址、协议类型和密钥动态生成用户自带上游。' },
      { key: 'images-map-routing-mode', downstream: 'routing_mode', internal: 'mapLegacyRoutingModeToSmartMode + resolveEffectiveImageRoutingMode', upstream: '网关内部路由策略', notes: '该字段不会原样透传给上游，而是在网关内部转换为实际路由模式。' },
    ],
    warnings: [
      '这页说明的是下游正式公开字段，不是“schema 里出现了就等于稳定支持”。',
      'async=true 与 stream=true 不是同一语义；两者同时传时，以 async=true 为准，首次响应不会返回 SSE。',
      '异步任务查询结果不是同步结果直接平铺到顶层；最终图片结果在任务对象的 result.body 中。',
      '后台总览 / 业务通道里的生成成功率，是业务统计口径；请求追踪和路由诊断里的失败，则分别属于调试日志口径和线路运行态口径。',
      'metadata、image_quality、image_tool_quality、mask 当前都不应被下游当作正式稳定契约依赖。',
    ],
    upstreamExamples: [
      {
        key: 'images-upstream-generate',
        title: '上游文生图：标准 Images generations',
        requestLabel: '网关发给上游的真实请求',
        requestBody: `POST /v1/images/generations
Content-Type: application/json

{
  "model": "gpt-image-2",
  "prompt": "一只小猫，干净背景，自然光，不要文字",
  "size": "1600x1200",
  "quality": "medium",
  "response_format": "b64_json",
  "output_format": "png",
  "n": 1
}`,
        responseLabel: '上游常见响应形态',
        responseBody: `{
  "created": 1782870000,
  "data": [
    { "b64_json": "<省略的内容>" }
  ]
}`,
      },
      {
        key: 'images-upstream-edit-multipart',
        title: '上游图生图：multipart/form-data + image 文件上传',
        requestLabel: '网关发给上游的真实请求',
        requestBody: `POST /v1/images/edits
Content-Type: multipart/form-data

model=gpt-image-2
prompt=保持主体不变，把背景改成未来城市夜景
image=@reference.png
size=1600x1200
response_format=b64_json
output_format=png`,
        responseLabel: '上游常见响应形态',
        responseBody: `{
  "created": 1782870000,
  "data": [
    { "url": "https://upstream.example.com/result/abc.png" }
  ]
}`,
      },
      {
        key: 'images-upstream-edit-json-url',
        title: '上游图生图：application/json + images[].image_url(URL)',
        requestLabel: '网关发给上游的真实请求',
        requestBody: `POST /v1/images/edits
Content-Type: application/json

{
  "model": "gpt-image-2",
  "prompt": "把背景改成干净的白色摄影棚",
  "images": [
    {
      "image_url": "https://api.example.com/test-assets/reference-test.png"
    }
  ],
  "size": "1024x1024",
  "output_format": "png",
  "response_format": "b64_json"
}`,
        responseLabel: '上游常见响应形态',
        responseBody: `{
  "created": 1783680244,
  "data": [
    { "b64_json": "<省略的内容>" }
  ]
}`,
      },
      {
        key: 'images-upstream-edit-json-data-url',
        title: '上游图生图：application/json + images[].image_url(data URL / Base64)',
        requestLabel: '网关发给上游的真实请求',
        requestBody: `POST /v1/images/edits
Content-Type: application/json

{
  "model": "gpt-image-2",
  "prompt": "把背景改成干净的白色摄影棚",
  "images": [
    {
      "image_url": "data:image/png;base64,<省略的内容>"
    }
  ],
  "size": "1024x1024",
  "output_format": "png",
  "response_format": "b64_json"
}`,
        responseLabel: '上游常见响应形态',
        responseBody: `{
  "created": 1783680251,
  "data": [
    { "b64_json": "<省略的内容>" }
  ]
}`,
      },
    ],
    downstreamExamples: [
      {
        key: 'images-downstream-generate',
        title: '下游文生图：标准同步 JSON 请求',
        requestLabel: '下游请求网关',
        requestBody: `POST /v1/images/generations
Content-Type: application/json

{
  "model": "gpt-image-2",
  "prompt": "一只小猫，干净背景，自然光，不要文字",
  "size": "1600x1200",
  "response_format": "b64_json"
}`,
        responseLabel: '网关返回给下游',
        responseBody: `{
  "created": 1782870000,
  "data": [
    { "b64_json": "<省略的内容>" }
  ]
}`,
      },
      {
        key: 'images-downstream-edit-json',
        title: '下游图生图：JSON 兼容别名请求',
        requestLabel: '下游请求网关',
        requestBody: `POST /v1/images/edits
Content-Type: application/json

{
  "model": "gpt-image-2",
  "prompt": "保持主体不变，把背景改成未来城市夜景",
  "images": [
    { "image_url": "https://api.example.com/test-assets/reference-test.png" }
  ],
  "response_format": "url"
}`,
        responseLabel: '网关返回给下游',
        responseBody: `{
  "created": 1782870000,
  "data": [
    { "url": "https://api.example.com/v1/generated-images/imgsync_xxx_0.png" }
  ]
}`,
      },
      {
        key: 'images-downstream-edit-multipart',
        title: '下游图生图：multipart/form-data 请求',
        requestLabel: '下游请求网关',
        requestBody: `POST /v1/images/edits
Content-Type: multipart/form-data

model=gpt-image-2
prompt=保持主体不变，把背景改成未来城市夜景
image=@reference.png
response_format=b64_json
output_format=webp`,
        responseLabel: '网关返回给下游',
        responseBody: `{
  "created": 1782870000,
  "data": [
    { "b64_json": "<省略的内容>" }
  ]
}`,
      },
      {
        key: 'images-downstream-stream',
        title: '下游同步 SSE：stream=true',
        requestLabel: '下游请求网关',
        requestBody: `POST /v1/images/generations
Content-Type: application/json
Accept: text/event-stream

{
  "model": "gpt-image-2",
  "prompt": "一只小猫，干净背景，自然光，不要文字",
  "stream": true,
  "response_format": "url"
}`,
        responseLabel: '网关返回给下游',
        responseBody: `data: {
  "object": "image.generation.result",
  "type": "image_generation.completed",
  "created": 1782870000,
  "data": [
    { "url": "https://api.example.com/v1/generated-images/imgsync_xxx_0.png" }
  ]
}

data: [DONE]`,
      },
      {
        key: 'images-downstream-async-submit',
        title: '下游异步提交：async=true',
        requestLabel: '下游请求网关',
        requestBody: `POST /v1/images/generations
Content-Type: application/json

{
  "model": "gpt-image-2",
  "prompt": "一只小猫，干净背景，自然光，不要文字",
  "async": true,
  "response_format": "url"
}`,
        responseLabel: '网关返回给下游',
        responseBody: `{
  "task_id": "imgtask_xxx",
  "status": "queued",
  "query_path": "/v1/images/generations/imgtask_xxx",
  "queue_position": 1,
  "queue_expires_at": 1782873600
}`,
      },
      {
        key: 'images-downstream-async-query',
        title: '下游异步查询：最终结果在 result.body',
        requestLabel: '下游查询网关',
        requestBody: `GET /v1/images/generations/imgtask_xxx
GET /v1/images/edits/imgtask_xxx
GET /v1/image/tasks/imgtask_xxx`,
        responseLabel: '网关返回给下游',
        responseBody: `{
  "task_id": "imgtask_xxx",
  "operation": "generations",
  "status": "completed",
  "created_at": 1782870000,
  "updated_at": 1782870030,
  "result": {
    "statusCode": 200,
    "body": {
      "created": 1782870030,
      "data": [
        { "url": "https://api.example.com/v1/generated-images/imgsync_xxx_0.png" }
      ]
    },
    "requestMeta": {
      "operation": "generations",
      "responseFormat": "url"
    }
  }
}`,
      },
    ],
  },
  chat: {
    title: 'Chat Completions 说明',
    summary: 'Chat Completions 只用于文本处理或视觉理解，不属于图像生成协议，不进入统一 Images 生图链路。',
    upstreamEndpoint: 'POST /v1/chat/completions',
    downstreamEndpoint: '仅文本 / 视觉理解业务，不对外伪装成 Images',
    businessRole: '用于理解图片、提取描述或执行普通文本能力。',
    onboardingDefaults: [
      '默认模型为 gpt-4.1-mini。',
      '视觉输入默认使用固定测试图片 URL。',
      '探测关注的是文本与视觉理解能力，不关注图像生成输出。',
    ],
    fixedRules: [
      'Chat 类型不会映射成 /v1/images/generations 或 /v1/images/edits。',
      '即使携带图片，也只是视觉理解，不是图像编辑。',
    ],
    requestDefaults: [
      '测试预设会带 messages、stream、referenceImageUrl 等字段。',
      '视觉图片会进入 messages[].content[].image_url。',
    ],
    downstreamRules: [
      'Chat 类型不承诺标准 Images 协议。',
      '如未来扩展视觉理解，也必须保持为文本类接口。',
    ],
    fields: [
      { key: 'chat-model', field: 'model', role: '正式支持', source: '下游 JSON', notes: '直接写入 chat completions 请求。' },
      { key: 'chat-messages', field: 'messages', role: '正式支持', source: '下游 JSON', notes: '标准 Chat 输入结构。' },
      { key: 'chat-stream', field: 'stream', role: '正式支持', source: '下游 JSON', notes: '标准 Chat 流式字段。' },
      { key: 'chat-vision', field: 'messages[].content[].image_url', role: '正式支持', source: '下游 JSON', notes: '用于视觉理解，不表示图像生成或编辑。' },
    ],
    mappings: [
      { key: 'chat-map-prompt', downstream: 'messages', internal: 'messages passthrough / normalized vision input', upstream: 'messages', notes: '标准 Chat 请求结构。' },
      { key: 'chat-map-stream', downstream: 'stream', internal: 'request.stream', upstream: 'stream', notes: '标准 Chat 流式字段。' },
      { key: 'chat-map-image', downstream: 'messages[].content[].image_url', internal: 'vision payload', upstream: 'messages[].content[].image_url', notes: '仅用于视觉理解。' },
    ],
    warnings: [
      'Chat Completions 不是图像生成协议，不能放进图像业务通道进行生图路由。',
      '视觉输入只用于“看图理解”，不能等同于图生图。',
    ],
    upstreamExamples: [
      {
        key: 'chat-upstream-vision',
        title: '上游视觉理解：Chat Completions',
        requestLabel: '网关发给上游的真实请求',
        requestBody: `POST /v1/chat/completions
Content-Type: application/json

{
  "model": "gpt-4.1-mini",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "请描述这张图里的主体、背景与风格" },
        { "type": "image_url", "image_url": { "url": "https://api.example.com/test-assets/reference-test.png" } }
      ]
    }
  ],
  "stream": false
}`,
        responseLabel: '上游常见响应形态',
        responseBody: `{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "图片主体是一只白猫，背景简洁，整体为写实摄影风格。"
      }
    }
  ]
}`,
      },
    ],
    downstreamExamples: [
      {
        key: 'chat-downstream-text',
        title: '下游文本 / 视觉理解请求',
        requestLabel: '下游请求网关',
        requestBody: `POST /v1/chat/completions
Content-Type: application/json

{
  "model": "gpt-4.1-mini",
  "messages": [
    {
      "role": "user",
      "content": "请描述这张图片里的主体、背景与风格"
    }
  ]
}`,
        responseLabel: '网关返回给下游',
        responseBody: `{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "..."
      }
    }
  ]
}`,
      },
    ],
  },
};

function renderBulletList(items: string[]) {
  return (
    <div className="page-stack" style={{ gap: 8 }}>
      {items.map((item, index) => (
        <Paragraph key={`${index}-${item}`} style={{ marginBottom: 0 }}>
          {item}
        </Paragraph>
      ))}
    </div>
  );
}

function renderExampleBlock(example: ExampleBlock) {
  return (
    <Card key={example.key} size="small" title={example.title}>
      <Paragraph type="secondary" style={{ marginBottom: 8 }}>
        {example.requestLabel}
      </Paragraph>
      <pre className="json-block">{example.requestBody}</pre>
      <Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 8 }}>
        {example.responseLabel}
      </Paragraph>
      <pre className="json-block">{example.responseBody}</pre>
    </Card>
  );
}

export function ProtocolDocsPage({ kind }: ProtocolDocsPageProps) {
  const config = docsMap[kind];

  return (
    <div className="page-stack protocol-docs-page">
      <PageHeader title={config.title} desc={config.summary} />

      <Alert
        type="info"
        showIcon
        message="本文档以当前业务代码的真实实现为准"
        description="这里不是通用协议百科，而是当前后台、接入向导、上游接入配置、测试构造以及下游对外契约的真实说明。修改协议逻辑时，应先同步这里，再同步业务代码和后台表单。"
      />

      <Alert
        type="info"
        showIcon
        message="术语边界说明"
        description="本文档里的“成功 / 失败 / SSE / 异步”都只描述当前接口契约本身。后台“总览 / 业务通道”展示的是业务统计口径；“请求追踪”展示的是调试日志口径；“路由诊断”展示的是线路运行态口径。三者不要混看。"
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={8}>
          <Card title="业务定位">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="上游接口">{config.upstreamEndpoint}</Descriptions.Item>
              <Descriptions.Item label="下游接口">{config.downstreamEndpoint}</Descriptions.Item>
              <Descriptions.Item label="角色定位">{config.businessRole}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} xl={16}>
          <Card title="实现边界 / 风险提醒">
            {renderBulletList(config.warnings)}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card title="接入向导默认行为">
            {renderBulletList(config.onboardingDefaults)}
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="固定适配规则 / 能力标记">
            {renderBulletList(config.fixedRules)}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card title="测试预设 / 请求级默认值">
            {renderBulletList(config.requestDefaults)}
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="下游对外规则">
            {renderBulletList(config.downstreamRules)}
          </Card>
        </Col>
      </Row>

      <Card title="关键字段与能力边界" className="diagnostic-card">
        <Table
          rowKey="key"
          size="small"
          pagination={false}
          scroll={{ x: 980 }}
          dataSource={config.fields}
          columns={fieldColumns}
        />
      </Card>

      <Card title="字段映射速查" className="diagnostic-card">
        <Table
          rowKey="key"
          size="small"
          pagination={false}
          scroll={{ x: 1180 }}
          dataSource={config.mappings}
          columns={mappingColumns}
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <div className="page-stack">
            <Card title="上游真实样例">
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                这里展示的是网关真实会发给上游的请求结构，以及上游常见响应形态。
              </Paragraph>
            </Card>
            {config.upstreamExamples.map(renderExampleBlock)}
          </div>
        </Col>
        <Col xs={24} xl={12}>
          <div className="page-stack">
            <Card title="下游统一样例">
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                这里展示的是下游调用网关时看到的统一契约，避免把上游私有差异泄露给接入方。
              </Paragraph>
            </Card>
            {config.downstreamExamples.map(renderExampleBlock)}
          </div>
        </Col>
      </Row>

      <Card title="维护原则">
        <Paragraph style={{ marginBottom: 8 }}>
          <Text strong>原则 1：</Text>
          先区分协议种类，再设计上下游映射，不要把 Responses、Images、Chat 的配置混在一起。
        </Paragraph>
        <Paragraph style={{ marginBottom: 8 }}>
          <Text strong>原则 2：</Text>
          只把真正属于下游标准契约的字段暴露给下游；上游私有差异应留在后台上游接入配置层。
        </Paragraph>
        <Paragraph style={{ marginBottom: 0 }}>
          <Text strong>原则 3：</Text>
          修改协议逻辑时，先同步这份文档，再同步后台表单、探测逻辑和运行时代码，避免文档与实现脱节。
        </Paragraph>
      </Card>
    </div>
  );
}
