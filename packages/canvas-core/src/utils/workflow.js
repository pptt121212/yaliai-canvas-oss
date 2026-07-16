import JSZip from 'jszip';
import { getEcommerceImageSetCount } from './ecommerce.js';

export const CANVAS_REFERENCE_IMAGE_MAX_COUNT = 8;
export const CANVAS_REFERENCE_IMAGE_MAX_BYTES = 12 * 1024 * 1024;

export function appendHistory(setHistory, text) {
  setHistory((items) => items.concat({ id: `${Date.now()}-${Math.random()}`, text }).slice(-12));
}

export function estimateEmbeddedImageBytes(value) {
  const match = String(value || '').trim().match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return 0;
  }
  const compact = String(match[1] || '').replace(/\s+/g, '');
  if (!compact) {
    return 0;
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function getPrimaryReferenceValue(node) {
  if (!node || typeof node !== 'object') {
    return '';
  }
  if (node.type === 'localReference') {
    return String(node.data?.annotatedImageUrl || node.data?.imageUrl || '').trim();
  }
  return String(node.data?.imageUrl || '').trim();
}

function getNodeProvidedImageCount(node) {
  if (!node || typeof node !== 'object') {
    return 0;
  }
  const resultItems = Array.isArray(node.data?.resultItems) ? node.data.resultItems : [];
  const resultCount = resultItems.filter((item) => item && String(item.imageUrl || item.image_url || item.downloadUrl || item.referenceUrl || item.reference_url || '').trim()).length;
  if (resultCount > 0) {
    return resultCount;
  }
  return getPrimaryReferenceValue(node) ? 1 : 0;
}

export function findUpstreamImage(nodeId, nodes, edges) {
  const incoming = edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
  for (const sourceId of incoming) {
    const node = nodes.find((item) => item.id === sourceId);
    if (node?.data?.imageUrl) {
      return node.data.imageUrl;
    }
  }
  return '';
}

export function buildRunnableExecutionPlan(nodes, edges) {
  const runnableNodes = nodes.filter((node) => isRunnableNode(node));
  const runnableIds = new Set(runnableNodes.map((node) => node.id));
  const incomingByTarget = new Map();
  const outgoingBySource = new Map();

  runnableNodes.forEach((node) => {
    incomingByTarget.set(node.id, new Set());
    outgoingBySource.set(node.id, new Set());
  });

  edges.forEach((edge) => {
    if (!runnableIds.has(edge.source) || !runnableIds.has(edge.target)) {
      return;
    }
    incomingByTarget.get(edge.target).add(edge.source);
    outgoingBySource.get(edge.source).add(edge.target);
  });

  const nodeById = new Map(runnableNodes.map((node) => [node.id, node]));
  const ready = runnableNodes
    .filter((node) => incomingByTarget.get(node.id).size === 0)
    .sort(compareNodePosition);
  const plan = [];

  while (ready.length) {
    const node = ready.shift();
    plan.push(node);
    const outgoing = Array.from(outgoingBySource.get(node.id) || []).sort((a, b) => compareNodePosition(nodeById.get(a), nodeById.get(b)));
    outgoing.forEach((targetId) => {
      const incoming = incomingByTarget.get(targetId);
      incoming.delete(node.id);
      if (incoming.size === 0) {
        ready.push(nodeById.get(targetId));
        ready.sort(compareNodePosition);
      }
    });
  }

  if (plan.length !== runnableNodes.length) {
    throw new Error('工作流连线存在循环依赖，请断开循环后再运行。');
  }

  return plan;
}

export function buildRunnableDependencyGraph(nodes, edges) {
  const runnableNodes = nodes.filter((node) => isRunnableNode(node));
  const runnableIds = new Set(runnableNodes.map((node) => node.id));
  const upstreamByNodeId = new Map();
  const downstreamByNodeId = new Map();

  runnableNodes.forEach((node) => {
    upstreamByNodeId.set(node.id, new Set());
    downstreamByNodeId.set(node.id, new Set());
  });

  edges.forEach((edge) => {
    if (!runnableIds.has(edge.source) || !runnableIds.has(edge.target)) {
      return;
    }
    upstreamByNodeId.get(edge.target).add(edge.source);
    downstreamByNodeId.get(edge.source).add(edge.target);
  });

  return {
    nodes: runnableNodes,
    nodeById: new Map(runnableNodes.map((node) => [node.id, node])),
    upstreamByNodeId,
    downstreamByNodeId,
  };
}

export function getIncompleteRunnableDependencies(nodeId, nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => nodeById.get(edge.source))
    .filter((node) => isRunnableNode(node) && node.type !== 'output' && !node?.data?.imageUrl);
}

