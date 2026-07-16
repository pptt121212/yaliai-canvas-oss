import type { CanvasNode } from './canvasWorkflowSchema.js';

export type CanvasPromptItem = {
  index: number;
  name: string;
  title?: string;
  image_category: string;
  mapped_type_key?: string;
  source_locator?: string;
  visible_headline?: string;
  visible_copy_points?: string[];
  goal?: string;
  reference_usage?: string;
  script_text?: string;
  shot_script?: string;
  prompt: string;
  raw?: Record<string, unknown>;
  batch_item?: Record<string, unknown> | null;
};

type EcommerceOption = {
  key: string;
  label: string;
  description: string;
};

type EcommerceTypeItem = {
  key: string;
  enabled: boolean;
  count: number;
  label?: string;
  description?: string;
  custom?: boolean;
};

const INTERNAL_LABEL_TERMS = [
  '首屏主视觉',
  '商品介绍',
  '核心卖点图',
  '核心卖点',
  '材质/细节图',
  '材质细节模块',
  '使用步骤图',
  '场景/人群图',
  '场景模块',
  '对比/证明图',
  '对比证明模块',
  '规格参数图',
  '包装清单图',
  'FAQ/信任图',
  'FAQ信任模块',
  'AI补充图',
];

const CAPABILITY_OPTIONS = [
  { key: 'listing_product_set', label: 'Listing 商品套图', shortLabel: 'Listing套图', description: '商品上架页图集，展示商品、卖点、细节和场景。', smartMin: 6, smartDefault: 6 },
  { key: 'detail_page', label: '商品详情页', shortLabel: '详情页', description: '详情页素材，用于展示商品、卖点、使用、规格和信任信息。', smartMin: 6, smartDefault: 7 },
  { key: 'ad_creative', label: '电商广告图', shortLabel: '广告图', description: '投放和促销素材，突出人群、利益点和转化目标。', smartMin: 3, smartDefault: 4 },
  { key: 'social_seed_content', label: '社媒种草图', shortLabel: '种草图', description: '社媒分享素材，突出真实体验和生活方式。', smartMin: 3, smartDefault: 4 },
  { key: 'brand_assets', label: '品牌资产图', shortLabel: '品牌资产', description: '店铺、品牌页和活动页素材，统一品牌视觉。', smartMin: 3, smartDefault: 4 },
  { key: 'short_video_assets', label: '短视频素材', shortLabel: '短视频素材', description: '短视频封面、脚本卡和分镜关键帧素材。', smartMin: 4, smartDefault: 5 },
] as const;

const TYPE_OPTIONS_BY_CAPABILITY: Record<string, EcommerceOption[]> = {
  listing_product_set: [
    { key: 'main', label: '主图', description: '商品主视觉，突出完整外观和第一眼吸引力' },
    { key: 'white_background', label: '白底图', description: '白底/合规主图，多角度呈现商品细节' },
    { key: 'scene', label: '场景图', description: '展示商品的生活使用场景和氛围搭配' },
    { key: 'selling_point', label: '卖点图', description: '展示商品的核心卖点及细节特写' },
    { key: 'detail', label: '细节图', description: '局部特写，呈现材质、结构、工艺或接口' },
    { key: 'function', label: '功能图', description: '展示功能、使用方式或工作状态' },
    { key: 'structure', label: '结构图', description: '展示部件关系、可调节结构或拆解视角' },
    { key: 'dimension', label: '尺寸/比例图', description: '展示尺寸比例、握持比例或部件尺度关系' },
    { key: 'comparison', label: '对比图', description: '展示前后对比、使用效果差异或竞品式视觉对照' },
    { key: 'variant', label: '变体/款式图', description: '展示颜色、款式、状态或同系列变体' },
    { key: 'package', label: '包装/配件图', description: '展示包装内容、配件清单或开箱组成' },
    { key: 'other_ai', label: 'AI补充图', description: '根据商品特征补充更适合的图片方向' },
  ],
  detail_page: [
    { key: 'hero', label: '首屏主视觉', description: '详情页开头的商品价值主视觉，建立第一印象' },
    { key: 'product_intro', label: '商品介绍', description: '说明商品是什么、核心用途和适用对象' },
    { key: 'benefit', label: '核心卖点图', description: '逐条解释商品优势和购买理由' },
    { key: 'detail_material', label: '材质/细节图', description: '展示材质、成分、工艺、结构或局部细节' },
    { key: 'usage_steps', label: '使用步骤图', description: '展示安装、操作、使用流程或护理步骤' },
    { key: 'scenario', label: '场景/人群图', description: '展示适合场景、目标人群或搭配方式' },
    { key: 'comparison', label: '对比/证明图', description: '展示前后、方案或价值证明' },
    { key: 'specs', label: '规格参数图', description: '展示尺寸、容量、规格或参数留白区' },
    { key: 'package', label: '包装清单图', description: '展示包装内容、配件清单或开箱信息' },
    { key: 'faq_trust', label: 'FAQ/信任图', description: '展示常见问题、注意事项、售后或保障信息' },
    { key: 'other_ai', label: 'AI补充图', description: '根据商品品类补充更适合的详情方向' },
  ],
  ad_creative: [
    { key: 'hook', label: '强吸引广告图', description: '用醒目的标题、问题或场景吸引点击' },
    { key: 'offer', label: '促销利益图', description: '突出优惠、礼包、限时活动或购买理由' },
    { key: 'problem_solution', label: '痛点解决图', description: '展示用户问题和商品解决方案' },
    { key: 'comparison', label: '对比广告图', description: '展示前后、普通方案和商品方案的差异' },
    { key: 'ugc_ad', label: 'UGC广告图', description: '模拟真实用户推荐、测评或使用反馈风格' },
    { key: 'seasonal', label: '活动节日图', description: '适配节日、活动档期或平台促销氛围' },
    { key: 'other_ai', label: 'AI补充图', description: '根据商品、受众和投放平台补充广告方向' },
  ],
  social_seed_content: [
    { key: 'lifestyle', label: '生活方式图', description: '把商品融入真实生活场景，降低广告感' },
    { key: 'unboxing', label: '开箱分享图', description: '展示包装、开箱、摆拍和第一印象' },
    { key: 'experience', label: '使用体验图', description: '以用户视角展示使用过程、感受或变化' },
    { key: 'cover', label: '笔记封面图', description: '适合小红书/Instagram/Pinterest 的内容封面' },
    { key: 'routine', label: '场景流程图', description: '展示日常使用、搭配流程或应用步骤' },
    { key: 'other_ai', label: 'AI补充图', description: '根据商品和平台内容语言补充种草角度' },
  ],
  brand_assets: [
    { key: 'brand_banner', label: '品牌Banner', description: '店铺、品牌页或活动页顶部横幅视觉' },
    { key: 'brand_story', label: '品牌故事图', description: '表达品牌理念、来源、价值观或长期承诺' },
    { key: 'product_family', label: '产品系列图', description: '展示系列产品、组合关系或品牌产品矩阵' },
    { key: 'a_plus', label: 'A+品牌模块', description: '适合 Amazon A+ 或独立站品牌模块' },
    { key: 'campaign_key_visual', label: '活动主视觉', description: '品牌活动、上新、促销或主题营销主视觉' },
    { key: 'other_ai', label: 'AI补充图', description: '根据品牌风格和商品特征补充图片方向' },
  ],
  short_video_assets: [
    { key: 'video_script', label: '视频脚本卡', description: '输出短视频脚本画面，包含镜头、旁白和节奏提示' },
    { key: 'cover', label: '短视频封面', description: '适合短视频平台点击的商品视频封面图' },
    { key: 'storyboard', label: '分镜关键帧', description: '展示开头、展示、使用、转化等关键镜头' },
    { key: 'demo_frame', label: '使用演示帧', description: '展示商品操作、使用过程或效果场景' },
    { key: 'ending_cta', label: '结尾转化帧', description: '展示购买引导、优惠提醒或品牌收尾画面' },
    { key: 'other_ai', label: 'AI补充图', description: '根据商品和视频目标补充分镜素材' },
  ],
};

const DEFAULT_SET_TYPES_BY_CAPABILITY: Record<string, EcommerceTypeItem[]> = {
  listing_product_set: [
    { key: 'white_background', enabled: true, count: 1 },
    { key: 'scene', enabled: true, count: 2 },
    { key: 'selling_point', enabled: true, count: 2 },
    { key: 'detail', enabled: true, count: 1 },
    { key: 'other_ai', enabled: true, count: 1 },
  ],
  detail_page: [
    { key: 'hero', enabled: true, count: 1 },
    { key: 'product_intro', enabled: true, count: 1 },
    { key: 'benefit', enabled: true, count: 2 },
    { key: 'detail_material', enabled: true, count: 1 },
    { key: 'usage_steps', enabled: true, count: 1 },
    { key: 'specs', enabled: true, count: 1 },
    { key: 'faq_trust', enabled: true, count: 1 },
  ],
  ad_creative: [
    { key: 'hook', enabled: true, count: 1 },
    { key: 'offer', enabled: true, count: 1 },
    { key: 'problem_solution', enabled: true, count: 1 },
    { key: 'comparison', enabled: true, count: 1 },
    { key: 'ugc_ad', enabled: true, count: 1 },
  ],
  social_seed_content: [
    { key: 'cover', enabled: true, count: 1 },
    { key: 'lifestyle', enabled: true, count: 1 },
    { key: 'experience', enabled: true, count: 1 },
    { key: 'routine', enabled: true, count: 1 },
    { key: 'other_ai', enabled: true, count: 1 },
  ],
  brand_assets: [
    { key: 'brand_banner', enabled: true, count: 1 },
    { key: 'campaign_key_visual', enabled: true, count: 1 },
    { key: 'brand_story', enabled: true, count: 1 },
    { key: 'a_plus', enabled: true, count: 1 },
  ],
  short_video_assets: [
    { key: 'video_script', enabled: true, count: 1 },
    { key: 'cover', enabled: true, count: 1 },
    { key: 'storyboard', enabled: true, count: 2 },
    { key: 'demo_frame', enabled: true, count: 1 },
    { key: 'ending_cta', enabled: true, count: 1 },
  ],
};

