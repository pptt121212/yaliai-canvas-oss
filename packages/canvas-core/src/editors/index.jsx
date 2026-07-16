import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, Copy, Crosshair, Download, Eraser, FileArchive, Maximize2, Minus, Plus, RotateCcw, Save, Sparkles, X } from 'lucide-react';
import { EDITOR_HEIGHT, EDITOR_WIDTH, LOCAL_EDITOR_HEIGHT, LOCAL_EDITOR_WIDTH, MAX_PROMPT_LENGTH } from '../config/constants.js';
import { blobToDataUrl, clamp, downloadImage, fitIntoArea, normalizeRect } from '../utils/image.js';

const REFERENCE_CIRCLE_COLORS = [
  { key: 'green', name: '绿色', value: '#22c55e' },
  { key: 'yellow', name: '黄色', value: '#facc15' },
  { key: 'blue', name: '蓝色', value: '#38bdf8' },
  { key: 'red', name: '红色', value: '#ef4444' },
  { key: 'purple', name: '紫色', value: '#a855f7' },
  { key: 'cyan', name: '青色', value: '#14b8a6' },
  { key: 'orange', name: '橙色', value: '#f97316' },
];

export function ReferenceEditorModal({ node, onClose, onSave }) {
  return createPortal(
    <div className="reference-modal" role="dialog" aria-modal="true" aria-label="编辑参考图">
      <div className="reference-shell">
        <header className="reference-head">
          <div>
            <strong>编辑参考图</strong>
            <span>单图编辑：拖拽平移预览，滚轮或快捷键缩放，剪裁确认按钮会贴近选区。</span>
          </div>
          <button type="button" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <SingleImageEditor imageUrl={node.data.imageUrl} originalImageUrl={node.data.originalImageUrl || node.data.imageUrl} onSave={onSave} />
      </div>
    </div>,
    document.body
  );
}

export function LocalReferenceModal({ node, onClose, onSave }) {
  return createPortal(
    <div className="reference-modal local-reference-modal" role="dialog" aria-modal="true" aria-label="局部参考图">
      <div className="reference-shell local-reference-shell">
        <header className="reference-head local-reference-head">
          <div>
            <strong>局部参考图</strong>
            <span>上传图片后圈选需要参考的局部，并为这个局部单独填写提示词。</span>
          </div>
          <button type="button" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <LocalReferenceSelector
          imageUrl={node.data.imageUrl}
          initialRegion={node.data.region}
          initialCircles={node.data.circles}
          initialPrompt={node.data.localPrompt || ''}
          onSave={onSave}
        />
      </div>
    </div>,
    document.body
  );
}

function normalizeLocalReferenceCircles(circles, initialRegion, initialPrompt) {
  const source = Array.isArray(circles) ? circles : [];
  const normalized = source.slice(0, 7).map((circle, index) => {
    const color = REFERENCE_CIRCLE_COLORS.find((item) => item.key === circle?.colorKey || item.name === circle?.colorName) || REFERENCE_CIRCLE_COLORS[index % REFERENCE_CIRCLE_COLORS.length];
    const safeCircle = constrainCircleToImage({
      x: circle?.x ?? 0.5,
      y: circle?.y ?? 0.5,
      r: circle?.r ?? 0.12,
    });
    return {
      x: safeCircle.x,
      y: safeCircle.y,
      r: safeCircle.r,
      colorKey: color.key,
      colorName: color.name,
      colorValue: color.value,
      text: String(circle?.text || ''),
    };
  });

  if (!normalized.length && initialRegion) {
    const color = REFERENCE_CIRCLE_COLORS[0];
    const safeCircle = constrainCircleToImage({
      x: (Number(initialRegion.x) || 0) + (Number(initialRegion.width) || 0) / 2,
      y: (Number(initialRegion.y) || 0) + (Number(initialRegion.height) || 0) / 2,
      r: Math.max(Number(initialRegion.width) || 0.12, Number(initialRegion.height) || 0.12) / 2,
    });
    normalized.push({
      x: safeCircle.x,
      y: safeCircle.y,
      r: safeCircle.r,
      colorKey: color.key,
      colorName: color.name,
      colorValue: color.value,
      text: String(initialPrompt || ''),
    });
  }

  return normalized;
}

function constrainCircleToImage(circle) {
  const r = clamp(circle?.r ?? 0.12, 0.03, 0.45);
  return {
    x: clamp(circle?.x ?? 0.5, r, 1 - r),
    y: clamp(circle?.y ?? 0.5, r, 1 - r),
    r,
  };
}

function colorToRgba(color, alpha) {
  const match = String(color || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) {
    return 'rgba(34,197,94,' + alpha + ')';
  }
  const hex = match[1];
  return 'rgba('
    + parseInt(hex.slice(0, 2), 16) + ','
    + parseInt(hex.slice(2, 4), 16) + ','
    + parseInt(hex.slice(4, 6), 16) + ','
    + alpha
    + ')';
}

function isViewportShortcut(event) {
  return Boolean(event?.ctrlKey || event?.metaKey || event?.altKey);
}

function isTypingTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));
}

