import type { UiLanguage } from '../../../shared/domain';

export interface LanWhiteboardText {
  sectionLabel: string;
  title: string;
  description: string;
  online(clientCount: number): string;
  unavailable: string;
  keepRunning: string;
  sameWifi: string;
  openAddress: string;
  scanTitle: string;
  scanDescription: string;
  lanAddress: string;
  localhost: string;
  otherAddresses: string;
  copyAddress: string;
  copyHint: string;
  copy: string;
  copied: string;
  preview: string;
  noAddress: string;
  loadingAddress: string;
  securityNote: string;
}

const zhCN: LanWhiteboardText = {
  sectionLabel: '局域网手写板',
  title: '平板手写与画布控制',
  description: '平板与电脑连接同一局域网后即可使用，无需安装应用。',
  online: (clientCount) => `运行中 · ${clientCount} 台已连接`,
  unavailable: '不可用',
  keepRunning: '保持 Tessel 在电脑上运行',
  sameWifi: '平板连接同一个 Wi-Fi',
  openAddress: '在平板浏览器打开下面地址',
  scanTitle: '用平板扫码打开',
  scanDescription: '二维码完全在本机生成，不会上传连接地址。',
  lanAddress: '局域网地址（推荐）',
  localhost: '本机地址',
  otherAddresses: '其他网络地址',
  copyAddress: '复制地址',
  copyHint: '复制的是完整链接，已包含连接密钥。',
  copy: '复制',
  copied: '已复制',
  preview: '在浏览器预览',
  noAddress: '局域网服务没有可用地址。请检查防火墙或网络连接。',
  loadingAddress: '正在读取连接地址…',
  securityNote: '连接地址包含本次启动的随机密钥；退出 Tessel 后立即失效。实时笔迹使用无压缩 WebSocket，并按屏幕刷新帧批量传输。'
};

const en: LanWhiteboardText = {
  sectionLabel: 'Tablet whiteboard',
  title: 'Tablet handwriting and canvas control',
  description: 'Works in a browser when the tablet and computer share a local network.',
  online: (clientCount) => `Online · ${clientCount} connected`,
  unavailable: 'Unavailable',
  keepRunning: 'Keep Tessel running',
  sameWifi: 'Join the same Wi-Fi',
  openAddress: 'Open an address below',
  scanTitle: 'Scan with your tablet',
  scanDescription: 'The QR code is generated locally; the connection address is never uploaded.',
  lanAddress: 'LAN address (recommended)',
  localhost: 'Localhost',
  otherAddresses: 'Other network addresses',
  copyAddress: 'Copy address',
  copyHint: 'Copies the full link, including the connection key.',
  copy: 'Copy',
  copied: 'Copied',
  preview: 'Preview in browser',
  noAddress: 'No LAN address is available. Check the firewall and network connection.',
  loadingAddress: 'Loading connection address…',
  securityNote: 'The address contains a random key for this session and expires when Tessel exits. Live ink uses uncompressed, frame-batched WebSocket updates.'
};

const lanWhiteboardTextByLanguage = { 'zh-CN': zhCN, en } satisfies Record<UiLanguage, LanWhiteboardText>;

export function lanWhiteboardText(language: UiLanguage): LanWhiteboardText {
  return lanWhiteboardTextByLanguage[language];
}
