import { Bomb, Braces, Crosshair, FileArchive, FileSpreadsheet, Image as ImageIcon, ShoppingBag, Sparkles } from 'lucide-react';

export const NODE_DEFS = {
  prompt: { label: '提示词', detail: '描述画面目标', icon: Braces },
  batchPrompt: { label: '批量提示词', detail: '导入CSV循环生成', icon: FileSpreadsheet },
  reference: { label: '参考图', detail: '上传、裁剪、抠图', icon: ImageIcon },
  localReference: { label: '局部参考图', detail: '圈选局部并描述修改', icon: Crosshair },
  generate: { label: '生成图片', detail: '调用绘图接口', icon: Sparkles },
  imageExplosion: { label: '图片大爆炸', detail: '拆解图片元素并生成', icon: Bomb },
  ecommerceImage: { label: '电商图', detail: '生成商品组图与 Listing 套图', icon: ShoppingBag },
  output: { label: '输出', detail: '导出图片或压缩包', icon: FileArchive },
};
