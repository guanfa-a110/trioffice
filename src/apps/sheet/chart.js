/**
 * chart.js —— 纯 SVG 图表渲染（柱状 / 折线 / 面积 / 饼图）。
 * 不依赖任何图表库，输出可直接内联到 HTML 或导出。
 */
import { svg } from '../../core/dom.js';
import { toNumber, isError, formatNumber } from './value.js';
import { colToLabel } from './address.js';

export const CHART_TYPES = [
  { id: 'bar', labelKey: 'sheet.chartBar', icon: 'chart-bar' },
  { id: 'line', labelKey: 'sheet.chartLine', icon: 'chart-line' },
  { id: 'area', labelKey: 'sheet.chartArea', icon: 'chart-line' },
  { id: 'pie', labelKey: 'sheet.chartPie', icon: 'chart-pie' },
];

export const CHART_PALETTE = [
  '#4f7cf7', '#f2994a', '#27ae60', '#eb5757', '#9b51e0',
  '#2d9cdb', '#f2c94c', '#56ccf2', '#bb6bd9', '#6fcf97',
];

/**
 * 从工作簿区域抽取图表数据。
 * 约定：第一行为系列名，第一列为分类名；若只有一列数据则视为单系列。
 * @param {import('./workbook.js').Workbook} workbook
 * @param {string} sheetName
 * @param {{from: {r:number,c:number}, to: {r:number,c:number}}} range
 */
export function buildChartData(workbook, sheetName, range) {
  const r1 = Math.min(range.from.r, range.to.r);
  const r2 = Math.max(range.from.r, range.to.r);
  const c1 = Math.min(range.from.c, range.to.c);
  const c2 = Math.max(range.from.c, range.to.c);

  const firstRowIsHeader = c2 > c1 && workbook.getValue(sheetName, r1, c1) !== null
    && typeof workbook.getValue(sheetName, r1, c1) !== 'number';
  const firstColIsCategory = r2 > r1 && !(typeof workbook.getValue(sheetName, r1, c1) === 'number'
    && typeof workbook.getValue(sheetName, r1 + 1, c1) === 'number');

  const headerRow = firstRowIsHeader ? r1 : null;
  const dataStartRow = firstRowIsHeader ? r1 + 1 : r1;
  const categoryCol = firstColIsCategory ? c1 : null;
  const seriesStartCol = firstColIsCategory ? c1 + 1 : c1;

  const categories = [];
  for (let r = dataStartRow; r <= r2; r += 1) {
    if (categoryCol === null) {
      categories.push(String(categories.length + 1));
    } else {
      const text = workbook.getText(sheetName, r, categoryCol);
      categories.push(text || String(categories.length + 1));
    }
  }

  const series = [];
  for (let c = Math.max(seriesStartCol, c1); c <= c2; c += 1) {
    if (categoryCol !== null && c === categoryCol) continue;
    const name = headerRow !== null ? (workbook.getText(sheetName, headerRow, c) || colToLabel(c)) : colToLabel(c);
    const values = [];
    for (let r = dataStartRow; r <= r2; r += 1) {
      const value = workbook.getValue(sheetName, r, c);
      const number = isError(value) || value === null ? 0 : toNumber(value);
      values.push(isError(number) || !Number.isFinite(number) ? 0 : number);
    }
    series.push({ name, values });
  }

  if (!series.length) {
    // 只有一列数据时的退化处理
    const values = [];
    for (let r = dataStartRow; r <= r2; r += 1) {
      const value = workbook.getValue(sheetName, r, seriesStartCol);
      const number = isError(value) || value === null ? 0 : toNumber(value);
      values.push(isError(number) || !Number.isFinite(number) ? 0 : number);
    }
    series.push({ name: workbook.getText(sheetName, r1, seriesStartCol) || '数值', values });
  }

  if (!categories.length) {
    categories.push(...series[0].values.map((_, index) => String(index + 1)));
  }
  return { categories, series };
}

