/**
 * render.js —— 幻灯片渲染（DOM 节点 + HTML 字符串两种输出）。
 * 定位统一使用画布坐标（1280×720），通过 CSS transform scale 适配显示尺寸。
 */
import { h, svg } from '../../core/dom.js';
import { escapeHtml } from '../writer/markdown.js';
import { getTheme, CANVAS } from './themes.js';

/** 元素默认样式 */
export function elementDefaults(type, theme, canvas = CANVAS) {
  const base = {
    id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    type,
    x: canvas.w * 0.12,
    y: canvas.h * 0.36,
    w: canvas.w * 0.6,
    h: canvas.h * 0.2,
    opacity: 1,
  };
  switch (type) {
    case 'text':
      return {
        ...base,
        text: '双击编辑文字',
        fontSize: theme.bodySize,
        color: theme.text,
        align: 'left',
        valign: 'top',
        bold: false,
        italic: false,
        lineHeight: 1.4,
        font: theme.bodyFont,
      };
    case 'heading':
      return {
        ...base,
        text: '标题文字',
        fontSize: theme.titleSize,
        color: theme.text,
        align: 'left',
        valign: 'top',
        bold: true,
        lineHeight: 1.2,
        font: theme.titleFont,
        y: canvas.h * 0.3,
      };
    case 'image':
      return { ...base, src: '', alt: '', w: canvas.w * 0.36, h: canvas.h * 0.4, radius: 12 };
    case 'rect':
      return { ...base, fill: theme.accent, stroke: 'transparent', strokeWidth: 0, radius: 10, w: canvas.w * 0.24, h: canvas.h * 0.12 };
    case 'ellipse':
      return { ...base, fill: theme.accentAlt, stroke: 'transparent', strokeWidth: 0, w: canvas.w * 0.2, h: canvas.h * 0.2 };
    case 'triangle':
      return { ...base, fill: theme.accent, w: canvas.w * 0.18, h: canvas.h * 0.18 };
    case 'line':
      return { ...base, stroke: theme.text, strokeWidth: 3, x: canvas.w * 0.2, y: canvas.h * 0.5, w: canvas.w * 0.4, h: 0 };
    case 'arrow':
      return { ...base, stroke: theme.accent, strokeWidth: 4, x: canvas.w * 0.2, y: canvas.h * 0.5, w: canvas.w * 0.4, h: 0 };
    default:
      return base;
  }
}

/** 按版式生成一页幻灯片 */
export function createSlide(layout, theme, index = 0, canvas = CANVAS) {
  const slide = {
    id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    layout,
    elements: [],
    transition: index === 0 ? 'fade' : 'fade',
    notes: '',
    background: null,
  };
  const margin = canvas.w * 0.09;

  if (layout === 'title') {
    slide.elements.push({
      ...elementDefaults('heading', theme, canvas),
      x: margin,
      y: canvas.h * 0.32,
      w: canvas.w - margin * 2,
      h: canvas.h * 0.18,
      text: index === 0 ? 'TriOffice 演示' : '新的一页',
      align: 'left',
      fontSize: theme.titleSize + 8,
    });
    slide.elements.push({
      ...elementDefaults('text', theme, canvas),
      x: margin,
      y: canvas.h * 0.52,
      w: canvas.w - margin * 2,
      h: canvas.h * 0.12,
      text: index === 0 ? '零依赖的开源办公三件套 · Writer / Sheet / Deck' : '副标题',
      color: theme.textDim,
      fontSize: theme.bodySize,
    });
    slide.elements.push({
      ...elementDefaults('rect', theme, canvas),
      x: margin,
      y: canvas.h * 0.47,
      w: 92,
      h: 6,
      fill: theme.accent,
      radius: 3,
    });
  } else if (layout === 'titleBody') {
    slide.elements.push({
      ...elementDefaults('heading', theme, canvas),
      x: margin,
      y: canvas.h * 0.13,
      w: canvas.w - margin * 2,
      h: canvas.h * 0.14,
      text: '标题',
      fontSize: theme.titleSize - 10,
    });
    slide.elements.push({
      ...elementDefaults('text', theme, canvas),
      x: margin,
      y: canvas.h * 0.34,
      w: canvas.w - margin * 2,
      h: canvas.h * 0.5,
      text: '· 第一个要点\n· 第二个要点\n· 第三个要点',
      fontSize: theme.bodySize,
      color: theme.textDim,
      lineHeight: 1.6,
    });
  } else if (layout === 'twoCol') {
    const colWidth = (canvas.w - margin * 2 - 40) / 2;
    slide.elements.push({
      ...elementDefaults('heading', theme, canvas),
      x: margin,
      y: canvas.h * 0.1,
      w: canvas.w - margin * 2,
      h: canvas.h * 0.13,
      text: '双栏布局',
      fontSize: theme.titleSize - 12,
    });
    for (let index2 = 0; index2 < 2; index2 += 1) {
      slide.elements.push({
        ...elementDefaults('text', theme, canvas),
        x: margin + index2 * (colWidth + 40),
        y: canvas.h * 0.3,
        w: colWidth,
        h: canvas.h * 0.55,
        text: index2 === 0 ? '左栏内容\n· 要点 A\n· 要点 B' : '右栏内容\n· 要点 C\n· 要点 D',
        fontSize: theme.bodySize - 2,
        color: theme.textDim,
        lineHeight: 1.6,
      });
    }
  } else if (layout === 'section') {
    slide.elements.push({
      ...elementDefaults('heading', theme, canvas),
      x: margin,
      y: canvas.h * 0.38,
      w: canvas.w - margin * 2,
      h: canvas.h * 0.2,
      text: '章节标题',
      align: 'center',
      fontSize: theme.titleSize + 4,
    });
    slide.elements.push({
      ...elementDefaults('rect', theme, canvas),
      x: canvas.w / 2 - 60,
      y: canvas.h * 0.62,
      w: 120,
      h: 5,
      fill: theme.accent,
      radius: 3,
    });
  }
  return slide;
}

