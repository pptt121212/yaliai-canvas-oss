import { getCanvasRuntimeGlobals } from './runtimeConfig.js';

export function createMockImage(prompt, title = 'Yali AI') {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 1024, 1024);
  gradient.addColorStop(0, '#eef2ff');
  gradient.addColorStop(0.45, '#f8fafc');
  gradient.addColorStop(1, '#dcfce7');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1024, 1024);
  context.fillStyle = 'rgba(15,23,42,.08)';
  for (let i = 0; i < 9; i += 1) {
    context.beginPath();
    context.arc(180 + i * 92, 210 + Math.sin(i) * 80, 72 + i * 4, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = '#111827';
  context.font = '700 54px Microsoft YaHei, Arial';
  context.fillText(title, 80, 150);
  context.font = '400 30px Microsoft YaHei, Arial';
  wrapCanvasText(context, prompt || '本地前端模拟生成图', 80, 230, 840, 44);
  context.strokeStyle = 'rgba(15,23,42,.18)';
  context.lineWidth = 2;
  context.strokeRect(54, 54, 916, 916);
  return canvas.toDataURL('image/png');
}

function wrapCanvasText(context, text, x, y, maxWidth, lineHeight) {
  const chars = String(text).split('');
  let line = '';
  let top = y;
  chars.forEach((char) => {
    const next = line + char;
    if (context.measureText(next).width > maxWidth && line) {
      context.fillText(line, x, top);
      line = char;
      top += lineHeight;
    } else {
      line = next;
    }
  });
  if (line) {
    context.fillText(line, x, top);
  }
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function fitIntoArea(width, height, maxWidth, maxHeight) {
  const safeWidth = Math.max(Number(width) || 1, 1);
  const safeHeight = Math.max(Number(height) || 1, 1);
  const scale = Math.min(maxWidth / safeWidth, maxHeight / safeHeight, 1);
  return { width: safeWidth * scale, height: safeHeight * scale, scale };
}

export function normalizeRect(startX, startY, endX, endY) {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function isEditableTarget(target) {
  return Boolean(
    target &&
      target.closest &&
      target.closest('input, textarea, select, button, [contenteditable="true"], .floating-inspector, .create-menu')
  );
}

const PROTECTED_DOWNLOAD_EXTENSIONS = new Set(['zip', 'apk', 'exe', 'dmg', 'pkg', 'deb', 'rpm', 'tar', 'gz', 'bz2', '7z']);
const TOKEN_DOWNLOAD_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg']);

function readDownloadExtension(value) {
  try {
    const url = new URL(String(value || ''), window.location.href);
    const match = url.pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
  } catch (error) {
    return '';
  }
}

function refreshRestDownloadNonce(value) {
  try {
    const url = new URL(String(value || ''), window.location.href);
    if (!url.pathname.includes('/wp-json/yali/v1/free-image/result-image')) {
      return String(value || '').trim();
    }

    const nextNonce = String(getCanvasRuntimeGlobals()?.wpNonce || '').trim();
    if (!nextNonce) {
      return String(value || '').trim();
    }

    url.searchParams.set('_wpnonce', nextNonce);
    return url.toString();
  } catch (error) {
    return String(value || '').trim();
  }
}

function shouldUseProtectedDownload(value) {
  try {
    const url = new URL(String(value || ''), window.location.href);
    const extension = readDownloadExtension(url.href);
    return url.origin === window.location.origin
      && PROTECTED_DOWNLOAD_EXTENSIONS.has(extension)
      && url.pathname.includes('/wp-content/uploads/');
  } catch (error) {
    return false;
  }
}

function shouldUseProtectedImageDownload(value) {
  try {
    const url = new URL(String(value || ''), window.location.href);
    const extension = readDownloadExtension(url.href);
    return url.origin === window.location.origin
      && TOKEN_DOWNLOAD_IMAGE_EXTENSIONS.has(extension)
      && url.pathname.includes('/wp-content/uploads/');
  } catch (error) {
    return false;
  }
}

function shouldUseServerManagedDownload(value) {
  try {
    const url = new URL(String(value || ''), window.location.href);
    if (url.pathname.includes('/download/')) {
      return true;
    }

    if (!url.pathname.includes('/wp-json/yali/v1/free-image/result-image')) {
      return false;
    }

    return url.searchParams.get('mode') === 'download';
  } catch (error) {
    return false;
  }
}

async function requestProtectedDownloadUrl(value) {
  const config = window.yaliDownload;
  if (!config?.ajaxUrl || !config?.nonce || !config?.isLoggedIn) {
    return '';
  }

  const body = new URLSearchParams({
    action: 'yali_get_download_token',
    nonce: String(config.nonce || ''),
    file: String(value || ''),
  });

  const response = await window.fetch(String(config.ajaxUrl || ''), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: body.toString(),
    credentials: 'same-origin',
    cache: 'no-store',
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.success || !payload?.data?.download_url) {
    return '';
  }

  return String(payload.data.download_url || '').trim();
}

function triggerDirectDownload(value, filename) {
  const link = document.createElement('a');
  link.href = value;
  link.rel = 'noopener noreferrer';
  if (filename) {
    link.download = filename;
  }
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function triggerServerManagedDownload(value) {
  const link = document.createElement('a');
  link.href = value;
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function downloadImage(imageUrl, filename) {
  const value = refreshRestDownloadNonce(String(imageUrl || '').trim());
  if (!value) {
    return;
  }

  if (shouldUseServerManagedDownload(value)) {
    triggerServerManagedDownload(value);
    return;
  }

  void (async () => {
    const protectedDownloadUrl = (shouldUseProtectedDownload(value) || shouldUseProtectedImageDownload(value))
      ? await requestProtectedDownloadUrl(value)
      : '';

    if (protectedDownloadUrl) {
      triggerServerManagedDownload(protectedDownloadUrl);
      return;
    }

    triggerDirectDownload(value, filename);
  })();
}
