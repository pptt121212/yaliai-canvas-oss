import { DEFAULT_ECOMMERCE_SET_IMAGE_TYPES, getDefaultEcommerceCapabilityFields } from '../utils/ecommerce.js';

export const initialNodes = [
  {
    id: 'prompt-1',
    type: 'prompt',
    position: { x: 40, y: 120 },
    data: {
      label: '主提示词',
      prompt: '一张高级感产品海报，柔和自然光，干净背景，主体清晰，适合社交媒体发布',
      optimizePrompt: true,
      status: 'ready',
    },
  },
  {
    id: 'reference-1',
    type: 'reference',
    position: { x: 40, y: 360 },
    data: {
      label: '参考图',
      note: '拖入或上传图片，作为主体、风格或构图参考。',
      imageUrl: '',
      originalImageUrl: '',
      wholeInstruction: '',
      referenceInstruction: '',
      referenceOrder: 1,
      status: 'empty',
    },
  },
  {
    id: 'generate-1',
    type: 'generate',
    position: { x: 410, y: 150 },
    data: {
      label: '初稿生成',
      size: 'auto',
      useCustomSize: false,
      customWidth: 1280,
      customHeight: 720,
      quality: 'low',
      outputFormat: 'jpeg',
      outputQuality: 100,
      fastMode: false,
      status: 'idle',
      imageUrl: '',
    },
  },
  {
    id: 'output-1',
    type: 'output',
    position: { x: 760, y: 150 },
    data: {
      label: '输出',
      outputMode: 'image_url',
      status: 'empty',
      imageUrl: '',
      outputUrl: '',
      packageUrl: '',
    },
  },
];

export const initialEdges = [
  { id: 'prompt-generate', source: 'prompt-1', target: 'generate-1', animated: true },
  { id: 'reference-generate', source: 'reference-1', target: 'generate-1' },
  { id: 'generate-output', source: 'generate-1', target: 'output-1', animated: true },
];

export function createDefaultData(type) {
  if (type === 'prompt') {
    return { label: '提示词', prompt: '', optimizePrompt: true, status: 'empty' };
  }
  if (type === 'batchPrompt') {
    return {
      label: '批量提示词',
      optimizePrompt: true,
      fileName: '',
      items: [],
      total: 0,
      billableTotal: 0,
      skippedTotal: 0,
      status: 'empty',
    };
  }
  if (type === 'reference') {
    return { label: '参考图', note: '上传或拖入一张参考图片。', imageUrl: '', originalImageUrl: '', wholeInstruction: '', referenceInstruction: '', status: 'empty' };
  }
  if (type === 'localReference') {
    return {
      label: '局部参考图',
      note: '上传图片后圈选局部区域，并填写这一区域的提示词。',
      imageUrl: '',
      originalImageUrl: '',
      localPrompt: '',
      region: null,
      circles: [],
      status: 'empty',
    };
  }
  if (type === 'generate') {
    return {
      label: '生成图片',
      size: 'auto',
      useCustomSize: false,
      customWidth: 1280,
      customHeight: 720,
      quality: 'low',
      outputFormat: 'jpeg',
      outputQuality: 100,
      fastMode: false,
      status: 'idle',
      imageUrl: '',
    };
  }
  if (type === 'imageExplosion') {
    return {
      label: '图片大爆炸',
      note: '先理解前置图片并拆解元素提示词，再批量生成对应元素图片。',
      size: 'auto',
      useCustomSize: false,
      customWidth: 1280,
      customHeight: 720,
      quality: 'low',
      outputFormat: 'jpeg',
      outputQuality: 100,
      fastMode: false,
      elementCount: 6,
      extractionMode: 'clean_material',
      explosionInstruction: '',
      status: 'idle',
      imageUrl: '',
      resultItems: [],
      explodedPrompts: [],
    };
  }
  if (type === 'ecommerceImage') {
    return {
      label: 'Listing 商品套图',
      note: '先生成一张 Listing 组图总览图，再拆解为多张商品 Listing 套图图片。',
      size: 'auto',
      useCustomSize: false,
      customWidth: 1280,
      customHeight: 720,
      quality: 'low',
      outputFormat: 'jpeg',
      outputQuality: 100,
      fastMode: false,
      ecommerceMode: 'listing_product_set',
      ecommerceCapability: 'listing_product_set',
      ...getDefaultEcommerceCapabilityFields('listing_product_set'),
      productImageMode: 'listing_set',
      textMode: 'finished_text',
      structureMode: 'smart',
      setImageCount: 6,
      platform: '',
      marketRegion: '全球/通用',
      copyLanguage: '',
      styleDirection: '干净专业电商风',
      userRequirements: '',
      excludeExtremeCopy: true,
      focusSingleProduct: false,
      setImageTypes: DEFAULT_ECOMMERCE_SET_IMAGE_TYPES,
      status: 'idle',
      imageUrl: '',
      referenceUrl: '',
      resultItems: [],
      ecommercePrompts: [],
    };
  }
  return { label: '输出', outputMode: 'image_url', status: 'empty', imageUrl: '', outputUrl: '', packageUrl: '' };
}