function LocalReferenceSelector({ imageUrl, initialRegion, initialPrompt, initialCircles, onSave }) {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const drawInfoRef = useRef(null);
  const panDragRef = useRef(null);
  const circleDragRef = useRef(null);
  const [circles, setCircles] = useState(() => normalizeLocalReferenceCircles(initialCircles, initialRegion, initialPrompt));
  const [activeIndex, setActiveIndex] = useState(() => (initialCircles?.length || initialRegion ? 0 : -1));
  const [mode, setMode] = useState('select');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dashOffset, setDashOffset] = useState(0);
  const [stageSize, setStageSize] = useState({ width: LOCAL_EDITOR_WIDTH, height: LOCAL_EDITOR_HEIGHT });

  const activeCircle = activeIndex >= 0 ? circles[activeIndex] : null;
  const selectionReady = circles.length > 0;
  const promptReady = circles.some((circle) => String(circle.text || '').trim());

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');
    context.clearRect(0, 0, LOCAL_EDITOR_WIDTH, LOCAL_EDITOR_HEIGHT);
    context.fillStyle = '#f8fafc';
    context.fillRect(0, 0, LOCAL_EDITOR_WIDTH, LOCAL_EDITOR_HEIGHT);

    if (!image) {
      drawInfoRef.current = null;
      context.fillStyle = '#64748b';
      context.font = '700 18px "Microsoft YaHei", Arial';
      context.textAlign = 'center';
      context.fillText('请先上传局部参考图', LOCAL_EDITOR_WIDTH / 2, LOCAL_EDITOR_HEIGHT / 2);
      return;
    }

    const fit = fitIntoArea(image.naturalWidth || image.width, image.naturalHeight || image.height, LOCAL_EDITOR_WIDTH - 88, LOCAL_EDITOR_HEIGHT - 88);
    const scale = fit.scale * zoom;
    const width = (image.naturalWidth || image.width) * scale;
    const height = (image.naturalHeight || image.height) * scale;
    const left = (LOCAL_EDITOR_WIDTH - width) / 2 + pan.x;
    const top = (LOCAL_EDITOR_HEIGHT - height) / 2 + pan.y;
    const minSide = Math.min(width, height);
    context.drawImage(image, left, top, width, height);
    drawInfoRef.current = { left, top, width, height, scale };

    if (!circles.length) {
      return;
    }

    circles.forEach((circle, index) => {
      const color = circle.colorValue || REFERENCE_CIRCLE_COLORS[index % REFERENCE_CIRCLE_COLORS.length].value;
      const x = left + circle.x * width;
      const y = top + circle.y * height;
      const r = Math.max(8, circle.r * minSide);
      const isActive = index === activeIndex;

      context.save();
      context.fillStyle = colorToRgba(color, isActive ? 0.14 : 0.09);
      context.beginPath();
      context.arc(x, y, r, 0, Math.PI * 2);
      context.fill();

      context.lineWidth = isActive ? 7 : 5;
      context.strokeStyle = 'rgba(255,255,255,0.86)';
      context.beginPath();
      context.arc(x, y, r, 0, Math.PI * 2);
      context.stroke();

      context.lineWidth = isActive ? 4 : 3;
      context.strokeStyle = colorToRgba(color, isActive ? 0.96 : 0.84);
      context.setLineDash([12, 8]);
      context.lineDashOffset = -dashOffset;
      context.beginPath();
      context.arc(x, y, r, 0, Math.PI * 2);
      context.stroke();
      context.setLineDash([]);

      const badgeRadius = 13;
      const badgeMargin = badgeRadius + 8;
      const badgeDistance = r + badgeRadius + 8;
      const diagonalOffset = badgeDistance / Math.SQRT2;
      const imageBadgeInsetX = Math.min(badgeMargin, Math.max(0, width / 2 - 1));
      const imageBadgeInsetY = Math.min(badgeMargin, Math.max(0, height / 2 - 1));
      const preferredBadgeBounds = {
        minX: Math.max(badgeMargin, left + imageBadgeInsetX),
        maxX: Math.min(LOCAL_EDITOR_WIDTH - badgeMargin, left + width - imageBadgeInsetX),
        minY: Math.max(badgeMargin, top + imageBadgeInsetY),
        maxY: Math.min(LOCAL_EDITOR_HEIGHT - badgeMargin, top + height - imageBadgeInsetY),
      };
      const fallbackBadgeBounds = {
        minX: badgeMargin,
        maxX: LOCAL_EDITOR_WIDTH - badgeMargin,
        minY: badgeMargin,
        maxY: LOCAL_EDITOR_HEIGHT - badgeMargin,
      };
      const badgeCandidates = [
        { x: x + diagonalOffset, y: y - diagonalOffset },
        { x: x - diagonalOffset, y: y - diagonalOffset },
        { x: x + diagonalOffset, y: y + diagonalOffset },
        { x: x - diagonalOffset, y: y + diagonalOffset },
      ];
      const badgeBounds = preferredBadgeBounds.minX <= preferredBadgeBounds.maxX && preferredBadgeBounds.minY <= preferredBadgeBounds.maxY ? preferredBadgeBounds : fallbackBadgeBounds;
      const badgeFallbackPoint = {
        x: clamp(badgeCandidates[0].x, badgeBounds.minX, badgeBounds.maxX),
        y: clamp(badgeCandidates[0].y, badgeBounds.minY, badgeBounds.maxY),
      };
      const badgePoint = badgeCandidates.find((candidate) => (
        candidate.x >= badgeBounds.minX
        && candidate.x <= badgeBounds.maxX
        && candidate.y >= badgeBounds.minY
        && candidate.y <= badgeBounds.maxY
      )) || badgeFallbackPoint;

      context.fillStyle = colorToRgba(color, 0.62);
      context.beginPath();
      context.arc(badgePoint.x, badgePoint.y, badgeRadius, 0, Math.PI * 2);
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = 'rgba(255,255,255,0.82)';
      context.stroke();
      context.fillStyle = 'rgba(255,255,255,0.92)';
      context.font = '900 14px "Microsoft YaHei", Arial';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(String(index + 1), badgePoint.x, badgePoint.y + 0.5);
      context.restore();
    });
  }, [activeIndex, circles, dashOffset, pan, zoom]);

  useEffect(() => {
    if (!imageUrl) {
      imageRef.current = null;
      setPan({ x: 0, y: 0 });
      setZoom(1);
      return undefined;
    }
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) {
        return;
      }
      imageRef.current = image;
      setPan({ x: 0, y: 0 });
      setZoom(1);
    };
    image.src = imageUrl;
    return () => {
      active = false;
    };
  }, [imageUrl]);

  useEffect(() => {
    if (!circles.length) {
      return undefined;
    }
    let frame = 0;
    const tick = () => {
      setDashOffset((value) => (value + 0.7) % 28);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [circles.length]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return undefined;
    }

    const syncSize = () => {
      const rect = stage.getBoundingClientRect();
      const availableWidth = Math.max(280, rect.width - 28);
      const availableHeight = Math.max(220, rect.height - 28);
      const scale = Math.min(availableWidth / LOCAL_EDITOR_WIDTH, availableHeight / LOCAL_EDITOR_HEIGHT, 1);
      setStageSize({
        width: Math.round(LOCAL_EDITOR_WIDTH * scale),
        height: Math.round(LOCAL_EDITOR_HEIGHT * scale),
      });
    };

    syncSize();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(syncSize);
      observer.observe(stage);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', syncSize);
    return () => window.removeEventListener('resize', syncSize);
  }, []);

  useEffect(() => {
    draw();
  }, [draw, stageSize]);

  useEffect(() => {
    const handleKey = (event) => {
      if (isTypingTarget(event.target)) {
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoom((value) => clamp(Number((value + 0.1).toFixed(2)), 0.35, 4));
      }
      if (event.key === '-') {
        event.preventDefault();
        setZoom((value) => clamp(Number((value - 0.1).toFixed(2)), 0.35, 4));
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const canvasPoint = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * LOCAL_EDITOR_WIDTH, 0, LOCAL_EDITOR_WIDTH),
      y: clamp(((event.clientY - rect.top) / rect.height) * LOCAL_EDITOR_HEIGHT, 0, LOCAL_EDITOR_HEIGHT),
    };
  };

  const normalizedImagePoint = (event) => {
    const info = drawInfoRef.current;
    if (!info) {
      return null;
    }
    const point = canvasPoint(event);
    if (point.x < info.left || point.y < info.top || point.x > info.left + info.width || point.y > info.top + info.height) {
      return null;
    }
    return {
      x: clamp((point.x - info.left) / info.width, 0, 1),
      y: clamp((point.y - info.top) / info.height, 0, 1),
    };
  };

  const findCircleAt = (point) => {
    const info = drawInfoRef.current;
    if (!info) {
      return -1;
    }
    const minSide = Math.min(info.width, info.height);
    for (let index = circles.length - 1; index >= 0; index -= 1) {
      const circle = circles[index];
      const dx = (point.x - circle.x) * info.width;
      const dy = (point.y - circle.y) * info.height;
      if (Math.sqrt(dx * dx + dy * dy) <= circle.r * minSide) {
        return index;
      }
    }
    return -1;
  };

  const updateCircle = (index, patch) => {
    setCircles((items) => items.map((item, itemIndex) => {
      if (itemIndex !== index) {
        return item;
      }
      const nextCircle = { ...item, ...patch };
      const safeCircle = constrainCircleToImage(nextCircle);
      return { ...nextCircle, ...safeCircle };
    }));
  };

  const handlePointerDown = (event) => {
    if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (mode === 'pan' || isViewportShortcut(event)) {
      panDragRef.current = { x: event.clientX, y: event.clientY, pan };
      return;
    }
    const point = normalizedImagePoint(event);
    if (!point) {
      return;
    }
    const hitIndex = findCircleAt(point);
    if (hitIndex >= 0) {
      setActiveIndex(hitIndex);
      circleDragRef.current = hitIndex;
      return;
    }
    if (circles.length >= 7) {
      return;
    }
    const color = REFERENCE_CIRCLE_COLORS[circles.length % REFERENCE_CIRCLE_COLORS.length];
    const safeCircle = constrainCircleToImage({
      x: point.x,
      y: point.y,
      r: 0.12,
    });
    const nextCircle = {
      x: safeCircle.x,
      y: safeCircle.y,
      r: safeCircle.r,
      colorKey: color.key,
      colorName: color.name,
      colorValue: color.value,
      text: '',
    };
    setCircles((items) => items.concat(nextCircle));
    setActiveIndex(circles.length);
    circleDragRef.current = circles.length;
  };

  const handlePointerMove = (event) => {
    if (panDragRef.current) {
      setPan({
        x: panDragRef.current.pan.x + event.clientX - panDragRef.current.x,
        y: panDragRef.current.pan.y + event.clientY - panDragRef.current.y,
      });
      return;
    }
    if (circleDragRef.current === null) {
      return;
    }
    const point = normalizedImagePoint(event);
    if (!point) {
      return;
    }
    updateCircle(circleDragRef.current, point);
  };

  const stopPointer = (event) => {
    panDragRef.current = null;
    circleDragRef.current = null;
    if (event?.currentTarget && typeof event.currentTarget.releasePointerCapture === 'function') {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch (error) {
        // Pointer capture may already be released by the browser.
      }
    }
  };

  const saveLocalReference = () => {
    if (!selectionReady || !promptReady) {
      return;
    }
    const nextCircles = circles.map((circle, index) => {
      const color = REFERENCE_CIRCLE_COLORS.find((item) => item.key === circle.colorKey) || REFERENCE_CIRCLE_COLORS[index % REFERENCE_CIRCLE_COLORS.length];
      const safeCircle = constrainCircleToImage(circle);
      return {
        x: Number(safeCircle.x.toFixed(4)),
        y: Number(safeCircle.y.toFixed(4)),
        r: Number(safeCircle.r.toFixed(4)),
        colorKey: color.key,
        colorName: color.name,
        colorValue: color.value,
        text: String(circle.text || '').trim(),
      };
    });
    const localPrompt = nextCircles
      .filter((circle) => circle.text)
      .map((circle, index) => `${circle.colorName}圈 ${index + 1}：${circle.text}`)
      .join('；');
    onSave({
      circles: nextCircles,
      region: nextCircles[0] || null,
      localPrompt,
    });
  };

  return (
    <div className="local-reference-editor">
      <div ref={stageRef} className={'local-reference-stage is-' + mode}>
        <div className="local-reference-canvas-wrap" style={{ width: stageSize.width + 'px', height: stageSize.height + 'px' }}>
          <canvas
            ref={canvasRef}
            width={LOCAL_EDITOR_WIDTH}
            height={LOCAL_EDITOR_HEIGHT}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopPointer}
            onPointerLeave={stopPointer}
            onWheel={(event) => {
              event.preventDefault();
              setZoom((value) => clamp(Number((value + (event.deltaY > 0 ? -0.08 : 0.08)).toFixed(2)), 0.35, 4));
            }}
          />
        </div>
      </div>

      <aside className="local-reference-panel">
        <div className="local-reference-summary">
          <span className={imageUrl ? 'is-done' : ''}>图片</span>
          <span className={selectionReady ? 'is-done' : ''}>圈选 {circles.length}/7</span>
          <span className={promptReady ? 'is-done' : ''}>提示词</span>
        </div>

        <div className="local-reference-color-row" aria-label="圈选颜色">
          {REFERENCE_CIRCLE_COLORS.map((color, index) => (
            <button
              key={color.key}
              type="button"
              className={activeCircle?.colorKey === color.key ? 'is-active' : ''}
              style={{ '--local-reference-color': color.value }}
              title={color.name}
              onClick={() => {
                if (!activeCircle) {
                  return;
                }
                updateCircle(activeIndex, { colorKey: color.key, colorName: color.name, colorValue: color.value });
              }}
            >
              {index + 1}
            </button>
          ))}
        </div>

        <div className="local-reference-tools">
          <button type="button" className={mode === 'select' ? 'is-active' : ''} onClick={() => setMode('select')}>
            <Crosshair size={15} />
            圈选/拖动
          </button>
          <button type="button" className={mode === 'pan' ? 'is-active' : ''} onClick={() => setMode('pan')}>
            <Maximize2 size={15} />
            移动画面
          </button>
          <button type="button" onClick={() => setZoom((value) => clamp(value - 0.1, 0.35, 4))}>-</button>
          <strong>{Math.round(zoom * 100)}%</strong>
          <button type="button" onClick={() => setZoom((value) => clamp(value + 0.1, 0.35, 4))}>+</button>
        </div>

        <label className="local-reference-radius">
          <span>当前圆圈大小 {activeCircle ? Math.round(activeCircle.r * 100) : 0}%</span>
          <input
            type="range"
            min="3"
            max="45"
            value={activeCircle ? Math.round(activeCircle.r * 100) : 12}
            disabled={!activeCircle}
            onChange={(event) => updateCircle(activeIndex, { r: clamp(Number(event.target.value) / 100, 0.03, 0.45) })}
          />
        </label>

        <div className="local-reference-circle-list">
          {circles.length ? circles.map((circle, index) => (
            <div key={circle.colorKey + '-' + index} className={'local-reference-circle-item' + (index === activeIndex ? ' is-active' : '')} style={{ '--local-reference-color': circle.colorValue }}>
              <button type="button" onClick={() => setActiveIndex(index)}>
                <span>{index + 1}</span>
                {circle.colorName}圈 {index + 1}
              </button>
              <textarea
                value={circle.text || ''}
                rows={2}
                placeholder="描述这个标注位置要如何修改或参考"
                onChange={(event) => updateCircle(index, { text: event.target.value })}
              />
              <button
                type="button"
                className="local-reference-circle-remove"
                onClick={() => {
                  setCircles((items) => items.filter((_, itemIndex) => itemIndex !== index));
                  setActiveIndex((current) => Math.min(Math.max(0, current - (current >= index ? 1 : 0)), Math.max(0, circles.length - 2)));
                }}
              >
                删除
              </button>
            </div>
          )) : <div className="local-reference-empty">点击图片添加第一个彩色圈选。</div>}
        </div>

        <div className="local-reference-actions">
          <button type="button" onClick={() => { setCircles([]); setActiveIndex(-1); }} disabled={!circles.length}>
            清空圈选
          </button>
          <button type="button" className="local-reference-save" onClick={saveLocalReference} disabled={!selectionReady || !promptReady}>
            <Save size={15} />
            保存局部参考
          </button>
        </div>
      </aside>
    </div>
  );
}

