/* ============================================================
   商品图片压缩（手机端）
   - 统一 512×512 方图，白底补边，不裁切商品
   - WebP 质量 75，设备不支持生成 WebP 时退回 JPEG
   - 输出带内容指纹，用于文件名和缓存失效
   ============================================================ */

const TARGET = 512;
const PAD = 8;
const MAX_SOURCE = 30 * 1024 * 1024;
const TARGET_BYTES = 80 * 1024;

function loadByImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ drawable: img, width: img.naturalWidth, height: img.naturalHeight, revoke: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张照片读不出来，请换一张试试')); };
    img.src = url;
  });
}

async function loadDrawable(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { drawable: bmp, width: bmp.width, height: bmp.height, revoke: () => bmp.close && bmp.close() };
    } catch (e) { /* 老浏览器 / HEIC 走 img 兜底 */ }
  }
  return loadByImg(file);
}

function toBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function hashBytes(bytes) {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest)).slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) { /* 非安全上下文兜底 */ }
  return Math.random().toString(36).slice(2, 10);
}

function toDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('图片读取失败，请重试'));
    fr.readAsDataURL(blob);
  });
}

export function imageExt(type) {
  return type === 'image/webp' ? 'webp' : 'jpg';
}

export async function compressProductImage(file) {
  if (!file) throw new Error('请选择一张商品图');
  if (!/^image\//.test(file.type || '')) throw new Error('请选择图片文件');
  if (file.size > MAX_SOURCE) throw new Error('图片太大，请选 30MB 以内的照片');

  const src = await loadDrawable(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = TARGET;
    canvas.height = TARGET;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, TARGET, TARGET);
    const sw = src.width || 1;
    const sh = src.height || 1;
    const scale = Math.min((TARGET - PAD * 2) / sw, (TARGET - PAD * 2) / sh);
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    ctx.drawImage(src.drawable, Math.round((TARGET - w) / 2), Math.round((TARGET - h) / 2), w, h);

    let type = 'image/webp';
    let blob = await toBlob(canvas, type, 0.75);
    if (!blob) {
      type = 'image/jpeg';
      blob = await toBlob(canvas, type, 0.8);
    }
    if (!blob) throw new Error('图片压缩失败，请重试');
    for (const q of [0.65, 0.55]) {
      if (blob.size <= TARGET_BYTES) break;
      const smaller = await toBlob(canvas, type, q);
      if (smaller) blob = smaller;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      blob,
      type,
      ext: imageExt(type),
      hash: await hashBytes(bytes),
      dataUrl: await toDataUrl(blob),
      bytes: blob.size,
      width: TARGET,
      height: TARGET
    };
  } finally {
    src.revoke();
  }
}
