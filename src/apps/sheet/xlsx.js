/**
 * xlsx.js —— XLSX（Office Open XML）导入与导出。
 *
 * 导出：使用自研 ZIP 写入器 + inlineStr 单元格，兼容 Excel / WPS / LibreOffice / Numbers。
 *      公式会连同当前计算结果一起导出（<f> + <v>），对方打开即可看到数值。
 *      图表不写入 XLSX（跨软件兼容性太差），但会保留在 .trio 里。
 * 导入：支持 store 与 deflate 压缩的 XLSX，读取工作表、单元格值、公式、数字格式、
 *      列宽行高、合并单元格与冻结窗格。
 */
import { zipSync, unzip, utf8 } from '../../core/zip.js';
import { escapeXml, parseXml, child, children, findAll, find } from '../../core/xml.js';
import { Workbook, normalizeWorkbook, cellKey, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT } from './workbook.js';
import { labelToCol, formatA1 } from './address.js';
import { isError } from './value.js';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 自定义数字格式 id 起点 */
const CUSTOM_FMT_BASE = 164;

const CUSTOM_FORMATS = [
  { fmt: 'date', code: 'yyyy\\-mm\\-dd' },
  { fmt: 'time', code: 'hh:mm:ss' },
  { fmt: 'currency', code: '¥#,##0.00' },
  { fmt: 'scientific', code: '0.00E+00' },
];

/** 内置 numFmtId → 我们的格式名 */
const BUILTIN_FMT_MAP = {
  0: 'general',
  1: 'general',
  2: 'number',
  3: 'number',
  4: 'currency',
  9: 'percent',
  10: 'percent',
  11: 'scientific',
  12: 'number',
  13: 'number',
  14: 'date',
  15: 'date',
  15.5: 'date',
  16: 'date',
  17: 'date',
  18: 'time',
  19: 'time',
  20: 'time',
  21: 'time',
  22: 'date',
  37: 'number',
  38: 'number',
  39: 'number',
  40: 'number',
  45: 'time',
  46: 'time',
  47: 'time',
  48: 'scientific',
  49: 'text',
};

/* ================================================================== *
 * 导出
 * ================================================================== */
/**
 * 工作簿 → XLSX 字节流。
 * @param {Workbook|object} source
 * @returns {Uint8Array}
 */
export function workbookToXlsx(source) {
  const workbook = source instanceof Workbook ? source : new Workbook(source);
  const registry = createStyleRegistry(workbook);

  const files = [
    { name: '[Content_Types].xml', data: XML_HEADER + contentTypes(workbook.data.sheets.length) },
    { name: '_rels/.rels', data: XML_HEADER + rootRels() },
    { name: 'docProps/core.xml', data: XML_HEADER + coreProps() },
    { name: 'docProps/app.xml', data: XML_HEADER + appProps(workbook.sheetNames) },
    { name: 'xl/workbook.xml', data: XML_HEADER + workbookXml(workbook.sheetNames) },
    { name: 'xl/_rels/workbook.xml.rels', data: XML_HEADER + workbookRels(workbook.data.sheets.length) },
    { name: 'xl/styles.xml', data: XML_HEADER + stylesXml(registry) },
  ];

  workbook.data.sheets.forEach((sheet, index) => {
    files.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: XML_HEADER + sheetXml(workbook, sheet, registry) });
  });

  return zipSync(files);
}