export function SingleImageEditor({ imageUrl, originalImageUrl, onSave }) {
  const editorStageRef = useRef(null);
  const canvasRef = useRef(null);
  const imageCanvasRef = useRef(null);
  const drawInfoRef = useRef(null);
  const panDragRef = useRef(null);
  const cropStartRef = useRef(null);
  const eraseDragRef = useRef(false);
  const [tool, setTool] = useState('pan');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cropRect, setCropRect] = useState(null);
  const [isCropping, setIsCropping] = useState(false);
  const [brushSize, setBrushSize] = useState(34);
  const [brushPreview, setBrushPreview] = useState(null);
  const [undoStack, setUndoStack] = useState([]);
  const [stageSize, setStageSize] = useState({ width: EDITOR_WIDTH, height: EDITOR_HEIGHT });
  const [progress, setProgress] = useState({ open: false, status: 'idle', progress: 0, message: '' });

  const currentImageUrl = useCallback(() => imageCanvasRef.current?.toDataURL('image/png') || imageUrl, [imageUrl]);

  const loadImage = useCallback((source) => {
    const image = new Image();
    image.onload = () => {
      const canvas = imageCanvasRef.current || document.createElement('canvas');
      canvas.width = image.naturalWidth || image.width || 1;
      canvas.height = image.naturalHeight || image.height || 1;
      imageCanvasRef.current = canvas;
      const context = canvas.getContext('2d');
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      setPan({ x: 0, y: 0 });
      setZoom(1);
      setCropRect(null);
    };
    image.src = source;
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const source = imageCanvasRef.current;
    if (!canvas || !source) {
      return;
    }
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#f8fafc';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const fit = fitIntoArea(source.width, source.height, canvas.width - 72, canvas.height - 72);
    const scale = fit.scale * zoom;
    const width = source.width * scale;
    const height = source.height * scale;
    const left = (canvas.width - width) / 2 + pan.x;
    const top = (canvas.height - height) / 2 + pan.y;
    context.drawImage(source, left, top, width, height);
    drawInfoRef.current = { left, top, width, height, scale };
  }, [pan, zoom]);

  useEffect(() => {
    if (imageUrl) {
      loadImage(imageUrl);
    }
  }, [imageUrl, loadImage]);

  useEffect(() => {
    const stage = editorStageRef.current;
    if (!stage) {
      return undefined;
    }

    const syncSize = () => {
      const rect = stage.getBoundingClientRect();
      const availableWidth = Math.max(240, rect.width - 32);
      const availableHeight = Math.max(180, rect.height - 32);
      const scale = Math.min(availableWidth / EDITOR_WIDTH, availableHeight / EDITOR_HEIGHT, 1);
      setStageSize({
        width: Math.round(EDITOR_WIDTH * scale),
        height: Math.round(EDITOR_HEIGHT * scale),
      });
    };

    syncSize();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(syncSize);
      observer.observe(stage);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', syncSize);
    return () => window.removeEventListener('resize', syncSize);
  }, []);

  useEffect(() => {
    draw();
  }, [draw, tool, cropRect]);

  useEffect(() => {
    if (tool !== 'erase') {
      setBrushPreview(null);
    }
  }, [tool]);

  useEffect(() => {
    const handleKey = (event) => {
      if (isTypingTarget(event.target)) {
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoom((value) => clamp(Number((value + 0.1).toFixed(2)), 0.25, 5));
      }
      if (event.key === '-') {
        event.preventDefault();
        setZoom((value) => clamp(Number((value - 0.1).toFixed(2)), 0.25, 5));
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const pushUndo = () => {
    const source = imageCanvasRef.current;
    if (!source) {
      return;
    }
    setUndoStack((items) => items.concat(source.toDataURL('image/png')).slice(-12));
  };

  const restoreUndo = () => {
    const snapshot = undoStack[undoStack.length - 1];
    if (!snapshot) {
      return;
    }
    setUndoStack((items) => items.slice(0, -1));
    loadImage(snapshot);
  };

  const canvasPoint = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * EDITOR_WIDTH, 0, EDITOR_WIDTH),
      y: clamp(((event.clientY - rect.top) / rect.height) * EDITOR_HEIGHT, 0, EDITOR_HEIGHT),
    };
  };

  const imagePoint = (point) => {
    const info = drawInfoRef.current;
    if (!info) {
      return null;
    }
    return {
      x: clamp((point.x - info.left) / info.scale, 0, imageCanvasRef.current.width),
      y: clamp((point.y - info.top) / info.scale, 0, imageCanvasRef.current.height),
    };
  };

  const eraseAt = (point) => {
    const source = imageCanvasRef.current;
    const target = imagePoint(point);
    if (!source || !target) {
      return;
    }
    const context = source.getContext('2d');
    context.save();
    context.globalCompositeOperation = 'destination-out';
    context.beginPath();
    context.arc(target.x, target.y, brushSize, 0, Math.PI * 2);
    context.fill();
    context.restore();
    draw();
  };

  const updateBrushPreview = (point) => {
    const info = drawInfoRef.current;
    if (!info) {
      setBrushPreview(null);
      return;
    }
    setBrushPreview({
      x: point.x,
      y: point.y,
      radius: Math.max(4, brushSize * info.scale),
    });
  };

  const handlePointerDown = (event) => {
    event.preventDefault();
    if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const point = canvasPoint(event);
    if (isViewportShortcut(event)) {
      panDragRef.current = { x: event.clientX, y: event.clientY, pan };
      return;
    }
    if (tool === 'crop') {
      cropStartRef.current = point;
      setIsCropping(true);
      setCropRect({ x: point.x, y: point.y, width: 1, height: 1 });
      return;
    }
    if (tool === 'erase') {
      updateBrushPreview(point);
      pushUndo();
      eraseDragRef.current = true;
      eraseAt(point);
      return;
    }
    panDragRef.current = { x: event.clientX, y: event.clientY, pan };
  };

  const handlePointerMove = (event) => {
    const point = canvasPoint(event);
    if (panDragRef.current) {
      setPan({
        x: panDragRef.current.pan.x + event.clientX - panDragRef.current.x,
        y: panDragRef.current.pan.y + event.clientY - panDragRef.current.y,
      });
      return;
    }
    if (tool === 'erase') {
      updateBrushPreview(point);
    }
    if (tool === 'crop' && cropStartRef.current) {
      setCropRect(normalizeRect(cropStartRef.current.x, cropStartRef.current.y, point.x, point.y));
      return;
    }
    if (tool === 'erase' && eraseDragRef.current) {
      eraseAt(point);
      return;
    }
    if (tool === 'pan' && panDragRef.current) {
      setPan({
        x: panDragRef.current.pan.x + event.clientX - panDragRef.current.x,
        y: panDragRef.current.pan.y + event.clientY - panDragRef.current.y,
      });
    }
  };

  const stopPointer = (event) => {
    cropStartRef.current = null;
    panDragRef.current = null;
    eraseDragRef.current = false;
    setIsCropping(false);
    if (event?.currentTarget && typeof event.currentTarget.releasePointerCapture === 'function') {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch (error) {
        // Pointer capture may already be released by the browser.
      }
    }
  };

  const leaveCanvas = () => {
    if (cropStartRef.current || panDragRef.current || eraseDragRef.current) {
      return;
    }
    stopPointer();
    setBrushPreview(null);
  };

  const applyCrop = () => {
    const source = imageCanvasRef.current;
    const info = drawInfoRef.current;
    if (!source || !info || !cropRect || cropRect.width < 18 || cropRect.height < 18) {
      return;
    }
    const p1 = imagePoint({ x: cropRect.x, y: cropRect.y });
    const p2 = imagePoint({ x: cropRect.x + cropRect.width, y: cropRect.y + cropRect.height });
    const x = Math.round(Math.min(p1.x, p2.x));
    const y = Math.round(Math.min(p1.y, p2.y));
    const width = Math.round(Math.abs(p2.x - p1.x));
    const height = Math.round(Math.abs(p2.y - p1.y));
    if (width < 2 || height < 2) {
      return;
    }
    pushUndo();
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = width;
    cropCanvas.height = height;
    cropCanvas.getContext('2d').drawImage(source, x, y, width, height, 0, 0, width, height);
    imageCanvasRef.current = cropCanvas;
    setCropRect(null);
    setTool('pan');
    setPan({ x: 0, y: 0 });
    setZoom(1);
  };

  const resetImage = () => {
    setUndoStack([]);
    loadImage(originalImageUrl || imageUrl);
  };

  const runCutout = async () => {
    const source = currentImageUrl();
    if (!source) {
      return;
    }
    pushUndo();
    setProgress({ open: true, status: 'running', progress: 8, message: '正在下载 AI 抠图模型，首次使用会稍慢。' });
    try {
      const module = await import('@imgly/background-removal');
      const removeBackground = module.default || module.removeBackground;
      const blob = await removeBackground(source, {
        progress: (_, current, total) => {
          const ratio = total > 0 ? current / total : 0;
          setProgress({
            open: true,
            status: 'running',
            progress: Math.min(94, Math.max(10, Math.round(ratio * 84) + 10)),
            message: '正在自动识别主体并移除背景。',
          });
        },
      });
      const nextUrl = await blobToDataUrl(blob);
      loadImage(nextUrl);
      setProgress({ open: true, status: 'done', progress: 100, message: '抠图完成，可以继续编辑或保存。' });
    } catch (error) {
      setProgress({
        open: true,
        status: 'error',
        progress: 100,
        message: error?.message || 'AI 抠图失败，请稍后重试。',
      });
    }
  };

  const cropStyle = cropRect
    ? {
        left: `${(cropRect.x / EDITOR_WIDTH) * 100}%`,
        top: `${(cropRect.y / EDITOR_HEIGHT) * 100}%`,
        width: `${(cropRect.width / EDITOR_WIDTH) * 100}%`,
        height: `${(cropRect.height / EDITOR_HEIGHT) * 100}%`,
      }
    : null;

  const cropConfirmStyle = cropRect
    ? {
        left: `${(clamp(cropRect.x + cropRect.width + 10, 8, EDITOR_WIDTH - 145) / EDITOR_WIDTH) * 100}%`,
        top: `${(clamp(cropRect.y + cropRect.height + 10, 8, EDITOR_HEIGHT - 48) / EDITOR_HEIGHT) * 100}%`,
      }
    : null;

  const brushPreviewStyle = tool === 'erase' && brushPreview
    ? {
        left: `${(brushPreview.x / EDITOR_WIDTH) * 100}%`,
        top: `${(brushPreview.y / EDITOR_HEIGHT) * 100}%`,
        width: `${((brushPreview.radius * 2) / EDITOR_WIDTH) * 100}%`,
        height: `${((brushPreview.radius * 2) / EDITOR_HEIGHT) * 100}%`,
      }
    : null;

  return (
    <div className="single-editor">
      <div ref={editorStageRef} className={`editor-stage is-${tool}`}>
        <div className="editor-canvas-wrap" style={{ width: `${stageSize.width}px`, height: `${stageSize.height}px` }}>
          <canvas
            ref={canvasRef}
            width={EDITOR_WIDTH}
            height={EDITOR_HEIGHT}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopPointer}
            onPointerCancel={stopPointer}
            onLostPointerCapture={stopPointer}
            onPointerLeave={leaveCanvas}
            onWheel={(event) => {
              event.preventDefault();
              setZoom((value) => clamp(Number((value + (event.deltaY > 0 ? -0.08 : 0.08)).toFixed(2)), 0.25, 5));
            }}
          />
          {brushPreviewStyle && <span className="erase-brush-preview" style={brushPreviewStyle} />}
          {tool === 'crop' && cropStyle && <span className="crop-box" style={cropStyle} />}
          {tool === 'crop' && !isCropping && cropRect && cropRect.width >= 18 && cropRect.height >= 18 && (
            <div className="crop-confirm" style={cropConfirmStyle}>
              <button type="button" onClick={applyCrop}>
                <Check size={14} />
                确认剪裁
              </button>
              <button type="button" onClick={() => setCropRect(null)}>
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      <footer className="editor-toolbar">
        <button type="button" className={tool === 'pan' ? 'is-active' : ''} onClick={() => setTool('pan')}>拖拽</button>
        <button type="button" className={tool === 'crop' ? 'is-active' : ''} onClick={() => { setTool('crop'); setCropRect(null); }}>剪裁</button>
        <button type="button" className={tool === 'erase' ? 'is-active' : ''} onClick={() => setTool('erase')}>
          <Eraser size={15} />
          擦除
        </button>
        <button type="button" onClick={runCutout}>
          <Sparkles size={15} />
          AI 抠图
        </button>
        {tool === 'erase' && (
          <label className="brush-control">
            <span>笔刷 {brushSize}</span>
            <input type="range" min="8" max="90" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} />
          </label>
        )}
        <span className="toolbar-spacer" />
        <button type="button" onClick={() => setZoom((value) => clamp(value - 0.1, 0.25, 5))}>-</button>
        <strong>{Math.round(zoom * 100)}%</strong>
        <button type="button" onClick={() => setZoom((value) => clamp(value + 0.1, 0.25, 5))}>+</button>
        <button type="button" onClick={restoreUndo} disabled={!undoStack.length}>
          <RotateCcw size={15} />
          撤销
        </button>
        <button type="button" onClick={resetImage}>重置</button>
        <button type="button" className="editor-save" onClick={() => onSave(currentImageUrl())}>
          <Save size={15} />
          保存为参考图
        </button>
      </footer>

      {progress.open && (
        <ProgressDialog
          state={progress}
          onClose={() => setProgress((current) => ({ ...current, open: false }))}
        />
      )}
    </div>
  );
}

