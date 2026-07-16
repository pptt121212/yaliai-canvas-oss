import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Crop, Crosshair, Eraser, Maximize2, Trash2, Upload, X } from 'lucide-react';
import { NODE_DEFS } from '../config/nodeDefs.jsx';
import {
  ECOMMERCE_CAPABILITY_OPTIONS,
  ECOMMERCE_AD_GOAL_OPTIONS,
  ECOMMERCE_AD_HOOK_STRENGTH_OPTIONS,
  ECOMMERCE_BRAND_GOAL_OPTIONS,
  ECOMMERCE_BRAND_TONE_OPTIONS,
  ECOMMERCE_COMPLIANCE_LEVEL_OPTIONS,
  ECOMMERCE_COPY_LANGUAGE_OPTIONS,
  ECOMMERCE_DETAIL_NARRATIVE_OPTIONS,
  ECOMMERCE_DETAIL_PAGE_PURPOSE_OPTIONS,
  ECOMMERCE_MARKET_REGION_OPTIONS,
  ECOMMERCE_PEOPLE_POLICY_OPTIONS,
  ECOMMERCE_SCRIPT_TONE_OPTIONS,
  ECOMMERCE_SOCIAL_ANGLE_OPTIONS,
  ECOMMERCE_SOCIAL_PLATFORM_OPTIONS,
  ECOMMERCE_VIDEO_GOAL_OPTIONS,
  ECOMMERCE_VIDEO_PLATFORM_OPTIONS,
  buildEcommerceCapabilityNodePatch,
  getEcommerceCapability,
  getEcommerceCapabilityConfig,
  getEcommerceCommonSettingUi,
  getEcommerceImageSetCount,
  normalizeEcommerceSetImageTypes,
} from '../utils/ecommerce.js';

const CANVAS_NODE_DRAG_MIME = 'application/x-yali-canvas-node';

function setCanvasNodeDragPayload(event, type, dataPatch = {}) {
  event.dataTransfer?.setData(CANVAS_NODE_DRAG_MIME, JSON.stringify({ type, dataPatch }));
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy';
  }
}

const SIZE_TIER_DEFINITIONS = [
  {
    key: 'auto',
    label: '自动',
    ratios: { auto: 'auto' },
  },
  {
    key: 'standard',
    label: '标准',
    ratios: {
      landscape: '1280x720',
      portrait: '720x1280',
      square: '1024x1024',
      fourThree: '960x720',
      threeFour: '720x960',
    },
  },
  {
    key: 'hd',
    label: '高清',
    ratios: {
      landscape: '1792x1008',
      portrait: '1008x1792',
      square: '1536x1536',
      fourThree: '1600x1200',
      threeFour: '1200x1600',
    },
  },
  {
    key: 'large',
    label: '超清',
    ratios: {
      landscape: '2048x1152',
      portrait: '1152x2048',
      square: '2048x2048',
      fourThree: '1920x1440',
      threeFour: '1440x1920',
    },
  },
  {
    key: 'max',
    label: '最大',
    ratios: {
      landscape: '3840x2160',
      portrait: '2016x3584',
      square: '2880x2880',
      fourThree: '3200x2400',
      threeFour: '2400x3200',
    },
  },
];

const SIZE_RATIO_DEFINITIONS = [
  { key: 'landscape', label: '16:9', detail: '横图', icon: 'wide' },
  { key: 'portrait', label: '9:16', detail: '竖图', icon: 'tall' },
  { key: 'fourThree', label: '4:3', detail: '横图', icon: 'classic' },
  { key: 'threeFour', label: '3:4', detail: '竖图', icon: 'poster' },
  { key: 'square', label: '1:1', detail: '方图', icon: 'square' },
];

function getSizePickerState(size) {
  const value = String(size || 'auto').trim();
  if (!value || value === 'auto') {
    return { tier: 'auto', ratio: 'auto', value: 'auto' };
  }

  for (const tier of SIZE_TIER_DEFINITIONS) {
    for (const [ratio, sizeValue] of Object.entries(tier.ratios || {})) {
      if (sizeValue === value) {
        return { tier: tier.key, ratio, value };
      }
    }
  }

  return { tier: 'other', ratio: '', value };
}

function getSizeTier(key) {
  return SIZE_TIER_DEFINITIONS.find((tier) => tier.key === key) || SIZE_TIER_DEFINITIONS[0];
}

function resolvePresetSize(tierKey, ratioKey) {
  const tier = getSizeTier(tierKey);
  if (tier.key === 'auto') {
    return 'auto';
  }

  return tier.ratios[ratioKey] || tier.ratios.landscape || Object.values(tier.ratios)[0] || 'auto';
}

function formatSizeValue(size) {
  const value = String(size || 'auto').trim();
  return value === 'auto' ? '自动' : value.replace('x', ' x ');
}

