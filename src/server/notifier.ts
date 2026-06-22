/**
 * 跨平台 OS 原生通知（零 npm 依赖，shell-out）。
 *
 * 平台：
 * - darwin：优先用一个「带我们 Logo 图标的 AppleScript applet」发通知（AICodeSwitch.app，
 *   一次性生成在 ~/.aicodeswitch/notifier/ 下）。macOS 通知图标取自「发起 App 的图标」，
 *   applet 发出 → 图标位显示我们的 Logo（填充系统强制保留的占位）。工具缺失/生成失败则
 *   回退到 osascript `display notification`（图标为空占位，但通知仍能弹）。
 * - linux：notify-send（libnotify；未安装则静默）。
 * - win32：PowerShell + WinForms NotifyIcon balloon（best-effort）。
 *
 * 任何环节失败均静默，绝不抛错、绝不影响代理主流程。
 */
import { execFile, execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface NotifyOptions {
  title: string;
  body: string;
  subtitle?: string;
}

// ─── macOS applet（带 Logo 图标） ───

const APPLET_DIR = join(homedir(), '.aicodeswitch', 'notifier');
const APPLET_PATH = join(APPLET_DIR, 'AICodeSwitch.app');

function findSourceLogo(): string | null {
  // Logo 作为服务端自有资源随包发布：
  //   dev  → src/server/assets/logo.png（__dirname = src/server）
  //   prod → dist/server/assets/logo.png（构建期由 scripts/copy-server-assets.js 从 src 复制过去）
  // 不依赖 vite 哈希产物、也不依赖 src 是否随包发布。
  const c = join(__dirname, 'assets', 'logo.png');
  try { if (existsSync(c)) return c; } catch { /* ignore */ }
  return null;
}

function hasBin(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

let appletCache: string | null | undefined;
/** 一次性生成带 Logo 的 AppleScript applet；返回 applet 路径或 null（工具/源缺失则降级） */
function ensureApplet(): string | null {
  if (appletCache !== undefined) return appletCache;
  if (process.platform !== 'darwin') { appletCache = null; return null; }
  if (existsSync(APPLET_PATH)) { appletCache = APPLET_PATH; return appletCache; }
  if (!hasBin('osacompile') || !hasBin('sips')) { appletCache = null; return appletCache; }
  const logo = findSourceLogo();
  if (!logo) { appletCache = null; return appletCache; }
  try {
    mkdirSync(APPLET_DIR, { recursive: true });
    // 用 argv 传参（特殊字符安全，无需 AppleScript 转义）
    const src = [
      'on run argv',
      'set ttl to item 1 of argv as text',
      'set msg to item 2 of argv as text',
      'try',
      'set sub to item 3 of argv as text',
      'on error',
      'set sub to ""',
      'end try',
      'if sub is "" then',
      'display notification msg with title ttl',
      'else',
      'display notification msg with title ttl subtitle sub',
      'end if',
      'end run',
    ];
    const args = ['-o', APPLET_PATH];
    for (const line of src) { args.push('-e', line); }
    execFileSync('osacompile', args, { stdio: 'ignore', windowsHide: true });
    if (!existsSync(APPLET_PATH)) { appletCache = null; return appletCache; }
    // 覆盖 applet 默认图标为我们的 Logo（Info.plist 已引用 applet.icns）
    const icns = join(APPLET_PATH, 'Contents', 'Resources', 'applet.icns');
    try {
      execFileSync('sips', ['-s', 'format', 'icns', logo, '--out', icns], { stdio: 'ignore', windowsHide: true });
    } catch { /* 图标失败不致命：applet 仍可发通知（默认图标） */ }
    appletCache = APPLET_PATH;
    return appletCache;
  } catch {
    appletCache = null;
    return appletCache;
  }
}

/** 转义 AppleScript 字符串里的反斜杠与双引号（仅回退路径用） */
function escApple(s: string): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function notifyDarwin(opts: NotifyOptions): void {
  const app = ensureApplet();
  if (app) {
    // 通知由 applet 发出 → 图标 = 我们的 Logo
    execFile('osascript', [app, opts.title, opts.body, opts.subtitle ?? ''], { windowsHide: true }, () => { /* ignore */ });
    return;
  }
  // 回退：osascript（图标为空占位）
  let script = `display notification "${escApple(opts.body)}" with title "${escApple(opts.title)}"`;
  if (opts.subtitle) script += ` subtitle "${escApple(opts.subtitle)}"`;
  execFile('osascript', ['-e', script], { windowsHide: true }, () => { /* ignore */ });
}

function notifyLinux(opts: NotifyOptions): void {
  execFile('notify-send', ['-a', 'AICodeSwitch', opts.title, opts.body], { windowsHide: true }, () => { /* ignore */ });
}

function notifyWindows(opts: NotifyOptions): void {
  // WinForms NotifyIcon balloon（Win10/11 上显示为 toast）
  const title = String(opts.title ?? '').replace(/'/g, "''");
  const body = String(opts.body ?? '').replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$n = New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon = [System.Drawing.SystemIcons]::Information',
    '$n.Visible = $true',
    `$n.ShowBalloonTip(5000, '${title}', '${body}', [System.Windows.Forms.ToolTipIcon]::Info)`,
    'Start-Sleep -Seconds 6',
    '$n.Dispose()',
  ].join('; ');
  const child = spawn('powershell', ['-NoProfile', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  });
  child.on('error', () => { /* ignore */ });
  child.unref();
}

/** 发送一条 OS 原生通知。失败静默。title 请自带「AICodeSwitch」标识来源。 */
export function notify(opts: NotifyOptions): void {
  try {
    if (process.platform === 'darwin') return notifyDarwin(opts);
    if (process.platform === 'linux') return notifyLinux(opts);
    if (process.platform === 'win32') return notifyWindows(opts);
    // 其它平台：no-op
  } catch {
    /* ignore */
  }
}