export function validateImageRequestInputs(nodes, edges, nodeIds = null) {
  const targetIds = nodeIds ? new Set(nodeIds) : null;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const batchContexts = getBatchContextsByNode(nodes, edges);
  const issues = [];

  nodes.forEach((node) => {
    if (!isImageRequestNode(node) || (targetIds && !targetIds.has(node.id))) {
      return;
    }

    const label = getNodeLabel(node);
    const inputNodes = edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => nodeById.get(edge.source))
      .filter(Boolean);
    const promptNodes = inputNodes.filter((inputNode) => inputNode.type === 'prompt');
    const batchPromptNodes = inputNodes.filter((inputNode) => inputNode.type === 'batchPrompt');
    const imageInputNodes = inputNodes.filter((inputNode) => isImageSourceNode(inputNode));
    const batchContext = batchContexts.get(node.id);
    const hasBatchContextItems = Boolean(batchContext && !batchContext.conflict && Number(batchContext.total || 0) > 0);
    const totalReferenceImages = imageInputNodes.reduce((sum, inputNode) => sum + getNodeProvidedImageCount(inputNode), 0);

    if (node.type === 'imageExplosion' || node.type === 'ecommerceImage') {
      if (!imageInputNodes.length) {
        issues.push({
          nodeId: node.id,
          message: `节点【${label}】必须连接一个有图片的前置节点。`,
          promptNodeIds: [],
          promptMessages: [],
          relatedMessages: [],
        });
        return;
      }
      const emptyImageNodes = imageInputNodes.filter((inputNode) => !nodeHasImageContent(inputNode));
      if (emptyImageNodes.length) {
        issues.push({
          nodeId: node.id,
          message: `节点【${label}】连接的前置图片还没有内容，请先上传或生成图片。`,
          promptNodeIds: [],
          promptMessages: [],
          relatedMessages: emptyImageNodes.map((inputNode) => ({
            nodeId: inputNode.id,
            message: `前置节点【${getNodeLabel(inputNode)}】还没有可用图片，被【${label}】使用。`,
          })),
        });
      }
      return;
    }

    if (!promptNodes.length && !batchPromptNodes.length && !hasBatchContextItems) {
      issues.push({
        nodeId: node.id,
        message: `节点【${label}】缺少提示词节点，请先连接一个提示词或批量提示词。`,
        promptNodeIds: [],
        promptMessages: [],
        relatedMessages: [],
      });
      return;
    }

    const emptyPromptNodes = promptNodes.filter((promptNode) => !String(promptNode.data?.prompt || '').trim());
    if (emptyPromptNodes.length) {
      const names = emptyPromptNodes.map((promptNode) => getNodeLabel(promptNode)).join('、');
      issues.push({
        nodeId: node.id,
        message: `节点【${label}】连接的提示词【${names}】内容为空，请先填写提示词。`,
        promptNodeIds: emptyPromptNodes.map((promptNode) => promptNode.id),
        promptMessages: emptyPromptNodes.map((promptNode) => ({
          nodeId: promptNode.id,
          message: `提示词节点【${getNodeLabel(promptNode)}】内容为空，被【${label}】使用。`,
        })),
        relatedMessages: emptyPromptNodes.map((promptNode) => ({
          nodeId: promptNode.id,
          message: `提示词节点【${getNodeLabel(promptNode)}】内容为空，被【${label}】使用。`,
        })),
      });
    }

    const emptyBatchPromptNodes = batchPromptNodes.filter((batchNode) => !getBatchPromptItems(batchNode).length);
    if (emptyBatchPromptNodes.length) {
      const names = emptyBatchPromptNodes.map((batchNode) => getNodeLabel(batchNode)).join('、');
      issues.push({
        nodeId: node.id,
        message: `节点【${label}】连接的批量提示词【${names}】还未导入有效 CSV，请先上传并确认批量提示词。`,
        promptNodeIds: [],
        promptMessages: [],
        relatedMessages: emptyBatchPromptNodes.map((batchNode) => ({
          nodeId: batchNode.id,
          message: `批量提示词节点【${getNodeLabel(batchNode)}】还未导入有效 CSV，被【${label}】使用。`,
        })),
      });
    }

    const emptyReferenceNodes = inputNodes.filter((inputNode) => inputNode.type === 'reference' && !inputNode.data?.imageUrl);
    if (emptyReferenceNodes.length) {
      const names = emptyReferenceNodes.map((referenceNode) => getNodeLabel(referenceNode)).join('、');
      issues.push({
        nodeId: node.id,
        message: `节点【${label}】连接的参考图【${names}】还未上传，请先上传参考图或断开该连线。`,
        promptNodeIds: [],
        promptMessages: [],
        relatedMessages: emptyReferenceNodes.map((referenceNode) => ({
          nodeId: referenceNode.id,
          message: `参考图节点【${getNodeLabel(referenceNode)}】还未上传，被【${label}】使用。`,
        })),
      });
    }

    const incompleteLocalReferenceNodes = inputNodes.filter((inputNode) => {
      if (inputNode.type !== 'localReference') {
        return false;
      }
      const circles = Array.isArray(inputNode.data?.circles) ? inputNode.data.circles : [];
      const hasCirclePrompt = circles.some((circle) => String(circle?.text || '').trim());
      return !inputNode.data?.imageUrl || !circles.length || !hasCirclePrompt;
    });
    if (incompleteLocalReferenceNodes.length) {
      const names = incompleteLocalReferenceNodes.map((referenceNode) => getNodeLabel(referenceNode)).join('、');
      issues.push({
        nodeId: node.id,
        message: `节点【${label}】连接的局部参考图【${names}】未完成，请上传图片、完成圈选并填写局部提示词，或断开该连线。`,
        promptNodeIds: [],
        promptMessages: [],
        relatedMessages: incompleteLocalReferenceNodes.map((referenceNode) => ({
          nodeId: referenceNode.id,
          message: `局部参考图节点【${getNodeLabel(referenceNode)}】未完成，被【${label}】使用。`,
        })),
      });
    }

    if (totalReferenceImages > CANVAS_REFERENCE_IMAGE_MAX_COUNT) {
      issues.push({
        nodeId: node.id,
        message: `节点「${label}」当前会携带 ${totalReferenceImages} 张参考图，单次最多只支持 ${CANVAS_REFERENCE_IMAGE_MAX_COUNT} 张，请减少后再试。`,
        promptNodeIds: [],
        promptMessages: [],
        relatedMessages: imageInputNodes.map((inputNode) => ({
          nodeId: inputNode.id,
          message: `参考图来源「${getNodeLabel(inputNode)}」被节点「${label}」使用。单次最多支持 ${CANVAS_REFERENCE_IMAGE_MAX_COUNT} 张参考图。`,
        })),
      });
    }

    const oversizedReferenceNodes = imageInputNodes.filter((inputNode) => (
      (inputNode.type === 'reference' || inputNode.type === 'localReference')
      && estimateEmbeddedImageBytes(getPrimaryReferenceValue(inputNode)) > CANVAS_REFERENCE_IMAGE_MAX_BYTES
    ));
    if (oversizedReferenceNodes.length) {
      issues.push({
        nodeId: node.id,
        message: `节点「${label}」引用了超过 12MB 的参考图。每张参考图最大只支持 12MB，请压缩后重试。`,
        promptNodeIds: [],
        promptMessages: [],
        relatedMessages: oversizedReferenceNodes.map((inputNode) => ({
          nodeId: inputNode.id,
          message: `参考图节点「${getNodeLabel(inputNode)}」超过 12MB，请压缩图片后再运行。`,
        })),
      });
    }
  });

  return issues;
}