const PROMPT_CONFIG_BY_KEY = {
  listing_product_set: {
    businessGoal: '生成一组可直接上架使用的商品图。',
    overviewRole: 'Listing 商品套图总览图提示词设计师',
    setRole: 'Listing 商品套图提示词策划师',
    overviewName: 'Listing 商品套图总览图',
    overviewDefinition: '这是一张图片，不是一组图片。\n这张图片内部要集中展示该电商图片任务的主要画面方向。',
    setDefinition: '每个提示词只生成一张独立 Listing 商品图。\n整组图要保持商品身份和视觉风格统一。',
    directionExamples: '主图、白底图、场景图、卖点图、细节图、功能图、结构图、尺寸/比例图、对比图、变体图、包装/配件图，以及根据商品本身判断出的其他合适方向',
    categoryExamples: '主图 / 白底图 / 场景图 / 卖点图 / 细节图 / 功能图 / 对比图 / 包装图',
    genericTypeSummary: '主图、白底图、场景图、卖点图、细节图、功能图、结构图、尺寸/比例图、对比图、包装图',
    finalItemStrategy: '最后一个提示词应选择一个最能检验整组 Listing 商品套图效果的成品图方向，优先是业务目标最强、商品匹配度最高、能体现风格和卖点控制力的类型，而不是普通白底图。',
  },
  detail_page: {
    businessGoal: '生成一组适合详情页模块化表达的商品图。',
    overviewRole: '商品详情页总览图提示词设计师',
    setRole: '商品详情页提示词策划师',
    overviewName: '商品详情页总览图',
    overviewDefinition: '这是一张图片，不是一组图片。\n这张图片内部要集中展示详情页模块的整体方向、节奏和信息层级。',
    setDefinition: '每个提示词只生成一张独立详情页模块图。\n整组图要形成可连续阅读的商品说明链路。',
    directionExamples: '首屏主视觉、商品介绍、核心卖点图、材质/细节图、使用步骤图、场景/人群图、对比/证明图、规格参数图、包装清单图、FAQ/信任图，以及根据商品本身判断出的其他合适方向',
    categoryExamples: '首屏主视觉 / 商品介绍 / 核心卖点图 / 材质细节图 / 使用步骤图 / 场景图 / 规格图 / FAQ图',
    genericTypeSummary: '首屏、卖点、细节、步骤、场景、规格、FAQ',
    finalItemStrategy: '最后一个提示词优先选择最能补全详情页转化链路的模块，例如规格、FAQ、证明或包装，不要机械重复主视觉。',
  },
  ad_creative: {
    businessGoal: '生成一组适合电商投放和促销转化的广告图。',
    overviewRole: '电商广告图总览图提示词设计师',
    setRole: '电商广告图提示词策划师',
    overviewName: '电商广告图总览图',
    overviewDefinition: '这是一张图片，不是一组图片。\n这张图片内部要集中展示广告图的主要创意方向、卖点表达和点击动机。',
    setDefinition: '每个提示词只生成一张独立广告图。\n整组图要兼顾吸引点击、说明利益点和转化目标。',
    directionExamples: '强吸引广告图、促销利益图、痛点解决图、对比广告图、UGC 广告图、活动节日图，以及根据商品本身判断出的其他合适方向',
    categoryExamples: '强吸引广告图 / 利益图 / 痛点图 / 对比图 / UGC广告图 / 活动图',
    genericTypeSummary: '吸引、利益点、痛点解决、对比、UGC、活动',
    finalItemStrategy: '最后一个提示词应选择最能承担转化收口的广告图方向，例如强利益点、UGC 证明或活动收尾图。',
  },
  social_seed_content: {
    businessGoal: '生成一组适合社媒种草与真实分享风格的商品图。',
    overviewRole: '社媒种草图总览图提示词设计师',
    setRole: '社媒种草图提示词策划师',
    overviewName: '社媒种草图总览图',
    overviewDefinition: '这是一张图片，不是一组图片。\n这张图片内部要集中展示种草图的内容语言、生活方式氛围和真实体验方向。',
    setDefinition: '每个提示词只生成一张独立社媒种草图。\n整组图要降低广告感，增强真实体验和生活方式表达。',
    directionExamples: '生活方式图、开箱分享图、使用体验图、笔记封面图、场景流程图，以及根据商品本身判断出的其他合适方向',
    categoryExamples: '生活方式图 / 开箱图 / 使用体验图 / 封面图 / 场景流程图',
    genericTypeSummary: '封面、生活方式、开箱、体验、流程',
    finalItemStrategy: '最后一个提示词优先选择最有平台传播感和真实体验感的成品图方向，而不是生硬的广告版式。',
  },
  brand_assets: {
    businessGoal: '生成一组适合品牌页、店铺页和品牌活动使用的品牌资产图。',
    overviewRole: '品牌资产图总览图提示词设计师',
    setRole: '品牌资产图提示词策划师',
    overviewName: '品牌资产图总览图',
    overviewDefinition: '这是一张图片，不是一组图片。\n这张图片内部要集中展示品牌调性、商品角色和整组品牌资产的视觉统一方式。',
    setDefinition: '每个提示词只生成一张独立品牌资产图。\n整组图要保持品牌统一性，同时突出商品价值和品牌调性。',
    directionExamples: '品牌 Banner、品牌故事图、产品系列图、A+ 品牌模块、活动主视觉，以及根据商品本身判断出的其他合适方向',
    categoryExamples: '品牌Banner / 品牌故事图 / 产品系列图 / A+模块 / 活动主视觉',
    genericTypeSummary: 'Banner、品牌故事、系列图、A+ 模块、活动主视觉',
    finalItemStrategy: '最后一个提示词优先选择最能体现品牌调性和视觉控制力的收官图，不要退化成普通商品图。',
  },
  short_video_assets: {
    businessGoal: '生成一组适合短视频封面、脚本卡和分镜关键帧使用的静态素材。',
    overviewRole: '短视频素材总览图提示词设计师',
    setRole: '短视频素材提示词策划师',
    overviewName: '短视频素材总览图',
    overviewDefinition: '这是一张图片，不是一组图片。\n这张图片内部要集中展示视频脚本节奏、镜头方向和整组短视频素材的核心风格。',
    setDefinition: '每个提示词只生成一张独立短视频静态素材图。\n整组图要能被下游用于短视频脚本卡、封面和分镜关键帧。',
    directionExamples: '视频脚本卡、短视频封面、分镜关键帧、使用演示帧、结尾转化帧，以及根据商品本身判断出的其他合适方向',
    categoryExamples: '视频脚本卡 / 视频封面 / 分镜关键帧 / 使用演示帧 / 结尾转化帧',
    genericTypeSummary: '脚本卡、封面、分镜、演示帧、转化帧',
    finalItemStrategy: '最后一个提示词优先选择最能承担转化收尾或品牌收口的结尾转化帧，而不是普通商品静物图。',
  },
} as const;

export function getCanvasEcommerceSetCount(data: Record<string, any>) {
  const effectiveConfig = data?.ecommerceEffectiveConfig && typeof data.ecommerceEffectiveConfig === 'object'
    ? data.ecommerceEffectiveConfig
    : null;
  const effectiveData = effectiveConfig ? { ...data, ...effectiveConfig } : data;
  const capability = getCapabilityConfig(effectiveData);
  if (String(effectiveData?.structureMode || 'smart').trim() === 'custom') {
    const total = normalizeEcommerceSetImageTypes(effectiveData?.setImageTypes, effectiveData)
      .filter((item) => item.enabled)
      .reduce((sum, item) => sum + Math.max(1, Number(item.count || 1) || 1), 0);
    return Math.max(1, total || 1);
  }
  const count = Number(effectiveData?.setImageCount || capability.smartDefault || 6);
  if (!Number.isFinite(count)) {
    return capability.smartDefault || 6;
  }
  return Math.min(20, Math.max(Number(capability.smartMin || 1), Math.round(count)));
}