/** 样式注册表：把每个单元格样式映射到 cellXfs 索引 */
function createStyleRegistry(workbook) {
  const fonts = [{ key: 'default', xml: '<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>' }];
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const cellXfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];

  const fontIndex = new Map([['default', 0]]);
  const fillIndex = new Map([['none', 0]]);
  const borderIndex = new Map([['none', 0]]);
  const xfIndex = new Map();
  const used = new Map(); // "sheet!A1" → xf 索引

  for (const sheet of workbook.data.sheets) {
    for (const [key, cell] of Object.entries(sheet.cells)) {
      const style = cell.s || {};
      const fmt = cell.fmt || 'general';
      const signature = JSON.stringify({
        b: !!style.b, i: !!style.i, u: !!style.u, st: !!style.st,
        color: style.color || '', size: style.size || 0, font: style.font || '',
        bg: style.bg || '', align: style.align || '', wrap: !!style.wrap,
        border: style.border ? 1 : 0, fmt,
      });
      let index = xfIndex.get(signature);
      if (index === undefined) {
        const fontKey = JSON.stringify({ b: !!style.b, i: !!style.i, u: !!style.u, st: !!style.st, color: style.color || '', size: style.size || 0, font: style.font || '' });
        let fontId = fontIndex.get(fontKey);
        if (fontId === undefined) {
          fontId = fonts.length;
          fonts.push({ key: fontKey, xml: fontXml(style) });
          fontIndex.set(fontKey, fontId);
        }
        let fillId = 0;
        if (style.bg) {
          fillId = fillIndex.get(style.bg);
          if (fillId === undefined) {
            fillId = fills.length;
            fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${toArgb(style.bg)}"/><bgColor indexed="64"/></patternFill></fill>`);
            fillIndex.set(style.bg, fillId);
          }
        }
        let borderId = 0;
        if (style.border) {
          borderId = 1;
        }
        const numFmtId = numFmtIdFor(fmt);
        index = cellXfs.length;
        cellXfs.push(xfXml({ numFmtId, fontId, fillId, borderId, align: style.align, wrap: style.wrap }));
        xfIndex.set(signature, index);
      }
      used.set(`${sheet.name}!${key}`, index);
    }
  }

  return { fonts, fills, borders, cellXfs, used, numFmts: CUSTOM_FORMATS };
}

function fontXml(style) {
  const parts = [];
  if (style.b) parts.push('<b/>');
  if (style.i) parts.push('<i/>');
  if (style.st) parts.push('<strike/>');
  if (style.u) parts.push('<u/>');
  parts.push(`<sz val="${style.size || 11}"/>`);
  if (style.color) parts.push(`<color rgb="${toArgb(style.color)}"/>`);
  parts.push(`<name val="${escapeXml(style.font || 'Calibri')}"/>`);
  return `<font>${parts.join('')}</font>`;
}

function xfXml({ numFmtId, fontId, fillId, borderId, align, wrap }) {
  const attrs = [`numFmtId="${numFmtId}"`, `fontId="${fontId}"`, `fillId="${fillId}"`, `borderId="${borderId}"`, 'xfId="0"'];
  if (numFmtId) attrs.push('applyNumberFormat="1"');
  if (fontId) attrs.push('applyFont="1"');
  if (fillId) attrs.push('applyFill="1"');
  if (borderId) attrs.push('applyBorder="1"');
  const alignment = [];
  if (wrap) alignment.push('wrapText="1"');
  if (align) alignment.push(`horizontal="${align}"`);
  const body = alignment.length ? `<alignment ${alignment.join(' ')}/>` : '';
  return `<xf ${attrs.join(' ')}${body ? ' applyAlignment="1"' : ''}>${body}</xf>`;
}

function numFmtIdFor(fmt) {
  switch (fmt) {
    case 'number': return 2;
    case 'percent': return 10;
    case 'currency': return CUSTOM_FMT_BASE + 2;
    case 'date': return CUSTOM_FMT_BASE;
    case 'time': return CUSTOM_FMT_BASE + 1;
    case 'scientific': return CUSTOM_FMT_BASE + 3;
    case 'text': return 49;
    default: return 0;
  }
}

/** #RRGGBB → AARRGGBB */
function toArgb(color) {
  const hex = String(color).replace('#', '').toUpperCase();
  if (hex.length === 8) return hex;
  return `FF${hex.padStart(6, '0')}`;
}

