import {
  abortable,
  assertSignal,
  blobToImg,
  blobToText,
  builtinDecode,
  canDecodeImageType,
  sniffMimeType,
} from './index';
import type WorkerBridge from '../worker-bridge';

const formatLabels: Record<string, string> = {
  'image/avif': 'AVIF',
  'image/bmp': 'BMP',
  'image/gif': 'GIF',
  'image/jpeg': 'JPEG',
  'image/jxl': 'JPEG XL',
  'image/png': 'PNG',
  'image/qoi': 'QOI',
  'image/tiff': 'TIFF',
  'image/webp': 'WebP',
  'image/webp2': 'WebP2',
};

export async function decodeImage(
  signal: AbortSignal,
  blob: Blob,
  workerBridge: WorkerBridge,
): Promise<ImageData> {
  assertSignal(signal);
  const mimeType = await abortable(signal, sniffMimeType(blob));
  if (mimeType === 'application/pdf')
    throw new Error('不支持 PDF 文件，请导出为图片后再压缩');
  const canDecode = await abortable(signal, canDecodeImageType(mimeType));
  // Chromium and Firefox have no TIFF decoder; fail early with a clear reason.
  if (mimeType === 'image/tiff' && !canDecode)
    throw new Error('当前浏览器不支持 TIFF，请先转换为 PNG 或 JPEG');
  try {
    if (!canDecode) {
      if (mimeType === 'image/avif')
        return await workerBridge.avifDecode(signal, blob);
      if (mimeType === 'image/webp')
        return await workerBridge.webpDecode(signal, blob);
      if (mimeType === 'image/jxl')
        return await workerBridge.jxlDecode(signal, blob);
      if (mimeType === 'image/webp2')
        return await workerBridge.wp2Decode(signal, blob);
      if (mimeType === 'image/qoi')
        return await workerBridge.qoiDecode(signal, blob);
    }
    return await builtinDecode(signal, blob);
  } catch (err) {
    assertSignal(signal);
    const label = formatLabels[mimeType];
    const error = new Error(
      label ? `无法解码 ${label} 图片，文件可能已损坏` : '无法识别的图片格式',
    );
    (error as any).cause = err;
    console.warn('Image decode failed:', mimeType || 'unknown type', err);
    throw error;
  }
}

export async function processSvg(
  signal: AbortSignal,
  blob: Blob,
): Promise<HTMLImageElement> {
  assertSignal(signal);
  const text = await abortable(signal, blobToText(blob));
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.localName !== 'svg' || doc.querySelector('parsererror'))
    throw new Error('SVG 文件无效');
  if (!svg.hasAttribute('width') || !svg.hasAttribute('height')) {
    const parts = (svg.getAttribute('viewBox') || '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (
      parts.length !== 4 ||
      !parts.every(Number.isFinite) ||
      parts[2] <= 0 ||
      parts[3] <= 0
    ) {
      throw new Error('SVG 缺少有效尺寸');
    }
    svg.setAttribute('width', String(parts[2]));
    svg.setAttribute('height', String(parts[3]));
  }
  return abortable(
    signal,
    blobToImg(
      new Blob([new XMLSerializer().serializeToString(doc)], {
        type: 'image/svg+xml',
      }),
    ),
  );
}