export function normalizeCanvasPromptItems(text: string, limit: number): CanvasPromptItem[] {
  const payload = extractJsonPayload(text);
  const source = Array.isArray((payload as Record<string, unknown>).prompt_items)
    ? (payload as Record<string, any>).prompt_items
    : (Array.isArray((payload as Record<string, unknown>).prompts) ? (payload as Record<string, any>).prompts : []);
  return source
    .map((item: unknown, index: number) => {
      const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, any> : {};
      const prompt = typeof item === 'string'
        ? item
        : String(record.prompt || record.final_prompt || record.description || record.text || '').trim();
      if (!prompt) {
        return null;
      }
      const imageCategory = String(record.image_category || record.category || record.type || '').trim();
      const title = String(record.title || record.name || '').trim();
      const visibleCopyPoints = normalizeCopyPoints(record.visible_copy_points || record.visibleCopyPoints);
      const visibleHeadline = String(
        record.visible_headline
        || record.visibleHeadline
        || record.visible_headline_direction
        || record.visibleHeadlineDirection
        || ''
      ).trim();
      const name = imageCategory && title && !title.includes(imageCategory)
        ? `${imageCategory}-${title}`
        : (title || imageCategory || `image_${index + 1}`);
      return {
        index: Number(record.index || index + 1),
        name,
        title,
        image_category: imageCategory,
        mapped_type_key: String(record.mapped_type_key || record.mappedTypeKey || '').trim(),
        source_locator: String(record.source_locator || record.sourceLocator || '').trim(),
        visible_headline: visibleHeadline,
        visible_copy_points: visibleCopyPoints,
        goal: String(record.goal || record.objective || '').trim(),
        reference_usage: String(record.reference_usage || record.referenceUsage || '').trim(),
        script_text: String(record.script_text || record.scriptText || record.video_script || record.videoScript || '').trim(),
        shot_script: String(record.shot_script || record.shotScript || record.storyboard_script || record.storyboardScript || '').trim(),
        prompt,
        raw: record,
      } satisfies CanvasPromptItem;
    })
    .filter(Boolean)
    .slice(0, Math.max(1, limit)) as CanvasPromptItem[];
}

export function buildCanvasImageExplosionPrompt(node: CanvasNode) {
  const data = node.data || {};
  const count = Math.max(1, Math.min(20, Number(data.elementCount || 6)));
  const custom = String(data.explosionInstruction || data.instruction || '').trim();
  const mode = getImageExplosionExtractionMode(data);
  const instruction = custom
    || (mode === 'original'
      ? '请基于前置参考图，拆解出适合单独再次生成的视觉主体、区域、版式片段、场景片段或风格片段。'
      : '请根据图片内容自行判断最有价值的拆解方式，尽量覆盖画面中的主要主体、背景、局部物体、设计元素或分镜。');
  if (mode === 'original') {
    return `你是图片大爆炸的原样提取提示词策划师。

任务目标：
根据用户提供的参考图，拆解出最多 ${count} 个可用于后续图像生成的 prompt_items。后续图像模型会同时收到原始参考图和你输出的每条 prompt。

提取模式：原样提取。
这不是纯素材抠图任务，也不是强制生成白底孤立元素。你需要根据目标对象或目标区域在原图中的真实呈现方式，保留对复现该片段有价值的原始视觉关系，包括构图、背景、光影、画面风格、海报/卡片版式、局部文字、标签、装饰、边框、场景氛围和主体之间的位置关系。

与纯素材提取的区别：
- 不要默认要求 isolate、clean cutout、white background、transparent background 或只重绘单个干净素材。
- 如果文字、广告短语、标签、包装文字或界面文字属于目标区域的重要组成部分，可以在 prompt 中要求按原图可见关系保留；不要无意义抄写整图所有文字。
- 如果目标是商品海报、卡片、详情图局部或场景片段，应保留它作为一个完整视觉片段的版式和背景，而不是只抽出其中的商品。
- 如果目标确实是一个可独立使用的干净主体，也可以输出偏素材化提示词，但不要强制所有条目都这样做。

拆解要求：
1. 先理解参考图中最值得拆解复用的视觉对象、区域、版式片段或风格片段。
2. 每条 prompt 必须能直接用于生成一张独立图片，并明确说明“参考原始图片中的对应区域/对象”。
3. 每条 prompt 要描述清楚主体、位置关系、背景/版式、光影、色彩、文字保留策略和禁止改动的关键点。
4. 不要发明与参考图无关的新商品、新人物、新品牌或新场景。
5. 用户自定义拆解指令优先；但如果自定义指令没有要求纯素材，就不要把结果改成纯素材提取。
6. 输出数量最多 ${count} 条；如果原图可拆解内容不足，可以少于 ${count} 条。

用户拆解指令：
${instruction}

只输出 JSON，不要 Markdown，不要解释。JSON 格式：
{"prompt_items":[{"name":"简短名称","source_locator":"说明来自原图哪个对象或区域","prompt":"用于后续图像生成的完整提示词，要求参考原始图片并原样保留该对象或区域的重要视觉关系"}]}`;
  }
  return `你是图片大爆炸的纯素材提取提示词策划师。

任务目标：
根据用户提供的参考图，拆解出最多 ${count} 个适合被单独定位、分离、提取并重绘的视觉素材，并为每个素材输出一条可直接用于后续图像生成的完整 prompt。后续图像模型会同时收到原始参考图和你输出的每条 prompt。

提取模式：纯素材提取。
这不是复刻整张海报、整张页面或整张广告版式的任务。你的目标是提取可复用的干净视觉素材，例如主体物、产品、包装、局部物体、人物、服饰、道具、背景、场景、分镜、装饰元素或 UI 局部模块。

拆解规则：
1. 必须优先满足用户拆解指令；如果用户指定范围、数量、类型或目标，不要额外扩展无关元素。
2. 不要提取、抄写或总结画面中的文字内容，除非用户明确要求文字元素。
3. 不要把整张广告图、整张海报、整张页面作为一个目标，除非用户明确要求。
4. 如果画面是商品图或海报，优先提取商品主体、商品局部、包装、背景、底座、装饰元素，不提取卖点文案。
5. 如果画面是分镜、漫画或多格图，优先按分镜或关键主体拆分。
6. 每条 prompt 都要明确要求：参考原图对应位置，只分离并重绘该素材，保持原素材的形状、颜色、材质、姿态、比例和光影；不要生成标题、卖点文案、海报排版、边框、复杂背景场景或无关元素。
7. 输出数量最多 ${count} 条；如果可提取素材不足，可以少于 ${count} 条。

用户拆解指令：
${instruction}

只输出 JSON，不要 Markdown，不要解释。JSON 格式：
{"prompt_items":[{"name":"简短素材名称","source_locator":"说明来自原图哪个对象或区域","prompt":"用于后续图像生成的完整纯素材提取提示词"}]}`;
}