export function CreateMenu({ menu, onCreate, onClose, title = '添加节点', compact = false, types: providedTypes = null }) {
  const types = useMemo(() => {
    if (Array.isArray(providedTypes)) {
      return providedTypes;
    }
    return compact ? ['reference', 'localReference', 'generate', 'imageExplosion', 'ecommerceImage', 'output'] : Object.keys(NODE_DEFS);
  }, [compact, providedTypes]);
  const menuRef = useRef(null);
  const ecommerceItemRef = useRef(null);
  const ecommerceSubmenuRef = useRef(null);
  const ecommerceSubmenuCloseTimerRef = useRef(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const [submenuStyle, setSubmenuStyle] = useState(null);
  const [ecommerceSubmenuOpen, setEcommerceSubmenuOpen] = useState(false);

  const clearEcommerceSubmenuCloseTimer = () => {
    if (ecommerceSubmenuCloseTimerRef.current) {
      window.clearTimeout(ecommerceSubmenuCloseTimerRef.current);
      ecommerceSubmenuCloseTimerRef.current = null;
    }
  };

  const openEcommerceSubmenu = () => {
    clearEcommerceSubmenuCloseTimer();
    setEcommerceSubmenuOpen(true);
  };

  const closeEcommerceSubmenuSoon = () => {
    clearEcommerceSubmenuCloseTimer();
    ecommerceSubmenuCloseTimerRef.current = window.setTimeout(() => {
      setEcommerceSubmenuOpen(false);
      ecommerceSubmenuCloseTimerRef.current = null;
    }, 160);
  };

  useLayoutEffect(() => () => {
    clearEcommerceSubmenuCloseTimer();
  }, []);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) {
      return;
    }

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const rect = element.getBoundingClientRect();
    const margin = 16;
    const maxLeft = Math.max(margin, viewportWidth - rect.width - margin);
    const maxTop = Math.max(margin, viewportHeight - rect.height - margin);

    const nextLeft = Math.min(Math.max(menu.x, margin), maxLeft);
    const nextTop = Math.min(Math.max(menu.y, margin), maxTop);

    setPosition((current) => (
      current.left === nextLeft && current.top === nextTop
        ? current
        : { left: nextLeft, top: nextTop }
    ));
  }, [menu.x, menu.y, title, types]);

  useLayoutEffect(() => {
    const menuElement = menuRef.current;
    const itemElement = ecommerceItemRef.current;
    const submenuElement = ecommerceSubmenuRef.current;
    if (!menuElement || !itemElement || !submenuElement) {
      setSubmenuStyle(null);
      return;
    }

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const margin = 16;
    const itemRect = itemElement.getBoundingClientRect();
    const submenuRect = submenuElement.getBoundingClientRect();
    const maxHeight = Math.max(180, viewportHeight - margin * 2);
    const desiredViewportTop = itemRect.top - 4;
    const adjustedViewportTop = Math.min(
      Math.max(desiredViewportTop, margin),
      Math.max(margin, viewportHeight - Math.min(submenuRect.height, maxHeight) - margin)
    );
    const nextStyle = {
      top: `${Math.round(adjustedViewportTop - itemRect.top)}px`,
      maxHeight: `${Math.round(maxHeight)}px`,
    };

    setSubmenuStyle((current) => (
      current?.top === nextStyle.top && current?.maxHeight === nextStyle.maxHeight
        ? current
        : nextStyle
    ));
  }, [position.left, position.top, title, types]);

  const content = (
    <div
      ref={menuRef}
      className="create-menu"
      style={{ left: position.left, top: position.top }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="create-menu-head">
        <strong>{title}</strong>
        <button type="button" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {types.length ? (
        <div className="create-menu-grid">
          {types.map((type) => {
            const def = NODE_DEFS[type];
            if (!def) {
              return null;
            }
            const Icon = def.icon;
            const isEcommerce = type === 'ecommerceImage';
            const createDefault = () => onCreate(type, isEcommerce ? buildEcommerceCapabilityNodePatch('listing_product_set') : null);
            return (
              <div
                key={type}
                ref={isEcommerce ? ecommerceItemRef : null}
                className={isEcommerce ? 'create-menu-item-wrap has-submenu' : 'create-menu-item-wrap'}
                onMouseEnter={isEcommerce ? openEcommerceSubmenu : undefined}
                onMouseLeave={isEcommerce ? closeEcommerceSubmenuSoon : undefined}
                onFocus={isEcommerce ? openEcommerceSubmenu : undefined}
                onBlur={isEcommerce ? closeEcommerceSubmenuSoon : undefined}
              >
                <button
                  type="button"
                  onClick={createDefault}
                  draggable={isEcommerce}
                  onDragStart={isEcommerce ? (event) => setCanvasNodeDragPayload(event, 'ecommerceImage', buildEcommerceCapabilityNodePatch('listing_product_set')) : undefined}
                >
                  <Icon size={16} />
                  <span>{def.label}</span>
                  <em>{def.detail}</em>
                </button>
                {isEcommerce ? (
                  <div
                    ref={ecommerceSubmenuRef}
                    className={`create-menu-submenu${ecommerceSubmenuOpen ? ' is-open' : ''}`}
                    style={submenuStyle || undefined}
                    role="menu"
                    aria-label="选择电商图能力"
                    onMouseEnter={openEcommerceSubmenu}
                    onMouseLeave={closeEcommerceSubmenuSoon}
                  >
                    {ECOMMERCE_CAPABILITY_OPTIONS.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className="create-menu-subitem"
                        draggable
                        onClick={() => onCreate('ecommerceImage', buildEcommerceCapabilityNodePatch(item.key))}
                        onDragStart={(event) => setCanvasNodeDragPayload(event, 'ecommerceImage', buildEcommerceCapabilityNodePatch(item.key))}
                      >
                        <strong>{item.label}</strong>
                        <small>{item.description}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="create-menu-empty">当前节点没有可创建并连接的下游节点。</div>
      )}
    </div>
  );

  return createPortal(content, document.body);
}

const ECOMMERCE_HERO_DESCRIPTION_MAP = {
  listing_product_set: '生成一组可直接上架使用的商品图。',
  detail_page: '生成一组用于详情页说明的模块图。',
  ad_creative: '生成一组更适合投放转化的广告图。',
  social_seed_content: '生成一组更像真实分享的种草图。',
  brand_assets: '生成一组统一品牌视觉的素材图。',
  short_video_assets: '生成一组短视频封面与分镜素材。',
};

const ECOMMERCE_CAPABILITY_PANEL_CONFIG = {
  detail_page: {
    eyebrow: '当前类型',
    title: '详情重点',
    fields: [
      { key: 'detailPagePurpose', label: '页面用途', kind: 'datalist', options: ECOMMERCE_DETAIL_PAGE_PURPOSE_OPTIONS, placeholder: '例如：Amazon A+、独立站详情', fallback: '通用平台详情页' },
      { key: 'detailNarrative', label: '内容重点', kind: 'select', options: ECOMMERCE_DETAIL_NARRATIVE_OPTIONS, fallback: 'value_first' },
      { key: 'detailTrustFocus', label: '证明重点', kind: 'input', placeholder: '例如：材质、使用步骤、售后保障', span: 'full' },
    ],
  },
  ad_creative: {
    eyebrow: '当前类型',
    title: '广告重点',
    fields: [
      { key: 'adGoal', label: '投放目标', kind: 'datalist', options: ECOMMERCE_AD_GOAL_OPTIONS, placeholder: '例如：转化购买、限时促销', fallback: '转化购买' },
      { key: 'adHookStrength', label: '表达强度', kind: 'select', options: ECOMMERCE_AD_HOOK_STRENGTH_OPTIONS, fallback: 'balanced' },
      { key: 'adAudience', label: '目标人群', kind: 'input', placeholder: '例如：年轻妈妈、户外人群' },
      { key: 'adComplianceLevel', label: '合规强度', kind: 'select', options: ECOMMERCE_COMPLIANCE_LEVEL_OPTIONS, fallback: 'standard' },
      { key: 'adOffer', label: '活动信息', kind: 'input', placeholder: '只填真实活动，留空则不强调优惠', span: 'full' },
    ],
  },
  social_seed_content: {
    eyebrow: '当前类型',
    title: '内容重点',
    fields: [
      { key: 'socialPlatform', label: '内容平台', kind: 'datalist', options: ECOMMERCE_SOCIAL_PLATFORM_OPTIONS, placeholder: '例如：小红书、Instagram', fallback: '通用社媒' },
      { key: 'socialAngle', label: '内容视角', kind: 'datalist', options: ECOMMERCE_SOCIAL_ANGLE_OPTIONS, placeholder: '例如：买家分享、开箱体验', fallback: '买家真实分享' },
      { key: 'creatorPersona', label: '内容人设', kind: 'input', placeholder: '例如：真实买家、家居博主' },
      { key: 'peoplePolicy', label: '人物出镜', kind: 'select', options: ECOMMERCE_PEOPLE_POLICY_OPTIONS, fallback: 'auto' },
      { key: 'realismLevel', label: '真实感', kind: 'input', placeholder: '例如：真实自然、精致但不广告', span: 'full', fallback: '真实自然' },
    ],
  },
  brand_assets: {
    eyebrow: '当前类型',
    title: '品牌重点',
    fields: [
      { key: 'brandGoal', label: '品牌目标', kind: 'datalist', options: ECOMMERCE_BRAND_GOAL_OPTIONS, placeholder: '例如：店铺首页、活动页', fallback: '店铺首页视觉' },
      { key: 'brandTone', label: '品牌调性', kind: 'datalist', options: ECOMMERCE_BRAND_TONE_OPTIONS, placeholder: '例如：高级专业、年轻活力', fallback: '高级专业' },
      { key: 'brandColors', label: '品牌视觉', kind: 'input', placeholder: '例如：奶油白 + 橄榄绿，极简高级' },
      { key: 'brandStory', label: '品牌主张', kind: 'textarea', placeholder: '填写真实理念、故事或长期主张', span: 'full' },
    ],
  },
  short_video_assets: {
    eyebrow: '当前类型',
    title: '视频重点',
    fields: [
      { key: 'videoPlatform', label: '视频平台', kind: 'datalist', options: ECOMMERCE_VIDEO_PLATFORM_OPTIONS, placeholder: '例如：TikTok、抖音', fallback: '通用短视频' },
      { key: 'videoGoal', label: '视频目标', kind: 'datalist', options: ECOMMERCE_VIDEO_GOAL_OPTIONS, placeholder: '例如：种草转化、产品演示', fallback: '种草转化' },
      { key: 'videoDuration', label: '视频时长', kind: 'input', placeholder: '例如：15秒、30秒', fallback: '15-30秒' },
      { key: 'scriptTone', label: '文案口吻', kind: 'datalist', options: ECOMMERCE_SCRIPT_TONE_OPTIONS, placeholder: '例如：自然口播、测评讲解', fallback: '自然口播' },
    ],
  },
};

function EcommerceSection({ eyebrow, title, badge, className = '', children }) {
  return (
    <section className={`ecommerce-settings-section ${className}`.trim()}>
      <div className="ecommerce-settings-section__head">
        <div>
          {eyebrow ? <span className="ecommerce-settings-section__eyebrow">{eyebrow}</span> : null}
          <strong>{title}</strong>
        </div>
        {badge ? <span>{badge}</span> : null}
      </div>
      {children}
    </section>
  );
}

function EcommerceConfigField({ field, value, locked, onChange }) {
  const listId = field.kind === 'datalist' ? `ecommerce-field-${field.key}` : undefined;
  const normalizedValue = value ?? field.fallback ?? '';
  const className = `field ecommerce-config-field${field.span === 'full' ? ' is-full' : ''}`;
  const options = Array.isArray(field.options) ? field.options : [];
  const renderOptions = () => options.map((item) => {
    if (item && typeof item === 'object') {
      return <option key={item.value} value={item.value}>{item.label}</option>;
    }
    return <option key={item} value={item} />;
  });

  return (
    <label className={className}>
      <span>{field.label}</span>
      {field.kind === 'textarea' ? (
        <textarea
          value={normalizedValue}
          disabled={locked}
          rows={field.rows || 3}
          placeholder={field.placeholder || ''}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
      ) : null}
      {field.kind === 'select' ? (
        <select value={normalizedValue} disabled={locked} onChange={(event) => onChange(field.key, event.target.value)}>
          {renderOptions()}
        </select>
      ) : null}
      {field.kind === 'datalist' ? (
        <>
          <input
            list={listId}
            value={normalizedValue}
            disabled={locked}
            placeholder={field.placeholder || ''}
            onChange={(event) => onChange(field.key, event.target.value)}
          />
          <datalist id={listId}>
            {renderOptions()}
          </datalist>
        </>
      ) : null}
      {field.kind === 'input' ? (
        <input
          value={normalizedValue}
          disabled={locked}
          placeholder={field.placeholder || ''}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
      ) : null}
    </label>
  );
}

function EcommerceTextModePreview({ mode }) {
  const previewClassName = `ecommerce-text-preview is-${mode || 'finished_text'}`;
  return (
    <div className={previewClassName} aria-hidden="true">
      <i className="ecommerce-text-preview__media" />
      <span className="ecommerce-text-preview__line line-1" />
      <span className="ecommerce-text-preview__line line-2" />
      <span className="ecommerce-text-preview__line line-3" />
    </div>
  );
}

export function Inspector({ node, rootConfig, outputGeneratedInputCount = 0, outputRequiresZip = false, locked = false, onUpdate, onClearResult, onDelete, onUpload, onOpenEditor, onPreview }) {
  if (!node) {
    return null;
  }

  const data = node.data || {};
  const referenceWholeInstruction = String(data.referenceInstruction ?? data.wholeInstruction ?? '');
  const displayLabel = node.type === 'generate' && String(data.label || '').trim() === '生成'
    ? '生成图片'
    : (data.label || NODE_DEFS[node.type]?.label);
  const localReferenceCircles = Array.isArray(data.circles) ? data.circles : [];
  const hasLocalReferencePrompt = localReferenceCircles.some((circle) => String(circle?.text || '').trim());
  const isGenerationSettingsNode = node.type === 'generate' || node.type === 'imageExplosion' || node.type === 'ecommerceImage';
  const sizePickerState = isGenerationSettingsNode ? getSizePickerState(data.size) : null;
  const selectedSizeTier = sizePickerState ? getSizeTier(sizePickerState.tier) : null;
  const selectedSizeValue = data.useCustomSize
    ? `${data.customWidth || 1280} x ${data.customHeight || 720}`
    : formatSizeValue(sizePickerState?.value);
  const presetDisabled = locked || Boolean(data.useCustomSize);
  const canClearResult = ['generate', 'imageExplosion', 'ecommerceImage'].includes(node.type)
    && (String(data.imageUrl || data.referenceUrl || '').trim() !== '' || (Array.isArray(data.resultItems) && data.resultItems.length > 0));
  const resultItems = Array.isArray(data.resultItems) ? data.resultItems : [];
  const resultDoneCount = resultItems.filter((item) => item?.imageUrl || item?.downloadUrl || item?.referenceUrl).length;
  const previewResultImageUrl = String(data.imageUrl || data.referenceUrl || data.outputUrl || '').trim();
  const ecommerceCapability = node.type === 'ecommerceImage' ? getEcommerceCapability(data) : '';
  const ecommerceCapabilityConfig = node.type === 'ecommerceImage' ? getEcommerceCapabilityConfig(data) : null;
  const ecommerceCommonUi = node.type === 'ecommerceImage' ? getEcommerceCommonSettingUi(data) : null;
  const ecommerceSetImageCount = node.type === 'ecommerceImage' ? getEcommerceImageSetCount(data) : 0;
  const ecommerceSetImageTypes = node.type === 'ecommerceImage' ? normalizeEcommerceSetImageTypes(data.setImageTypes, data) : [];
  const ecommerceTextOptions = ecommerceCommonUi?.textOptions || [
    { value: 'finished_text', label: '简短文案' },
    { value: 'rich_text', label: '丰富图文' },
    { value: 'clean', label: '纯视觉商品展示' },
  ];
  const ecommercePresetTypeOptions = ecommerceSetImageTypes.filter((item) => !item.custom);
  const ecommerceCustomTypeOptions = ecommerceSetImageTypes.filter((item) => item.custom);
  const [customTypeLabel, setCustomTypeLabel] = useState('');
  const [customTypeDescription, setCustomTypeDescription] = useState('');
  const ecommerceStructureMode = node.type === 'ecommerceImage' ? (data.structureMode || 'smart') : '';
  const ecommerceTextMode = node.type === 'ecommerceImage' ? (data.textMode || 'finished_text') : 'finished_text';
  const ecommerceTextOption = ecommerceTextOptions.find((item) => item.value === ecommerceTextMode) || ecommerceTextOptions[0] || null;
  const ecommerceTextModeDescriptions = {
    finished_text: '少量标题',
    rich_text: '更多说明',
    clean: '不出文字',
  };
  const ecommerceCapabilityPanelConfig = ECOMMERCE_CAPABILITY_PANEL_CONFIG[ecommerceCapability] || null;
  const ecommercePlanningSummary = node.type === 'ecommerceImage'
    ? (ecommerceStructureMode === 'smart'
      ? `AI 自动规划${data.ecommerceEffectiveConfig?.setImageCount ? ` ${data.ecommerceEffectiveConfig.setImageCount} 张` : ''}`
      : `当前 ${ecommerceSetImageCount} 张${ecommerceCapabilityConfig?.shortLabel || '素材'}`)
    : '';
  const ecommerceHeroPills = node.type === 'ecommerceImage'
    ? [
      ecommerceTextOption?.label || '未设文字',
      ecommerceStructureMode === 'smart' ? 'AI 规划' : '手动规划',
      `预计 1 + ${ecommerceSetImageCount} 张`,
      Number(data.estimatedCreditCost || 0) > 0 ? `预计 ${Number(data.estimatedCreditCost || 0)} 积分` : '',
    ].filter(Boolean)
    : [];
  const expectedResultCount = node.type === 'imageExplosion'
    ? (resultItems.length || Number(data.elementCount || 6))
    : (node.type === 'ecommerceImage'
      ? (resultItems.length || Math.max(2, ecommerceSetImageCount + 1))
      : (resultItems.length || Number(data.batchTotal || 0) || (data.imageUrl ? 1 : 0)));
  const canPreviewResults = ['generate', 'imageExplosion', 'ecommerceImage'].includes(node.type)
    && (resultItems.length > 0 || previewResultImageUrl || expectedResultCount > 1);
  const openResultPreview = () => {
    onPreview?.({
      title: displayLabel + '结果',
      imageUrl: previewResultImageUrl,
      downloadUrl: data.referenceUrl || data.downloadUrl || previewResultImageUrl,
      items: resultItems,
      expectedCount: expectedResultCount,
      forceGallery: expectedResultCount > 1 || resultItems.length > 1,
    });
  };
  const openReferencePreview = (title) => {
    if (!data.imageUrl) {
      return;
    }
    onPreview?.({
      title,
      previewKind: node.type === 'localReference' ? 'localReference' : 'reference',
      nodeType: node.type,
      editable: false,
      imageUrl: data.imageUrl,
      downloadUrl: data.originalImageUrl || data.imageUrl,
      instruction: node.type === 'localReference' ? (data.localPrompt || '') : (referenceWholeInstruction || ''),
      circleCount: node.type === 'localReference' ? localReferenceCircles.length : 0,
      circles: node.type === 'localReference' ? localReferenceCircles : [],
    });
  };
  return (
    <aside className="floating-inspector">
      <header className="inspector-head">
        <div>
          <strong>{displayLabel}</strong>
          <span>{NODE_DEFS[node.type]?.detail}</span>
        </div>
        <div className="inspector-head-actions">
          {canClearResult ? (
            <button type="button" onClick={onClearResult} title="清空结果" disabled={locked}>
              <Eraser size={16} />
            </button>
          ) : null}
          <button type="button" onClick={onDelete} title="删除节点" disabled={locked}>
            <Trash2 size={16} />
          </button>
        </div>
      </header>

      <label className="field">
        <span>节点名称</span>
        <input value={data.label || ''} disabled={locked} onChange={(event) => onUpdate({ label: event.target.value })} />
      </label>

      {node.type === 'prompt' && (
        <>
          <label className="field">
            <span>提示词</span>
            <textarea
              value={data.prompt || ''}
              disabled={locked}
              onChange={(event) => {
                const prompt = event.target.value;
                onUpdate({ prompt, status: String(prompt || '').trim() ? 'ready' : 'empty', errorMessage: '' });
              }}
            />
          </label>
          <PromptOptimizeControl data={data} locked={locked} onUpdate={onUpdate} />
        </>
      )}

      {node.type === 'batchPrompt' && (
        <>
          <PromptOptimizeControl data={data} locked={locked} onUpdate={onUpdate} />
        </>
      )}

      {node.type === 'reference' && (
        <>
          {data.imageUrl ? (
            <button type="button" className="inspector-preview inspector-preview-button" onClick={() => openReferencePreview(data.label || '参考图预览')}>
              <img src={data.imageUrl} alt="" />
              <span className="inspector-preview-badge">
                <Maximize2 size={13} />
                预览
              </span>
            </button>
          ) : <div className="inspector-preview"><span>未上传参考图</span></div>}
          <label className="field">
            <span>整图指令</span>
            <textarea
              value={referenceWholeInstruction}
              disabled={locked}
              placeholder="描述这张参考图在最终画面中的作用，可以留空"
              onChange={(event) => onUpdate({
                wholeInstruction: event.target.value,
                referenceInstruction: event.target.value,
              })}
            />
          </label>
          <div className="inspector-actions">
            <button type="button" onClick={onUpload} disabled={locked}>
              <Upload size={15} />
              上传
            </button>
            <button type="button" onClick={onOpenEditor} disabled={!data.imageUrl || locked}>
              <Crop size={15} />
              编辑参考图
            </button>
          </div>
        </>
      )}

      {node.type === 'localReference' && (
        <>
          {data.imageUrl ? (
            <button type="button" className="inspector-preview inspector-preview-button" onClick={() => openReferencePreview(data.label || '局部参考图预览')}>
              <img src={data.imageUrl} alt="" />
              <span className="inspector-preview-badge">
                <Maximize2 size={13} />
                预览
              </span>
            </button>
          ) : <div className="inspector-preview"><span>未上传局部参考图</span></div>}
          <div className="local-ref-status local-ref-status--panel">
            <span className={data.imageUrl ? 'is-done' : ''}>图片</span>
            <span className={localReferenceCircles.length ? 'is-done' : ''}>圈选 {localReferenceCircles.length}/7</span>
            <span className={hasLocalReferencePrompt ? 'is-done' : ''}>提示词</span>
          </div>
          <label className="field">
            <span>局部提示词</span>
            <textarea value={data.localPrompt || ''} disabled={locked} onChange={(event) => onUpdate({ localPrompt: event.target.value })} />
          </label>
          <div className="inspector-actions">
            <button type="button" onClick={onUpload} disabled={locked}>
              <Upload size={15} />
              上传
            </button>
            <button type="button" onClick={onOpenEditor} disabled={!data.imageUrl || locked}>
              <Crosshair size={15} />
              圈选局部
            </button>
          </div>
        </>
      )}

      {node.type === 'imageExplosion' && (
        <>
          <ResultSummary
            doneCount={resultDoneCount}
            expectedCount={expectedResultCount}
            buttonText="查看爆炸结果"
            disabled={!canPreviewResults}
            onPreview={openResultPreview}
          />
          <p className="inspector-note">
            图片大爆炸需要连接一个前置图片节点。这里的拆解数量，就是本节点后续要生成的元素图片数量；实际生成规则和耗时由当前接入的上游适配器决定。
          </p>
          <label className="field">
            <span>提取模式</span>
            <select
              value={data.extractionMode || (data.explosionMode === 'clean' ? 'clean_material' : 'original')}
              disabled={locked}
              onChange={(event) => onUpdate({ extractionMode: event.target.value })}
            >
              <option value="clean_material">纯素材提取</option>
              <option value="original">原样提取</option>
            </select>
          </label>
          <p className="inspector-note">
            纯素材提取会尽量拆成干净主体或局部素材；原样提取会保留画面原有版式、背景、文字和视觉关系中对目标片段有价值的部分。
          </p>
          <label className="field">
            <span>拆解指令</span>
            <textarea
              value={data.explosionInstruction || ''}
              disabled={locked}
              placeholder="可选，例如：只拆主要人物、服饰和道具，不拆背景"
              onChange={(event) => onUpdate({ explosionInstruction: event.target.value })}
            />
          </label>
          <label className="field">
            <span>拆解数量</span>
            <input
              type="number"
              min="1"
              max="20"
              step="1"
              value={data.elementCount || 6}
              disabled={locked}
              onChange={(event) => onUpdate({ elementCount: Math.max(1, Math.min(20, Number(event.target.value) || 1)) })}
            />
          </label>
          <p className="inspector-note">
            当前计划会尝试生成 {Number(data.elementCount || 6)} 张元素图。
          </p>
        </>
      )}

      {node.type === 'ecommerceImage' && (
        <>
          <div className="ecommerce-settings-shell">
            <section className="ecommerce-task-hero">
              <p className="ecommerce-task-hero__summary">
                {ECOMMERCE_HERO_DESCRIPTION_MAP[ecommerceCapability] || '生成一组电商图片素材。'}
              </p>
              <div className="ecommerce-hero-pills">
                {ecommerceHeroPills.map((item) => (
                  <span key={item} className="ecommerce-hero-pill">{item}</span>
                ))}
              </div>
            </section>

            <ResultSummary
              doneCount={resultDoneCount}
              expectedCount={expectedResultCount}
              buttonText="查看结果"
              disabled={!canPreviewResults}
              onPreview={openResultPreview}
            />

            <EcommerceSection title={ecommerceCommonUi?.requirementsLabel || '内容要求'}>
              <label className="field field--featured field--bare">
                <textarea
                  value={data.userRequirements || ''}
                  disabled={locked}
                  placeholder={ecommerceCommonUi?.requirementsPlaceholder || '可选，例如：突出材质、适合首图、不要人物'}
                  onChange={(event) => onUpdate({ userRequirements: event.target.value })}
                />
              </label>
              <label className="field field--bare">
                <span>风格方向</span>
                <textarea
                  value={data.styleDirection || ''}
                  disabled={locked}
                  placeholder="例如：清爽专业、东南亚电商风、真实照片质感"
                  onChange={(event) => onUpdate({ styleDirection: event.target.value })}
                />
              </label>
            </EcommerceSection>

            <EcommerceSection title={ecommerceCommonUi?.textLabel || '画面文字'}>
              <div className="ecommerce-choice-group">
                <div className="ecommerce-choice-grid">
                  {ecommerceTextOptions.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={`ecommerce-choice-card${ecommerceTextMode === item.value ? ' is-active' : ''}`}
                      disabled={locked}
                      onClick={() => onUpdate({ textMode: item.value })}
                    >
                      <EcommerceTextModePreview mode={item.value} />
                      <strong>{item.label}</strong>
                      <small>{ecommerceTextModeDescriptions[item.value] || '按当前模式生成。'}</small>
                    </button>
                  ))}
                </div>
              </div>
              <div className="ecommerce-form-grid">
                {ecommerceCommonUi?.hidePlatform ? null : (
                  <label className="field ecommerce-config-field is-full">
                    <span>{ecommerceCommonUi?.platformLabel || '目标平台'}</span>
                    <input
                      list="ecommerce-platform-options"
                      value={data.platform || ''}
                      disabled={locked}
                      placeholder={ecommerceCommonUi?.platformPlaceholder || '可选或输入平台，例如：Amazon、Temu、独立站'}
                      onChange={(event) => onUpdate({ platform: event.target.value })}
                    />
                    <datalist id="ecommerce-platform-options">
                      {(ecommerceCommonUi?.platformOptions || []).map((item) => <option key={item} value={item} />)}
                    </datalist>
                  </label>
                )}
                <label className="field">
                  <span>{ecommerceCommonUi?.regionLabel || '销售地区'}</span>
                  <select
                    value={data.marketRegion || '全球/通用'}
                    disabled={locked}
                    onChange={(event) => onUpdate({ marketRegion: event.target.value })}
                  >
                    {ECOMMERCE_MARKET_REGION_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>{ecommerceCommonUi?.languageLabel || '文案语言'}</span>
                  <input
                    list="ecommerce-copy-language-options"
                    value={data.copyLanguage || ''}
                    disabled={locked}
                    placeholder={ecommerceCommonUi?.languagePlaceholder || '可选或输入语言'}
                    onChange={(event) => onUpdate({ copyLanguage: event.target.value })}
                  />
                  <datalist id="ecommerce-copy-language-options">
                    {ECOMMERCE_COPY_LANGUAGE_OPTIONS.map((item) => <option key={item} value={item} />)}
                  </datalist>
                </label>
              </div>
            </EcommerceSection>

            {ecommerceCapabilityPanelConfig ? (
              <EcommerceSection
                eyebrow={ecommerceCapabilityPanelConfig.eyebrow}
                title={ecommerceCapabilityPanelConfig.title}
                badge={ecommerceCapabilityConfig?.shortLabel || '专属'}
                className="ecommerce-capability-panel"
              >
                <div className="ecommerce-form-grid">
                  {ecommerceCapabilityPanelConfig.fields.map((field) => (
                    <EcommerceConfigField
                      key={field.key}
                      field={field}
                      value={data[field.key]}
                      locked={locked}
                      onChange={(key, value) => onUpdate({ [key]: value })}
                    />
                  ))}
                </div>
              </EcommerceSection>
            ) : null}

            <EcommerceSection title="出图规划" badge={ecommercePlanningSummary} className="ecommerce-structure-panel">
              <div className="ecommerce-planning-grid">
                <button
                  type="button"
                  className={`ecommerce-planning-card${ecommerceStructureMode === 'smart' ? ' is-active' : ''}`}
                  disabled={locked}
                  onClick={() => onUpdate({ structureMode: 'smart' })}
                >
                  <strong>AI 智能规划</strong>
                  <small>自动规划类型和数量</small>
                </button>
                <button
                  type="button"
                  className={`ecommerce-planning-card${ecommerceStructureMode !== 'smart' ? ' is-active' : ''}`}
                  disabled={locked}
                  onClick={() => onUpdate({ structureMode: 'custom', setImageTypes: ecommerceSetImageTypes })}
                >
                  <strong>手动配置</strong>
                  <small>自己控制类型和张数</small>
                </button>
              </div>
              {ecommerceStructureMode === 'smart' ? (
                <label className="field">
                  <span>最少商品图数量</span>
                  <input
                    type="number"
                    min={ecommerceCapabilityConfig?.smartMin || 1}
                    max="30"
                    step="1"
                    value={data.setImageCount || ecommerceCapabilityConfig?.smartDefault || 6}
                    disabled={locked}
                    onChange={(event) => {
                      const min = ecommerceCapabilityConfig?.smartMin || 1;
                      const fallback = ecommerceCapabilityConfig?.smartDefault || min;
                      onUpdate({ setImageCount: Math.max(min, Math.min(30, Number(event.target.value) || fallback)) });
                    }}
                  />
                </label>
              ) : (
                <>
                  <div className="ecommerce-type-grid">
                    {ecommercePresetTypeOptions.map((item) => {
                      const updateItem = (patch) => {
                        onUpdate({
                          structureMode: 'custom',
                          setImageTypes: ecommerceSetImageTypes.map((current) => (
                            current.key === item.key ? { ...current, ...patch } : current
                          )),
                        });
                      };
                      return (
                        <div key={item.key} className={`ecommerce-type-card${item.enabled ? ' is-enabled' : ''}`}>
                          <div className="ecommerce-type-card__top">
                            <label>
                              <input
                                type="checkbox"
                                checked={Boolean(item.enabled)}
                                disabled={locked}
                                onChange={(event) => updateItem({ enabled: event.target.checked })}
                              />
                              <span>{item.label}</span>
                            </label>
                            <div className="ecommerce-type-count">
                              <button type="button" disabled={locked || !item.enabled || item.count <= 1} onClick={() => updateItem({ count: Math.max(1, Number(item.count || 1) - 1) })}>-</button>
                              <input
                                type="number"
                                min="1"
                                max="5"
                                step="1"
                                value={item.count}
                                disabled={locked || !item.enabled}
                                onChange={(event) => updateItem({ count: Math.max(1, Math.min(5, Number(event.target.value) || 1)) })}
                              />
                              <button type="button" disabled={locked || !item.enabled || item.count >= 5} onClick={() => updateItem({ count: Math.min(5, Number(item.count || 1) + 1) })}>+</button>
                            </div>
                          </div>
                          <p>{item.description}</p>
                        </div>
                      );
                    })}
                    {ecommerceCustomTypeOptions.map((item) => {
                      const updateItem = (patch) => {
                        onUpdate({
                          structureMode: 'custom',
                          setImageTypes: ecommerceSetImageTypes.map((current) => (
                            current.key === item.key ? { ...current, ...patch } : current
                          )),
                        });
                      };
                      const removeItem = () => {
                        onUpdate({
                          structureMode: 'custom',
                          setImageTypes: ecommerceSetImageTypes.filter((current) => current.key !== item.key),
                        });
                      };
                      return (
                        <div key={item.key} className="ecommerce-type-card ecommerce-type-card--custom is-enabled">
                          <div className="ecommerce-type-card__top">
                            <label>
                              <input type="checkbox" checked={Boolean(item.enabled)} disabled={locked} onChange={(event) => updateItem({ enabled: event.target.checked })} />
                              <input
                                className="ecommerce-type-name-input"
                                value={item.label}
                                disabled={locked}
                                maxLength={18}
                                placeholder="自定义类型"
                                onChange={(event) => updateItem({ label: event.target.value })}
                              />
                            </label>
                            <div className="ecommerce-type-count">
                              <button type="button" disabled={locked || !item.enabled || item.count <= 1} onClick={() => updateItem({ count: Math.max(1, Number(item.count || 1) - 1) })}>-</button>
                              <input type="number" min="1" max="5" step="1" value={item.count} disabled={locked || !item.enabled} onChange={(event) => updateItem({ count: Math.max(1, Math.min(5, Number(event.target.value) || 1)) })} />
                              <button type="button" disabled={locked || !item.enabled || item.count >= 5} onClick={() => updateItem({ count: Math.min(5, Number(item.count || 1) + 1) })}>+</button>
                            </div>
                          </div>
                          <div className="ecommerce-type-custom-row">
                            <input value={item.description || ''} disabled={locked} maxLength={42} placeholder="可选说明" onChange={(event) => updateItem({ description: event.target.value })} />
                            <button type="button" disabled={locked} onClick={removeItem}>删除</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="ecommerce-type-add-panel">
                    <span className="ecommerce-type-add-panel__label">自定义类型</span>
                    <div className="ecommerce-type-add-form">
                      <input value={customTypeLabel} disabled={locked} maxLength={18} placeholder="类型名称" onChange={(event) => setCustomTypeLabel(event.target.value)} />
                      <input value={customTypeDescription} disabled={locked} maxLength={42} placeholder="可选说明" onChange={(event) => setCustomTypeDescription(event.target.value)} />
                      <button
                        type="button"
                        disabled={locked || !customTypeLabel.trim()}
                        onClick={() => {
                          const label = customTypeLabel.trim();
                          if (!label) {
                            return;
                          }
                          const key = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
                          onUpdate({
                            structureMode: 'custom',
                            setImageTypes: ecommerceSetImageTypes.concat({
                              key,
                              label,
                              description: customTypeDescription.trim(),
                              enabled: true,
                              count: 1,
                              custom: true,
                            }),
                          });
                          setCustomTypeLabel('');
                          setCustomTypeDescription('');
                        }}
                      >
                        添加
                      </button>
                    </div>
                  </div>
                </>
              )}
            </EcommerceSection>

            <EcommerceSection title="约束设置">
              <div className="ecommerce-toggle-grid">
                {ecommerceTextMode !== 'clean' ? (
                  <label className="toggle-field toggle-field--card">
                    <input
                      type="checkbox"
                      checked={data.excludeExtremeCopy !== false}
                      disabled={locked}
                      onChange={(event) => onUpdate({ excludeExtremeCopy: event.target.checked })}
                    />
                    <span><strong>排除极限词</strong></span>
                  </label>
                ) : null}
                <label className="toggle-field toggle-field--card">
                  <input
                    type="checkbox"
                    checked={Boolean(data.focusSingleProduct)}
                    disabled={locked}
                    onChange={(event) => onUpdate({ focusSingleProduct: event.target.checked })}
                  />
                  <span><strong>聚焦单品</strong></span>
                </label>
              </div>
            </EcommerceSection>
          </div>
        </>
      )}

      {isGenerationSettingsNode && (
        <>
          {node.type === 'generate' ? (
            <ResultSummary
              doneCount={resultDoneCount}
              expectedCount={expectedResultCount}
              buttonText="查看生成结果"
              disabled={!canPreviewResults}
              onPreview={openResultPreview}
            />
          ) : null}
          <section className={`size-picker-panel ${data.useCustomSize ? 'is-custom-active' : ''}`}>
            <div className="size-picker-heading">
              <span>尺寸</span>
              <code>{data.useCustomSize ? '自定义' : `当前 ${selectedSizeValue}`}</code>
            </div>
            <div className="size-tier-grid" aria-label="选择分辨率">
              {SIZE_TIER_DEFINITIONS.map((tier) => {
                const isActive = !data.useCustomSize && sizePickerState?.tier === tier.key;
                return (
                  <button
                    key={tier.key}
                    type="button"
                    className={isActive ? 'is-active' : ''}
                    disabled={presetDisabled}
                    onClick={() => {
                      if (tier.key === 'auto') {
                        onUpdate({ size: 'auto', useCustomSize: false });
                        return;
                      }
                      const ratio = selectedSizeTier?.ratios?.[sizePickerState?.ratio] ? sizePickerState.ratio : 'landscape';
                      onUpdate({ size: resolvePresetSize(tier.key, ratio), useCustomSize: false });
                    }}
                  >
                    <strong>{tier.label}</strong>
                  </button>
                );
              })}
            </div>
            {sizePickerState?.tier === 'auto' && !data.useCustomSize ? (
              <div className="size-auto-card">
                <strong>自动</strong>
                <span>由系统按当前任务选择尺寸</span>
              </div>
            ) : (
              <div className="size-ratio-grid" aria-label="选择生成比例">
                {SIZE_RATIO_DEFINITIONS.map((ratio) => {
                  const sizeValue = resolvePresetSize(
                    selectedSizeTier?.key === 'auto' || selectedSizeTier?.key === 'other' ? 'standard' : selectedSizeTier?.key,
                    ratio.key
                  );
                  const isActive = !data.useCustomSize && sizePickerState?.ratio === ratio.key;
                  return (
                    <button
                      key={ratio.key}
                      type="button"
                      className={isActive ? 'is-active' : ''}
                      disabled={presetDisabled}
                      onClick={() => {
                        const tierKey = selectedSizeTier?.key && selectedSizeTier.key !== 'auto' && selectedSizeTier.key !== 'other'
                          ? selectedSizeTier.key
                          : 'standard';
                        onUpdate({ size: resolvePresetSize(tierKey, ratio.key), useCustomSize: false });
                      }}
                    >
                      <i className={`size-ratio-icon size-ratio-icon--${ratio.icon}`} aria-hidden="true" />
                      <strong>{ratio.label}</strong>
                      <span>{ratio.detail} / {formatSizeValue(sizeValue)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
          <label className="toggle-field">
            <input
              type="checkbox"
              checked={Boolean(data.useCustomSize)}
              disabled={locked}
              onChange={(event) => onUpdate({ useCustomSize: event.target.checked })}
            />
            <span>使用自定义尺寸</span>
          </label>
          {data.useCustomSize && (
            <div className="field-grid">
              <label className="field">
                <span>宽度</span>
                <input
                  type="number"
                  min="16"
                  max="3840"
                  step="16"
                  value={data.customWidth || 1280}
                  disabled={locked}
                  onChange={(event) => onUpdate({ customWidth: Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span>高度</span>
                <input
                  type="number"
                  min="16"
                  max="3840"
                  step="16"
                  value={data.customHeight || 720}
                  disabled={locked}
                  onChange={(event) => onUpdate({ customHeight: Number(event.target.value) })}
                />
              </label>
            </div>
          )}
          <label className="field">
            <span>质量</span>
            <select value={data.quality || 'low'} disabled={locked} onChange={(event) => onUpdate({ quality: event.target.value })}>
              <option value="low">标准</option>
              <option value="medium">增强</option>
              <option value="high">精绘</option>
            </select>
          </label>
          <label className="field">
            <span>输出格式</span>
            <select value={data.outputFormat || 'jpeg'} disabled={locked} onChange={(event) => onUpdate({ outputFormat: event.target.value })}>
              <option value="jpeg">JPEG</option>
              <option value="png">PNG</option>
              <option value="webp">WEBP</option>
            </select>
          </label>
          <label className="field">
            <span>图片质量 {data.outputQuality || 100}%</span>
            <input
              type="range"
              min="1"
              max="100"
              value={data.outputQuality || 100}
              disabled={locked}
              onChange={(event) => onUpdate({ outputQuality: Number(event.target.value) })}
            />
          </label>
          <label className="toggle-field">
            <input
              type="checkbox"
              checked={Boolean(data.fastMode)}
              disabled={locked}
              onChange={(event) => onUpdate({ fastMode: event.target.checked })}
            />
            <span>快速生图</span>
          </label>
        </>
      )}

      {node.type === 'output' && (
        <>
          <label className="field">
            <span>输出方式</span>
            <select
              value={outputRequiresZip ? 'zip' : (data.outputMode || 'image_url')}
              disabled={outputRequiresZip || locked}
              onChange={(event) => onUpdate({ outputMode: event.target.value, outputUrl: '', packageUrl: '' })}
            >
              <option value="image_url">图片URL</option>
              <option value="zip">压缩包</option>
            </select>
          </label>
          {outputRequiresZip ? (
            <p className="inspector-note">
              {outputGeneratedInputCount > 1
                ? `当前输出连接了 ${outputGeneratedInputCount} 个生成节点，已自动锁定为压缩包输出。`
                : '当前输出受批量提示词影响，已自动锁定为压缩包输出。'}
            </p>
          ) : null}
        </>
      )}

      <div className="inspector-meta">
        <span>接口状态</span>
        <code>{rootConfig.startEndpoint ? '已接入后端配置' : '本地前端模拟'}</code>
      </div>
    </aside>
  );
}

function PromptOptimizeControl({ data, locked, onUpdate }) {
  const enabled = data.optimizePrompt !== false;
  return (
    <label className={`prompt-optimize-field${enabled ? ' is-on' : ''}`}>
      <span className="prompt-optimize-field__main">
        <span className="prompt-optimize-switch" aria-hidden="true">
          <i />
        </span>
        <span>
          <strong>优化提示词</strong>
        </span>
      </span>
      <input
        type="checkbox"
        checked={enabled}
        disabled={locked}
        onChange={(event) => onUpdate({ optimizePrompt: event.target.checked })}
      />
    </label>
  );
}

function ResultSummary({ doneCount, expectedCount, buttonText, disabled, onPreview }) {
  const safeDoneCount = Math.max(0, Number(doneCount || 0));
  const safeExpectedCount = Math.max(safeDoneCount, Number(expectedCount || 0));
  return (
    <div className="inspector-result-summary">
      <div className="inspector-result-summary__meta">
        <strong>{safeDoneCount}/{safeExpectedCount || 1}</strong>
        <span>已生成结果</span>
      </div>
      <button type="button" className="inspector-result-summary__action" onClick={onPreview} disabled={disabled}>
        <Maximize2 size={14} />
        {buttonText}
      </button>
    </div>
  );
}

export function EdgeInspector({ edge, nodes, locked = false, onDelete }) {
  if (!edge) {
    return null;
  }

  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  return (
    <aside className="edge-inspector">
      <div>
        <strong>连线</strong>
        <span>
          {source?.data?.label || edge.source} → {target?.data?.label || edge.target}
        </span>
      </div>
      <button type="button" onClick={onDelete} disabled={locked}>
        <X size={15} />
        断开连线
      </button>
    </aside>
  );
}

export function RunLog({ history }) {
  return (
    <section className="run-log">
      <strong>运行记录</strong>
      <div>
        {history.length ? history.slice(-4).map((item) => <span key={item.id}>{item.text}</span>) : <span>暂无任务</span>}
      </div>
    </section>
  );
}
