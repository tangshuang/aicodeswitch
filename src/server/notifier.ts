/**
 * 跨平台 OS 原生通知（零依赖，shell-out）。
 *
 * 不带 Logo（osascript 等无法可靠显示自定义图标；去掉图标把空间留给文本）。
 * 调用方负责在 title 里带上「AICodeSwitch」让用户识别来源。
 *
 * 平台：
 * - darwin：osascript `display notification`（系统内置）
 * - linux：notify-send（libnotify；未安装则静默）
 * - win32：PowerShell + WinForms NotifyIcon balloon（best-effort）
 *
 * 任何环节失败均静默，绝不抛错、绝不影响代理主流程。
 */
import { execFile, spawn } from 'child_process';

export interface NotifyOptions {
  title: string;
  body: string;
  subtitle?: string;
}

/** 转义 AppleScript 字符串里的反斜杠与双引号 */
function escApple(s: string): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function notifyDarwin(opts: NotifyOptions): void {
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