export function buildCanvasEcommerceStrategyPrompt(node: CanvasNode) {
  const data = getEffectiveEcommerceData(node.data || {});
  const capabilityKey = getCapabilityKey(data);
  const config = getPromptConfig(data);
  const capabilityPayload = {
    capability_key: capabilityKey,
    label: config.label,
    business_goal: config.businessGoal,
    overview_definition: config.overviewDefinition,
    set_definition: config.setDefinition,
    non_binding_direction_examples: config.directionExamples,
    non_binding_category_examples: config.categoryExamples,
    non_binding_generic_type_summary: config.genericTypeSummary,
  };
  const capabilityJson = JSON.stringify(capabilityPayload, null, 2);
  const allowedJson = JSON.stringify(buildAllowedTypeSummary(data), null, 2);
  const userJson = JSON.stringify(buildUserConfigSummary(data), null, 2);
  return `你是商品图片结构规划 Agent，是资深电商商品理解专家、电商图片结构规划师和电商转化内容策划师。

你的任务：
在当前电商图工作流真正进入总览图和单图拆解前，先理解商品本身，再为当前电商图能力自主规划最适合该商品的图片结构、最终图片数量、每张图片职责、风格补充和卖点可视化补充。
你的核心价值不是复述默认模块，而是根据商品品类、可见证据、购买决策链路、使用方式、信任疑虑和用户配置，重构出更适合当前商品的专属图片计划。

重要边界：
1. 你只在“出图规划=AI智能规划 smart”时执行，所以你必须主动规划图片类型和图片数量。
2. 你不是最终图片生成模型，不要输出最终生图 prompt。
3. 原始商品参考图优先级最高，用于锁定商品身份、结构、颜色、比例、材质线索、关键部件和商品关系。
4. 用户明确输入的商品事实、卖点、风格和限制必须保留；你只能追加增强，不要覆盖用户原文。
5. 不要编造参考图或用户要求中没有的功效、认证、参数、价格、销量、医学效果、绝对化效果。
6. 当前能力不是固定模板，必须根据 capability_config 和商品本身重新组织图片结构。
7. 短视频素材能力只规划静态图片素材、视频脚本卡和分镜关键帧，不生成真实视频。

当前电商图能力配置 capability_config：
${capabilityJson}

系统归类标签 system_mapping_labels：
${allowedJson}

用户原始配置 user_config：
${userJson}

自主规划方法：
1. 先从参考图判断商品品类、商品关系和可见证据，不要先套用默认结构。
2. 再推导该商品的真实购买决策链路：用户为什么会买、购买前会担心什么、哪些画面证据最能解释商品、哪些内容不能从图中确认。
3. 再规划商品专属模块机会，不要机械套用通用模块。
4. 根据商品复杂度、当前电商图能力和用户真实配置，自主决定最终需要多少张图；不要为了凑数生成重复或空泛图片。
5. 最后才把商品专属模块映射到 system_mapping_labels 的 mapped_type_key；mapped_type_key 只是系统归类标签，不是内容来源。真正的图片类别必须写在 image_category、goal 和 visual_idea 里。

规划字段与画面文案分工：
1. mapped_type_key、image_category 和 title 负责后台归类、文件命名和下游拆解；它们可以使用稳定的业务分类口吻。
2. visible_headline_direction 和 visible_copy_points 负责真实图片里可能出现的买家可见文案方向，必须使用商品语言、消费场景语言和购买理由语言。
3. 规划每张图时，先想清楚买家看到这张图时应该理解什么，再把这个理解写成 visible_headline_direction 和 visible_copy_points；后台分类字段随后再填写。

规划重点：
1. recommended_image_plan 是最重要的输出，不要偷懒，不要只给 1-2 个泛化类型；最终数量由你基于商品理解和业务目标自行决定。
2. 每个 mapped_type_key 必须来自 system_mapping_labels 的 key；如果商品需要更细、更真实、更品类专属的图片类别，把它写进 image_category，并映射到最接近的 mapped_type_key。
3. workflow_injection_brief 要简洁但具体，必须说明这组图为什么这样规划，以及哪些内容是当前商品专属判断。
4. stage1_guidance 只指导单张总览图如何规划；stage2_guidance 只指导后续如何拆解成多张独立图片。

只输出 JSON，不要 Markdown，不要解释。JSON 格式：
{"product_strategy_status":"ok | uncertain | conflict","capability_key":"${capabilityKey}","product_identity":{"category":"商品大类","subcategory":"商品子类或款式","product_relationship":"single_product | series_variants | multiple_related_products | uncertain","visible_features":["从参考图可见的商品特征"],"material_or_texture_clues":["只能写视觉线索，不要写无法确认的成分"],"uncertain_points":["无法确认但影响视觉策略的点"]},"buyer_decision_factors":["买家做购买决策时最关心的判断点"],"product_specific_module_opportunities":[{"opportunity":"该商品专属的展示机会或购买疑虑","why_it_matters":"为什么这个商品需要这个方向","evidence_source":"来自参考图/用户输入/品类常识/保守留白"}],"default_structure_review":{"kept":["保留的通用方向及原因"],"merged":["合并的通用方向及原因"],"replaced":["被商品专属方向替换的通用方向及原因"],"discarded":["不适合当前商品的通用方向及原因"]},"capability_strategy":{"business_goal_understanding":"你如何理解当前电商图能力的业务目标","what_this_capability_should_emphasize":"当前能力下该商品最应该强调什么","what_this_capability_should_avoid":"当前能力下该商品应该避免什么"},"recommended_image_plan":[{"mapped_type_key":"必须来自 system_mapping_labels 的 key","image_category":"后台归类名称，用于文件命名和下游拆解","count":1,"goal":"这类图承担的展示目标","visual_idea":"这类图应该如何表现","visible_headline_direction":"面向买家的自然短标题方向","visible_copy_points":["可出现在图片里的短卖点或短说明，必须是商品语言"],"reason":"为什么该商品需要这类图","script_text":"仅 short_video_assets 需要，可为空","shot_script":"仅 short_video_assets 需要，可为空"}],"user_requirements_append":"保留用户原始通用要求字段基础上追加的图像可执行要求","workflow_injection_brief":"可直接插入第1/2阶段元提示词的商品规划说明，简洁但具体","stage1_guidance":"给第1阶段总览图规划使用的指导","stage2_guidance":"给第2阶段拆解独立图片prompt使用的指导","avoid_list":["该商品生成中应避免的视觉套路、误导表达或不合适场景"],"conflict_notes":["用户输入、参考图、平台要求或策略判断之间的冲突"]}`;
}

export function normalizeCanvasEcommerceStrategyResult(text: string, node: CanvasNode) {
  const data = getEffectiveEcommerceData(node.data || {});
  const payload = extractJsonPayload(text);
  const allowedOptions = getAllowedTypeMap(data);
  const allowedKeys = Array.from(allowedOptions.keys());
  const sourcePlan = Array.isArray((payload as any).recommended_image_plan) ? (payload as any).recommended_image_plan : [];
  const normalizedPlan: Record<string, unknown>[] = [];
  const aggregatedTypes = new Map<string, number>();
  let setTotal = 0;

  sourcePlan.forEach((item: any) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return;
    }
    let typeKey = String(item.mapped_type_key || item.key || item.type_key || '').trim();
    if (typeKey === 'other') {
      typeKey = 'other_ai';
    }
    if (!allowedOptions.has(typeKey)) {
      typeKey = allowedOptions.has('other_ai') ? 'other_ai' : (allowedKeys[0] || '');
    }
    if (!typeKey) {
      return;
    }
    const count = Math.max(1, Number(item.count || 1) || 1);
    normalizedPlan.push({
      mapped_type_key: typeKey,
      image_category: String(item.image_category || allowedOptions.get(typeKey)?.label || typeKey).trim(),
      count,
      goal: stringifyField(item.goal || ''),
      visual_idea: stringifyField(item.visual_idea || item.visualIdea || ''),
      visible_headline_direction: stringifyField(item.visible_headline_direction || item.visibleHeadlineDirection || ''),
      visible_copy_points: normalizeCopyPoints(item.visible_copy_points || item.visibleCopyPoints),
      reason: stringifyField(item.reason || ''),
      script_text: stringifyField(item.script_text || item.scriptText || ''),
      shot_script: stringifyField(item.shot_script || item.shotScript || ''),
    });
    aggregatedTypes.set(typeKey, (aggregatedTypes.get(typeKey) || 0) + count);
    setTotal += count;
  });

  let setImageTypes = Array.from(aggregatedTypes.entries()).map(([key, count]) => ({
    key,
    enabled: true,
    count: Math.max(1, Number(count || 1) || 1),
  }));
  if (!setImageTypes.length) {
    const defaults = getDefaultSetImageTypes(data);
    setImageTypes = defaults
      .filter((item) => item.enabled)
      .map((item) => ({
        key: item.key === 'other' ? 'other_ai' : item.key,
        enabled: true,
        count: Math.max(1, Number(item.count || 1) || 1),
      }))
      .filter((item) => item.key && allowedOptions.has(item.key));
    setTotal = setImageTypes.reduce((sum, item) => sum + item.count, 0);
  }

  const selectedTypeByKey = new Map(setImageTypes.map((item) => [item.key, item]));
  setImageTypes = getTypeOptions(data).map((option) => ({
    key: option.key,
    enabled: selectedTypeByKey.has(option.key),
    count: Math.max(1, Number(selectedTypeByKey.get(option.key)?.count || 1) || 1),
  }));
  setTotal = setImageTypes
    .filter((item) => item.enabled)
    .reduce((sum, item) => sum + Math.max(1, Number(item.count || 1) || 1), 0);

  return {
    product_strategy_status: String((payload as any).product_strategy_status || 'ok').trim() || 'ok',
    capability_key: getCapabilityKey(data),
    product_identity: isPlainObject((payload as any).product_identity) ? (payload as any).product_identity : {},
    buyer_decision_factors: Array.isArray((payload as any).buyer_decision_factors) ? (payload as any).buyer_decision_factors : [],
    product_specific_module_opportunities: Array.isArray((payload as any).product_specific_module_opportunities) ? (payload as any).product_specific_module_opportunities : [],
    default_structure_review: isPlainObject((payload as any).default_structure_review) ? (payload as any).default_structure_review : {},
    capability_strategy: isPlainObject((payload as any).capability_strategy) ? (payload as any).capability_strategy : {},
    recommended_image_plan: normalizedPlan,
    recommended_config_patch: {
      structureMode: 'custom',
      setImageCount: Math.max(1, setTotal || getCanvasEcommerceSetCount(data)),
      setImageTypes,
      userRequirementsAppend: String((payload as any).user_requirements_append || (payload as any).userRequirementsAppend || '').trim(),
    },
    workflow_injection_brief: String((payload as any).workflow_injection_brief || '').trim(),
    stage1_guidance: String((payload as any).stage1_guidance || '').trim(),
    stage2_guidance: String((payload as any).stage2_guidance || '').trim(),
    avoid_list: Array.isArray((payload as any).avoid_list) ? (payload as any).avoid_list : [],
    conflict_notes: Array.isArray((payload as any).conflict_notes) ? (payload as any).conflict_notes : [],
    raw: payload,
  };
}