function contentTypes(sheetCount) {
  const overrides = [];
  for (let i = 1; i <= sheetCount; i += 1) {
    overrides.push(`<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  }
  return `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${overrides.join('\n')}
</Types>`;
}

function rootRels() {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="${NS_REL}/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function workbookRels(sheetCount) {
  const rows = [];
  for (let i = 1; i <= sheetCount; i += 1) {
    rows.push(`<Relationship Id="rId${i}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i}.xml"/>`);
  }
  rows.push(`<Relationship Id="rId${sheetCount + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>`);
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n${rows.join('\n')}\n</Relationships>`;
}

function workbookXml(sheetNames) {
  const rows = sheetNames.map((name, index) => `<sheet name="${escapeXml(sanitizeSheetName(name))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`);
  return `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">
<workbookPr/><bookViews><workbookView activeTab="0"/></bookViews>
<sheets>${rows.join('')}</sheets>
<calcPr calcId="171027" fullCalcOnLoad="1"/>
</workbook>`;
}

function sanitizeSheetName(name) {
  const text = String(name || 'Sheet').replace(/[\\/?*[\]:]/g, '_').slice(0, 31);
  return text || 'Sheet';
}

function coreProps() {
  const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>TriOffice</dc:creator><cp:lastModifiedBy>TriOffice</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>
</cp:coreProperties>`;
}

function appProps(sheetNames) {
  return `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>TriOffice</Application><Sheets>${sheetNames.length}</Sheets><AppVersion>0.1.0</AppVersion>
</Properties>`;
}

function stylesXml(registry) {
  const numFmts = registry.numFmts
    .map((item, index) => `<numFmt numFmtId="${CUSTOM_FMT_BASE + index}" formatCode="${escapeXml(item.code)}"/>`)
    .join('');
  return `<styleSheet xmlns="${NS_MAIN}">
<numFmts count="${registry.numFmts.length}">${numFmts}</numFmts>
<fonts count="${registry.fonts.length}">${registry.fonts.map((font) => (typeof font === 'string' ? font : font.xml)).join('')}</fonts>
<fills count="${registry.fills.length}">${registry.fills.join('')}</fills>
<borders count="${registry.borders.length}">${registry.borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${registry.cellXfs.length}">${registry.cellXfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function sheetXml(workbook, sheet, registry) {
  const used = workbook.usedRange(sheet);
  const rows = [];
  const maxRow = used.empty ? 0 : used.to.r;
  const maxCol = used.empty ? 0 : used.to.c;

  for (let r = 0; r <= maxRow; r += 1) {
    const cells = [];
    for (let c = 0; c <= maxCol; c += 1) {
      const key = cellKey(r, c);
      const cell = sheet.cells[key];
      if (!cell) continue;
      const ref = formatA1({ r, c });
      const styleIndex = registry.used.get(`${sheet.name}!${key}`) || 0;
      const attrs = [`r="${ref}"`];
      if (styleIndex) attrs.push(`s="${styleIndex}"`);
      const body = cellBody(workbook, sheet, r, c, cell);
      if (body === null) {
        cells.push(`<c ${attrs.join(' ')}/>`);
        continue;
      }
      cells.push(`<c ${attrs.join(' ')}${body.type ? ` t="${body.type}"` : ''}>${body.xml}</c>`);
    }
    const height = sheet.rowHeights[String(r)];
    const rowAttrs = [`r="${r + 1}"`];
    if (height) rowAttrs.push(`ht="${(height / 1).toFixed(2)}"`, 'customHeight="1"');
    rows.push(cells.length ? `<row ${rowAttrs.join(' ')}>${cells.join('')}</row>` : `<row ${rowAttrs.join(' ')}/>`);
  }

  const cols = Object.entries(sheet.colWidths || {})
    .map(([index, width]) => ({ index: Number(index), width }))
    .filter((item) => Number.isFinite(item.index))
    .sort((a, b) => a.index - b.index)
    .map((item) => `<col min="${item.index + 1}" max="${item.index + 1}" width="${(item.width / 7).toFixed(2)}" customWidth="1"/>`)
    .join('');

  const merges = (sheet.merges || []).length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map(([r1, c1, r2, c2]) => `<mergeCell ref="${formatA1({ r: r1, c: c1 })}:${formatA1({ r: r2, c: c2 })}"/>`).join('')}</mergeCells>`
    : '';

  const freeze = (sheet.frozen?.rows || sheet.frozen?.cols)
    ? `<pane${sheet.frozen.cols ? ` xSplit="${sheet.frozen.cols}"` : ''}${sheet.frozen.rows ? ` ySplit="${sheet.frozen.rows}"` : ''} topLeftCell="${formatA1({ r: sheet.frozen.rows || 0, c: sheet.frozen.cols || 0 })}" activePane="bottomRight" state="frozen"/>`
    : '';

  return `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">
<dimension ref="${used.empty ? 'A1' : `${formatA1({ r: 0, c: 0 })}:${formatA1({ r: maxRow, c: maxCol })}`}"/>
<sheetViews><sheetView workbookViewId="0">${freeze}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols ? `<cols>${cols}</cols>` : ''}
<sheetData>${rows.join('')}</sheetData>
${merges}
</worksheet>`;
}

/** 生成单元格内容 */
function cellBody(workbook, sheet, r, c, cell) {
  const formula = cell.f ? String(cell.f).replace(/^=/, '') : null;
  const value = cell.f || cell.v !== undefined ? workbook.getValue(sheet.name, r, c) : null;

  if (formula) {
    const cached = cachedValue(value, cell, workbook, sheet, r, c);
    return { type: cached.type, xml: `<f>${escapeXml(formula)}</f>${cached.xml}` };
  }
  if (cell.v === undefined) return { type: '', xml: '' };
  if (typeof cell.v === 'boolean') return { type: 'b', xml: `<v>${cell.v ? 1 : 0}</v>` };
  if (typeof cell.v === 'number') return { type: '', xml: `<v>${Number.isFinite(cell.v) ? cell.v : 0}</v>` };
  return { type: 'inlineStr', xml: `<is><t xml:space="preserve">${escapeXml(String(cell.v))}</t></is>` };
}

function cachedValue(value, cell, workbook, sheet, r, c) {
  if (value === null || value === undefined) return { type: '', xml: '' };
  if (isError(value)) return { type: 'e', xml: `<v>${escapeXml(value.code)}</v>` };
  if (typeof value === 'boolean') return { type: 'b', xml: `<v>${value ? 1 : 0}</v>` };
  if (typeof value === 'number') return { type: '', xml: `<v>${Number.isFinite(value) ? value : 0}</v>` };
  return { type: 'str', xml: `<v>${escapeXml(String(value))}</v>` };
}

/* ================================================================== *
 * 导入
 * ================================================================== */
/**
 * XLSX 字节流 → 工作簿模型。
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<object>}
 */
export async function xlsxToWorkbook(buffer) {
  const files = await unzip(buffer);
  const read = (path) => {
    const bytes = files.get(path);
    return bytes ? utf8.decode(bytes) : null;
  };

  const workbookXmlText = read('xl/workbook.xml');
  if (!workbookXmlText) throw new Error('不是有效的 XLSX：缺少 xl/workbook.xml');

  const relsText = read('xl/_rels/workbook.xml.rels') || '';
  const relMap = new Map();
  if (relsText) {
    const relRoot = parseXml(relsText);
    for (const rel of findAll(relRoot, 'Relationship')) {
      relMap.set(rel.attrs.Id, rel.attrs.Target);
    }
  }

  const sharedStrings = parseSharedStrings(read('xl/sharedStrings.xml'));
  const fmtMap = parseStyles(read('xl/styles.xml'));

  const root = parseXml(workbookXmlText);
  const sheetNodes = findAll(root, 'sheet');
  const sheets = [];

  sheetNodes.forEach((node, index) => {
    const relId = node.attrs['r:id'] || node.attrs.id;
    let target = relMap.get(relId) || `worksheets/sheet${index + 1}.xml`;
    target = target.replace(/^\//, '').replace(/^xl\//, '');
    const xml = read(`xl/${target}`);
    if (!xml) return;
    sheets.push(parseSheet(xml, node.attrs.name || `Sheet${index + 1}`, sharedStrings, fmtMap));
  });

  if (!sheets.length) throw new Error('XLSX 中没有可读取的工作表');
  return normalizeWorkbook({ version: 1, active: 0, sheets });
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const root = parseXml(xml);
  return findAll(root, 'si').map((si) => {
    const texts = findAll(si, 't');
    return texts.map((node) => node.text).join('');
  });
}

/**
 * 读取 styles.xml，返回 cellXfs 索引 → { fmt, s }。
 * 尽量还原加粗/斜体/下划线/字号/颜色/填充/边框/对齐。
 */
function parseStyles(xml) {
  const map = new Map();
  if (!xml) return map;
  const root = parseXml(xml);
  const custom = new Map();
  const numFmtsNode = find(root, 'numFmts');
  if (numFmtsNode) {
    for (const node of children(numFmtsNode, 'numFmt')) {
      custom.set(Number(node.attrs.numFmtId), node.attrs.formatCode || '');
    }
  }

  const fonts = [];
  const fontsNode = find(root, 'fonts');
  if (fontsNode) {
    for (const font of children(fontsNode, 'font')) {
      const style = {};
      if (child(font, 'b') || font.attrs.b === '1') style.b = true;
      if (child(font, 'i') || font.attrs.i === '1') style.i = true;
      if (child(font, 'u')) style.u = true;
      if (child(font, 'strike')) style.st = true;
      const size = child(font, 'sz');
      if (size && Number(size.attrs.val)) style.size = Number(size.attrs.val);
      const name = child(font, 'name');
      if (name && name.attrs.val && name.attrs.val !== 'Calibri') style.font = name.attrs.val;
      const color = child(font, 'color');
      if (color?.attrs.rgb) {
        const hex = color.attrs.rgb.replace(/^FF/i, '').replace(/^00/i, '');
        if (/^[0-9a-f]{6}$/i.test(hex)) style.color = `#${hex.toLowerCase()}`;
      }
      fonts.push(style);
    }
  }

  const fills = [];
  const fillsNode = find(root, 'fills');
  if (fillsNode) {
    for (const fill of children(fillsNode, 'fill')) {
      const pattern = child(fill, 'patternFill');
      const fg = pattern ? child(pattern, 'fgColor') : null;
      const rgb = fg?.attrs.rgb;
      if (rgb && /^[0-9a-f]{8}$/i.test(rgb)) {
        const hex = rgb.replace(/^FF/i, '');
        fills.push(/^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null);
      } else {
        fills.push(null);
      }
    }
  }

  const cellXfs = find(root, 'cellXfs');
  if (cellXfs) {
    children(cellXfs, 'xf').forEach((node, index) => {
      const numFmtId = Number(node.attrs.numFmtId || 0);
      const fmt = resolveFormat(numFmtId, custom.get(numFmtId));
      const style = { ...(fonts[Number(node.attrs.fontId || 0)] || {}) };
      const bg = fills[Number(node.attrs.fillId || 0)];
      if (bg) style.bg = bg;
      if (Number(node.attrs.borderId || 0) > 0) style.border = true;
      const alignment = child(node, 'alignment');
      if (alignment) {
        if (alignment.attrs.horizontal && alignment.attrs.horizontal !== 'general') style.align = alignment.attrs.horizontal;
        if (alignment.attrs.vertical && alignment.attrs.vertical !== 'bottom') style.valign = alignment.attrs.vertical;
        if (alignment.attrs.wrapText === '1') style.wrap = true;
      }
      const cleaned = Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined && value !== false && value !== ''));
      map.set(index, { fmt, s: cleaned });
    });
  }
  return map;
}