/* ------------------------------------------------------------------ *
 * DOM 渲染
 * ------------------------------------------------------------------ */
/**
 * 渲染一页幻灯片为 DOM 节点。
 * @param {object} slide
 * @param {string|object} themeId
 * @param {{canvas?: object, className?: string}} [options]
 */
export function renderSlideNode(slide, themeId, options = {}) {
  const theme = typeof themeId === 'string' ? getTheme(themeId) : themeId;
  const canvas = options.canvas || CANVAS;
  const node = h('div', {
    class: ['slide', options.className].filter(Boolean).join(' '),
    style: {
      width: `${canvas.w}px`,
      height: `${canvas.h}px`,
      background: slide.background || theme.background,
      fontFamily: theme.bodyFont,
      color: theme.text,
    },
    dataset: { slide: slide.id },
  });
  for (const element of slide.elements) node.appendChild(renderElementNode(element, theme, canvas));
  if (!slide.elements.length) {
    node.appendChild(h('div.slide__empty', { text: '空白页 · 从工具栏插入元素' }));
  }
  return node;
}

/** 渲染单个元素 */
export function renderElementNode(element, theme, canvas = CANVAS) {
  const style = {
    left: `${element.x}px`,
    top: `${element.y}px`,
    width: `${Math.max(1, element.w)}px`,
    height: `${Math.max(1, element.h)}px`,
    opacity: element.opacity === undefined ? 1 : element.opacity,
  };
  if (element.rotate) style.transform = `rotate(${element.rotate}deg)`;

  switch (element.type) {
    case 'text':
    case 'heading': {
      style.fontSize = `${element.fontSize}px`;
      style.color = element.color;
      style.fontFamily = element.font || theme.bodyFont;
      style.fontWeight = element.bold ? '700' : '400';
      style.fontStyle = element.italic ? 'italic' : 'normal';
      style.lineHeight = String(element.lineHeight || 1.4);
      style.textAlign = element.align || 'left';
      style.display = 'flex';
      style.flexDirection = 'column';
      style.justifyContent = element.valign === 'middle' ? 'center' : element.valign === 'bottom' ? 'flex-end' : 'flex-start';
      style.whiteSpace = 'pre-wrap';
      const node = h('div.slide__element.slide__text', { style, dataset: { id: element.id, type: element.type } });
      node.appendChild(h('div.slide__text-inner', { text: String(element.text ?? '') }));
      return node;
    }
    case 'image': {
      style.borderRadius = `${element.radius || 0}px`;
      style.overflow = 'hidden';
      const node = h('div.slide__element.slide__image', { style, dataset: { id: element.id, type: 'image' } });
      if (element.src) {
        node.appendChild(h('img', { src: element.src, alt: element.alt || '', draggable: 'false', style: { width: '100%', height: '100%', objectFit: element.fit || 'cover' } }));
      } else {
        node.appendChild(h('div.slide__placeholder', { text: '图片' }));
      }
      return node;
    }
    case 'line':
    case 'arrow': {
      const node = h('div.slide__element.slide__shape', { style, dataset: { id: element.id, type: element.type } });
      node.appendChild(svg('svg', { width: '100%', height: '100%', viewBox: `0 0 ${Math.max(1, element.w)} ${Math.max(1, element.h || 1)}`, preserveAspectRatio: 'none' }, [
        svg('line', {
          x1: 0, y1: (element.h || 1) / 2, x2: element.w, y2: (element.h || 1) / 2,
          stroke: element.stroke || theme.text, 'stroke-width': element.strokeWidth || 3, 'stroke-linecap': 'round',
          'marker-end': element.type === 'arrow' ? 'url(#arrowhead)' : null,
        }),
        element.type === 'arrow'
          ? svg('defs', {}, [svg('marker', {
            id: 'arrowhead', markerWidth: 6, markerHeight: 6, refX: 4.5, refY: 3, orient: 'auto',
          }, [svg('path', { d: 'M0,0 L6,3 L0,6 z', fill: element.stroke || theme.text })])])
          : null,
      ]));
      return node;
    }
    case 'ellipse': {
      style.background = element.fill || theme.accent;
      style.borderRadius = '50%';
      if (element.strokeWidth) style.border = `${element.strokeWidth}px solid ${element.stroke}`;
      return h('div.slide__element.slide__shape', { style, dataset: { id: element.id, type: element.type } });
    }
    case 'triangle': {
      style.background = element.fill || theme.accent;
      style.clipPath = 'polygon(50% 0%, 100% 100%, 0% 100%)';
      return h('div.slide__element.slide__shape', { style, dataset: { id: element.id, type: element.type } });
    }
    default: {
      style.background = element.fill || theme.accent;
      style.borderRadius = `${element.radius || 0}px`;
      if (element.strokeWidth) style.border = `${element.strokeWidth}px solid ${element.stroke || theme.border}`;
      return h('div.slide__element.slide__shape', { style, dataset: { id: element.id, type: element.type || 'rect' } });
    }
  }
}

