export const ECOMMERCE_CAPABILITY_OPTIONS = [
  { key: 'listing_product_set', label: 'Listing 商品套图', shortLabel: 'Listing套图', description: '商品上架页图集，展示商品、卖点、细节和场景。', smartMin: 6, smartDefault: 6 },
  { key: 'detail_page', label: '商品详情页', shortLabel: '详情页', description: '详情页素材，用于展示商品、卖点、使用、规格和信任信息。', smartMin: 6, smartDefault: 7 },
  { key: 'ad_creative', label: '电商广告图', shortLabel: '广告图', description: '投放和促销素材，突出人群、利益点和转化目标。', smartMin: 3, smartDefault: 4 },
  { key: 'social_seed_content', label: '社媒种草图', shortLabel: '种草图', description: '社媒分享素材，突出真实体验和生活方式。', smartMin: 3, smartDefault: 4 },
  { key: 'brand_assets', label: '品牌资产图', shortLabel: '品牌资产', description: '店铺、品牌页和活动页素材，统一品牌视觉。', smartMin: 3, smartDefault: 4 },
  { key: 'short_video_assets', label: '短视频素材', shortLabel: '短视频素材', description: '短视频封面、脚本卡和分镜关键帧素材。', smartMin: 4, smartDefault: 5 },
];

export const ECOMMERCE_CAPABILITY_BY_KEY = new Map(ECOMMERCE_CAPABILITY_OPTIONS.map((item) => [item.key, item]));