function resolveFormat(numFmtId, code) {
  if (code) {
    if (/[ymd]/.test(code) && !/^0/.test(code)) return /h/.test(code) ? 'date' : 'date';
    if (/[hms]/.test(code) && /:/.test(code)) return 'time';
    if (code.includes('%')) return 'percent';
    if (/[¥$€£]/.test(code)) return 'currency';
    if (/E\+/.test(code)) return 'scientific';
    if (/@/.test(code)) return 'text';
    return 'number';
  }
  return BUILTIN_FMT_MAP[numFmtId] || 'general';
}

function parseSheet(xml, name, sharedStrings, fmtMap) {
  const root = parseXml(xml);
  const sheet = {
    id: `s${Math.random().toString(36).slice(2, 8)}`,
    name,
    cells: {},
    colWidths: {},
    rowHeights: {},
    merges: [],
    frozen: { rows: 0, cols: 0 },
    charts: [],
    view: { row: 0, col: 0 },
  };

  const colsNode = find(root, 'cols');
  if (colsNode) {
    for (const col of children(colsNode, 'col')) {
      const min = Number(col.attrs.min || 1) - 1;
      const max = Number(col.attrs.max || min + 1) - 1;
      const width = Number(col.attrs.width || 12) * 7;
      for (let c = min; c <= max; c += 1) sheet.colWidths[String(c)] = width;
    }
  }

  const sheetData = find(root, 'sheetData');
  for (const row of children(sheetData, 'row')) {
    const rowIndex = Number(row.attrs.r || 1) - 1;
    const height = Number(row.attrs.ht || 0);
    if (height) sheet.rowHeights[String(rowIndex)] = height * 1.4;
    let columnCursor = 0;
    for (const cell of children(row, 'c')) {
      const ref = cell.attrs.r;
      const position = ref ? parseCellRef(ref) : { r: rowIndex, c: columnCursor };
      if (!position) continue;
      columnCursor = position.c + 1;
      const parsed = parseCellNode(cell, sharedStrings, fmtMap);
      if (!parsed) continue;
      sheet.cells[cellKey(position.r, position.c)] = parsed;
    }
  }

  const mergesNode = find(root, 'mergeCells');
  if (mergesNode) {
    for (const node of children(mergesNode, 'mergeCell')) {
      const [fromText, toText] = String(node.attrs.ref || '').split(':');
      const from = parseCellRef(fromText);
      const to = parseCellRef(toText);
      if (from && to) sheet.merges.push([from.r, from.c, to.r, to.c]);
    }
  }

  const pane = find(root, 'pane');
  if (pane && pane.attrs.state === 'frozen') {
    sheet.frozen = { rows: Number(pane.attrs.ySplit || 0), cols: Number(pane.attrs.xSplit || 0) };
  }

  return sheet;
}