export function buildCanvasEcommerceFallbackStrategyResult(node: CanvasNode, reason = '') {
  const data = getEffectiveEcommerceData(node.data || {});
  const allowedOptions = getAllowedTypeMap(data);
  const defaults = getDefaultSetImageTypes(data);
  const recommendedPlan = defaults
    .filter((item) => item.enabled)
    .map((item) => {
      const key = item.key === 'other' ? 'other_ai' : item.key;
      const option = allowedOptions.get(key);
      if (!option) {
        return null;
      }
      return {
        mapped_type_key: key,
        image_category: String(option.label || key).trim(),
        count: Math.max(1, Math.min(5, Number(item.count || 1) || 1)),
        goal: '按当前电商图能力默认智能结构继续生成，保证任务不中断。',
        visual_idea: '根据原始商品参考图、当前电商图设置、画面文字要求和该图片类型职责生成具体画面。',
        visible_headline_direction: '根据商品真实特征生成面向买家的短标题，不使用内部模块名称。',
        visible_copy_points: [],
        reason: reason ? `策略分析失败后使用保守兜底结构：${reason}` : '策略分析失败后使用保守兜底结构。',
        script_text: '',
        shot_script: '',
      };
    })
    .filter(Boolean);
  const fallbackText = reason
    ? `策略分析未返回可用结构，已按默认能力结构继续。原因：${reason}`
    : '策略分析未返回可用结构，已按默认能力结构继续。';
  return {
    product_strategy_status: 'uncertain',
    capability_key: getCapabilityKey(data),
    product_identity: {},
    buyer_decision_factors: [],
    product_specific_module_opportunities: [],
    default_structure_review: {},
    capability_strategy: {},
    recommended_image_plan: recommendedPlan,
    recommended_config_patch: {
      structureMode: 'custom',
      setImageCount: recommendedPlan.reduce((sum, item: any) => sum + Math.max(1, Number(item?.count || 1) || 1), 0) || getCanvasEcommerceSetCount(data),
      setImageTypes: normalizeEcommerceSetImageTypes(defaults, data).map((item) => ({
        key: item.key,
        enabled: Boolean(item.enabled),
        count: Math.max(1, Number(item.count || 1) || 1),
      })),
      userRequirementsAppend: '',
    },
    workflow_injection_brief: fallbackText,
    stage1_guidance: '第一阶段按默认能力结构规划总览图，并严格以原始商品参考图锁定商品身份。',
    stage2_guidance: '第二阶段按默认能力结构展开独立图片，并优先保证每张图职责不同、商品身份一致。',
    avoid_list: [],
    conflict_notes: reason ? [reason] : [],
    raw: { fallback: true, reason },
  };
}

export function buildCanvasEcommerceEffectiveConfig(node: CanvasNode, strategyResult: any) {
  const data = node.data || {};
  const patch = isPlainObject(strategyResult?.recommended_config_patch) ? strategyResult.recommended_config_patch as Record<string, any> : {};
  const plannedCount = Math.max(1, Number(patch.setImageCount || getCanvasEcommerceSetCount(data)) || getCanvasEcommerceSetCount(data));
  return {
    source: 'ecommerce_product_visual_strategy',
    structureMode: 'custom',
    setImageCount: plannedCount,
    setImageTypes: Array.isArray(patch.setImageTypes) ? patch.setImageTypes : [],
    userRequirements: appendText(
      String(data.userRequirements || ''),
      String(patch.userRequirementsAppend || '').trim(),
      'Agent补充执行要求'
    ),
    ecommerceStrategyBrief: String(strategyResult?.workflow_injection_brief || '').trim(),
    ecommerceStage1Guidance: String(strategyResult?.stage1_guidance || '').trim(),
    ecommerceStage2Guidance: String(strategyResult?.stage2_guidance || '').trim(),
    ecommerceAvoidList: Array.isArray(strategyResult?.avoid_list) ? strategyResult.avoid_list : [],
    ecommerceRecommendedImagePlan: Array.isArray(strategyResult?.recommended_image_plan) ? strategyResult.recommended_image_plan : [],
    ecommerceConflictNotes: Array.isArray(strategyResult?.conflict_notes) ? strategyResult.conflict_notes : [],
    ecommerceProductStrategyStatus: String(strategyResult?.product_strategy_status || 'ok').trim() || 'ok',
    recommendedImagePlan: Array.isArray(strategyResult?.recommended_image_plan) ? strategyResult.recommended_image_plan : [],
  };
}

export function buildCanvasEffectiveEcommerceNode(node: CanvasNode, effectiveConfig: Record<string, unknown> | null, strategyResult: Record<string, unknown> | null) {
  if (!effectiveConfig) {
    return node;
  }
  return {
    ...node,
    data: {
      ...(node.data || {}),
      ...effectiveConfig,
      ecommerceEffectiveConfig: effectiveConfig,
      ecommerceStrategyResult: strategyResult,
    },
  };
}

export function buildCanvasEcommerceOverviewPrompt(node: CanvasNode) {
  const data = getEffectiveEcommerceData(node.data || {});
  const config = getPromptConfig(data);
  const textMode = String(data.textMode || 'finished_text').trim();
  const modeKey = textMode === 'clean' ? 'clean' : (textMode === 'rich_text' ? 'rich_text' : 'finished_text');
  const settings = buildCommonSettingLines(data, false);
  const structure = buildStructureConfigText(data, 'overview');
  const strategyText = buildOverviewStrategyText(data);
  const textPolicy = buildOverviewTextPolicy(data);
  return `你是${config.overviewRole}。

你的任务：
根据用户提供的商品参考图，生成一个“用于生成单张${config.overviewName}”的最终图像提示词。

${config.overviewName}定义：
${config.overviewDefinition}

当前变量：
- 业务目标：${config.businessGoal}
${settings}
- 出图规划：${structure}
- 参考优先级：原始商品参考图最高，必须用于锁定商品身份、结构、颜色、比例和关键部件。
- 商品关系策略：先判断参考图表现的是单一商品、同系列多款式，还是多个相关商品；不确定时采用保守表达，不要错误合并。
- 画面文字要求：${textPolicy}

${strategyText}品类原生展示思考：
在规划组图前，先用简短文字判断该商品属于什么类型、买家最需要被说服的点是什么、哪些视觉证据最适合这个品类、哪些表现方式可能误导或过度承诺。
这种思考只用于启发组图方向，不要把它变成僵硬模板；不要因为想到某个品类案例，就强行套用到不相关商品。

展示单元方向包括但不限于：
${config.directionExamples}。

工作要求：
1. 先综合理解所有参考图，判断商品是什么、外观结构是什么、有哪些关键部件、功能、状态、款式或变体。
2. 再判断商品的品类原生展示逻辑：该商品最适合用哪些画面证明价值，哪些画面只是通用电商套路但对该商品说服力不强。
3. 不要预设参考图中没有出现或用户没有要求的固定使用场景。
4. 不要写无法从图中确认的性能参数，例如续航、功率、档位、认证、价格。
5. 根据出图规划设计这张总览图内部的展示单元，但最终只生成一张总览图提示词。
6. 严格遵循输出模式处理文字、图标、箭头和说明区域。
7. 总览图必须是一张完整大图，内部可以包含多个缩略展示单元、模块或信息区，但最终只生成一张图片。
8. 最终提示词必须足够具体，可以直接交给图像模型生成这一张${config.overviewName}。

只输出 JSON，不要 Markdown，不要输出解释。JSON 格式：
{"mode":"${modeKey}","product_relationship":"single_product | series_variants | multiple_related_products | uncertain","product_understanding":"对商品的简洁理解","category_reasoning":{"product_category":"根据参考图判断的商品类型，不确定时保守描述","buyer_decision_factors":["买家最关心的判断点"],"category_specific_visual_proof":["该品类最适合用图片证明价值的方式"],"visual_risks":["容易误导、过度承诺或偏离商品真实身份的风险"]},"overview_strategy":"单张${config.overviewName}的整体策略","display_units":[{"name":"展示单元名称","purpose":"该展示单元展示什么","visual_description":"该展示单元在${config.overviewName}中如何呈现"}],"prompt_items":[{"name":"overview","prompt":"最终用于生成单张${config.overviewName}的完整提示词"}]}`;
}