export function ProgressDialog({ state, onClose }) {
  return createPortal(
    <div className="progress-backdrop">
      <div className="progress-dialog">
        <strong>{state.status === 'error' ? '处理失败' : state.status === 'done' ? '处理完成' : '正在处理'}</strong>
        <p>{state.message}</p>
        <div className="progress-track">
          <span style={{ width: `${clamp(state.progress, 0, 100)}%` }} />
        </div>
        <em>{Math.round(clamp(state.progress, 0, 100))}%</em>
        {state.status !== 'running' && <button type="button" onClick={onClose}>知道了</button>}
      </div>
    </div>,
    document.body
  );
}

function resultStatusLabel(status) {
  const value = String(status || '').trim();
  if (value === 'done') {
    return '完成';
  }
  if (value === 'running' || value === 'starting') {
    return '生成中';
  }
  if (value === 'failed') {
    return '失败';
  }
  return '等待';
}

function resultItemTitle(item, index) {
  const batchItem = item?.batchItem || item?.batch_item || null;
  const itemIndex = Number(item?.index || batchItem?.index || index + 1);
  const name = String(item?.name || batchItem?.name || '').trim();
  return `${String(itemIndex).padStart(2, '0')} ${name || `结果-${String(index + 1).padStart(2, '0')}`}`;
}

function cleanResultStatusLabel(status) {
  const value = String(status || '').trim();
  if (value === 'done') {
    return '完成';
  }
  if (value === 'running' || value === 'starting') {
    return '生成中';
  }
  if (value === 'failed') {
    return '失败';
  }
  return '等待';
}

function cleanResultItemTitle(item, index) {
  const batchItem = item?.batchItem || item?.batch_item || null;
  const itemIndex = Number(item?.index || batchItem?.index || index + 1);
  const name = String(item?.name || batchItem?.name || '').trim();
  return `${String(itemIndex).padStart(2, '0')} ${name || `结果-${String(index + 1).padStart(2, '0')}`}`;
}

function resultItemCategory(item) {
  const batchItem = item?.batchItem || item?.batch_item || null;
  return String(item?.imageCategory || item?.image_category || batchItem?.image_category || batchItem?.imageCategory || '').trim();
}

function resultItemStatusKey(item) {
  if (String(item?.errorMessage || item?.error_message || '').trim() || String(item?.status || '').trim() === 'failed') {
    return 'failed';
  }
  if (String(item?.imageUrl || item?.downloadUrl || item?.referenceUrl || '').trim()) {
    return 'done';
  }
  const status = String(item?.status || '').trim();
  if (status === 'running' || status === 'starting') {
    return 'running';
  }
  return 'waiting';
}

function resultStatusFilterLabel(value) {
  if (value === 'done') {
    return '完成';
  }
  if (value === 'failed') {
    return '失败';
  }
  if (value === 'running') {
    return '生成中';
  }
  if (value === 'waiting') {
    return '等待';
  }
  return '全部';
}

function normalizeResultItemBusinessFields(item) {
  const batchItem = item?.batchItem || item?.batch_item || null;
  return {
    prompt: String(item?.prompt || batchItem?.prompt || '').trim(),
    goal: String(item?.goal || batchItem?.goal || '').trim(),
    referenceUsage: String(item?.referenceUsage || item?.reference_usage || batchItem?.reference_usage || batchItem?.referenceUsage || '').trim(),
    scriptText: String(item?.scriptText || item?.script_text || batchItem?.script_text || batchItem?.scriptText || batchItem?.video_script || batchItem?.videoScript || '').trim(),
    shotScript: String(item?.shotScript || item?.shot_script || batchItem?.shot_script || batchItem?.shotScript || batchItem?.storyboard_script || batchItem?.storyboardScript || '').trim(),
  };
}

function cleanDownloadFileName(value) {
  return String(value || '')
    .trim()
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120)
    .trim();
}

function ensureImageFileExtension(fileName) {
  const safeName = cleanDownloadFileName(fileName);
  if (!safeName) {
    return '';
  }
  return /\.[a-z0-9]{2,5}$/i.test(safeName) ? safeName : `${safeName}.png`;
}

function buildResultDownloadFileName(item, index = 0, fallbackTitle = '') {
  const batchItem = item?.batchItem || item?.batch_item || null;
  const explicitName = String(
    item?.fileName || item?.file_name || item?.downloadName || item?.download_name ||
    batchItem?.fileName || batchItem?.file_name || batchItem?.downloadName || batchItem?.download_name || ''
  ).trim();
  const explicitSafeName = ensureImageFileExtension(explicitName);
  if (explicitSafeName) {
    return explicitSafeName;
  }

  const title = String(fallbackTitle || item?.title || item?.name || batchItem?.name || '').trim();
  const category = resultItemCategory(item);
  const taskId = String(item?.taskId || item?.task_id || '').trim();
  const fallbackName = `canvas-result-${String(Number(index) + 1).padStart(2, '0')}`;
  const stem = cleanDownloadFileName([
    title || cleanResultItemTitle(item, index) || fallbackName,
    category && !String(title).includes(category) ? category : '',
    taskId ? `task-${taskId}` : '',
  ].filter(Boolean).join('-')) || fallbackName;
  return ensureImageFileExtension(stem) || `${fallbackName}.png`;
}