export function validateBatchPromptUsage(nodes, edges) {
  const issues = [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const contexts = getBatchContextsByNode(nodes, edges);
  const imageGroupContexts = getImageGroupContextsByNode(nodes, edges);

  nodes
    .filter((node) => node.type === 'batchPrompt')
    .forEach((node) => {
      const items = getBatchPromptItems(node);
      if (getRawBatchPromptItemCount(node) > 20) {
        issues.push({
          nodeId: node.id,
          message: `批量提示词节点【${getNodeLabel(node)}】最多支持 20 条，请重新导入 CSV。`,
          promptMessages: [],
          relatedMessages: [],
        });
      }
      edges
        .filter((edge) => edge.source === node.id)
        .forEach((edge) => {
          const target = nodeById.get(edge.target);
          if (target && target.type !== 'generate') {
            issues.push({
              nodeId: target.id,
              message: `批量提示词【${getNodeLabel(node)}】只能连接到生成节点，请断开到【${getNodeLabel(target)}】的连线。`,
              promptMessages: [],
              relatedMessages: [{
                nodeId: node.id,
                message: `批量提示词只能连接生成节点。`,
              }],
            });
          }
        });
    });

  contexts.forEach((context, nodeId) => {
    if (context.conflict) {
      const node = nodeById.get(nodeId);
      issues.push({
        nodeId,
        message: `节点【${getNodeLabel(node)}】受多个批量提示词影响，请保留一个批量提示词来源。`,
        promptMessages: [],
        relatedMessages: context.sourceIds.map((sourceId) => ({
          nodeId: sourceId,
          message: `该批量提示词与其他批量提示词汇入同一条生成链路。`,
        })),
      });
    }
  });

  imageGroupContexts.forEach((context, nodeId) => {
    if (!context?.conflict) {
      return;
    }
    const node = nodeById.get(nodeId);
    issues.push({
      nodeId,
      message: `生成图片节点【${getNodeLabel(node)}】不能同时连接多个图片大爆炸节点，请拆成多个生成节点分别处理。`,
      promptMessages: [],
      relatedMessages: context.sourceIds.map((sourceId) => ({
        nodeId: sourceId,
        message: `该图片大爆炸与其他图片大爆炸同时连接到同一个生成节点。`,
      })),
    });
  });

  contexts.forEach((context, nodeId) => {
    if (context?.conflict || !context?.total || !imageGroupContexts.has(nodeId)) {
      return;
    }
    const node = nodeById.get(nodeId);
    if (!node || node.type !== 'generate') {
      return;
    }
    issues.push({
      nodeId,
      message: `生成图片节点【${getNodeLabel(node)}】不能同时连接批量提示词和图片大爆炸，请改用普通提示词作为统一指令。`,
      promptMessages: [],
      relatedMessages: [{
        nodeId,
        message: `图片大爆炸已经会让该节点按图片组批量生成。`,
      }],
    });
  });

  return issues;
}

export function validateRequiredOutputNodes(nodes, edges) {
  const outputNodes = nodes.filter((node) => node.type === 'output');
  const outputIds = new Set(outputNodes.map((node) => node.id));
  const missingOutputGenerateNodes = findMissingOutputTerminalGenerateNodes(nodes, edges, outputIds);

  if (!outputNodes.length) {
    const targetGenerateNodes = missingOutputGenerateNodes.length
      ? missingOutputGenerateNodes
      : nodes.filter((node) => node.type === 'generate').sort(compareNodePosition);
    if (!targetGenerateNodes.length) {
      return [{
        nodeId: '',
        message: '画布缺少输出节点，请添加一个输出节点并连接到最终生成节点。',
        promptMessages: [],
        relatedMessages: [],
      }];
    }
    return targetGenerateNodes.map((node) => ({
      nodeId: node.id,
      message: `生成节点【${getNodeLabel(node)}】缺少输出节点，请添加输出节点并从该生成节点连接过去。`,
      promptMessages: [],
      relatedMessages: [],
    }));
  }

  if (outputNodes.length > 1) {
    return outputNodes.map((node) => ({
      nodeId: node.id,
      message: 'Only one output node is allowed. Remove extra output nodes and connect all final generated images to the same output node.',
      promptMessages: [],
      relatedMessages: [],
    }));
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const directOutputInputIssues = [];
  outputNodes.forEach((outputNode) => {
    edges
      .filter((edge) => edge.target === outputNode.id)
      .map((edge) => nodeById.get(edge.source))
      .filter(Boolean)
      .forEach((sourceNode) => {
        if (!['generate', 'imageExplosion', 'ecommerceImage'].includes(sourceNode.type)) {
          directOutputInputIssues.push({
            nodeId: outputNode.id,
            message: `输出节点【${getNodeLabel(outputNode)}】只能直接连接生成图片节点或图片大爆炸节点，不能连接【${getNodeLabel(sourceNode)}】。`,
            promptMessages: [],
            relatedMessages: [{
              nodeId: sourceNode.id,
              message: `节点【${getNodeLabel(sourceNode)}】不是有效的输出前置生成结果。`,
            }],
          });
        }
      });
  });
  if (directOutputInputIssues.length) {
    return directOutputInputIssues;
  }

  const issues = outputNodes
    .filter((node) => {
      const upstreamNodes = edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => nodeById.get(edge.source))
        .filter(Boolean);
      return !upstreamNodes.some((upstream) => ['generate', 'imageExplosion', 'ecommerceImage', 'output'].includes(upstream.type));
    })
    .map((node) => ({
      nodeId: node.id,
      message: `输出节点【${getNodeLabel(node)}】必须连接到一个上游生成节点。`,
      promptMessages: [],
      relatedMessages: [],
    }));

  missingOutputGenerateNodes
    .forEach((node) => {
      issues.push({
        nodeId: node.id,
        message: `生成节点【${getNodeLabel(node)}】没有连接到输出节点，请从该生成节点连接到输出。`,
        promptMessages: [],
        relatedMessages: [],
      });
    });

  return issues;
}

export function getOutputGeneratedInputCount(outputNodeId, nodes, edges) {
  return collectUpstreamGenerateNodes(outputNodeId, nodes, edges).length;
}

export function getOutputModeRequirements(nodes, edges) {
  const batchContexts = getBatchContextsByNode(nodes, edges);
  const imageGroupContexts = getImageGroupContextsByNode(nodes, edges);
  return nodes
    .filter((node) => node.type === 'output')
    .map((node) => {
      const generatedInputCount = getOutputGeneratedInputCount(node.id, nodes, edges);
      const upstreamGenerateNodes = collectUpstreamGenerateNodes(node.id, nodes, edges);
      const hasGroupedGenerateInput = upstreamGenerateNodes.some((generateNode) => {
        const batchContext = batchContexts.get(generateNode.id);
        const imageGroupContext = imageGroupContexts.get(generateNode.id);
        return Number(batchContext?.total || 0) > 1 || Number(imageGroupContext?.total || 0) > 1;
      });
      return {
        nodeId: node.id,
        generatedInputCount,
        requiresZip: generatedInputCount > 1 || Boolean(batchContexts.get(node.id)) || hasGroupedGenerateInput,
      };
    });
}

export async function buildWorkflowOutputPackage(outputNodeId, nodes, edges) {
  const imageNodes = collectUpstreamGeneratedImageNodes(outputNodeId, nodes, edges);
  if (!imageNodes.length) {
    throw new Error('输出压缩包缺少可打包的生成图片。');
  }

  const zip = new JSZip();
  const manifest = [];
  let added = 0;

  for (let index = 0; index < imageNodes.length; index += 1) {
    const node = imageNodes[index];
    const imageUrl = String(node.data?.imageUrl || '');
    const label = getNodeLabel(node);
    const entryName = `${String(index + 1).padStart(2, '0')}-${sanitizeFileName(label)}${inferImageExtension(imageUrl)}`;
    manifest.push({ label, url: imageUrl, file: entryName });

    try {
      const blob = await fetchImageBlob(imageUrl);
      zip.file(entryName, blob);
      added += 1;
    } catch (error) {
      manifest[manifest.length - 1].error = error?.message || '图片读取失败';
    }
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  if (!added) {
    throw new Error('输出压缩包生成失败：没有成功读取到可打包图片。');
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  return {
    url: URL.createObjectURL(blob),
    fileName: `yali-canvas-${Date.now()}.zip`,
    count: added,
  };
}

export async function buildWorkflowOutputPackageFromItems(items, options = {}) {
  const sourceItems = Array.isArray(items)
    ? items.filter((item) => item && String(item.downloadUrl || item.referenceUrl || item.imageUrl || '').trim())
    : [];
  if (!sourceItems.length) {
    throw new Error('输出压缩包缺少可打包的生成图片。');
  }

  const zip = new JSZip();
  const manifest = [];
  let added = 0;
  const fileNamePrefix = String(options.fileNamePrefix || 'yali-canvas').trim() || 'yali-canvas';

  for (let index = 0; index < sourceItems.length; index += 1) {
    const item = sourceItems[index];
    const imageUrl = String(item.downloadUrl || item.referenceUrl || item.imageUrl || '').trim();
    const label = String(item.name || item.label || `image_${index + 1}`).trim() || `image_${index + 1}`;
    const entryName = `${String(index + 1).padStart(2, '0')}-${sanitizeFileName(label)}${inferImageExtension(imageUrl)}`;
    manifest.push({
      index: index + 1,
      label,
      url: imageUrl,
      prompt: String(item.prompt || '').trim(),
      file: entryName,
    });

    try {
      const blob = await fetchImageBlob(imageUrl);
      zip.file(entryName, blob);
      added += 1;
    } catch (error) {
      manifest[manifest.length - 1].error = error?.message || '图片读取失败';
    }
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  if (!added) {
    throw new Error('输出压缩包生成失败：没有成功读取到可打包图片。');
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  return {
    url: URL.createObjectURL(blob),
    fileName: `${sanitizeFileName(fileNamePrefix)}-${Date.now()}.zip`,
    count: added,
  };
}

function isRunnableNode(node) {
  return Boolean(node && ['generate', 'imageExplosion', 'ecommerceImage', 'output'].includes(node.type));
}

function isImageRequestNode(node) {
  return Boolean(node && ['generate', 'imageExplosion', 'ecommerceImage'].includes(node.type));
}

function getNodeLabel(node) {
  return String(node?.data?.label || node?.id || '未命名节点');
}

function compareNodePosition(a, b) {
  const ax = Number(a?.position?.x || 0);
  const bx = Number(b?.position?.x || 0);
  if (ax !== bx) {
    return ax - bx;
  }
  const ay = Number(a?.position?.y || 0);
  const by = Number(b?.position?.y || 0);
  if (ay !== by) {
    return ay - by;
  }
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

export function nodeHasContent(node) {
  if (!node || !node.data) {
    return false;
  }
  if (node.type === 'prompt') {
    return Boolean(String(node.data.prompt || '').trim());
  }
  if (node.type === 'batchPrompt') {
    return Boolean(getBatchPromptItems(node).length);
  }
  if (node.type === 'reference') {
    return Boolean(node.data.imageUrl);
  }
  if (node.type === 'localReference') {
    const circles = Array.isArray(node.data.circles) ? node.data.circles : [];
    return Boolean(node.data.imageUrl && circles.length && circles.some((circle) => String(circle?.text || '').trim()));
  }
  if (['generate', 'imageExplosion', 'ecommerceImage', 'output'].includes(node.type)) {
    return Boolean(node.data.imageUrl);
  }
  return false;
}

export function getBatchPromptItems(node) {
  const items = Array.isArray(node?.data?.items) ? node.data.items : [];
  return items
    .filter((item) => item && !item.skip && String(item.prompt || '').trim())
    .slice(0, 20)
    .map((item, index) => ({
      index: Number(item.index || index + 1),
      name: String(item.name || `batch-${String(index + 1).padStart(3, '0')}`).trim(),
      prompt: String(item.prompt || '').trim(),
    }));
}

function getRawBatchPromptItemCount(node) {
  const items = Array.isArray(node?.data?.items) ? node.data.items : [];
  return items.filter((item) => item && !item.skip && String(item.prompt || '').trim()).length;
}

export function getBatchContextsByNode(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoingBySource = new Map();
  edges.forEach((edge) => {
    if (!outgoingBySource.has(edge.source)) {
      outgoingBySource.set(edge.source, []);
    }
    outgoingBySource.get(edge.source).push(edge.target);
  });

  const contexts = new Map();
  nodes
    .filter((node) => node.type === 'batchPrompt')
    .forEach((batchNode) => {
      const items = getBatchPromptItems(batchNode);
      const stack = outgoingBySource.get(batchNode.id) ? [...outgoingBySource.get(batchNode.id)] : [];
      const visited = new Set();
      while (stack.length) {
        const nodeId = stack.pop();
        if (visited.has(nodeId)) {
          continue;
        }
        visited.add(nodeId);
        const node = nodeById.get(nodeId);
        if (!node) {
          continue;
        }
        if (['generate', 'imageExplosion', 'ecommerceImage', 'output'].includes(node.type)) {
          const existing = contexts.get(nodeId);
          if (existing && existing.sourceId !== batchNode.id) {
            contexts.set(nodeId, {
              ...existing,
              conflict: true,
              sourceIds: Array.from(new Set([...(existing.sourceIds || [existing.sourceId]), batchNode.id])),
            });
          } else {
            contexts.set(nodeId, {
              sourceId: batchNode.id,
              sourceLabel: getNodeLabel(batchNode),
              items,
              total: items.length,
              conflict: false,
              sourceIds: [batchNode.id],
            });
          }
        }
        (outgoingBySource.get(nodeId) || []).forEach((targetId) => stack.push(targetId));
      }
    });

  return contexts;
}

export function getImageGroupContextsByNode(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const contexts = new Map();

  edges.forEach((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !['imageExplosion', 'ecommerceImage'].includes(source.type) || !target || target.type !== 'generate') {
      return;
    }
    const resultItems = Array.isArray(source.data?.resultItems) ? source.data.resultItems : [];
    const completedCount = resultItems.filter((item) => item?.imageUrl || item?.downloadUrl || item?.referenceUrl).length;
    const configuredCount = source.type === 'ecommerceImage'
      ? getEcommerceExpectedImageCount(source.data || {})
      : Math.max(1, Math.min(20, Number(source.data?.elementCount || 0) || 1));
    const total = Math.max(1, completedCount || resultItems.length || configuredCount);
    const existing = contexts.get(target.id);
    if (existing && existing.sourceId !== source.id) {
      contexts.set(target.id, {
        ...existing,
        conflict: true,
        sourceIds: Array.from(new Set([...(existing.sourceIds || [existing.sourceId]), source.id])),
        total: Math.max(existing.total || 1, total),
      });
      return;
    }
    contexts.set(target.id, {
      sourceId: source.id,
      sourceLabel: getNodeLabel(source),
      total,
      conflict: false,
      sourceIds: [source.id],
    });
  });

  return contexts;
}

function getEcommerceExpectedImageCount(data = {}) {
  return Math.max(2, getEcommerceImageSetCount(data) + 1);
}

function collectUpstreamGeneratedImageNodes(outputNodeId, nodes, edges) {
  return collectUpstreamGenerateNodes(outputNodeId, nodes, edges, true);
}

function collectUpstreamGenerateNodes(outputNodeId, nodes, edges, completedOnly = false) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map();
  edges.forEach((edge) => {
    if (!incomingByTarget.has(edge.target)) {
      incomingByTarget.set(edge.target, []);
    }
    incomingByTarget.get(edge.target).push(edge.source);
  });

  const visited = new Set();
  const result = [];
  const resultIds = new Set();
  const walk = (nodeId) => {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    const incoming = incomingByTarget.get(nodeId) || [];
    incoming.forEach((sourceId) => {
      const node = nodeById.get(sourceId);
      if (!node) {
        return;
      }
      if (['generate', 'imageExplosion', 'ecommerceImage'].includes(node.type) && (!completedOnly || node.data?.imageUrl) && !resultIds.has(node.id)) {
        resultIds.add(node.id);
        result.push(node);
      }
      if (['generate', 'imageExplosion', 'ecommerceImage', 'output'].includes(node.type)) {
        walk(node.id);
      }
    });
  };

  walk(outputNodeId);
  return result.sort(compareNodePosition);
}

function isImageSourceNode(node) {
  return Boolean(node && ['reference', 'localReference', 'generate', 'imageExplosion', 'ecommerceImage', 'output'].includes(node.type));
}

function nodeHasImageContent(node) {
  if (!node) {
    return false;
  }
  if (node.type === 'localReference') {
    return Boolean(node.data?.imageUrl);
  }
  return Boolean(node.data?.imageUrl || node.data?.referenceUrl || node.data?.outputUrl);
}

function canReachAnyOutput(startNodeId, outputIds, edges) {
  const outgoingBySource = new Map();
  edges.forEach((edge) => {
    if (!outgoingBySource.has(edge.source)) {
      outgoingBySource.set(edge.source, []);
    }
    outgoingBySource.get(edge.source).push(edge.target);
  });

  const visited = new Set();
  const stack = [startNodeId];
  while (stack.length) {
    const nodeId = stack.pop();
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    const outgoing = outgoingBySource.get(nodeId) || [];
    for (const targetId of outgoing) {
      if (outputIds.has(targetId)) {
        return true;
      }
      stack.push(targetId);
    }
  }
  return false;
}

function findMissingOutputTerminalGenerateNodes(nodes, edges, outputIds) {
  const generateNodes = nodes.filter((node) => node.type === 'generate');
  const generateIds = new Set(generateNodes.map((node) => node.id));
  const outgoingGenerateBySource = new Map();

  generateNodes.forEach((node) => {
    outgoingGenerateBySource.set(node.id, []);
  });

  edges.forEach((edge) => {
    if (generateIds.has(edge.source) && generateIds.has(edge.target)) {
      outgoingGenerateBySource.get(edge.source).push(edge.target);
    }
  });

  const missingNodes = generateNodes.filter((node) => !canReachAnyOutput(node.id, outputIds, edges));
  const missingIds = new Set(missingNodes.map((node) => node.id));
  const terminalNodes = missingNodes.filter((node) => {
    const downstreamGenerateIds = outgoingGenerateBySource.get(node.id) || [];
    return !downstreamGenerateIds.some((targetId) => missingIds.has(targetId));
  });

  return (terminalNodes.length ? terminalNodes : missingNodes).sort(compareNodePosition);
}

async function fetchImageBlob(imageUrl) {
  if (String(imageUrl || '').startsWith('data:')) {
    return (await fetch(imageUrl)).blob();
  }

  const response = await fetch(imageUrl, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`图片读取失败：${response.status}`);
  }
  return response.blob();
}

function inferImageExtension(imageUrl) {
  const value = String(imageUrl || '').toLowerCase();
  if (value.startsWith('data:image/png') || value.includes('.png')) {
    return '.png';
  }
  if (value.startsWith('data:image/webp') || value.includes('.webp')) {
    return '.webp';
  }
  return '.jpg';
}

function sanitizeFileName(value) {
  const cleaned = String(value || 'image')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 48);
  return cleaned || 'image';
}