export function buildCanvasEcommerceSetPrompt(node: CanvasNode, overviewAnalysis: string) {
  const data = getEffectiveEcommerceData(node.data || {});
  const config = getPromptConfig(data);
  const count = getCanvasEcommerceSetCount(data);
  const textMode = String(data.textMode || 'finished_text').trim();
  const modeKey = textMode === 'clean' ? 'clean' : (textMode === 'rich_text' ? 'rich_text' : 'finished_text');
  const settings = buildCommonSettingLines(data, true);
  const structure = buildStructureConfigText(data, 'set');
  const strategyText = buildSetStrategyText(data);
  const textPolicy = buildSetTextPolicy(data);
  const focusPolicy = buildFocusPolicy(data);
  const shortVideoRequirements = getCapabilityKey(data) === 'short_video_assets'
    ? `短视频脚本要求：
1. 你输出的是短视频静态素材和可复制的视频脚本文本，不生成真实视频。
2. 至少一条 prompt_items 必须是完整视频脚本卡或脚本总览，image_category 可用“视频脚本卡”。
3. 每条 prompt_items 都应尽量补充 script_text 或 shot_script：script_text 是用户可复制的视频脚本、旁白或字幕文案；shot_script 是这一帧/这一张素材对应的镜头说明、画面动作、节奏和转场建议。
4. 分镜关键帧要能对应脚本顺序，例如开头钩子、商品展示、使用演示、卖点证明、转化收尾；不要只生成无脚本关系的普通商品图。

`
    : '';
  const shortVideoJsonFields = getCapabilityKey(data) === 'short_video_assets'
    ? ',"script_text":"短视频脚本、旁白、字幕或画面文案；非短视频素材可留空","shot_script":"这一张素材对应的镜头画面、动作、节奏、转场或剪辑说明；非短视频素材可留空"'
    : '';
  return `你是${config.setRole}。

输入包含两类图：
1. 原始商品参考图：用于锁定商品身份、真实结构、颜色、比例、材质、关键部件和款式关系。
2. 上一阶段生成的${config.overviewName}：用于参考图片方向、画面职责、整体风格、分区逻辑、卖点表达和视觉一致性。

你的任务：
一次性生成 ${count} 条“用于生成独立${config.label}图片”的图像提示词。
${config.setDefinition}

当前变量：
- 业务目标：${config.businessGoal}
${settings}
- 生成图片数量：${count}
- 出图规划：${structure}
- 风格保持方式：原始参考图用于商品身份校准，${config.overviewName}用于风格、构图和卖点方向参考。
- 画面文字要求：${textPolicy}

- 单品聚焦策略：${focusPolicy}

${strategyText}品类原生展示思考：
请先参考第一阶段 JSON 中的 category_reasoning、product_understanding、display_units 和${config.overviewName}画面，理解该商品真正适合用什么画面说服买家。
这些思考字段是辅助判断，不是强制模板；第二阶段仍必须优先满足原始参考图真实性、用户设置、图片数量、类型配置、当前画面文字要求和风格一致性。
如果第一阶段思考与原始参考图或用户设置冲突，以原始参考图和用户设置为准；如果第一阶段思考只提供了通用方向，你需要把它进一步转化成更贴合商品品类的具体图像提示词。

图片方向可以包括但不限于：
${config.directionExamples}。

${shortVideoRequirements}工作要求：
1. 先根据原始商品参考图重新确认商品真实身份，不要被${config.overviewName}中可能错误或夸张的细节带偏。
2. 再结合第一阶段的品类原生展示思考，判断哪些图像类型对该商品最有说服力；只把它作为选题和构图参考，不要让它覆盖用户设置。
3. 再分析${config.overviewName}的结构和风格，把其中适合的展示单元拆成多张独立${config.label}图片。
4. 如果原始参考图和组图对商品结构有冲突，以原始参考图为准。
5. 不要预设参考图中没有出现或无法合理推断的固定场景；不要写无法从图中确认的性能参数。
6. 必须输出正好 ${count} 条 prompt_items，不多不少；每条都必须有明确 image_category、title、goal、reference_usage 和 prompt。image_category 是用于归类和文件命名的图像类型，例如${config.categoryExamples}等；不必局限于这些示例，但必须是简短、稳定、可归类的类型名称。
7. prompt 写法必须站在真实买家浏览图片的角度：先写这张图要呈现的商品画面主题，再写构图、可见短文案、参考图使用方式和生成限制；后台分类名称只保留在 JSON 字段中。
8. title 是给后台和下载文件使用的展示名称；如果 prompt 需要建议主标题，应写成买家能直接理解的商品短句。
9. 若出图规划为手动配置，prompt_items 的类型和数量必须严格匹配配置；如果某类不完全适合商品，也不要减少数量，而是保守改造成该商品可接受的展示方式。
10. 同一类型重复出现时，必须设计不同职责，例如不同使用场景、不同卖点、不同角度、不同细节或不同品类证明方式。
11. 每张图都要说明参考策略：原始参考图用于商品身份，${config.overviewName}和第一阶段思考用于风格、构图和选题启发。
12. ${config.finalItemStrategy}

第一阶段分析 JSON：
${String(overviewAnalysis || '').trim()}

只输出 JSON，不要 Markdown，不要输出解释。JSON 格式：
{"mode":"${modeKey}","product_relationship":"single_product | series_variants | multiple_related_products | uncertain","product_understanding":"对商品身份、关键结构、款式关系和视觉风险的简洁理解","category_reasoning_used":"如何参考第一阶段品类思考，以及哪些部分只是启发而非强制遵循","set_strategy":"整组${config.label}的设计策略","style_consistency":"如何利用原始参考图和${config.overviewName}保持风格统一","prompt_items":[{"index":1,"image_category":"后台归类和文件命名类型，如${config.categoryExamples}等","title":"后台展示和文件命名用的具体展示名称","visible_headline":"如果图片需要主标题，写面向买家的自然短标题；干净模式可为空","visible_copy_points":["如果图片需要短文案，写商品语言短句"],"goal":"这张图承担的展示目标","reference_usage":"如何参考原始商品图、${config.overviewName}和第一阶段思考","prompt":"用于生成这一张独立${config.label}图片的完整提示词，只包含最终画面描述、构图、可见买家文案和生成限制"${shortVideoJsonFields}}]}`;
}

export function cleanCanvasEcommerceVisiblePromptText(prompt: string, item: Record<string, unknown> = {}) {
  let cleaned = String(prompt || '').trim();
  if (!cleaned) {
    return '';
  }
  const headline = String(
    item.visible_headline
    || item.visibleHeadline
    || item.visible_headline_direction
    || item.visibleHeadlineDirection
    || ''
  ).trim();
  const replacement = sanitizeVisibleHeadline(headline || item.title || item.name || '商品核心信息');
  cleaned = cleaned.replace(
    /\s*注意：image_category、title、模块名和系统归类标签仅用于内部管理，不能作为图片可见主标题；图片中的可见文字必须改写为面向买家的自然商品文案。(?:\s*建议可见主标题方向：[^。]*。)?(?:\s*建议短文案方向：[^。]*。)?/gu,
    ''
  );
  INTERNAL_LABEL_TERMS.forEach((term) => {
    const escaped = escapeRegExp(term);
    cleaned = cleaned.replace(new RegExp(`主题为[“"]?${escaped}[”"]?[：:、，,]?`, 'gu'), `围绕“${replacement}”设计画面，`);
    cleaned = cleaned.replace(new RegExp(`主标题可用[“"]${escaped}[”"]`, 'gu'), `主标题可用“${replacement}”`);
  });
  return cleaned.trim();
}

function getImageExplosionExtractionMode(data: Record<string, unknown>) {
  const mode = String((data as any).extractionMode || (((data as any).explosionMode === 'clean') ? 'clean_material' : (data as any).explosionMode) || 'clean_material')
    .trim()
    .toLowerCase();
  return mode === 'original' ? 'original' : 'clean_material';
}

function getCapabilityKey(data: Record<string, any>) {
  const key = String(data?.ecommerceCapability || data?.ecommerceMode || '').trim();
  return CAPABILITY_OPTIONS.some((item) => item.key === key) ? key : 'listing_product_set';
}

function getCapabilityConfig(data: Record<string, any>) {
  return CAPABILITY_OPTIONS.find((item) => item.key === getCapabilityKey(data)) || CAPABILITY_OPTIONS[0];
}

function getPromptConfig(data: Record<string, any>) {
  const capabilityKey = getCapabilityKey(data);
  const capability = getCapabilityConfig(data);
  return {
    label: capability.label,
    shortLabel: capability.shortLabel,
    description: capability.description,
    ...PROMPT_CONFIG_BY_KEY[capabilityKey as keyof typeof PROMPT_CONFIG_BY_KEY],
  };
}

function getTypeOptions(data: Record<string, any>) {
  return TYPE_OPTIONS_BY_CAPABILITY[getCapabilityKey(data)] || TYPE_OPTIONS_BY_CAPABILITY.listing_product_set;
}

function getDefaultSetImageTypes(data: Record<string, any>) {
  return DEFAULT_SET_TYPES_BY_CAPABILITY[getCapabilityKey(data)] || DEFAULT_SET_TYPES_BY_CAPABILITY.listing_product_set;
}

function normalizeEcommerceSetImageTypes(items: unknown, data: Record<string, any>) {
  const options = getTypeOptions(data);
  const defaults = getDefaultSetImageTypes(data);
  const sourceItems = Array.isArray(items) && items.length ? items : defaults;
  const defaultTypeByKey = new Map(defaults.map((item) => [item.key, item]));
  const byKey = new Map(sourceItems.map((item: any) => {
    const key = String(item?.key || '') === 'other' ? 'other_ai' : String(item?.key || '');
    return [key, item];
  }));
  const optionKeys = new Set(options.map((option) => option.key));
  const normalized: Array<{
    key: string;
    label: string;
    description: string;
    enabled: boolean;
    count: number;
    custom?: boolean;
  }> = options.map((option) => {
    const item: any = byKey.get(option.key) || defaultTypeByKey.get(option.key);
    return {
      key: option.key,
      label: option.label,
      description: option.description,
      enabled: Boolean(item?.enabled),
      count: Math.max(1, Math.min(5, Math.round(Number(item?.count || 1) || 1))),
    };
  });
  sourceItems.forEach((item: any) => {
    const rawKey = String(item?.key || '').trim();
    const key = rawKey === 'other' ? 'other_ai' : rawKey;
    if (!key || optionKeys.has(key)) {
      return;
    }
    const label = String(item?.label || '').trim();
    if (!label) {
      return;
    }
    normalized.push({
      key,
      label,
      description: String(item?.description || '').trim(),
      enabled: Boolean(item?.enabled),
      count: Math.max(1, Math.min(5, Math.round(Number(item?.count || 1) || 1))),
      custom: true,
    });
  });
  return normalized;
}

