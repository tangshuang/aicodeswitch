/**
 * 跨平台 OS 原生通知（零 npm 依赖，shell-out）。
 *
 * macOS：直接用 `osascript display notification`。它以 Terminal/Script Editor 的身份发起，
 * 这些身份在本机已有通知权限，因此**始终能可靠弹出**。代价：通知图标位是系统默认占位
 * （无自定义 Logo）——尝试用「带 Logo 的 AppleScript applet」方案在较新 macOS 上会被系统
 * 静默拦截（ad-hoc applet 无通知权限），故回退到这条最稳的路径。
 *
 * - linux：notify-send（libnotify；未安装则静默）
 * - win32：PowerShell + WinForms NotifyIcon balloon（best-effort）
 *
 * 任何环节失败均静默，绝不影响代理主流程。
 */
import { execFile, execFileSync, spawn } from 'child_process';

export interface NotifyOptions {
  title: string;
  body: string;
  subtitle?: string;
}

/** 转义 AppleScript 字符串里的反斜杠与双引号 */
function escApple(s: string): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// terminal-notifier 存在性（带缓存）。它是 macOS 上唯一能「点击通知可控」的可靠手段：
// osascript 的 display notification 点击必激活脚本宿主（Script Editor/文本阅读器），无法关闭；
// terminal-notifier 点击可经 -open 打开我们指定的 URL（默认无 URL 则点击=仅消失、无动作）。
let hasTN: boolean | undefined;
function hasTerminalNotifier(): boolean {
  if (hasTN !== undefined) return hasTN;
  try {
    execFileSync('which', ['terminal-notifier'], { stdio: 'ignore', windowsHide: true });
    hasTN = true;
  } catch { hasTN = false; }
  return hasTN;
}

// 点击通知要打开的 URL（由 main.ts 在服务启动后设置，指向 AICodeSwitch 任务地图页）。
// 仅 terminal-notifier 路径生效；osascript 无法控制点击行为。
let appOpenUrl: string | null = null;
export function setNotifierAppUrl(url: string | null) { appOpenUrl = url; }

function notifyDarwin(opts: NotifyOptions): void {
  // 优先 terminal-notifier：可控制点击行为。设了 appOpenUrl 则点击打开该 URL（我们的页面），
  // 否则点击仅消失、无动作。
  if (hasTerminalNotifier()) {
    const args = ['-title', opts.title, '-message', opts.body, '-ignoreDn'];
    if (opts.subtitle) args.push('-subtitle', opts.subtitle);
    if (appOpenUrl) args.push('-open', appOpenUrl);
    execFile('terminal-notifier', args, { windowsHide: true }, () => { /* ignore */ });
    return;
  }
  // 回退：osascript（稳定弹通知，但点击会打开脚本宿主，无法避免）
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
