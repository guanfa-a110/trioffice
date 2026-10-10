/**
 * themes.js —— 演示文稿主题（配色 + 字体 + 字号层级）。
 * 字体只用系统字体栈，保证离线可用、不产生外部请求。
 */

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const SERIF = 'Georgia, "Songti SC", "SimSun", "Noto Serif SC", serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

export const THEMES = {
  aurora: {
    id: 'aurora',
    name: '极光 Aurora',
    background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 55%, #0b3b52 100%)',
    backgroundFlat: '#101a2e',
    surface: 'rgba(255,255,255,0.06)',
    text: '#f2f6ff',
    textDim: 'rgba(233,240,255,0.66)',
    accent: '#63e6ff',
    accentAlt: '#7c8cff',
    border: 'rgba(255,255,255,0.14)',
    titleFont: SANS,
    bodyFont: SANS,
    titleSize: 62,
    bodySize: 28,
    dark: true,
  },
  paper: {
    id: 'paper',
    name: '纸页 Paper',
    background: '#fbfaf7',
    backgroundFlat: '#fbfaf7',
    surface: 'rgba(0,0,0,0.03)',
    text: '#22201c',
    textDim: 'rgba(34,32,28,0.62)',
    accent: '#c2410c',
    accentAlt: '#0369a1',
    border: 'rgba(34,32,28,0.12)',
    titleFont: SERIF,
    bodyFont: SANS,
    titleSize: 58,
    bodySize: 27,
    dark: false,
  },
  mint: {
    id: 'mint',
    name: '薄荷 Mint',
    background: 'linear-gradient(160deg, #e9fbf3 0%, #f7fffb 60%, #eaf4ff 100%)',
    backgroundFlat: '#eeFbf6',
    surface: 'rgba(16,120,90,0.06)',
    text: '#0f2a23',
    textDim: 'rgba(15,42,35,0.6)',
    accent: '#0f9d70',
    accentAlt: '#2563eb',
    border: 'rgba(15,42,35,0.12)',
    titleFont: SANS,
    bodyFont: SANS,
    titleSize: 58,
    bodySize: 27,
    dark: false,
  },
  mono: {
    id: 'mono',
    name: '终端 Mono',
    background: '#0b0e14',
    backgroundFlat: '#0b0e14',
    surface: 'rgba(255,255,255,0.05)',
    text: '#d8e3f0',
    textDim: 'rgba(216,227,240,0.6)',
    accent: '#4ade80',
    accentAlt: '#facc15',
    border: 'rgba(216,227,240,0.14)',
    titleFont: MONO,
    bodyFont: MONO,
    titleSize: 52,
    bodySize: 25,
    dark: true,
  },
  sunset: {
    id: 'sunset',
    name: '日落 Sunset',
    background: 'linear-gradient(150deg, #2b1055 0%, #7b2c6b 55%, #c2543f 100%)',
    backgroundFlat: '#4c1d52',
    surface: 'rgba(255,255,255,0.08)',
    text: '#fff5f3',
    textDim: 'rgba(255,240,238,0.68)',
    accent: '#ffd166',
    accentAlt: '#ff8fab',
    border: 'rgba(255,255,255,0.16)',
    titleFont: SANS,
    bodyFont: SANS,
    titleSize: 60,
    bodySize: 28,
    dark: true,
  },
};

export const THEME_LIST = Object.values(THEMES);

/** 取主题（带兜底） */
export function getTheme(id) {
  return THEMES[id] || THEMES.aurora;
}

/** 画布尺寸（16:9） */
export const CANVAS = { w: 1280, h: 720 };

export const TRANSITIONS = [
  { id: 'none', labelKey: 'deck.transitionNone' },
  { id: 'fade', labelKey: 'deck.transitionFade' },
  { id: 'slide', labelKey: 'deck.transitionSlide' },
  { id: 'zoom', labelKey: 'deck.transitionZoom' },
];

export const LAYOUTS = [
  { id: 'title', labelKey: 'deck.layoutTitle' },
  { id: 'titleBody', labelKey: 'deck.layoutTitleBody' },
  { id: 'twoCol', labelKey: 'deck.layoutTwoCol' },
  { id: 'section', labelKey: 'deck.layoutSection' },
  { id: 'blank', labelKey: 'deck.layoutBlank' },
];
