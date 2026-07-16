import { useEffect, useRef, useState } from 'react';
import { Handle, NodeToolbar, Position } from '@xyflow/react';
import { Bomb, BoxSelect, Crop, Crosshair, Download, Eraser, FileArchive, FileSpreadsheet, Image as ImageIcon, Link as LinkIcon, Maximize2, ShoppingBag, Trash2, Upload } from 'lucide-react';
import { NODE_DEFS } from '../config/nodeDefs.jsx';
import { STATUS_LABELS } from '../config/constants.js';
import { downloadImage } from '../utils/image.js';
import { getEcommerceCapabilityConfig, getEcommerceImageSetCount } from '../utils/ecommerce.js';

function isCanvasResultItemDone(item) {
  return Boolean(getCanvasResultImageUrl(item) || String(item?.status || '').trim() === 'done');
}

function getCanvasResultImageUrl(item = {}) {
  return String(item?.imageUrl || item?.image_url || item?.downloadUrl || item?.download_url || item?.referenceUrl || item?.reference_url || '').trim();
}

function getNodePreviewImageUrl(data = {}) {
  return String(data.imageUrl || data.referenceUrl || data.outputUrl || '').trim();
}

function isEcommerceOverviewItem(item) {
  const batchItem = item?.batchItem || item?.batch_item || null;
  const role = String(item?.role || item?.batchRole || batchItem?.role || '').trim().toLowerCase();
  const name = String(item?.name || batchItem?.name || '').trim().toLowerCase();
  const category = String(item?.imageCategory || item?.image_category || batchItem?.imageCategory || batchItem?.image_category || '').trim().toLowerCase();
  return role === 'overview' || name === 'overview' || category === 'overview' || category === '商品组图总览' || category === '组图总览';
}

function getStepClassName(ready, current = false) {
  return [ready ? 'is-ready' : '', current ? 'is-current' : ''].filter(Boolean).join(' ');
}

export function PromptNode({ id, data, selected }) {
  return (
    <NodeShell id={id} data={data} selected={selected} tone="prompt" source>
      <NodeHeader data={data} type="prompt" />
      {String(data.prompt || '').trim()
        ? <p className="node-text">{data.prompt}</p>
        : <p className="node-hint">请填写本次生成提示词。</p>}
      {data.errorMessage ? <p className="node-error">{data.errorMessage}</p> : null}
    </NodeShell>
  );
}

export function BatchPromptNode({ id, data, selected }) {
  const items = Array.isArray(data.items) ? data.items.filter((item) => item && !item.skip && String(item.prompt || '').trim()).slice(0, 20) : [];
  return (
    <NodeShell id={id} data={data} selected={selected} tone="batchPrompt" source>
      <NodeHeader data={data} type="batchPrompt" />
      {items.length ? (
        <>
          <div className="batch-node-summary">
            <strong>{items.length}</strong>
            <span>条提示词</span>
            <em>{data.fileName || 'CSV 已导入'}</em>
          </div>
          <div className="batch-node-list">
            {items.slice(0, 3).map((item, index) => (
              <span key={`${item.name}-${index}`}>
                <b>{String(item.index || index + 1).padStart(2, '0')}</b>
                {item.name || `batch-${index + 1}`}
              </span>
            ))}
          </div>
        </>
      ) : (
        <div className="batch-node-empty">
          <FileSpreadsheet size={24} />
          <span>导入 CSV 后循环生成</span>
        </div>
      )}
      {data.errorMessage ? <p className="node-error">{data.errorMessage}</p> : null}
      <div className="node-inline-actions nodrag">
        <button type="button" onClick={() => data.onOpenBatchPrompt?.(id)} disabled={data.locked}>
          <Upload size={14} />
          {items.length ? '更换' : '导入'}
        </button>
        <button type="button" onClick={() => data.onClearBatchPrompt?.(id)} disabled={!items.length || data.locked}>
          <Trash2 size={14} />
          清除
        </button>
      </div>
    </NodeShell>
  );
}

export function ReferenceNode({ id, data, selected }) {
  const openPreview = () => data.onPreview?.({
    title: data.label || '参考图预览',
    previewKind: 'reference',
    nodeType: 'reference',
    editable: false,
    imageUrl: data.imageUrl,
    downloadUrl: data.originalImageUrl || data.imageUrl,
    fileName: data.fileName || data.note || '',
    instruction: String(data.referenceInstruction ?? data.wholeInstruction ?? '').trim(),
  });

  return (
    <NodeShell id={id} data={data} selected={selected} tone="reference" source>
      <NodeHeader data={data} type="reference" />
      <PreviewMedia imageUrl={data.imageUrl} emptyText="拖入参考图" onPreview={openPreview} />
      <p className="node-hint">{data.note || '上传一张参考图后可以单独打开编辑器。'}</p>
      {data.errorMessage ? <p className="node-error">{data.errorMessage}</p> : null}
      <div className="node-inline-actions nodrag">
        <button type="button" onClick={() => data.onRequestUpload?.(id)} disabled={data.locked}>
          <Upload size={14} />
          上传
        </button>
        <button type="button" onClick={() => data.onOpenReferenceEditor?.(id)} disabled={!data.imageUrl || data.locked}>
          <Crop size={14} />
          编辑
        </button>
      </div>
    </NodeShell>
  );
}

export function LocalReferenceNode({ id, data, selected }) {
  const circles = Array.isArray(data.circles) ? data.circles : [];
  const hasCirclePrompt = circles.some((circle) => String(circle?.text || '').trim());
  const isReady = Boolean(data.imageUrl && circles.length && hasCirclePrompt);
  const openPreview = () => data.onPreview?.({
    title: data.label || '局部参考图预览',
    previewKind: 'localReference',
    nodeType: 'localReference',
    editable: false,
    imageUrl: data.imageUrl,
    downloadUrl: data.originalImageUrl || data.imageUrl,
    fileName: data.fileName || data.note || '',
    instruction: data.localPrompt || '',
    circleCount: circles.length,
    circles,
  });

  return (
    <NodeShell id={id} data={data} selected={selected} tone="localReference" source>
      <NodeHeader data={data} type="localReference" />
      <LocalReferencePreview imageUrl={data.imageUrl} circles={circles} emptyText="上传局部参考图" onPreview={openPreview} />
      <div className="local-ref-status">
        <span className={data.imageUrl ? 'is-done' : ''}>图片</span>
        <span className={circles.length ? 'is-done' : ''}>圈选 {circles.length}/7</span>
        <span className={hasCirclePrompt ? 'is-done' : ''}>提示词</span>
      </div>
      {data.localPrompt ? <p className="node-text">{data.localPrompt}</p> : <p className="node-hint">{data.note}</p>}
      {data.errorMessage ? <p className="node-error">{data.errorMessage}</p> : null}
      <div className="node-inline-actions nodrag">
        <button type="button" onClick={() => data.onRequestUpload?.(id)} disabled={data.locked}>
          <Upload size={14} />
          上传
        </button>
        <button type="button" onClick={() => data.onOpenLocalReference?.(id)} disabled={!data.imageUrl || data.locked}>
          <Crosshair size={14} />
          圈选
        </button>
      </div>
      {isReady && <div className="local-ref-ready">局部参考已就绪</div>}
    </NodeShell>
  );
}

export function GenerateNode({ id, data, selected }) {
  const sizeLabel = data.useCustomSize ? `${data.customWidth || 1280}x${data.customHeight || 720}` : data.size;
  const resultItems = Array.isArray(data.resultItems) ? data.resultItems : [];
  const doneCount = resultItems.filter(isCanvasResultItemDone).length;
  const totalCount = resultItems.length || Number(data.batchTotal || 0);
  const previewImageUrl = getNodePreviewImageUrl(data);
  const openPreview = () => data.onPreview?.({
    title: data.label || '生成图片结果',
    imageUrl: previewImageUrl,
    downloadUrl: data.referenceUrl || data.downloadUrl || previewImageUrl,
    items: resultItems,
    expectedCount: totalCount,
  });
  return (
    <NodeShell id={id} data={data} selected={selected} tone="generate" target source>
      <NodeHeader data={data} type="generate" />
      <PreviewMedia
        imageUrl={previewImageUrl}
        emptyText="等待生成"
        onPreview={openPreview}
      />
      {data.errorMessage ? <p className="node-error">{data.errorMessage}</p> : null}
      <BatchBadge data={data} />
      {totalCount > 1 ? (
        <div className="node-result-count">
          <span>{doneCount}</span>
          <em>/ {totalCount} 张</em>
        </div>
      ) : null}
      <div className="node-meta-row">
        <span>{sizeLabel}</span>
        <span>{qualityLabel(data.quality)}</span>
        <span>{String(data.outputFormat || 'jpeg').toUpperCase()}</span>
        {data.fastMode ? <span>快速</span> : null}
        {Number(data.estimatedCreditCost || 0) > 0 ? <span>{Number(data.estimatedCreditCost || 0)} 积分</span> : null}
      </div>
      <RunBar data={data} />
    </NodeShell>
  );
}

export function ImageExplosionNode({ id, data, selected }) {
  const resultItems = Array.isArray(data.resultItems) ? data.resultItems : [];
  const doneCount = resultItems.filter(isCanvasResultItemDone).length;
  const expectedCount = resultItems.length || Number(data.elementCount || 6);
  const prompts = Array.isArray(data.explodedPrompts) ? data.explodedPrompts.filter(Boolean) : [];
  const previewImageUrl = getNodePreviewImageUrl(data);
  const openPreview = () => data.onPreview?.({
    title: data.label || '图片大爆炸结果',
    imageUrl: previewImageUrl,
    downloadUrl: data.referenceUrl || data.downloadUrl || previewImageUrl,
    items: resultItems,
    expectedCount,
    forceGallery: expectedCount > 1,
  });

  return (
    <NodeShell id={id} data={data} selected={selected} tone="imageExplosion" target source>
      <NodeHeader data={data} type="imageExplosion" />
      <PreviewMedia
        imageUrl={previewImageUrl}
        emptyText="等待拆解"
        onPreview={openPreview}
      />
      <div className="explosion-steps">
        <span className="is-ready">理解图片</span>
        <span className={prompts.length ? 'is-ready' : ''}>拆解提示词</span>
        <span className={doneCount ? 'is-ready' : ''}>生成元素图</span>
      </div>
      <div className="node-result-count">
        <Bomb size={13} />
        <span>{doneCount}</span>
        <em>/ {expectedCount} 张</em>
      </div>
      <div className="node-meta-row">
        {Number(data.estimatedCreditCost || 0) > 0 ? <span>预计 {Number(data.estimatedCreditCost || 0)} 积分</span> : null}
        <span>目标 {expectedCount} 张</span>
      </div>
      {data.errorMessage ? <p className="node-error">{data.errorMessage}</p> : null}
      <p className="node-hint">{data.note || '前置必须连接一张图片；API 接入后会自动拆解元素并批量生成。'}</p>
      <RunBar data={data} />
    </NodeShell>
  );
}