function getAllowedTypeMap(data: Record<string, any>) {
  return new Map(getTypeOptions(data).map((option) => [option.key, option]));
}

function buildAllowedTypeSummary(data: Record<string, any>) {
  const typeMap = getAllowedTypeMap(data);
  const types: Array<{ key: string; label: string; description: string; custom?: boolean }> = Array.from(typeMap.values()).map((option) => ({
    key: option.key,
    label: option.label,
    description: option.description,
  }));
  normalizeEcommerceSetImageTypes(data.setImageTypes, data)
    .filter((item) => item.custom)
    .forEach((item) => {
      types.push({
        key: item.key,
        label: item.label || item.key,
        description: item.description || '',
        custom: true,
      });
    });
  return types;
}

function buildUserConfigSummary(data: Record<string, any>) {
  const structureMode = String(data.structureMode || 'smart').trim();
  const keys = [
    'ecommerceMode', 'ecommerceCapability', 'textMode', 'structureMode', 'platform', 'marketRegion',
    'copyLanguage', 'userRequirements', 'detailPagePurpose', 'detailNarrative', 'detailTrustFocus',
    'adGoal', 'adAudience', 'adOffer', 'adHookStrength', 'adComplianceLevel', 'socialPlatform',
    'socialAngle', 'creatorPersona', 'realismLevel', 'peoplePolicy', 'brandGoal', 'brandTone',
    'brandColors', 'brandStory', 'videoPlatform', 'videoGoal', 'videoDuration', 'scriptTone',
    'excludeExtremeCopy', 'focusSingleProduct',
  ];
  if (structureMode === 'custom') {
    keys.push('setImageCount', 'setImageTypes');
  }
  return keys.reduce<Record<string, unknown>>((summary, key) => {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      summary[key] = data[key];
    }
    return summary;
  }, {});
}

function getEffectiveEcommerceData(data: Record<string, any>) {
  const effectiveConfig = data?.ecommerceEffectiveConfig && typeof data.ecommerceEffectiveConfig === 'object'
    ? data.ecommerceEffectiveConfig
    : null;
  return effectiveConfig ? { ...data, ...effectiveConfig } : data;
}

function buildCommonSettingLines(data: Record<string, any>, includeFocusSingleProduct: boolean) {
  const capabilityKey = getCapabilityKey(data);
  const lines: string[] = [];
  const labelMap: Record<string, { platform: string; region: string; language: string; requirements: string }> = {
    listing_product_set: { platform: '目标平台', region: '销售地区', language: '输出文字语言', requirements: '卖点与要求' },
    detail_page: { platform: '承载平台', region: '销售地区', language: '页面语言', requirements: '内容要求' },
    ad_creative: { platform: '投放平台', region: '投放地区', language: '广告语言', requirements: '投放要求' },
    social_seed_content: { platform: '发布平台', region: '发布地区', language: '内容语言', requirements: '内容要求' },
    brand_assets: { platform: '使用场景', region: '销售地区', language: '品牌语言', requirements: '品牌要求' },
    short_video_assets: { platform: '视频平台', region: '投放地区', language: '字幕语言', requirements: '视频要求' },
  };
  const labels = labelMap[capabilityKey] || labelMap.listing_product_set;
  if (String(data.platform || '').trim()) {
    lines.push(`- ${labels.platform}：${String(data.platform || '').trim()}`);
  }
  lines.push(`- ${labels.region}：${String(data.marketRegion || '全球/通用').trim() || '全球/通用'}`);
  lines.push(`- ${labels.language}：${String(data.copyLanguage || '未指定').trim() || '未指定'}`);
  if (String(data.styleDirection || '').trim()) {
    lines.push(`- 风格方向：${String(data.styleDirection || '').trim()}`);
  }
  if (data.excludeExtremeCopy !== false) {
    lines.push('- 排除极限词：开启。短文案和卖点必须避免绝对化、极限化或无法验证的承诺。');
  }
  if (includeFocusSingleProduct) {
    lines.push(`- 聚焦单品：${data.focusSingleProduct ? '开启。优先聚焦单个商品本体，减少多件并列。' : '关闭。允许更丰富的多视角、多状态表达。'}`);
  }
  buildCapabilitySettingLines(data, capabilityKey).forEach((line) => lines.push(line));
  lines.push(`- ${labels.requirements}：${String(data.userRequirements || '无额外要求').trim() || '无额外要求'}`);
  lines.push(`- 用户自定义指令优先级：${labels.requirements} 属于用户自定义输入；当它与平台、地区、出图规划等自动配置存在冲突时，在不违反原始商品参考图真实性和基础合规的前提下，优先满足用户自定义输入。`);
  return lines.join('\n');
}

function buildCapabilitySettingLines(data: Record<string, any>, capabilityKey: string) {
  if (capabilityKey === 'detail_page') {
    return [
      `- 详情页用途：${String(data.detailPagePurpose || '通用平台详情页').trim() || '通用平台详情页'}`,
      `- 内容重点：${String(data.detailNarrative || 'value_first').trim() || 'value_first'}`,
      `- 证明重点：${String(data.detailTrustFocus || '未指定，由模型根据商品品类保守判断').trim() || '未指定，由模型根据商品品类保守判断'}`,
    ];
  }
  if (capabilityKey === 'ad_creative') {
    return [
      `- 投放目标：${String(data.adGoal || '转化购买').trim() || '转化购买'}`,
      `- 目标人群：${String(data.adAudience || '未指定，由模型根据商品和平台保守推断').trim() || '未指定，由模型根据商品和平台保守推断'}`,
      `- 活动信息：${String(data.adOffer || '未指定；不要编造价格、折扣、赠品或活动承诺').trim() || '未指定；不要编造价格、折扣、赠品或活动承诺'}`,
    ];
  }
  if (capabilityKey === 'social_seed_content') {
    return [
      `- 社媒平台：${String(data.socialPlatform || '通用社媒').trim() || '通用社媒'}`,
      `- 种草角度：${String(data.socialAngle || '买家真实分享').trim() || '买家真实分享'}`,
      `- 创作者人设：${String(data.creatorPersona || '未指定').trim() || '未指定'}`,
      `- 真实感级别：${String(data.realismLevel || '真实自然').trim() || '真实自然'}`,
      `- 人物策略：${String(data.peoplePolicy || 'auto').trim() || 'auto'}`,
    ];
  }
  if (capabilityKey === 'brand_assets') {
    return [
      `- 品牌目标：${String(data.brandGoal || '店铺首页视觉').trim() || '店铺首页视觉'}`,
      `- 品牌调性：${String(data.brandTone || '高级专业').trim() || '高级专业'}`,
      `- 品牌颜色：${String(data.brandColors || '未指定').trim() || '未指定'}`,
      `- 品牌故事：${String(data.brandStory || '未指定').trim() || '未指定'}`,
    ];
  }
  if (capabilityKey === 'short_video_assets') {
    return [
      `- 视频平台：${String(data.videoPlatform || '通用短视频').trim() || '通用短视频'}`,
      `- 视频目标：${String(data.videoGoal || '种草转化').trim() || '种草转化'}`,
      `- 视频时长：${String(data.videoDuration || '15-30秒').trim() || '15-30秒'}`,
      `- 脚本语气：${String(data.scriptTone || '自然口播').trim() || '自然口播'}`,
    ];
  }
  return [];
}

function buildStructureConfigText(data: Record<string, any>, stage: 'overview' | 'set') {
  const count = getCanvasEcommerceSetCount(data);
  const config = getPromptConfig(data);
  if (String(data.structureMode || 'smart').trim() !== 'custom') {
    return `AI智能规划：目标生成 ${count} 张${config.label}。请根据商品参考图、商品品类、购买决策点、平台或使用场景、地区语言和当前子能力，主动规划最适合该商品的出图方向。${config.genericTypeSummary}只是常见起点，不是必须逐项覆盖的固定清单；如果某些通用类型不适合该商品，可以跳过或合并；如果商品本身更适合未列出的图片类型，必须主动扩展并给出具体、稳定、可归类的 image_category。最终规划应在覆盖必要基础信息的同时，保留足够 AI 自主发散空间，生成更贴合商品和业务目标的专属出图计划。`;
  }
  const items = normalizeEcommerceSetImageTypes(data.setImageTypes, data).filter((item) => item.enabled);
  const summary = items.length
    ? items.map((item) => `${item.label || item.key} ${Math.max(1, Number(item.count || 1) || 1)} 张`).join('、')
    : 'AI补充图 1 张';
  const baseText = `手动出图规划：最终必须生成 ${count} 张${config.label}，内部归类和数量必须匹配：${summary}。这些归类名称只用于规划、拆解、文件命名和数量校验，不是图片里的主标题、副标题或可见文案。`;
  return stage === 'set'
    ? `${baseText} 第二阶段输出 JSON 时要逐条展开这些内部类型；同一类型重复出现时，每张图必须有不同职责和构图。生成 prompt 时必须把内部类型改写成买家能理解的商品画面主题，不要把后台归类名称直接写成图片可见标题或生图主题。AI补充图不能直接写成“其他图”，必须根据商品特征解析成具体、可执行、面向买家的图片方向。`
    : `${baseText} 第一阶段只需要把这些内部类型方向体现在单张${config.overviewName}的规划里，不要输出多张图片；展示单元的可见文案也必须使用商品语言，不要直接展示内部归类名称。AI补充图可以作为启发模型扩展商品专属展示方向。`;
}