/* ------------------------------------------------------------------ *
 * HTML 字符串渲染（导出用）
 * ------------------------------------------------------------------ */
/** 单页 → HTML 字符串 */
export function slideToHtml(slide, themeId, canvas = CANVAS) {
  const theme = typeof themeId === 'string' ? getTheme(themeId) : themeId;
  const parts = [];
  parts.push(`<div class="slide" style="position:relative;width:100%;height:100%;background:${slide.background || theme.background};font-family:${theme.bodyFont};color:${theme.text}">`);
  for (const element of slide.elements) parts.push(elementToHtml(element, theme, canvas));
  parts.push('</div>');
  return parts.join('');
}

function box(element) {
  return `position:absolute;left:${percent(element.x, CANVAS.w)};top:${percent(element.y, CANVAS.h)};width:${percent(element.w, CANVAS.w)};height:${percent(element.h, CANVAS.h)};`;
}

function percent(value, total) {
  return `${(value / total * 100).toFixed(4)}%`;
}

function elementToHtml(element, theme, canvas) {
  const base = box(element);
  const opacity = element.opacity === undefined ? 1 : element.opacity;
  const transform = element.rotate ? `transform:rotate(${element.rotate}deg);` : '';
  switch (element.type) {
    case 'text':
    case 'heading':
      return `<div style="${base}${transform}opacity:${opacity};display:flex;flex-direction:column;justify-content:${element.valign === 'middle' ? 'center' : element.valign === 'bottom' ? 'flex-end' : 'flex-start'};font-size:${percent(element.fontSize, canvas.h)};line-height:${element.lineHeight || 1.4};color:${element.color};font-family:${element.font || theme.bodyFont};font-weight:${element.bold ? 700 : 400};font-style:${element.italic ? 'italic' : 'normal'};text-align:${element.align || 'left'};white-space:pre-wrap">${escapeHtml(element.text ?? '')}</div>`;
    case 'image':
      return element.src
        ? `<div style="${base}${transform}opacity:${opacity};border-radius:${percent(element.radius || 0, canvas.h)};overflow:hidden"><img src="${element.src}" alt="${escapeHtml(element.alt || '')}" style="width:100%;height:100%;object-fit:${element.fit || 'cover'}"></div>`
        : '';
    case 'line':
    case 'arrow': {
      const id = `arrow-${Math.random().toString(36).slice(2, 8)}`;
      const defs = element.type === 'arrow'
        ? `<defs><marker id="${id}" markerWidth="6" markerHeight="6" refX="4.5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="${element.stroke || theme.text}"/></marker></defs>`
        : '';
      const lineW = Math.max(1, element.w);
      const lineH = Math.max(1, element.h || 1);
      return `<div style="${base}${transform}opacity:${opacity}"><svg width="100%" height="100%" viewBox="0 0 ${lineW} ${lineH}" preserveAspectRatio="none">${defs}<line x1="0" y1="${lineH / 2}" x2="${lineW}" y2="${lineH / 2}" stroke="${element.stroke || theme.text}" stroke-width="${element.strokeWidth || 3}" stroke-linecap="round"${element.type === 'arrow' ? ` marker-end="url(#${id})"` : ''}/></svg></div>`;
    }
    case 'ellipse':
      return `<div style="${base}${transform}opacity:${opacity};background:${element.fill || theme.accent};border-radius:50%"></div>`;
    case 'triangle':
      return `<div style="${base}${transform}opacity:${opacity};background:${element.fill || theme.accent};clip-path:polygon(50% 0%, 100% 100%, 0% 100%)"></div>`;
    default:
      return `<div style="${base}${transform}opacity:${opacity};background:${element.fill || theme.accent};border-radius:${percent(element.radius || 0, canvas.h)}"></div>`;
  }
}

