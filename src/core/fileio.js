/**
 * fileio.js —— 与浏览器文件系统的边界层：下载、选取文件、剪贴板。
 */

/** 生成安全的文件名 */
export function safeFileName(name, ext) {
  const base = String(name || 'untitled')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'untitled';
  return ext ? `${base}.${ext}` : base;
}

/**
 * 触发下载。
 * @param {Blob|Uint8Array|string} content
 * @param {string} filename
 * @param {string} [mime]
 */
export function download(content, filename, mime = 'application/octet-stream') {
  let blob;
  if (content instanceof Blob) blob = content;
  else if (content instanceof Uint8Array) blob = new Blob([content], { type: mime });
  else if (typeof content === 'string') blob = new Blob([content], { type: mime });
  else blob = new Blob([JSON.stringify(content, null, 2)], { type: mime });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return filename;
}

/**
 * 打开系统文件选择器。
 * @param {{accept?: string, multiple?: boolean}} [options]
 * @returns {Promise<File[]>}
 */
export function pickFiles(options = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (options.accept) input.accept = options.accept;
    if (options.multiple) input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.remove();
      resolve(files);
    });
    // 用户取消时无法可靠监听，用窗口焦点回归做兜底清理
    window.addEventListener('focus', () => {
      setTimeout(() => {
        if (document.body.contains(input)) {
          input.remove();
          resolve([]);
        }
      }, 800);
    }, { once: true });
    input.click();
  });
}

/** 读取为文本 */
export function readText(file) {
  if (file.text) return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, 'utf-8');
  });
}

/** 读取为 ArrayBuffer */
export function readArrayBuffer(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** 读取为 DataURL（图片用） */
export function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * 复制文本到剪贴板（带 execCommand 兜底）。
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 继续走兜底 */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 读取剪贴板文本 */
export async function readClipboardText() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

/** 触发打印（用于导出 PDF） */
export function printSection(element, title) {
  const html = element.outerHTML;
  const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
    .map((node) => node.outerHTML)
    .join('\n');
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html lang="${document.documentElement.lang || 'zh-CN'}"><head>
<meta charset="utf-8"><title>${escapeAttr(title || document.title)}</title>
${styles}
<style>
  @page { margin: 16mm; }
  body { background: #fff; }
  .print-root { box-shadow: none !important; border: 0 !important; margin: 0 !important; }
</style>
</head><body>${html.replace(/class="([^"]*)"/, (m, cls) => `class="${cls} print-root"`)}</body></html>`);
  doc.close();

  const run = () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } finally {
      setTimeout(() => frame.remove(), 1500);
    }
  };
  if (frame.contentWindow.document.readyState === 'complete') setTimeout(run, 120);
  else frame.contentWindow.addEventListener('load', () => setTimeout(run, 120));
}

function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