export function EcommerceImageNode({ id, data, selected }) {
  const resultItems = Array.isArray(data.resultItems) ? data.resultItems : [];
  const doneCount = resultItems.filter(isCanvasResultItemDone).length;
  const setImageCount = getEcommerceImageSetCount(data);
  const capabilityConfig = getEcommerceCapabilityConfig(data);
  const configuredExpectedCount = Math.max(2, setImageCount + 1);
  const expectedCount = Math.max(resultItems.length, configuredExpectedCount);
  const prompts = Array.isArray(data.ecommercePrompts)
    ? data.ecommercePrompts.filter(Boolean)
    : (Array.isArray(data.explodedPrompts) ? data.explodedPrompts.filter(Boolean) : []);
  const ecommerceStage = String(data.ecommerceStage || '').trim();
  const analysisStatus = String(data.ecommerceAnalysisStatus || '').trim();
  const setAnalysisStatus = String(data.ecommerceSetAnalysisStatus || '').trim();
  const overviewItem = resultItems.find((item) => isEcommerceOverviewItem(item)) || null;
  const overviewDone = isCanvasResultItemDone(overviewItem);
  const setImageItems = resultItems.filter((item) => !isEcommerceOverviewItem(item));
  const completedSetImageCount = setImageItems.filter(isCanvasResultItemDone).length;
  const setPromptItems = prompts.filter((item) => !isEcommerceOverviewItem(item));
  const allSetImagesDone = setImageCount > 0 && completedSetImageCount >= setImageCount;
  const currentStep = ['strategy_analysis', 'overview_analysis'].includes(ecommerceStage)
    ? 'understanding'
    : (ecommerceStage === 'overview_generating'
      ? 'overview'
      : (ecommerceStage === 'set_analysis'
        ? 'setAnalysis'
        : (ecommerceStage === 'set_generating' && !allSetImagesDone ? 'setGeneration' : '')));
  const hasUnderstanding = Boolean(
    currentStep
    || overviewDone
    || setPromptItems.length
    || completedSetImageCount
    || String(data.status || '').trim() === 'done'
  );
  const hasOverview = Boolean(
    overviewDone
    || setPromptItems.length
    || completedSetImageCount
    || String(data.status || '').trim() === 'done'
  );
  const hasSetAnalysis = Boolean(
    setPromptItems.length
    || ['done', 'recovered'].includes(setAnalysisStatus)
    || completedSetImageCount
    || String(data.status || '').trim() === 'done'
  );
  const hasSetGeneration = Boolean(
    allSetImagesDone
    || String(data.status || '').trim() === 'done'
  );
  const previewImageUrl = getNodePreviewImageUrl(data);
  const textModeLabel = data.textMode === 'clean' ? '纯视觉展示' : (data.textMode === 'rich_text' ? '丰富图文' : '简短文案');
  const openPreview = () => data.onPreview?.({
    title: data.label || `${capabilityConfig?.label || '电商图'}结果`,
    imageUrl: previewImageUrl,
    downloadUrl: data.referenceUrl || data.downloadUrl || previewImageUrl,
    items: resultItems,
    expectedCount,
    forceGallery: expectedCount > 1,
  });

  return (
    <NodeShell id={id} data={data} selected={selected} tone="ecommerceImage" target source>
      <NodeHeader data={data} type="ecommerceImage" />
      <PreviewMedia
        imageUrl={previewImageUrl}
        emptyText={`等待${capabilityConfig?.shortLabel || '电商图'}`}
        onPreview={openPreview}
      />
      <div className="explosion-steps ecommerce-steps">
        <span className={getStepClassName(hasUnderstanding || analysisStatus === 'done' || prompts.length, currentStep === 'understanding')}>
          理解商品
        </span>
        <span className={getStepClassName(hasOverview, currentStep === 'overview')}>
          生成总览
        </span>
        <span className={getStepClassName(hasSetAnalysis, currentStep === 'setAnalysis')}>
          拆解素材
        </span>
        <span className={getStepClassName(hasSetGeneration || doneCount > 1, currentStep === 'setGeneration')}>
          生成图片
        </span>
      </div>
      <div className="node-result-count">
        <ShoppingBag size={13} />
        <span>{doneCount}</span>
        <em>/ {expectedCount} 张</em>
      </div>
      <div className="node-meta-row">
        <span>{textModeLabel}</span>
        <span>{setImageCount} 张{capabilityConfig?.shortLabel || '图片'}</span>
        {Number(data.estimatedCreditCost || 0) > 0 ? <span>{Number(data.estimatedCreditCost || 0)} 积分</span> : null}
      </div>
      {data.errorMessage ? <p className="node-error">{data.errorMessage}</p> : null}
      <p className="node-hint">{data.note || `连接商品参考图后，自动生成${capabilityConfig?.label || '电商图片素材'}。`}</p>
      <RunBar data={data} />
    </NodeShell>
  );
}

export function OutputNode({ id, data, selected }) {
  const isZip = data.outputMode === 'zip';
  const previewImageUrl = getNodePreviewImageUrl(data);
  const downloadUrl = isZip ? (data.packageUrl || data.outputUrl) : (data.outputUrl || data.referenceUrl || data.imageUrl);
  const downloadName = isZip ? data.packageFileName || 'yali-canvas.zip' : 'yali-output.png';
  const resultItems = Array.isArray(data.resultItems) ? data.resultItems : [];
  const outputCount = resultItems.filter(isCanvasResultItemDone).length || Number(data.packageCount || 0);
  const openPreview = () => data.onPreview?.({
    title: data.label || '输出结果',
    imageUrl: previewImageUrl,
    downloadUrl,
    items: resultItems,
    packageUrl: data.packageUrl || '',
    packageFileName: downloadName,
    csvUrl: data.csvUrl || '',
    forceGallery: resultItems.length > 1 || outputCount > 1 || Boolean(data.packageUrl),
    expectedCount: outputCount,
  });
  return (
    <NodeShell id={id} data={data} selected={selected} tone="output" target>
      <NodeHeader data={data} type="output" />
      <PreviewMedia
        imageUrl={previewImageUrl}
        emptyText="最终图"
        onPreview={openPreview}
      />
      {data.errorMessage ? <p className="node-error">{data.errorMessage}</p> : null}
      <BatchBadge data={data} />
      <div className="node-meta-row">
        <span>{isZip ? '压缩包' : '图片URL'}</span>
        {outputCount ? <span>{outputCount} 张</span> : null}
      </div>
      <div className="node-inline-actions nodrag">
        <button type="button" onClick={openPreview} disabled={!previewImageUrl && !resultItems.length && !data.packageUrl}>
          <Maximize2 size={14} />
          预览
        </button>
        <button type="button" onClick={() => downloadImage(downloadUrl, downloadName)} disabled={!downloadUrl}>
          {isZip ? <FileArchive size={14} /> : <Download size={14} />}
          {isZip ? '下载包' : '下载'}
        </button>
      </div>
      {!isZip && data.outputUrl ? (
        <button type="button" className="node-copy-link nodrag" onClick={() => navigator.clipboard?.writeText(data.outputUrl)}>
          <LinkIcon size={14} />
          复制URL
        </button>
      ) : null}
    </NodeShell>
  );
}