/** 计算合适的坐标刻度 */
function niceScale(min, max, ticks = 5) {
  if (min === max) {
    if (min === 0) return { min: 0, max: 1, step: 0.2 };
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  const span = max - min || 1;
  const rough = span / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  return {
    min: Math.floor(min / step) * step,
    max: Math.ceil(max / step) * step,
    step,
  };
}

/**
 * 渲染图表。
 * @param {{type: string, title?: string, range?: any, legend?: boolean}} config
 * @param {{categories: string[], series: Array<{name: string, values: number[]}>}} data
 * @param {{width?: number, height?: number, colorOffset?: number}} [options]
 * @returns {SVGElement}
 */
export function renderChart(config, data, options = {}) {
  const width = options.width || 720;
  const height = options.height || 400;
  const type = config.type || 'bar';
  const padding = { top: config.title ? 52 : 32, right: 28, bottom: 62, left: 68 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    height: '100%',
    class: 'chart-svg',
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': config.title || 'chart',
  });
  const offset = options.colorOffset || 0;

  root.appendChild(svg('rect', { x: 0, y: 0, width, height, fill: 'var(--surface, #fff)', rx: 8 }));

  if (config.title) {
    root.appendChild(text(20, 30, config.title, { size: 17, weight: 600, fill: 'var(--text, #1a1d21)' }));
  }

  const legendItems = data.series.map((item, index) => ({ name: item.name, color: CHART_PALETTE[(index + offset) % CHART_PALETTE.length] }));

  if (type === 'pie') {
    drawPie(root, data, { padding, width, height, offset });
    if (config.legend !== false) drawLegend(root, legendItems, { x: 20, y: height - 26, width: width - 40 });
    return root;
  }

  const allValues = data.series.flatMap((item) => item.values);
  const scale = niceScale(Math.min(0, ...allValues), Math.max(0, ...allValues));

  // Y 轴网格与刻度
  for (let value = scale.min; value <= scale.max + scale.step / 2; value += scale.step) {
    const y = padding.top + plotHeight - ((value - scale.min) / (scale.max - scale.min)) * plotHeight;
    root.appendChild(svg('line', {
      x1: padding.left, y1: y, x2: padding.left + plotWidth, y2: y,
      stroke: value === 0 ? 'var(--border-strong, #9aa3ad)' : 'var(--border, #e4e8ee)',
      'stroke-width': 1,
    }));
    root.appendChild(text(padding.left - 10, y + 4, formatNumber(round(value)), {
      size: 11, fill: 'var(--text-dim, #7a828c)', anchor: 'end',
    }));
  }

  // X 轴刻度
  const step = Math.max(1, Math.ceil(data.categories.length / 12));
  data.categories.forEach((label, index) => {
    if (index % step !== 0) return;
    const x = padding.left + (plotWidth / data.categories.length) * (index + 0.5);
    root.appendChild(text(x, padding.top + plotHeight + 20, truncate(label, 8), {
      size: 11, fill: 'var(--text-dim, #7a828c)', anchor: 'middle',
    }));
  });

  const valueToY = (value) => padding.top + plotHeight - ((value - scale.min) / (scale.max - scale.min || 1)) * plotHeight;
  const bandWidth = plotWidth / data.categories.length;

  if (type === 'bar') {
    const groupWidth = bandWidth * 0.72;
    const barWidth = groupWidth / data.series.length;
    data.series.forEach((item, seriesIndex) => {
      const color = CHART_PALETTE[(seriesIndex + offset) % CHART_PALETTE.length];
      item.values.forEach((value, index) => {
        const x = padding.left + bandWidth * index + (bandWidth - groupWidth) / 2 + barWidth * seriesIndex;
        const y = valueToY(Math.max(0, value));
        const baseY = valueToY(Math.min(0, value));
        root.appendChild(svg('rect', {
          x, y, width: Math.max(1, barWidth - 2), height: Math.max(1, baseY - y),
          fill: color, rx: 3, class: 'chart-bar-rect',
        }, [svg('title', {}, [`${item.name} · ${data.categories[index]}: ${formatNumber(value)}`])]));
      });
    });
  } else {
    data.series.forEach((item, seriesIndex) => {
      const color = CHART_PALETTE[(seriesIndex + offset) % CHART_PALETTE.length];
      const points = item.values.map((value, index) => [
        padding.left + bandWidth * (index + 0.5),
        valueToY(value),
      ]);
      const path = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${round(x)},${round(y)}`).join(' ');
      if (type === 'area') {
        const baseline = valueToY(Math.max(scale.min, 0));
        const areaPath = `${path} L${round(points[points.length - 1][0])},${round(baseline)} L${round(points[0][0])},${round(baseline)} Z`;
        root.appendChild(svg('path', { d: areaPath, fill: color, opacity: 0.18 }));
      }
      root.appendChild(svg('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2.2, 'stroke-linejoin': 'round' }));
      points.forEach(([x, y], index) => {
        root.appendChild(svg('circle', { cx: x, cy: y, r: 3.1, fill: 'var(--surface, #fff)', stroke: color, 'stroke-width': 2 }, [
          svg('title', {}, [`${item.name} · ${data.categories[index]}: ${formatNumber(item.values[index])}`]),
        ]));
      });
    });
  }

  // 轴线
  root.appendChild(svg('line', {
    x1: padding.left, y1: padding.top + plotHeight, x2: padding.left + plotWidth, y2: padding.top + plotHeight,
    stroke: 'var(--border-strong, #9aa3ad)', 'stroke-width': 1,
  }));

  if (config.legend !== false) drawLegend(root, legendItems, { x: padding.left, y: height - 22, width: plotWidth });
  return root;
}

function drawPie(root, data, { padding, width, height, offset }) {
  const values = (data.series[0]?.values || []).map((value) => Math.abs(value));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = padding.left + (width - padding.left - padding.right) / 2;
  const cy = padding.top + (height - padding.top - padding.bottom) / 2;
  const radius = Math.min(width - padding.left - padding.right, height - padding.top - padding.bottom) / 2 - 8;
  let angle = -Math.PI / 2;

  values.forEach((value, index) => {
    const slice = (value / total) * Math.PI * 2;
    const end = angle + slice;
    const color = CHART_PALETTE[(index + offset) % CHART_PALETTE.length];
    const x1 = cx + radius * Math.cos(angle);
    const y1 = cy + radius * Math.sin(angle);
    const x2 = cx + radius * Math.cos(end);
    const y2 = cy + radius * Math.sin(end);
    const largeArc = slice > Math.PI ? 1 : 0;
    const d = slice >= Math.PI * 2 - 1e-6
      ? `M${cx},${cy - radius} A${radius},${radius} 0 1 1 ${cx - 0.01},${cy - radius} Z`
      : `M${cx},${cy} L${round(x1)},${round(y1)} A${radius},${radius} 0 ${largeArc} 1 ${round(x2)},${round(y2)} Z`;
    root.appendChild(svg('path', { d, fill: color, stroke: 'var(--surface, #fff)', 'stroke-width': 1.5 }, [
      svg('title', {}, [`${data.categories[index] || index + 1}: ${formatNumber(value)}（${(value / total * 100).toFixed(1)}%）`]),
    ]));
    angle = end;
  });
}

function drawLegend(root, items, { x, y, width }) {
  let cursor = x;
  items.forEach((item, index) => {
    const label = truncate(item.name, 12);
    const itemWidth = 12 + 6 + label.length * 7 + 18;
    if (cursor + itemWidth > x + width && index > 0) return;
    root.appendChild(svg('rect', { x: cursor, y: y - 9, width: 11, height: 11, rx: 2.5, fill: item.color }));
    root.appendChild(text(cursor + 17, y, label, { size: 12, fill: 'var(--text-dim, #6b7280)' }));
    cursor += itemWidth;
  });
}

function text(x, y, content, options = {}) {
  const node = svg('text', {
    x: round(x),
    y: round(y),
    'font-size': options.size || 12,
    'font-family': 'inherit',
    fill: options.fill || 'currentColor',
    'text-anchor': options.anchor || 'start',
    'font-weight': options.weight || 400,
  });
  node.textContent = content;
  return node;
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const round = (value) => Math.round(Number(value) * 100) / 100;

/** 图表类型的中文/英文标签键 */
export const chartTypes = CHART_TYPES;
export const chartPalette = CHART_PALETTE;

/** 供独立的 HTML 导出使用：把图表渲染成 SVG 字符串 */
export function chartToSvgString(config, data, options) {
  const node = renderChart(config, data, options);
  return new XMLSerializer().serializeToString(node);
}
