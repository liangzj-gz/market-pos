/* ============================================================
   商品图片压缩（手机端）
   - 优先 512×512 方图，白底补边，不裁切商品
   - 优先 WebP，逐步调整质量和尺寸；不支持 WebP 时使用 JPEG
   - 输出带内容指纹，用于文件名和缓存失效
   ============================================================ */

const SIZES = [512, 448, 384];
const QUALITIES = [0.75, 0.68, 0.60, 0.55];
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
  if (type === 'image/webp') return 'webp';
  if (type === 'image/png') return 'png';
  return 'jpg';
}

/* 按文件头判断真实格式。
   部分设备（iOS Safari 等）canvas.toBlob('image/webp') 不报错但静默返回 PNG，
   如果按「请求的类型」命名，存出来的对象就是「.webp 里装着 PNG」：
   上传可以成功、数据库路径也正确，但浏览器拉图时会因为声明类型与字节不一致而渲染失败。 */
export function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return '';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return '';
}

export async function compressProductImage(file) {
  if (!file) throw new Error('请选择一张商品图');
  if (!/^image\//.test(file.type || '')) throw new Error('请选择图片文件');
  if (file.size > MAX_SOURCE) throw new Error('图片太大，请选 30MB 以内的照片');

  const src = await loadDrawable(file);
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('图片处理失败，请重试');
    const sw = src.width || 1;
    const sh = src.height || 1;
    let type = 'image/webp';
    let best = null;
    for (const size of SIZES) {
      canvas.width = canvas.height = size;
      const pad = Math.round(size * 8 / 512);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      const scale = Math.min((size - pad * 2) / sw, (size - pad * 2) / sh);
      const w = Math.max(1, Math.round(sw * scale));
      const h = Math.max(1, Math.round(sh * scale));
      ctx.drawImage(src.drawable, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);

      for (const quality of QUALITIES) {
        let blob = await toBlob(canvas, type, quality);
        if (type === 'image/webp' && (!blob || blob.type !== type)) {
          type = 'image/jpeg';
          blob = await toBlob(canvas, type, quality);
        }
        if (!blob || blob.type !== type) throw new Error('图片压缩失败，设备不支持图片编码');
        if (!best || blob.size < best.blob.size) best = { blob, size, type };
        if (blob.size <= TARGET_BYTES) { best = { blob, size, type }; break; }
      }
      if (best.blob.size <= TARGET_BYTES) break;
    }
    const { blob, size } = best;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    /* 以真实字节为准定格式与扩展名，绝不按「想压成什么」命名 */
    type = sniffImageType(bytes) || best.type || blob.type || 'image/jpeg';
    return {
      blob,
      type,
      ext: imageExt(type),
      hash: await hashBytes(bytes),
      dataUrl: await toDataUrl(blob),
      bytes: blob.size,
      width: size,
      height: size
    };
  } finally {
    src.revoke();
  }
}