export const ECOMMERCE_MODULE_TYPE_OPTIONS_BY_CAPABILITY = {
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
    { key: 'comparison', label: '对比/证明图', description: '展示前后对比、方案对比或价值证明' },
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

export const DEFAULT_ECOMMERCE_SET_IMAGE_TYPES_BY_CAPABILITY = {
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

export const DEFAULT_ECOMMERCE_SET_IMAGE_TYPES = DEFAULT_ECOMMERCE_SET_IMAGE_TYPES_BY_CAPABILITY.listing_product_set;

export const ECOMMERCE_PLATFORM_OPTIONS = ['淘宝天猫1688', 'Temu', 'TikTok', '拼多多', '抖音电商', 'Ozon', '独立站', '亚马逊', 'Shopee', '阿里国际站', '速卖通', 'SHEIN', '京东', '美客多', 'Coupang', 'Wayfair', 'Lazada', '小红书', 'Instagram', 'Pinterest', 'Meta Ads', 'Google Ads', '通用电商平台'];
export const ECOMMERCE_AD_PLATFORM_OPTIONS = ['Meta Ads', 'Google Ads', 'TikTok Ads', 'Amazon Ads', 'Shopee Ads', '小红书聚光', '巨量引擎', '独立站广告', '通用广告平台'];
export const ECOMMERCE_MARKET_REGION_OPTIONS = ['美国', '欧洲', '日本', '韩国', '东南亚', '中国', '泰国', '全球/通用'];
export const ECOMMERCE_COPY_LANGUAGE_OPTIONS = ['英文', '中文', '日文', '韩文', '泰语', '德文', '法文', '西班牙文', '葡萄牙文', '俄文', '阿拉伯文', '印尼文', '越南文'];
export const ECOMMERCE_DETAIL_PAGE_PURPOSE_OPTIONS = ['通用平台详情页', 'Amazon/A+品牌内容', '独立站转化落地页', '批发/B2B说明页', '规格说明/安装使用页', '信任证明/FAQ页'];
export const ECOMMERCE_DETAIL_NARRATIVE_OPTIONS = [
  { value: 'value_first', label: '价值主张优先' },
  { value: 'problem_solution', label: '痛点解决优先' },
  { value: 'usage_education', label: '使用教育优先' },
  { value: 'trust_first', label: '信任证明优先' },
];
export const ECOMMERCE_AD_GOAL_OPTIONS = ['点击引流', '转化购买', '新品曝光', '限时促销', '再营销召回'];
export const ECOMMERCE_AD_HOOK_STRENGTH_OPTIONS = [
  { value: 'balanced', label: '平衡' },
  { value: 'strong', label: '强吸引' },
  { value: 'soft', label: '克制可信' },
];
export const ECOMMERCE_COMPLIANCE_LEVEL_OPTIONS = [
  { value: 'standard', label: '标准合规' },
  { value: 'strict', label: '严格合规' },
  { value: 'flexible', label: '适度营销' },
];
export const ECOMMERCE_SOCIAL_PLATFORM_OPTIONS = ['小红书', 'Instagram', 'Pinterest', 'TikTok', '抖音', '通用社媒'];
export const ECOMMERCE_SOCIAL_ANGLE_OPTIONS = ['买家真实分享', '达人推荐', '开箱体验', '使用体验', '对比测评', '生活方式灵感'];
export const ECOMMERCE_PEOPLE_POLICY_OPTIONS = [
  { value: 'auto', label: 'AI 判断' },
  { value: 'no_people', label: '不出现人物' },
  { value: 'hands_only', label: '只出现手部/局部' },
  { value: 'allow_people', label: '允许人物出镜' },
];
export const ECOMMERCE_BRAND_GOAL_OPTIONS = ['店铺首页视觉', '品牌故事', '产品系列展示', 'Amazon A+品牌模块', '活动主视觉'];
export const ECOMMERCE_BRAND_TONE_OPTIONS = ['高级专业', '自然温和', '年轻活力', '科技理性', '手作质感', '奢华精致'];
export const ECOMMERCE_VIDEO_PLATFORM_OPTIONS = ['TikTok', '抖音', 'Instagram Reels', 'YouTube Shorts', '小红书视频', '通用短视频'];
export const ECOMMERCE_VIDEO_GOAL_OPTIONS = ['种草转化', '产品演示', '开箱展示', '痛点解决', '广告投放'];
export const ECOMMERCE_SCRIPT_TONE_OPTIONS = ['自然口播', '强吸引广告', '测评讲解', '生活方式', '精简字幕'];

export const ECOMMERCE_COMMON_SETTING_UI_BY_CAPABILITY = {
  listing_product_set: {
    requirementsLabel: '卖点与要求',
    requirementsPlaceholder: '例如：突出材质与做工，包含白底主图、场景图和卖点图，不要人物',
    textLabel: '画面文字',
    textOptions: [
      { value: 'finished_text', label: '简短文案' },
      { value: 'rich_text', label: '丰富图文' },
      { value: 'clean', label: '纯视觉商品展示' },
    ],
    platformLabel: '目标平台',
    platformPlaceholder: '可选或输入平台，例如：Amazon、Temu、独立站',
    platformOptions: ECOMMERCE_PLATFORM_OPTIONS,
    regionLabel: '销售地区',
    languageLabel: '文案语言',
    languagePlaceholder: '可选或输入语言',
    focusHelp: '开启后减少多件并列，更聚焦单个商品。',
  },
  detail_page: {
    requirementsLabel: '内容要求',
    requirementsPlaceholder: '例如：完整展示细节、规格、包装与使用步骤，需要更强说明文字',
    textLabel: '画面文字',
    textOptions: [
      { value: 'finished_text', label: '简短说明' },
      { value: 'rich_text', label: '详细图文' },
      { value: 'clean', label: '纯视觉详情图' },
    ],
    platformLabel: '承载平台',
    platformPlaceholder: '可选或输入页面场景，例如：Amazon A+、独立站、淘宝详情',
    platformOptions: ECOMMERCE_PLATFORM_OPTIONS,
    regionLabel: '销售地区',
    languageLabel: '页面语言',
    languagePlaceholder: '可选或输入语言',
    focusHelp: '开启后详情图更聚焦单个商品，减少多件重复陈列。',
  },
  ad_creative: {
    requirementsLabel: '投放要求',
    requirementsPlaceholder: '例如：突出折扣利益点，面向宝妈，转化导向但不过度夸张',
    textLabel: '画面文字',
    textOptions: [
      { value: 'finished_text', label: '短广告文案' },
      { value: 'rich_text', label: '强信息广告' },
      { value: 'clean', label: '纯视觉广告图' },
    ],
    platformLabel: '投放平台',
    platformPlaceholder: '可选或输入广告平台，例如：Meta Ads、TikTok Ads、Google Ads',
    platformOptions: ECOMMERCE_AD_PLATFORM_OPTIONS,
    regionLabel: '投放地区',
    languageLabel: '广告语言',
    languagePlaceholder: '可选或输入语言',
    focusHelp: '开启后广告图只围绕单个商品表达，减少多主体干扰。',
  },
  social_seed_content: {
    requirementsLabel: '内容要求',
    requirementsPlaceholder: '例如：像真实分享，不像硬广，突出使用体验和生活方式',
    textLabel: '画面文字',
    textOptions: [
      { value: 'finished_text', label: '自然短文案' },
      { value: 'rich_text', label: '图文种草' },
      { value: 'clean', label: '纯视觉种草图' },
    ],
    platformLabel: '发布平台',
    platformPlaceholder: '可选或输入内容平台，例如：小红书、Instagram、Pinterest',
    platformOptions: ECOMMERCE_SOCIAL_PLATFORM_OPTIONS,
    hidePlatform: true,
    regionLabel: '发布地区',
    languageLabel: '内容语言',
    languagePlaceholder: '可选或输入语言',
    focusHelp: '开启后内容更突出单个商品，避免画面像产品合集。',
  },
  brand_assets: {
    requirementsLabel: '品牌要求',
    requirementsPlaceholder: '例如：统一品牌视觉，突出品牌调性，适合首页或活动页',
    textLabel: '画面文字',
    textOptions: [
      { value: 'finished_text', label: '简短品牌文案' },
      { value: 'rich_text', label: '完整品牌图文' },
      { value: 'clean', label: '纯视觉品牌图' },
    ],
    platformLabel: '使用场景',
    platformPlaceholder: '可选或输入场景，例如：店铺首页、品牌页、活动页',
    platformOptions: ECOMMERCE_PLATFORM_OPTIONS,
    hidePlatform: true,
    regionLabel: '销售地区',
    languageLabel: '品牌语言',
    languagePlaceholder: '可选或输入语言',
    focusHelp: '开启后品牌图更突出单个核心商品，减少系列产品铺陈。',
  },
  short_video_assets: {
    requirementsLabel: '视频要求',
    requirementsPlaceholder: '例如：前三秒抓人，突出使用过程，口播自然并有转化感',
    textLabel: '画面文字',
    textOptions: [
      { value: 'finished_text', label: '短字幕文案' },
      { value: 'rich_text', label: '脚本图文' },
      { value: 'clean', label: '纯视觉分镜' },
    ],
    platformLabel: '视频平台',
    platformPlaceholder: '可选或输入平台，例如：TikTok、抖音、Reels',
    platformOptions: ECOMMERCE_VIDEO_PLATFORM_OPTIONS,
    hidePlatform: true,
    regionLabel: '投放地区',
    languageLabel: '字幕语言',
    languagePlaceholder: '可选或输入语言',
    focusHelp: '开启后分镜更聚焦单个商品演示，减少多个同款主体。',
  },
};

export function getEcommerceCommonSettingUi(data = {}) {
  return ECOMMERCE_COMMON_SETTING_UI_BY_CAPABILITY[getEcommerceCapability(data)] || ECOMMERCE_COMMON_SETTING_UI_BY_CAPABILITY.listing_product_set;
}

export function getDefaultEcommerceCapabilityFields(capabilityKey) {
  const key = normalizeCapabilityKey(capabilityKey);
  if (key === 'detail_page') {
    return { detailPagePurpose: '通用平台详情页', detailNarrative: 'value_first', detailTrustFocus: '' };
  }
  if (key === 'ad_creative') {
    return { adGoal: '转化购买', adAudience: '', adOffer: '', adHookStrength: 'balanced', adComplianceLevel: 'standard' };
  }
  if (key === 'social_seed_content') {
    return { socialPlatform: '通用社媒', socialAngle: '买家真实分享', creatorPersona: '', realismLevel: '真实自然', peoplePolicy: 'auto' };
  }
  if (key === 'brand_assets') {
    return { brandGoal: '店铺首页视觉', brandTone: '高级专业', brandColors: '', brandStory: '' };
  }
  if (key === 'short_video_assets') {
    return { videoPlatform: '通用短视频', videoGoal: '种草转化', videoDuration: '15-30秒', scriptTone: '自然口播' };
  }
  return {};
}

export function buildEcommerceCapabilityNodePatch(capabilityKey) {
  const key = normalizeCapabilityKey(capabilityKey);
  const config = ECOMMERCE_CAPABILITY_BY_KEY.get(key) || ECOMMERCE_CAPABILITY_BY_KEY.get('listing_product_set');
  return {
    label: config?.label || 'Listing 商品套图',
    note: config?.description || '',
    ecommerceMode: key,
    ecommerceCapability: key,
    setImageCount: config?.smartDefault || config?.smartMin || 6,
    setImageTypes: getDefaultEcommerceSetImageTypes({ ecommerceCapability: key }),
    ...getDefaultEcommerceCapabilityFields(key),
  };
}

function normalizeCapabilityKey(value) {
  const key = String(value || '').trim();
  return ECOMMERCE_CAPABILITY_BY_KEY.has(key) ? key : 'listing_product_set';
}

export function getEcommerceCapability(data = {}) {
  return normalizeCapabilityKey(data?.ecommerceCapability || data?.ecommerceMode);
}

export function getEcommerceCapabilityConfig(data = {}) {
  return ECOMMERCE_CAPABILITY_BY_KEY.get(getEcommerceCapability(data)) || ECOMMERCE_CAPABILITY_BY_KEY.get('listing_product_set');
}

export function getEcommerceModuleTypeOptions(data = {}) {
  return ECOMMERCE_MODULE_TYPE_OPTIONS_BY_CAPABILITY[getEcommerceCapability(data)] || ECOMMERCE_MODULE_TYPE_OPTIONS_BY_CAPABILITY.listing_product_set;
}

export function getDefaultEcommerceSetImageTypes(data = {}) {
  return DEFAULT_ECOMMERCE_SET_IMAGE_TYPES_BY_CAPABILITY[getEcommerceCapability(data)] || DEFAULT_ECOMMERCE_SET_IMAGE_TYPES;
}

export function normalizeEcommerceSetImageTypes(items, data = {}) {
  const options = getEcommerceModuleTypeOptions(data);
  const defaults = getDefaultEcommerceSetImageTypes(data);
  const sourceItems = Array.isArray(items) && items.length ? items : defaults;
  const defaultTypeByKey = new Map(defaults.map((item) => [item.key, item]));
  const byKey = new Map(sourceItems.map((item) => {
    const key = String(item?.key || '') === 'other' ? 'other_ai' : String(item?.key || '');
    return [key, item];
  }));
  const optionKeys = new Set(options.map((option) => option.key));
  const normalized = options.map((option) => {
    const item = byKey.get(option.key) || defaultTypeByKey.get(option.key);
    const count = Math.max(1, Math.min(5, Math.round(Number(item?.count || 1) || 1)));
    return {
      key: option.key,
      label: option.label,
      description: option.description,
      enabled: Boolean(item?.enabled),
      count,
    };
  });
  sourceItems.forEach((item) => {
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

export function getEcommerceImageSetCount(data = {}) {
  const effectiveConfig = data?.ecommerceEffectiveConfig && typeof data.ecommerceEffectiveConfig === 'object'
    ? data.ecommerceEffectiveConfig
    : null;
  const effectiveData = effectiveConfig ? { ...data, ...effectiveConfig } : data;
  const capability = getEcommerceCapabilityConfig(effectiveData);
  if (effectiveData?.structureMode === 'custom') {
    const total = normalizeEcommerceSetImageTypes(effectiveData?.setImageTypes, effectiveData)
      .filter((item) => item.enabled)
      .reduce((sum, item) => sum + Math.max(1, Math.min(5, Number(item.count || 1))), 0);
    return Math.max(1, total || 1);
  }
  const count = Number(effectiveData?.setImageCount || capability.smartDefault || 6);
  if (!Number.isFinite(count)) {
    return capability.smartDefault || 6;
  }
  return Math.min(20, Math.max(Number(capability.smartMin || 1), Math.round(count)));
}

export function describeEcommerceSetImageType(item, data = {}) {
  const typeOptionByKey = new Map(getEcommerceModuleTypeOptions(data).map((option) => [option.key, option]));
  const option = typeOptionByKey.get(String(item?.key || ''));
  const label = String(item?.label || option?.label || item?.key || '').trim();
  const description = String(item?.description || option?.description || '').trim();
  return description ? `${label}：${description}` : label;
}