function BatchBadge({ data }) {
  if (!data.batchTotal) {
    return null;
  }
  return (
    <div className="node-batch-badge">
      <FileSpreadsheet size={13} />
      <span>批量 x {data.batchTotal}</span>
      {data.batchSourceLabel ? <em>{data.batchSourceLabel}</em> : null}
    </div>
  );
}

function NodeShell({ id, data, selected, tone, target = false, source = false, children }) {
  const handleClick = (event) => {
    if (!event.target.closest('.node-media-hit') || data.locked) {
      return;
    }

    if (tone === 'reference') {
      if (data.imageUrl) {
        data.onOpenReferenceEditor?.(id);
        return;
      }
      data.onRequestUpload?.(id);
      return;
    }

    if (tone === 'localReference') {
      if (data.imageUrl) {
        data.onOpenLocalReference?.(id);
        return;
      }
      data.onRequestUpload?.(id);
    }
  };

  return (
    <div className={`flow-node flow-node--${tone}${selected ? ' is-selected' : ''}${data.status === 'running' ? ' is-running' : ''}${data.locked ? ' is-locked' : ''}`} onClick={handleClick}>
      {target && <Handle type="target" position={Position.Left} />}
      <NodeToolbar
        isVisible={selected && !data.locked}
        position={Position.Top}
        offset={10}
        className="node-toolbar nodrag"
      >
        {['generate', 'imageExplosion', 'ecommerceImage'].includes(tone) && nodeHasResult(data) ? (
          <button type="button" title="清空结果" onClick={() => data.onClearResult?.(id)} disabled={data.locked}>
            <Eraser size={14} />
            <span>清空结果</span>
          </button>
        ) : null}
        <button type="button" title="删除节点" onClick={() => data.onDelete?.(id)} disabled={data.locked}>
          <Trash2 size={14} />
          <span>删除节点</span>
        </button>
      </NodeToolbar>
      {children}
      {source && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

function nodeHasResult(data = {}) {
  if (String(data.imageUrl || data.referenceUrl || '').trim()) {
    return true;
  }
  return Array.isArray(data.resultItems) && data.resultItems.some((item) => item && isCanvasResultItemDone(item));
}

function NodeHeader({ data, type }) {
  const Icon = NODE_DEFS[type]?.icon || BoxSelect;
  const referenceOrder = ['reference', 'localReference', 'generate', 'imageExplosion', 'ecommerceImage', 'output'].includes(type)
    ? Number(data.referenceDisplayOrder || 0)
    : 0;
  const label = type === 'generate' && String(data.label || '').trim() === '生成'
    ? '生成图片'
    : (data.label || NODE_DEFS[type]?.label);
  return (
    <div className="node-head">
      <span className="node-icon">
        <Icon size={16} />
      </span>
      <strong>{label}</strong>
      {referenceOrder > 0 ? <span className="reference-order-badge">#{referenceOrder}</span> : null}
      <em className={`status-pill status-${data.status || 'idle'}`}>
        {STATUS_LABELS[data.status] || data.status || '待处理'}
      </em>
    </div>
  );
}

function PreviewMedia({ imageUrl, emptyText, onPreview }) {
  if (!imageUrl) {
    return (
      <div className="node-empty node-media-hit">
        <ImageIcon size={22} />
        <span>{emptyText}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="node-image-button node-media-hit nodrag"
      onClick={(event) => {
        event.stopPropagation();
        onPreview?.(event);
      }}
      aria-label="预览图片"
    >
      <img className="node-image" src={imageUrl} alt="" draggable="false" />
    </button>
  );
}

function LocalReferencePreview({ imageUrl, circles, emptyText, onPreview }) {
  const buttonRef = useRef(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) {
      return undefined;
    }

    const syncSize = () => {
      setStageSize({ width: button.clientWidth, height: button.clientHeight });
    };

    syncSize();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(syncSize);
      observer.observe(button);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', syncSize);
    return () => window.removeEventListener('resize', syncSize);
  }, []);

  if (!imageUrl) {
    return <PreviewMedia imageUrl={imageUrl} emptyText={emptyText} />;
  }

  const safeCircles = Array.isArray(circles) ? circles : [];
  const fit = getContainedImageRect(stageSize, imageSize);

  return (
    <button
      type="button"
      ref={buttonRef}
      className="node-image-button node-local-preview node-media-hit nodrag"
      onClick={(event) => {
        event.stopPropagation();
        onPreview?.(event);
      }}
      aria-label="局部参考图预览"
    >
      <img
        className="node-image"
        src={imageUrl}
        alt=""
        draggable="false"
        onLoad={(event) => {
          setImageSize({
            width: event.currentTarget.naturalWidth || 1,
            height: event.currentTarget.naturalHeight || 1,
          });
        }}
      />
      {fit && (
        <span className="local-ref-preview-layer" aria-hidden="true" style={{ left: fit.left, top: fit.top, width: fit.width, height: fit.height }}>
          {safeCircles.slice(0, 7).map((circle, index) => {
            const color = circle.colorValue || '#14b8a6';
            const r = Math.max(0.035, Math.min(0.45, Number(circle.r) || 0.12));
            const x = clamp(Number(circle.x) || 0.5, r, 1 - r);
            const y = clamp(Number(circle.y) || 0.5, r, 1 - r);
            const minSide = Math.min(fit.width, fit.height);
            const diameter = Math.max(12, r * minSide * 2);
            const badgeSize = 18;
            const preferredBadgeLeft = x * fit.width + diameter / 2 + 4;
            const preferredBadgeTop = y * fit.height - diameter / 2 - badgeSize - 4;
            const canUseRight = preferredBadgeLeft + badgeSize <= fit.width;
            const canUseTop = preferredBadgeTop >= 0;
            const badgeLeft = canUseRight
              ? preferredBadgeLeft
              : Math.max(2, x * fit.width - diameter / 2 - badgeSize - 4);
            const badgeTop = canUseTop
              ? preferredBadgeTop
              : Math.min(fit.height - badgeSize - 2, y * fit.height + diameter / 2 + 4);

            return (
              <span key={circle.colorKey + '-' + index} className="local-ref-preview-circle">
                <span
                  className="local-ref-preview-ring"
                  style={{
                    left: x * fit.width - diameter / 2,
                    top: y * fit.height - diameter / 2,
                    width: diameter,
                    height: diameter,
                    borderColor: hexToRgba(color, 0.88),
                    backgroundColor: hexToRgba(color, 0.11),
                  }}
                />
                <span
                  className="local-ref-preview-badge"
                  style={{
                    left: Math.max(2, Math.min(fit.width - badgeSize - 2, badgeLeft)),
                    top: Math.max(2, Math.min(fit.height - badgeSize - 2, badgeTop)),
                    backgroundColor: hexToRgba(color, 0.66),
                  }}
                >
                  {index + 1}
                </span>
              </span>
            );
          })}
        </span>
      )}
    </button>
  );
}

function getContainedImageRect(stageSize, imageSize) {
  if (!stageSize.width || !stageSize.height || !imageSize.width || !imageSize.height) {
    return null;
  }
  const scale = Math.min(stageSize.width / imageSize.width, stageSize.height / imageSize.height);
  const width = imageSize.width * scale;
  const height = imageSize.height * scale;
  return {
    left: (stageSize.width - width) / 2,
    top: (stageSize.height - height) / 2,
    width,
    height,
  };
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function hexToRgba(color, alpha) {
  const match = String(color || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) {
    return 'rgba(20,184,166,' + alpha + ')';
  }
  const hex = match[1];
  return 'rgba('
    + parseInt(hex.slice(0, 2), 16) + ','
    + parseInt(hex.slice(2, 4), 16) + ','
    + parseInt(hex.slice(4, 6), 16) + ','
    + alpha
    + ')';
}

function qualityLabel(value) {
  const labels = { low: '标准', medium: '增强', high: '精绘' };
  return labels[value] || '标准';
}
function RunBar({ data }) {
  if (data.status === 'running') {
    return <div className="node-run-line"><span /></div>;
  }

  if (data.status === 'failed') {
    return <div className="node-run-hint">请修正问题后运行画布</div>;
  }

  return <div className="node-run-hint">由画布统一调度</div>;
}