function parseCellRef(text) {
  const match = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(String(text || '').trim());
  if (!match) return null;
  const c = labelToCol(match[1]);
  const r = Number(match[2]) - 1;
  if (c < 0 || r < 0) return null;
  return { r, c };
}

function parseCellNode(node, sharedStrings, fmtMap) {
  const type = node.attrs.t;
  const styleIndex = Number(node.attrs.s || 0);
  const styleEntry = fmtMap.get(styleIndex) || {};
  const fmt = styleEntry.fmt;
  const formulaNode = child(node, 'f');
  const valueNode = child(node, 'v');
  const inlineNode = child(node, 'is');
  const rawValue = valueNode ? valueNode.text : null;

  const out = {};
  if (formulaNode && (formulaNode.text || '').trim()) {
    out.f = `=${formulaNode.text.trim().startsWith('=') ? formulaNode.text.trim().slice(1) : formulaNode.text.trim()}`;
  }

  if (type === 's') {
    const index = Number(rawValue);
    out.v = sharedStrings[index] ?? '';
  } else if (type === 'inlineStr') {
    out.v = inlineNode ? findAll(inlineNode, 't').map((item) => item.text).join('') : '';
  } else if (type === 'str') {
    out.v = rawValue ?? '';
  } else if (type === 'b') {
    out.v = rawValue === '1' || rawValue === 'TRUE';
  } else if (type === 'e') {
    // 缓存的是错误值：丢弃缓存，交给本地引擎按公式重算
    if (!out.f) return null;
  } else if (rawValue !== null && rawValue !== undefined && rawValue !== '') {
    const number = Number(rawValue);
    out.v = Number.isFinite(number) ? number : rawValue;
  } else if (out.f) {
    // 只带公式没有缓存值：交给本地引擎重算
  } else {
    return null;
  }

  if (fmt && fmt !== 'general') out.fmt = fmt;
  if (styleEntry.s && Object.keys(styleEntry.s).length) out.s = styleEntry.s;
  if (out.v === undefined && out.f === undefined && !out.s) return null;
  return out;
}

/** 供 UI 使用的默认列宽 */
export { DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT };
