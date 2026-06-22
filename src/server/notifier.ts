/**
 * 跨平台 OS 原生通知（零 npm 依赖，shell-out）。
 *
 * 用于 Agent Map「一轮工作结束」等服务端通知：OS 级交付，浏览器/Tab 关掉也能弹。
 *
 * 平台与 Logo：
 * - darwin：osascript `display notification`（系统内置，但**不支持自定义 Logo**，显示脚本图标）；
 *   若系统装了 `terminal-notifier`（brew），自动改用它并带 `-contentImage <logo>`，即可显示我们的 Logo。
 * - linux：notify-send（libnotify），`-i <logo>` 显示 Logo；未安装则静默。
 * - win32：PowerShell + WinForms NotifyIcon，从 Logo 文件加载图标（best-effort）。
 *
 * Logo 路径解析后缓存到 ~/.aicodeswitch/data/logo.png（稳定路径），dev/prod 多候选回退。
 * 任何环节失败均静默，绝不抛错、绝不影响代理主流程。
 */
import { execFile, execFileSync, spawn } from 'child_process';
import { existsSync, copyFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface NotifyOptions {
  title: string;
  body: string;
  subtitle?: string;
}

const LOGO_CACHE = join(homedir(), '.aicodeswitch', 'data', 'logo.png');

/** 在 dev/prod 多候选位置里找源 Logo，找不到返回 null */
function findSourceLogo(): string | null {
  // __dirname：dev 下是 src/server，prod 下是 dist/server
  const candidates = [
    join(__dirname, '..', 'ui', 'assets', 'logo.png'),            // dev: src/ui/assets/logo.png
    join(__dirname, '..', 'ui', 'logo.png'),                       // prod: dist/ui/logo.png（需构建拷贝）
    join(__dirname, '..', '..', 'src', 'ui', 'assets', 'logo.png'),// prod: 包根/src/ui/assets/logo.png
  ];
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

let cachedLogo: string | null | undefined;
function resolveLogo(): string | null {
  if (cachedLogo !== undefined) return cachedLogo;
  try { if (existsSync(LOGO_CACHE)) { cachedLogo = LOGO_CACHE; return cachedLogo; } } catch { /* ignore */ }
  const src = findSourceLogo();
  if (src) {
    try {
      mkdirSync(dirname(LOGO_CACHE), { recursive: true });
      copyFileSync(src, LOGO_CACHE);
      cachedLogo = LOGO_CACHE;
      return cachedLogo;
    } catch { /* ignore */ }
  }
  cachedLogo = null;
  return null;
}

let tnAvailable: boolean | undefined;
function hasTerminalNotifier(): boolean {
  if (tnAvailable !== undefined) return tnAvailable;
  try {
    execFileSync('which', ['terminal-notifier'], { stdio: 'ignore', windowsHide: true });
    tnAvailable = true;
  } catch {
    tnAvailable = false;
  }
  return tnAvailable;
}

/** 转义 AppleScript 字符串里的反斜杠与双引号 */
function escApple(s: string): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function notifyDarwin(opts: NotifyOptions): void {
  // 若装了 terminal-notifier，用它带 Logo；否则 osascript（系统内置，但无自定义 Logo）
  if (hasTerminalNotifier()) {
    const args = ['-title', opts.title, '-message', opts.body, '-appIcon', 'AICodeSwitch'];
    const logo = resolveLogo();
    if (logo) args.push('-contentImage', logo);
    execFile('terminal-notifier', args, { windowsHide: true }, () => { /* ignore */ });
    return;
  }
  let script = `display notification "${escApple(opts.body)}" with title "${escApple(opts.title)}"`;
  if (opts.subtitle) script += ` subtitle "${escApple(opts.subtitle)}"`;
  execFile('osascript', ['-e', script], { windowsHide: true }, () => { /* ignore */ });
}

function notifyLinux(opts: NotifyOptions): void {
  const args = ['-a', 'AICodeSwitch'];
  const logo = resolveLogo();
  if (logo) args.push('-i', logo);
  args.push(opts.title, opts.body);
  execFile('notify-send', args, { windowsHide: true }, () => { /* ignore */ });
}

function notifyWindows(opts: NotifyOptions): void {
  // WinForms NotifyIcon balloon（Win10/11 上显示为 toast）
  const title = String(opts.title ?? '').replace(/'/g, "''");
  const body = String(opts.body ?? '').replace(/'/g, "''");
  const logo = resolveLogo();
  const iconLine = logo
    ? `$icon = [System.Drawing.Icon]::new('${logo.replace(/'/g, "''")}')`
    : `$icon = [System.Drawing.SystemIcons]::Information`;
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    iconLine,
    '$n = New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon = $icon',
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

/** 发送一条 OS 原生通知。失败静默。 */
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