/** 整个演示 → 独立 HTML 文件 */
export function buildDeckHtml({ title, slides, themeId, showNotes = false, autoplay = false }) {
  const theme = getTheme(themeId);
  const slidesHtml = slides.map((slide, index) => `
<section class="deck-slide" data-index="${index}" data-transition="${slide.transition || 'fade'}">
  ${slideToHtml(slide, theme)}
  ${showNotes && slide.notes ? `<aside class="deck-notes">${escapeHtml(slide.notes)}</aside>` : ''}
</section>`).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || 'TriOffice 演示')}</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:#0c0f14;font-family:${theme.bodyFont}}
  body{display:flex;align-items:center;justify-content:center;overflow:hidden}
  .stage{position:relative;width:min(100vw,177.78vh);height:min(56.25vw,100vh);background:${theme.backgroundFlat};box-shadow:0 24px 80px rgba(0,0,0,.5)}
  .deck-slide{position:absolute;inset:0;opacity:0;visibility:hidden;transition:opacity .35s ease,transform .35s ease}
  .deck-slide.is-active{opacity:1;visibility:visible;transform:none}
  .deck-slide[data-transition="slide"].is-active{animation:slideIn .4s ease}
  .deck-slide[data-transition="zoom"].is-active{animation:zoomIn .38s ease}
  .deck-slide[data-transition="none"]{transition:none}
  @keyframes slideIn{from{transform:translateX(6%)}to{transform:none}}
  @keyframes zoomIn{from{transform:scale(.94)}to{transform:none}}
  .deck-notes{position:absolute;left:0;right:0;bottom:0;padding:10px 16px;background:rgba(0,0,0,.66);color:#fff;font:400 14px/1.5 ${theme.bodyFont}}
  .hint{position:fixed;bottom:12px;right:16px;color:rgba(255,255,255,.5);font:400 12px/1.4 sans-serif}
  .bar{position:fixed;top:0;left:0;height:2px;background:${theme.accent};transition:width .3s ease}
</style>
</head>
<body>
<div class="stage">
${slidesHtml}
</div>
<div class="bar" id="bar" style="width:0"></div>
<div class="hint">${escapeHtml('← → 翻页 · F 全屏 · Esc 退出')}</div>
<script>
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('.deck-slide'));
  var index = 0;
  var bar = document.getElementById('bar');
  function show(next) {
    index = Math.max(0, Math.min(slides.length - 1, next));
    slides.forEach(function (slide, i) { slide.classList.toggle('is-active', i === index); });
    bar.style.width = ((index + 1) / slides.length * 100) + '%';
  }
  function next() { show(index + 1); }
  function prev() { show(index - 1); }
  document.addEventListener('keydown', function (event) {
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].indexOf(event.key) !== -1) { event.preventDefault(); next(); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].indexOf(event.key) !== -1) { event.preventDefault(); prev(); }
    else if (event.key === 'Home') show(0);
    else if (event.key === 'End') show(slides.length - 1);
    else if (event.key.toLowerCase() === 'f') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    }
  });
  document.addEventListener('click', function (event) { if (event.target.closest('.deck-notes')) return; next(); });
  show(0);
  ${autoplay ? 'setInterval(next, 6000);' : ''}
})();
</script>
</body>
</html>`;
}

export { CANVAS as DECK_CANVAS };