function copyTextToClipboard(text) {
  const value = String(text || '').trim();
  if (!value) {
    return;
  }
  if (typeof navigator !== 'undefined') {
    void navigator.clipboard?.writeText(value);
  }
}

export function ResultGalleryModal({ title, items = [], packageUrl = '', packageFileName = '', csvUrl = '', expectedCount = 0, onPreviewImage, onClose }) {
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const safeItems = Array.isArray(items) ? items : [];
  const normalizedItems = safeItems
    .map((item, index) => {
      const imageUrl = String(item?.imageUrl || item?.downloadUrl || item?.referenceUrl || '').trim();
      const downloadUrl = String(item?.downloadUrl || item?.referenceUrl || imageUrl).trim();
      const itemTitle = cleanResultItemTitle(item, index);
      const itemCategory = resultItemCategory(item);
      const itemStatusKey = resultItemStatusKey(item);
      const itemStatusLabel = itemStatusKey === 'done' ? '完成' : cleanResultStatusLabel(item?.status);
      const businessFields = normalizeResultItemBusinessFields(item);
      const downloadName = buildResultDownloadFileName(item, index, itemTitle);
      return {
        ...item,
        ...businessFields,
        itemIndex: index,
        imageUrl,
        downloadUrl,
        downloadName,
        title: itemTitle,
        resultCategory: itemCategory,
        resultStatusKey: itemStatusKey,
        resultStatusLabel: itemStatusLabel,
      };
    });
  const completedCount = normalizedItems.filter((item) => item.resultStatusKey === 'done').length;
  const failedCount = normalizedItems.filter((item) => item.resultStatusKey === 'failed').length;
  const runningCount = normalizedItems.filter((item) => item.resultStatusKey === 'running').length;
  const waitingCount = normalizedItems.filter((item) => item.resultStatusKey === 'waiting').length;
  const totalCount = Math.max(safeItems.length, Number(expectedCount || 0), completedCount);
  const packageName = packageFileName || 'yali-canvas.zip';
  const categoryOptions = Array.from(new Set(normalizedItems.map((item) => item.resultCategory).filter(Boolean)));
  const visibleItems = normalizedItems.filter((item) => (
    (statusFilter === 'all' || item.resultStatusKey === statusFilter)
    && (categoryFilter === 'all' || item.resultCategory === categoryFilter)
  ));
  const galleryItems = visibleItems
    .filter((item) => item.imageUrl)
    .map((item, index) => ({ ...item, galleryIndex: index }));
  const activeFilterSummary = [
    statusFilter !== 'all' ? `状态：${resultStatusFilterLabel(statusFilter)}` : '',
    categoryFilter !== 'all' ? `类型：${categoryFilter}` : '',
  ].filter(Boolean).join(' / ');

  useEffect(() => {
    const handleKey = (event) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (document.querySelector('.lightbox')) {
        return;
      }
      event.preventDefault();
      onClose?.();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return createPortal(
    <div className="result-gallery" role="dialog" aria-modal="true" onPointerDown={onClose}>
      <section className="result-gallery-shell" onPointerDown={(event) => event.stopPropagation()}>
        <header className="result-gallery-head">
          <div>
            <strong className="result-gallery-title">{title || '结果列表'}</strong>
            <span className="result-gallery-count">{completedCount} / {totalCount} 张已生成</span>
            <div className="result-gallery-status-row" aria-label="结果状态汇总">
              <button type="button" className={statusFilter === 'all' ? 'is-active' : ''} onClick={() => setStatusFilter('all')}>全部 {safeItems.length}</button>
              {completedCount ? <button type="button" className={`is-done${statusFilter === 'done' ? ' is-active' : ''}`} onClick={() => setStatusFilter('done')}>完成 {completedCount}</button> : null}
              {failedCount ? <button type="button" className={`is-failed${statusFilter === 'failed' ? ' is-active' : ''}`} onClick={() => setStatusFilter('failed')}>失败 {failedCount}</button> : null}
              {runningCount ? <button type="button" className={`is-running${statusFilter === 'running' ? ' is-active' : ''}`} onClick={() => setStatusFilter('running')}>生成中 {runningCount}</button> : null}
              {waitingCount ? <button type="button" className={`is-waiting${statusFilter === 'waiting' ? ' is-active' : ''}`} onClick={() => setStatusFilter('waiting')}>等待 {waitingCount}</button> : null}
            </div>
          </div>
          <div className="result-gallery-tools">
            {csvUrl ? (
              <button type="button" onClick={() => downloadImage(csvUrl, 'canvas-results.csv')}>
                <Download size={15} />
                CSV
              </button>
            ) : null}
            {packageUrl ? (
              <a className="result-gallery-download-link" href={packageUrl} download={packageName} target="_blank" rel="noopener noreferrer">
                <FileArchive size={15} />
                下载包
              </a>
            ) : null}
            <button type="button" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="result-gallery-filterbar">
          <div className="result-gallery-filterbar__group" aria-label="图片类型筛选">
            <button type="button" className={categoryFilter === 'all' ? 'is-active' : ''} onClick={() => setCategoryFilter('all')}>
              全部类型
            </button>
            {categoryOptions.map((category) => (
              <button
                key={category}
                type="button"
                className={categoryFilter === category ? 'is-active' : ''}
                onClick={() => setCategoryFilter(category)}
                title={category}
              >
                {category}
              </button>
            ))}
          </div>
          <span>{activeFilterSummary || `当前显示 ${visibleItems.length} 项`}</span>
        </div>
        <div className="result-gallery-grid">
          {!safeItems.length ? (
            <div className="result-gallery-empty">
              <strong className="result-gallery-empty-title">图片明细准备中</strong>
              <span className="result-gallery-empty-copy">可以先使用上方下载包，或稍后刷新画布状态。</span>
            </div>
          ) : null}
          {safeItems.length && !visibleItems.length ? (
            <div className="result-gallery-empty">
              <strong className="result-gallery-empty-title">当前筛选没有结果</strong>
              <span className="result-gallery-empty-copy">切回“全部”或换一个图片类型继续查看。</span>
            </div>
          ) : null}
          {visibleItems.map((item) => {
            const imageUrl = item.imageUrl;
            const downloadUrl = item.downloadUrl;
            const { prompt, goal, referenceUsage, scriptText, shotScript } = item;
            const itemTitle = item.title;
            const itemCategory = item.resultCategory;
            const itemStatusLabel = item.resultStatusLabel;
            const itemErrorMessage = String(item?.errorMessage || item?.error_message || '').trim();
            const itemJobId = String(item?.jobId || item?.job_id || '').trim();
            const itemTaskId = String(item?.taskId || item?.task_id || '').trim();
            const itemNodeId = String(item?.nodeId || item?.node_id || '').trim();
            const index = Number(item.itemIndex || 0);
            const errorCopyText = [
              `标题：${itemTitle}`,
              `状态：${itemStatusLabel}`,
              itemNodeId ? `节点：${itemNodeId}` : '',
              itemJobId ? `任务项：${itemJobId}` : '',
              itemTaskId ? `图片任务：${itemTaskId}` : '',
              itemErrorMessage ? `错误：${itemErrorMessage}` : '',
            ].filter(Boolean).join('\n');
            const downloadName = item.downloadName || buildResultDownloadFileName(item, index, itemTitle);
            const previewPayload = {
              ...item,
              prompt,
              goal,
              referenceUsage,
              scriptText,
              shotScript,
              itemIndex: index,
              imageUrl,
              downloadUrl,
              downloadName,
              title: itemTitle,
              resultCategory: itemCategory,
              resultStatusLabel: itemStatusLabel,
              errorMessage: itemErrorMessage,
              galleryItems,
              galleryIndex: galleryItems.findIndex((entry) => Number(entry.itemIndex) === index),
            };
            return (
              <article key={`${item?.jobId || item?.taskId || index}`} className={`result-gallery-card is-${item.resultStatusKey || String(item?.status || 'idle')}`}>
                <button
                  type="button"
                  className="result-gallery-thumb"
                  onClick={() => imageUrl && onPreviewImage?.(previewPayload)}
                  disabled={!imageUrl}
                >
                  {imageUrl ? <img src={imageUrl} alt="" draggable="false" /> : <span>{itemStatusLabel}</span>}
                </button>
                <div className="result-gallery-info">
                  <div>
                    <strong>{itemTitle}</strong>
                    <em>{itemStatusLabel}</em>
                  </div>
                  {itemCategory ? <span className="result-gallery-category">{itemCategory}</span> : null}
                  {goal || referenceUsage ? (
                    <div className="result-gallery-meta">
                      {goal ? <span><b>目标</b>{goal}</span> : null}
                      {referenceUsage ? <span><b>参考</b>{referenceUsage}</span> : null}
                    </div>
                  ) : null}
                  {scriptText || shotScript ? (
                    <div className="result-gallery-script">
                      {scriptText ? <span><b>视频脚本</b>{scriptText}</span> : null}
                      {shotScript ? <span><b>分镜说明</b>{shotScript}</span> : null}
                    </div>
                  ) : null}
                  {prompt ? <p>{prompt}</p> : null}
                  {itemErrorMessage ? <p className="result-gallery-error">{itemErrorMessage}</p> : null}
                </div>
                <footer className="result-gallery-actions">
                  <button type="button" className="result-gallery-preview-action" onClick={() => imageUrl && onPreviewImage?.(previewPayload)} disabled={!imageUrl}>
                    <Maximize2 size={14} />
                    预览
                  </button>
                  <button type="button" className="result-gallery-download-action" onClick={() => downloadImage(downloadUrl || imageUrl, downloadName)} disabled={!downloadUrl && !imageUrl}>
                    <Download size={14} />
                    下载
                  </button>
                  {itemErrorMessage ? (
                    <button type="button" className="result-gallery-copy-error-action" onClick={() => copyTextToClipboard(errorCopyText)} title="复制失败原因">
                      <Copy size={14} />
                      复制错误
                    </button>
                  ) : null}
                </footer>
              </article>
            );
          })}
        </div>
      </section>
    </div>,
    document.body
  );
}

const LIGHTBOX_FIT_PADDING = 48;
const LIGHTBOX_MIN_ZOOM = 0.03;
const LIGHTBOX_MAX_ZOOM = 6;

export function ImageLightbox({ imageUrl, downloadUrl, editContext = null, onSubmitEdit, onSelectVersion, onNavigateGallery, onOpenReferenceEditor, onOpenLocalReferenceEditor, onClose }) {
  const [zoom, setZoom] = useState(1);
  const [fitZoom, setFitZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [annotationTool, setAnnotationTool] = useState('annotate');
  const [editPrompt, setEditPrompt] = useState('');
  const [localCircles, setLocalCircles] = useState([]);
  const [activeLocalCircleIndex, setActiveLocalCircleIndex] = useState(-1);
  const [imageNaturalSize, setImageNaturalSize] = useState({ width: 0, height: 0 });
  const [editStatus, setEditStatus] = useState({ state: 'idle', message: '' });
  const stageRef = useRef(null);
  const imageRef = useRef(null);
  const dragRef = useRef(null);
  const annotationDragRef = useRef(null);
  const previewKind = String(editContext?.previewKind || '').trim();
  const canEdit = Boolean(editContext?.nodeId && imageUrl && onSubmitEdit && editContext?.editable !== false && previewKind !== 'reference' && previewKind !== 'localReference');
  const lightboxTitle = String(editContext?.title || (
    previewKind === 'localReference'
      ? '局部参考图预览'
      : (previewKind === 'reference' ? '参考图预览' : '结果预览')
  )).trim();
  const resultCategoryLabel = String(editContext?.resultCategory || editContext?.imageCategory || editContext?.image_category || '').trim();
  const resultStatusLabel = String(editContext?.resultStatusLabel || '').trim();
  const resultTaskId = String(editContext?.taskId || editContext?.task_id || '').trim();
  const resultIndex = Number.isFinite(Number(editContext?.itemIndex)) ? Number(editContext.itemIndex) + 1 : 0;
  const imageSizeLabel = imageNaturalSize.width > 0 && imageNaturalSize.height > 0
    ? `${Math.round(imageNaturalSize.width)}×${Math.round(imageNaturalSize.height)}`
    : '';
  const lightboxDownloadName = buildResultDownloadFileName(
    editContext,
    resultIndex > 0 ? resultIndex - 1 : 0,
    previewKind ? 'yali-image' : lightboxTitle || 'yali-image'
  );
  const galleryItems = Array.isArray(editContext?.galleryItems)
    ? editContext.galleryItems.filter((item) => item?.imageUrl || item?.downloadUrl || item?.referenceUrl)
    : [];
  const galleryIndex = Number.isFinite(Number(editContext?.galleryIndex)) ? Number(editContext.galleryIndex) : -1;
  const hasGalleryNavigation = galleryItems.length > 1 && typeof onNavigateGallery === 'function';
  const safeGalleryIndex = galleryIndex >= 0 ? galleryIndex : 0;
  const galleryThumbItems = hasGalleryNavigation
    ? galleryItems.map((item, index) => ({
      index,
      imageUrl: String(item?.imageUrl || item?.downloadUrl || item?.referenceUrl || '').trim(),
      title: String(item?.title || item?.name || item?.imageCategory || item?.image_category || cleanResultItemTitle(item, index)).trim(),
    })).filter((item) => item.imageUrl)
    : [];
  const lightboxSubtitle = [
    previewKind === 'localReference'
      ? `圈选 ${Number(editContext?.circleCount || 0)}/7`
      : '',
    imageSizeLabel,
    String(editContext?.instruction || '').trim() ? '已填写参考要求' : '',
    !previewKind && resultCategoryLabel ? resultCategoryLabel : '',
    !previewKind && resultStatusLabel ? resultStatusLabel : '',
    !previewKind && galleryIndex >= 0 && galleryItems.length > 1 ? `${galleryIndex + 1}/${galleryItems.length}` : (!previewKind && resultIndex > 0 ? `第 ${resultIndex} 张` : ''),
    !previewKind && resultTaskId ? `任务 ${resultTaskId}` : '',
    canEdit ? '可生成新版本' : '',
  ].filter(Boolean).join(' · ');
  const sourceVersion = {
    id: 'original',
    label: '原始图',
    imageUrl,
    downloadUrl: downloadUrl || imageUrl,
    taskId: String(editContext?.taskId || editContext?.task_id || '').trim(),
    prompt: String(editContext?.prompt || '').trim(),
    createdAt: '',
  };
  const versions = (Array.isArray(editContext?.versions) ? editContext.versions : [])
    .filter((version) => version && (version.imageUrl || version.image_url || version.downloadUrl || version.download_url))
    .map((version, index) => ({
      id: String(version.id || version.versionId || version.version_id || `version-${index + 1}`),
      label: String(version.label || `版本 ${index + 1}`),
      imageUrl: String(version.imageUrl || version.image_url || version.downloadUrl || version.download_url || ''),
      downloadUrl: String(version.downloadUrl || version.download_url || version.referenceUrl || version.reference_url || version.imageUrl || version.image_url || ''),
      taskId: String(version.taskId || version.task_id || ''),
      prompt: String(version.prompt || ''),
      editType: String(version.editType || version.edit_type || ''),
      createdAt: String(version.createdAt || version.created_at || ''),
    }));
  const safeVersions = versions.some((version) => version.id === 'original')
    ? versions
    : [sourceVersion].concat(versions);
  const selectedVersionId = String(editContext?.selectedVersionId || editContext?.selected_version_id || '').trim()
    || (safeVersions.find((version) => version.imageUrl === imageUrl || version.downloadUrl === downloadUrl)?.id || 'original');
  const readonlyLocalCircles = previewKind === 'localReference' && Array.isArray(editContext?.circles)
    ? editContext.circles
    : [];
  const visibleLocalCircles = canEdit ? localCircles : readonlyLocalCircles;
  const activeLocalCircle = activeLocalCircleIndex >= 0 ? localCircles[activeLocalCircleIndex] : null;
  const wholePromptReady = Boolean(editPrompt.trim());
  const validLocalCircles = localCircles.filter((circle) => String(circle?.text || '').trim());
  const readonlyReferenceFileName = String(editContext?.fileName || editContext?.file_name || '').trim();
  const readonlyReferenceInstruction = String(editContext?.instruction || '').trim();
  const showReadonlyReferencePanel = !canEdit && ['reference', 'localReference'].includes(previewKind);
  const canOpenReferenceEditor = showReadonlyReferencePanel
    && String(editContext?.nodeId || '').trim()
    && (
      (previewKind === 'localReference' && typeof onOpenLocalReferenceEditor === 'function')
      || (previewKind === 'reference' && typeof onOpenReferenceEditor === 'function')
    );
  const lightboxBodyClassName = [
    'lightbox-body',
    canEdit ? 'has-editor' : '',
    showReadonlyReferencePanel ? 'has-reference-info' : '',
  ].filter(Boolean).join(' ');

  const calculateFitZoom = useCallback(() => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image?.naturalWidth || !image?.naturalHeight) {
      return 1;
    }
    const rect = stage.getBoundingClientRect();
    const availableWidth = Math.max(1, rect.width - LIGHTBOX_FIT_PADDING * 2);
    const availableHeight = Math.max(1, rect.height - LIGHTBOX_FIT_PADDING * 2);
    return clamp(
      Math.min(availableWidth / image.naturalWidth, availableHeight / image.naturalHeight, 1),
      LIGHTBOX_MIN_ZOOM,
      LIGHTBOX_MAX_ZOOM
    );
  }, []);

  const fitImageToStage = useCallback(() => {
    const nextFitZoom = calculateFitZoom();
    setFitZoom(nextFitZoom);
    setZoom(nextFitZoom);
    setPan({ x: 0, y: 0 });
    setIsPanning(false);
    setAnnotationTool('annotate');
    setEditPrompt('');
    setLocalCircles([]);
    setActiveLocalCircleIndex(-1);
    setImageNaturalSize({
      width: Number(imageRef.current?.naturalWidth || 0),
      height: Number(imageRef.current?.naturalHeight || 0),
    });
    setEditStatus({ state: 'idle', message: '' });
    dragRef.current = null;
    annotationDragRef.current = null;
  }, [calculateFitZoom]);

  useEffect(() => {
    setFitZoom(1);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setIsPanning(false);
    setImageNaturalSize({ width: 0, height: 0 });
    dragRef.current = null;
    annotationDragRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      if (imageRef.current?.complete) {
        fitImageToStage();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitImageToStage, imageUrl]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      setFitZoom(calculateFitZoom());
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [calculateFitZoom]);

  const stopPanning = useCallback((event) => {
    if (event?.currentTarget && dragRef.current?.pointerId !== undefined) {
      try {
        event.currentTarget.releasePointerCapture?.(dragRef.current.pointerId);
      } catch (error) {
        // Pointer capture may already be released by the browser.
      }
    }
    dragRef.current = null;
    setIsPanning(false);
  }, []);

  const resetView = useCallback(() => {
    setZoom(fitZoom);
    setPan({ x: 0, y: 0 });
    dragRef.current = null;
    setIsPanning(false);
  }, [fitZoom]);

  useEffect(() => {
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (isTypingTarget(event.target)) {
        return;
      }
      if (hasGalleryNavigation && event.key === 'ArrowLeft') {
        event.preventDefault();
        onNavigateGallery(-1);
      } else if (hasGalleryNavigation && event.key === 'ArrowRight') {
        event.preventDefault();
        onNavigateGallery(1);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoom((value) => clamp(value * 1.12, LIGHTBOX_MIN_ZOOM, LIGHTBOX_MAX_ZOOM));
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        setZoom((value) => clamp(value / 1.12, LIGHTBOX_MIN_ZOOM, LIGHTBOX_MAX_ZOOM));
      } else if (event.key === '0') {
        event.preventDefault();
        resetView();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [hasGalleryNavigation, onClose, onNavigateGallery, resetView]);

  useEffect(() => {
    if (!localCircles.length) {
      setActiveLocalCircleIndex(-1);
      return;
    }
    setActiveLocalCircleIndex((current) => (
      current >= 0 && current < localCircles.length ? current : 0
    ));
  }, [localCircles]);

  const updateLocalCircle = useCallback((index, patch) => {
    setLocalCircles((items) => items.map((item, itemIndex) => {
      if (itemIndex !== index) {
        return item;
      }
      const nextCircle = { ...item, ...patch };
      const safeCircle = constrainCircleToImage(nextCircle);
      return { ...nextCircle, ...safeCircle };
    }));
  }, []);

  const removeLocalCircle = useCallback((index) => {
    setLocalCircles((items) => items.filter((_, itemIndex) => itemIndex !== index));
    setActiveLocalCircleIndex((current) => {
      if (current === index) {
        return -1;
      }
      if (current > index) {
        return current - 1;
      }
      return current;
    });
  }, []);

  const readAnnotationPoint = useCallback((event) => {
    const overlay = event.currentTarget;
    const rect = overlay.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
      width: rect.width,
      height: rect.height,
    };
  }, []);

  const findAnnotationCircleAt = useCallback((point) => {
    const minSide = Math.min(point.width, point.height);
    for (let index = localCircles.length - 1; index >= 0; index -= 1) {
      const circle = localCircles[index];
      const dx = (point.x - circle.x) * point.width;
      const dy = (point.y - circle.y) * point.height;
      if (Math.sqrt(dx * dx + dy * dy) <= circle.r * minSide) {
        return index;
      }
    }
    return -1;
  }, [localCircles]);

  const handleAnnotationPointerDown = useCallback((event) => {
    if (annotationTool !== 'annotate') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = readAnnotationPoint(event);
    const hitIndex = findAnnotationCircleAt(point);
    if (hitIndex >= 0) {
      setActiveLocalCircleIndex(hitIndex);
      annotationDragRef.current = hitIndex;
      return;
    }
    if (localCircles.length >= 7) {
      return;
    }
    const color = REFERENCE_CIRCLE_COLORS[localCircles.length % REFERENCE_CIRCLE_COLORS.length];
    const safeCircle = constrainCircleToImage({ x: point.x, y: point.y, r: 0.12 });
    setLocalCircles((items) => items.concat({
      x: safeCircle.x,
      y: safeCircle.y,
      r: safeCircle.r,
      colorKey: color.key,
      colorName: color.name,
      colorValue: color.value,
      text: '',
    }));
    setActiveLocalCircleIndex(localCircles.length);
    annotationDragRef.current = localCircles.length;
  }, [annotationTool, findAnnotationCircleAt, localCircles.length, readAnnotationPoint]);

  const handleAnnotationPointerMove = useCallback((event) => {
    if (annotationDragRef.current === null || annotationDragRef.current === undefined) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const point = readAnnotationPoint(event);
    updateLocalCircle(annotationDragRef.current, { x: point.x, y: point.y });
  }, [readAnnotationPoint, updateLocalCircle]);

  const stopAnnotationDrag = useCallback((event) => {
    if (annotationDragRef.current === null || annotationDragRef.current === undefined) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch (error) {
      // Pointer capture may already be released by the browser.
    }
    annotationDragRef.current = null;
  }, []);

  const submitEdit = async () => {
    if (!canEdit || editStatus.state === 'running') {
      return;
    }
    const prompt = editPrompt.trim();
    if (!prompt && !validLocalCircles.length) {
      setEditStatus({ state: 'error', message: '请先输入主编辑提示词，或添加局部圈选。' });
      return;
    }
    setEditStatus({ state: 'running', message: '正在生成新版本，完成后会加入版本列表。' });
    try {
      await onSubmitEdit({
        prompt,
        context: editContext,
        editType: validLocalCircles.length ? 'local' : 'whole',
        circles: validLocalCircles,
        onProgress: (status) => {
          setEditStatus({
            state: status?.state || 'running',
            message: status?.message || '正在生成新版本...',
            taskId: String(status?.taskId || '').trim(),
          });
        },
      });
      setEditPrompt('');
      setLocalCircles([]);
      setActiveLocalCircleIndex(-1);
      setEditStatus({ state: 'done', message: '新版本已生成，可设为最终图。' });
    } catch (error) {
      setEditStatus({ state: 'error', message: error?.message || '图片编辑失败，请稍后重试。' });
    }
  };

  const openReadonlyReferenceEditor = () => {
    const nodeId = String(editContext?.nodeId || '').trim();
    if (!nodeId) {
      return;
    }
    onClose?.();
    if (previewKind === 'localReference') {
      onOpenLocalReferenceEditor?.(nodeId);
      return;
    }
    onOpenReferenceEditor?.(nodeId);
  };

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" onPointerDown={onClose}>
      <div className="lightbox-shell" onPointerDown={(event) => event.stopPropagation()}>
        <header className="lightbox-head">
          <div className="lightbox-title-block">
            <strong>{lightboxTitle || '图片预览'}</strong>
            {lightboxSubtitle ? <span>{lightboxSubtitle}</span> : null}
          </div>
          <div className="lightbox-tools">
            {hasGalleryNavigation ? (
              <>
                <button type="button" className="lightbox-gallery-nav-button" onClick={() => onNavigateGallery(-1)} aria-label="上一张">
                  <ChevronLeft size={16} />
                </button>
                <button type="button" className="lightbox-gallery-nav-button" onClick={() => onNavigateGallery(1)} aria-label="下一张">
                  <ChevronRight size={16} />
                </button>
              </>
            ) : null}
            <button type="button" onClick={() => setZoom((value) => clamp(value - 0.12, 0.2, 6))} aria-label="缩小">
              <Minus size={16} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((value) => clamp(value + 0.12, 0.2, 6))} aria-label="放大">
              <Plus size={16} />
            </button>
            <button type="button" onClick={resetView} aria-label="重置视图">
              <Maximize2 size={16} />
            </button>
            <button type="button" onClick={() => downloadImage(downloadUrl || imageUrl, lightboxDownloadName)}>
              <Download size={16} />
            </button>
            <button type="button" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </button>
          </div>
        </header>
        <div className={lightboxBodyClassName}>
          <div
            className={`lightbox-stage${isPanning ? ' is-panning' : ''}`}
            ref={stageRef}
            onWheel={(event) => {
              if (event.target?.closest?.('.lightbox-stage-panel')) {
                return;
              }
              event.preventDefault();
              setZoom((value) => clamp(value * (event.deltaY > 0 ? 0.9 : 1.1), LIGHTBOX_MIN_ZOOM, LIGHTBOX_MAX_ZOOM));
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) {
                return;
              }
              if (event.target?.closest?.('.lightbox-stage-panel')) {
                return;
              }
              event.preventDefault();
              event.currentTarget.setPointerCapture?.(event.pointerId);
              dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pan };
              setIsPanning(true);
            }}
            onPointerMove={(event) => {
              if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) {
                return;
              }
              event.preventDefault();
              setPan({
                x: dragRef.current.pan.x + event.clientX - dragRef.current.x,
                y: dragRef.current.pan.y + event.clientY - dragRef.current.y,
              });
            }}
            onPointerUp={stopPanning}
            onPointerCancel={stopPanning}
            onPointerLeave={(event) => {
              if (dragRef.current?.pointerId === event.pointerId) {
                stopPanning(event);
              }
            }}
            onLostPointerCapture={() => {
              dragRef.current = null;
              setIsPanning(false);
            }}
          >
            <div
              className="lightbox-image-frame"
              style={{ transform: `translate3d(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px), 0) scale(${zoom})` }}
            >
              <img ref={imageRef} src={imageUrl} alt="" draggable="false" onLoad={fitImageToStage} />
              {(canEdit || visibleLocalCircles.length > 0) && imageNaturalSize.width > 0 && imageNaturalSize.height > 0 ? (
                <div
                  className={`lightbox-annotation-layer is-${canEdit ? annotationTool : 'readonly'}`}
                  style={{ width: `${imageNaturalSize.width}px`, height: `${imageNaturalSize.height}px` }}
                  onPointerDown={canEdit ? handleAnnotationPointerDown : undefined}
                  onPointerMove={canEdit ? handleAnnotationPointerMove : undefined}
                  onPointerUp={canEdit ? stopAnnotationDrag : undefined}
                  onPointerCancel={canEdit ? stopAnnotationDrag : undefined}
                  onPointerLeave={canEdit ? stopAnnotationDrag : undefined}
                >
                  <svg viewBox={`0 0 ${imageNaturalSize.width} ${imageNaturalSize.height}`} preserveAspectRatio="none" aria-hidden="true">
                    {visibleLocalCircles.map((circle, index) => {
                      const radius = circle.r * Math.min(imageNaturalSize.width, imageNaturalSize.height);
                      const centerX = circle.x * imageNaturalSize.width;
                      const centerY = circle.y * imageNaturalSize.height;
                      const isActive = canEdit && index === activeLocalCircleIndex;
                      return (
                        <g key={circle.colorKey + '-' + index}>
                          <circle cx={centerX} cy={centerY} r={radius} fill={colorToRgba(circle.colorValue, isActive ? 0.16 : 0.1)} />
                          <circle cx={centerX} cy={centerY} r={radius} fill="none" stroke="rgba(255,255,255,0.92)" strokeWidth={isActive ? 7 : 5} />
                          <circle cx={centerX} cy={centerY} r={radius} fill="none" stroke={circle.colorValue} strokeWidth={isActive ? 4 : 3} strokeDasharray="14 9" />
                          <circle cx={centerX + radius * 0.72} cy={centerY - radius * 0.72} r="14" fill={colorToRgba(circle.colorValue, 0.74)} stroke="rgba(255,255,255,0.86)" strokeWidth="2" />
                          <text x={centerX + radius * 0.72} y={centerY - radius * 0.72 + 0.5} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize="14" fontWeight="900">
                            {index + 1}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              ) : null}
            </div>
            {galleryThumbItems.length > 1 ? (
              <div
                className="lightbox-gallery-strip"
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
                aria-label="结果缩略图导航"
              >
                {galleryThumbItems.map((item) => {
                  const isCurrent = item.index === safeGalleryIndex;
                  return (
                    <button
                      key={`${item.imageUrl}-${item.index}`}
                      type="button"
                      className={isCurrent ? 'is-current' : ''}
                      onClick={() => {
                        const step = item.index - safeGalleryIndex;
                        if (step) {
                          onNavigateGallery(step);
                        }
                      }}
                      disabled={isCurrent}
                      title={item.title}
                      aria-label={`预览第 ${item.index + 1} 张：${item.title}`}
                    >
                      <img src={item.imageUrl} alt="" draggable="false" />
                      <span>{String(item.index + 1).padStart(2, '0')}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {canEdit ? (
              <div
                className="lightbox-stage-panel"
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
              >
                <div className="lightbox-stage-toolbar">
                  <button type="button" className={annotationTool === 'annotate' ? 'is-active' : ''} onClick={() => setAnnotationTool('annotate')}>
                    <Crosshair size={14} />
                    标注
                  </button>
                  <button type="button" className={annotationTool === 'pan' ? 'is-active' : ''} onClick={() => setAnnotationTool('pan')}>
                    <Maximize2 size={14} />
                    移动
                  </button>
                  <span>{localCircles.length}/7</span>
                  <button type="button" onClick={() => { setLocalCircles([]); setActiveLocalCircleIndex(-1); }} disabled={!localCircles.length}>
                    清空圈选
                  </button>
                </div>
                <div className={`lightbox-local-overlay-panel${localCircles.length ? '' : ' is-empty'}`}>
                  {localCircles.length ? (
                    <>
                      <div className="lightbox-local-overlay-head">
                        <strong>局部修改</strong>
                        <span>点击左侧圈选切换目标区域，拖动圆圈可调整位置。</span>
                      </div>
                      <div className="lightbox-local-chip-row">
                        {localCircles.map((circle, index) => (
                          <button
                            key={circle.colorKey + '-' + index}
                            type="button"
                            className={index === activeLocalCircleIndex ? 'is-active' : ''}
                            style={{ '--local-reference-color': circle.colorValue }}
                            onClick={() => setActiveLocalCircleIndex(index)}
                          >
                            <span>{index + 1}</span>
                            {circle.colorName}圈
                          </button>
                        ))}
                      </div>
                      {activeLocalCircle ? (
                        <div className="lightbox-local-active-card" style={{ '--local-reference-color': activeLocalCircle.colorValue }}>
                          <label className="lightbox-edit-field">
                            <span>{activeLocalCircle.colorName}圈 {activeLocalCircleIndex + 1}</span>
                            <textarea
                              value={activeLocalCircle.text || ''}
                              onChange={(event) => updateLocalCircle(activeLocalCircleIndex, { text: event.target.value })}
                              placeholder="描述这个局部要如何修改"
                              maxLength={MAX_PROMPT_LENGTH}
                            />
                          </label>
                          <div className="lightbox-local-active-actions">
                            <label>
                              大小
                              <input
                                type="range"
                                min="3"
                                max="45"
                                value={Math.round((activeLocalCircle.r || 0.12) * 100)}
                                onChange={(event) => updateLocalCircle(activeLocalCircleIndex, { r: clamp(Number(event.target.value) / 100, 0.03, 0.45) })}
                              />
                            </label>
                            <button type="button" onClick={() => removeLocalCircle(activeLocalCircleIndex)}>
                              删除这个圈选
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <div className="lightbox-local-overlay-head">
                        <strong>局部修改</strong>
                        <span>在左侧图片上直接点击即可新增圈选，适合修局部人物、文案、材质或细节。</span>
                      </div>
                      <div className="lightbox-local-empty">局部圈选和主编辑提示词可以同时存在。先在左侧点一下，再为该区域填写修改要求。</div>
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </div>
          {canEdit ? (
            <aside className="lightbox-edit-panel">
              <div className="lightbox-edit-topbar">
                <strong>编辑图片</strong>
                <div className="lightbox-edit-summary">
                  <span className={wholePromptReady ? 'is-ready' : ''}>
                    <Sparkles size={14} />
                    主提示词
                  </span>
                  <span className={localCircles.length ? 'is-ready' : ''}>
                    <Crosshair size={14} />
                    局部圈选 {localCircles.length}/7
                  </span>
                  <span className={validLocalCircles.length ? 'is-ready' : ''}>
                    <Check size={14} />
                    已填写 {validLocalCircles.length}
                  </span>
                </div>
              </div>
              <div className="lightbox-edit-scroll">
                <div className="lightbox-edit-section">
                  <div className="lightbox-whole-edit-card">
                    <label className="lightbox-edit-field">
                      <span>主编辑提示词</span>
                      <textarea
                        value={editPrompt}
                        onChange={(event) => setEditPrompt(event.target.value)}
                        placeholder="例如：保持主体不变，增强光影层次与冲击力，并统一整体氛围"
                        maxLength={MAX_PROMPT_LENGTH}
                      />
                    </label>
                  </div>
                </div>
              </div>
              <div className="lightbox-edit-actionbar">
                <button
                  type="button"
                  className={`lightbox-edit-submit${editStatus.state === 'running' ? ' is-running' : ''}`}
                  onClick={submitEdit}
                  disabled={editStatus.state === 'running'}
                >
                  {editStatus.state === 'running' ? (
                    <>
                      <span className="lightbox-edit-spinner" aria-hidden="true" />
                      <span className="lightbox-edit-label">生成中</span>
                    </>
                  ) : <span className="lightbox-edit-label">生成新版本</span>}
                </button>
                {editStatus.message ? (
                  <p className={`lightbox-edit-status is-${editStatus.state}`}>
                    <span>{editStatus.message}</span>
                    {editStatus.taskId ? <code>{editStatus.taskId}</code> : null}
                  </p>
                ) : null}
              </div>
              <div className="lightbox-version-section">
                <strong>图片版本</strong>
                <div className="lightbox-version-list">
                  {safeVersions.map((version) => {
                    const isSelected = version.id === selectedVersionId;
                    return (
                      <div key={version.id} className={`lightbox-version-card${isSelected ? ' is-selected' : ''}`}>
                        <button type="button" className="lightbox-version-thumb" onClick={() => onSelectVersion?.(editContext, version)}>
                          <img src={version.imageUrl || version.downloadUrl} alt="" draggable="false" />
                        </button>
                        <div>
                          <b>{version.label}</b>
                          {version.prompt ? <span>{version.prompt}</span> : <span>{isSelected ? '当前最终图' : '可设为最终图'}</span>}
                        </div>
                        <button type="button" onClick={() => onSelectVersion?.(editContext, version)} disabled={isSelected}>
                          {isSelected ? '已选' : '设为最终'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </aside>
          ) : null}
          {showReadonlyReferencePanel ? (
            <aside className="lightbox-reference-panel">
              <div className="lightbox-reference-panel__head">
                <strong>{previewKind === 'localReference' ? '局部参考说明' : '参考图说明'}</strong>
                <span>{previewKind === 'localReference' ? `${readonlyLocalCircles.length}/7 个圈选` : '只读预览'}</span>
              </div>
              {canOpenReferenceEditor ? (
                <button type="button" className="lightbox-reference-action" onClick={openReadonlyReferenceEditor}>
                  {previewKind === 'localReference' ? '编辑圈选与说明' : '编辑参考要求'}
                </button>
              ) : null}
              {readonlyReferenceFileName ? (
                <div className="lightbox-reference-file">
                  <b>原始文件</b>
                  <span title={readonlyReferenceFileName}>{readonlyReferenceFileName}</span>
                </div>
              ) : null}
              {readonlyReferenceInstruction ? (
                <div className="lightbox-reference-note">
                  <div className="lightbox-reference-note-head">
                    <b>{previewKind === 'localReference' ? '整体要求' : '参考要求'}</b>
                    <button type="button" onClick={() => copyTextToClipboard(readonlyReferenceInstruction)} aria-label={previewKind === 'localReference' ? '复制整体要求' : '复制参考要求'}>
                      <Copy size={13} />
                      复制
                    </button>
                  </div>
                  <p>{readonlyReferenceInstruction}</p>
                </div>
              ) : (
                <div className="lightbox-reference-note is-empty">
                  <b>{previewKind === 'localReference' ? '整体要求' : '参考要求'}</b>
                  <p>暂未填写说明。</p>
                </div>
              )}
              {previewKind === 'localReference' ? (
                <div className="lightbox-reference-circles">
                  {readonlyLocalCircles.length ? readonlyLocalCircles.map((circle, index) => (
                    <div key={`${circle.colorKey || circle.colorValue || 'circle'}-${index}`} className="lightbox-reference-circle-item" style={{ '--local-reference-color': circle.colorValue || '#14b8a6' }}>
                      <span>{index + 1}</span>
                      <div>
                        <div className="lightbox-reference-circle-head">
                          <strong>{circle.colorName || '圈选'} {index + 1}</strong>
                          <button type="button" onClick={() => copyTextToClipboard(String(circle.text || '').trim())} disabled={!String(circle.text || '').trim()} aria-label={`复制${circle.colorName || '圈选'} ${index + 1}说明`}>
                            <Copy size={13} />
                            复制
                          </button>
                        </div>
                        <p>{String(circle.text || '').trim() || '暂未填写局部说明。'}</p>
                      </div>
                    </div>
                  )) : <p className="lightbox-reference-empty">还没有圈选区域。</p>}
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