function buildOverviewStrategyText(data: Record<string, any>) {
  const parts: string[] = [];
  const brief = String(data.ecommerceStrategyBrief || '').trim();
  const stage1Guidance = String(data.ecommerceStage1Guidance || '').trim();
  if (brief) {
    parts.push(`- 商品视觉策略 Brief：${brief}`);
  }
  if (stage1Guidance) {
    parts.push(`- 第一阶段总览图指导：${stage1Guidance}`);
  }
  if (!parts.length) {
    return '';
  }
  return `商品视觉策略 Agent 输出：
${parts.join('\n')}
这些策略用于增强当前总览图规划，但不得覆盖原始商品参考图真实性、用户明确要求和当前电商图能力定义。

`;
}

function buildSetStrategyText(data: Record<string, any>) {
  const parts: string[] = [];
  const brief = String(data.ecommerceStrategyBrief || '').trim();
  const stage2Guidance = String(data.ecommerceStage2Guidance || '').trim();
  const productStrategyStatus = String(data.ecommerceProductStrategyStatus || '').trim();
  const avoidList = Array.isArray(data.ecommerceAvoidList) ? data.ecommerceAvoidList.filter(Boolean) : [];
  const conflictNotes = Array.isArray(data.ecommerceConflictNotes) ? data.ecommerceConflictNotes.filter(Boolean) : [];
  const recommendedPlan = Array.isArray(data.ecommerceRecommendedImagePlan)
    ? data.ecommerceRecommendedImagePlan
    : (Array.isArray(data.recommendedImagePlan) ? data.recommendedImagePlan : []);
  const recommendedPlanText = buildRecommendedPlanText(recommendedPlan);
  if (productStrategyStatus) {
    parts.push(`- 策略状态：${productStrategyStatus}`);
  }
  if (brief) {
    parts.push(`- 商品视觉策略 Brief：${brief}`);
  }
  if (stage2Guidance) {
    parts.push(`- 第二阶段拆解指导：${stage2Guidance}`);
  }
  if (avoidList.length) {
    parts.push(`- 避免方向：${avoidList.join('；')}`);
  }
  if (conflictNotes.length) {
    parts.push(`- 冲突/不确定备注：${conflictNotes.join('；')}`);
  }
  if (recommendedPlanText) {
    parts.push(`- Agent 逐图计划 JSON：${recommendedPlanText}`);
  }
  if (!parts.length) {
    return '';
  }
  const planNote = recommendedPlanText
    ? '执行 Agent 逐图计划时，必须把每个计划项按 count 展开成独立 prompt_items；同一 mapped_type_key 下的不同 image_category、goal、visible_headline_direction、visible_copy_points、script_text、shot_script 都要保留差异，不得合并成泛化图片。prompt 字段只写最终画面、构图、买家可见文案和生成限制；后台归类字段保存为 JSON 字段，不进入画面主题写法。\n\n'
    : '\n';
  return `商品视觉策略 Agent 输出：
${parts.join('\n')}
这些策略用于增强单图拆解和选题表达，但不得覆盖原始商品参考图真实性、用户明确要求、出图规划和当前电商图能力定义。
${planNote}`;
}

function buildOverviewTextPolicy(data: Record<string, any>) {
  const textMode = String(data.textMode || 'finished_text').trim();
  if (textMode === 'clean') {
    return '输出模式：Clean Image Mode。生成干净的总览图提示词。画面中不要生成可读文字、标题、标签、参数、徽章或说明段落；可以规划留白区、图标占位区、箭头占位区和文案预留区，方便后期设计和多语言排版。';
  }
  if (textMode === 'rich_text') {
    return '输出模式：Rich Copy Mode。生成文字信息更丰富的电商总览图提示词。画面中可以有更完整的信息层级和商业设计感：主标题、副标题、展示单元标题、卖点胶囊、图标说明、箭头标注、步骤卡片、局部说明和品类氛围元素可以按商品和当前业务目标组合使用。文字必须短句化、可读、排版精致，不要写长段落、虚假参数、乱码、极度拥挤或遮挡商品主体。';
  }
  return '输出模式：Finished Text Mode。生成接近成品电商图片风格的总览图提示词。画面中应包含简短、可读、利益点明确的电商短文案；每个需要说明的展示单元可以包含 1 个短标题或 1-3 个短卖点。避免长段落、虚假参数、乱码、密集文字和遮挡商品主体的文字。';
}

function buildSetTextPolicy(data: Record<string, any>) {
  const textMode = String(data.textMode || 'finished_text').trim();
  if (textMode === 'clean') {
    return '输出模式：Clean Product Image Mode。每张提示词应生成干净、可后期排版的商品图。不要让图像模型生成可读文字、标题、标签、数字参数、徽章或长文案；需要表达卖点时，用留白、卡片区域、箭头占位、图标占位和构图表达，方便后期叠加真实文案。';
  }
  if (textMode === 'rich_text') {
    return '输出模式：Rich Copy Product Image Mode。每张提示词可以生成文字信息更丰富的成品电商图，而不是只生成干净产品照。请主动规划标题、副标题、卖点胶囊、图标标签、箭头标注、步骤短语、局部说明、品质证明或使用场景说明等信息层级。文字要短句化、精致、可读，只允许使用能从参考图确认、用户要求支持或非常保守的描述，不要生成无法确认的性能参数、认证、价格或夸张承诺。';
  }
  return '输出模式：Finished Text Product Image Mode。每张提示词可以生成简短、可读、平台友好的短标题和短卖点。只允许使用能从参考图确认或非常保守的描述，不要生成无法确认的参数。文字要少、清楚、不要遮挡商品。';
}

function buildFocusPolicy(data: Record<string, any>) {
  return data.focusSingleProduct
    ? '聚焦单品已开启：每条图像提示词都要优先描述单个商品本体在一个明确画面中的聚焦展示；允许局部放大、小插图、多角度或同一商品状态示意，但不要让画面主体变成多件并列陈列。'
    : '聚焦单品未开启：保留当前多视角、多形态、丰富展示策略；可以在合理范围内使用双形态并列、多状态小图、局部放大和场景拼接，让电商图片信息更完整。';
}

function buildRecommendedPlanText(plan: unknown) {
  const normalized = Array.isArray(plan)
    ? plan
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .slice(0, 20)
      .map((item: any, index) => ({
        index: index + 1,
        mapped_type_key: String(item.mapped_type_key || '').trim(),
        image_category: String(item.image_category || '').trim(),
        count: Math.max(1, Number(item.count || 1) || 1),
        goal: stringifyField(item.goal || ''),
        visual_idea: stringifyField(item.visual_idea || ''),
        visible_headline_direction: stringifyField(item.visible_headline_direction || ''),
        visible_copy_points: normalizeCopyPoints(item.visible_copy_points),
        reason: stringifyField(item.reason || ''),
        script_text: stringifyField(item.script_text || ''),
        shot_script: stringifyField(item.shot_script || ''),
      }))
    : [];
  return normalized.length ? JSON.stringify(normalized) : '';
}

function appendText(base: string, append: string, label = '') {
  const baseText = String(base || '').trim();
  const appendTextValue = String(append || '').trim();
  if (!appendTextValue) {
    return baseText;
  }
  if (!baseText) {
    return appendTextValue;
  }
  return `${baseText}\n${label ? `${label}：` : ''}${appendTextValue}`;
}

function stringifyField(value: unknown) {
  if (Array.isArray(value) || isPlainObject(value)) {
    return JSON.stringify(value);
  }
  return String(value || '').trim();
}

function normalizeCopyPoints(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  const text = String(value || '').trim();
  return text ? [text] : [];
}

function sanitizeVisibleHeadline(value: unknown) {
  let headline = String(value || '').trim();
  INTERNAL_LABEL_TERMS.forEach((term) => {
    headline = headline.replaceAll(term, '');
  });
  headline = headline.replace(/^[\s\-_:：、，,/]+|[\s\-_:：、，,/]+$/gu, '').trim();
  return headline || '商品核心信息';
}

function extractJsonPayload(text: string) {
  const raw = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const direct = tryParseJson(raw);
  if (direct && typeof direct === 'object') {
    return Array.isArray(direct) ? { prompt_items: direct } : direct as Record<string, unknown>;
  }
  const objectStart = raw.indexOf('{');
  const objectEnd = raw.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    const parsed = tryParseJson(raw.slice(objectStart, objectEnd + 1));
    if (parsed && typeof parsed === 'object') {
      return Array.isArray(parsed) ? { prompt_items: parsed } : parsed as Record<string, unknown>;
    }
  }
  const arrayStart = raw.indexOf('[');
  const arrayEnd = raw.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    const parsed = tryParseJson(raw.slice(arrayStart, arrayEnd + 1));
    if (Array.isArray(parsed)) {
      return { prompt_items: parsed };
    }
  }
  return {};
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(value: string) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
