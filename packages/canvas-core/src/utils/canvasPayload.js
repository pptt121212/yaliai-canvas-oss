import { clamp } from './image.js';
import { CANVAS_REFERENCE_IMAGE_MAX_BYTES, estimateEmbeddedImageBytes } from './workflow.js';

const DEFAULT_REFERENCE_COLORS = [
  { key: 'green', name: '绿色', value: '#22c55e' },
  { key: 'yellow', name: '黄色', value: '#facc15' },
  { key: 'blue', name: '蓝色', value: '#38bdf8' },
  { key: 'red', name: '红色', value: '#ef4444' },
  { key: 'purple', name: '紫色', value: '#a855f7' },
  { key: 'cyan', name: '青色', value: '#14b8a6' },
  { key: 'orange', name: '橙色', value: '#f97316' },
];

export async function prepareCanvasWorkflowNodesForServer(nodes, options = {}) {
  const source = Array.isArray(nodes) ? nodes : [];
  return Promise.all(source.map(async (node) => {
    if (!node || !['reference', 'localReference'].includes(node.type)) {
      return node;
    }

    let nextNode = node;

    if (node.type === 'localReference' && node.data?.imageUrl) {
      const circles = normalizeLocalCircles(node.data?.circles);
      if (circles.length) {
        try {
          const annotatedImageUrl = await annotateLocalReferenceImage(node.data.imageUrl, circles);
          nextNode = {
            ...node,
            data: {
              ...node.data,
              annotatedImageUrl,
            },
          };
        } catch (error) {
          nextNode = node;
        }
      }
    }

    if (typeof options.uploadReferenceAsset !== 'function') {
      return nextNode;
    }

    const fieldName = nextNode.type === 'localReference' && String(nextNode.data?.annotatedImageUrl || '').trim()
      ? 'annotatedImageUrl'
      : 'imageUrl';
    const imageUrl = String(nextNode.data?.[fieldName] || '').trim();
    if (!imageUrl.startsWith('data:image/')) {
      return nextNode;
    }

    const embeddedBytes = estimateEmbeddedImageBytes(imageUrl);
    if (embeddedBytes > CANVAS_REFERENCE_IMAGE_MAX_BYTES) {
      throw new Error('Reference image exceeds 12MB. Please compress it and try again.');
    }

    const uploadedUrl = await uploadReferenceDataUrl(options.uploadReferenceAsset, imageUrl, nextNode, fieldName);
    if (!uploadedUrl) {
      return nextNode;
    }
    return {
      ...nextNode,
      data: {
        ...nextNode.data,
        [fieldName]: uploadedUrl,
      },
    };
  }));
}

async function uploadReferenceDataUrl(uploadReferenceAsset, imageUrl, node, fieldName) {
  try {
    const payload = await uploadReferenceAsset(imageUrl, {
      fileName: `${String(node?.id || 'reference')}-${fieldName}.png`,
      ownerId: String(node?.id || ''),
    });
    return String(payload?.image_url || payload?.download_url || payload?.remote_reference_url || '').trim();
  } catch {
    return '';
  }
}

export function normalizeLocalCircles(circles) {
  const source = Array.isArray(circles) ? circles : [];
  return source.slice(0, 7).map((circle, index) => {
    const color = DEFAULT_REFERENCE_COLORS.find((item) => item.key === circle?.colorKey || item.name === circle?.colorName)
      || DEFAULT_REFERENCE_COLORS[index % DEFAULT_REFERENCE_COLORS.length];
    const r = clamp(circle?.r ?? 0.12, 0.03, 0.45);
    return {
      x: clamp(circle?.x ?? 0.5, r, 1 - r),
      y: clamp(circle?.y ?? 0.5, r, 1 - r),
      r,
      colorKey: color.key,
      colorName: color.name,
      colorValue: circle?.colorValue || color.value,
      text: String(circle?.text || ''),
    };
  });
}

export function annotateLocalReferenceImage(imageUrl, circles) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const width = image.naturalWidth || image.width || 1;
      const height = image.naturalHeight || image.height || 1;
      const minSide = Math.min(width, height);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, width, height);

      circles.forEach((circle, index) => {
        const x = circle.x * width;
        const y = circle.y * height;
        const radius = Math.max(8, circle.r * minSide);
        const color = circle.colorValue || DEFAULT_REFERENCE_COLORS[index % DEFAULT_REFERENCE_COLORS.length].value;
        context.save();
        context.fillStyle = colorToRgba(color, 0.12);
        context.strokeStyle = colorToRgba(color, 0.92);
        context.lineWidth = Math.max(4, Math.round(minSide * 0.006));
        context.setLineDash([Math.max(10, radius * 0.22), Math.max(7, radius * 0.14)]);
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.setLineDash([]);

        const badgeRadius = Math.max(16, Math.min(34, radius * 0.28));
        const badge = resolveBadgePoint(x, y, radius, badgeRadius, width, height);
        context.fillStyle = colorToRgba(color, 0.72);
        context.beginPath();
        context.arc(badge.x, badge.y, badgeRadius, 0, Math.PI * 2);
        context.fill();
        context.lineWidth = Math.max(2, badgeRadius * 0.12);
        context.strokeStyle = 'rgba(255,255,255,0.82)';
        context.stroke();
        context.fillStyle = '#fff';
        context.font = '900 ' + Math.round(badgeRadius * 1.05) + 'px sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(String(index + 1), badge.x, badge.y + 1);
        context.restore();
      });

      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('参考图标注生成失败，请重新上传图片。'));
    image.src = imageUrl;
  });
}

function resolveBadgePoint(x, y, radius, badgeRadius, width, height) {
  const margin = badgeRadius + 6;
  const distance = radius + badgeRadius + 8;
  const offset = distance / Math.SQRT2;
  const candidates = [
    { x: x + offset, y: y - offset },
    { x: x - offset, y: y - offset },
    { x: x + offset, y: y + offset },
    { x: x - offset, y: y + offset },
  ];

  return candidates.find((point) => (
    point.x >= margin
    && point.x <= width - margin
    && point.y >= margin
    && point.y <= height - margin
  )) || {
    x: clamp(candidates[0].x, margin, width - margin),
    y: clamp(candidates[0].y, margin, height - margin),
  };
}

function colorToRgba(color, alpha) {
  const match = String(color || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) {
    return `rgba(34,197,94,${alpha})`;
  }
  const hex = match[1];
  return 'rgba('
    + parseInt(hex.slice(0, 2), 16) + ','
    + parseInt(hex.slice(2, 4), 16) + ','
    + parseInt(hex.slice(4, 6), 16) + ','
    + alpha
    + ')';
}
