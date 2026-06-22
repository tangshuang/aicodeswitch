/**
 * 跨平台 OS 原生通知（零 npm 依赖，shell-out）。
 *
 * macOS 关键点（深入调研结论）：
 * 通知的图标 = 「**发起通知的那个 App**」的图标。
 * - `osascript path.app` 会在 **osascript 自己的进程**里执行 applet 脚本 → 通知归属 osascript
 *   → 图标是 osascript 的（空/通用），**不是我们的**。这是之前 logo 不显示的根因。
 * - 必须让 applet **以独立 App 进程启动**（`open`），通知才归属该 bundle → 显示其 .icns（我们的 Logo）。
 * - `open` 无法可靠传 argv → 通过约定临时文件传 title/body/subtitle。
 * - applet 必须有**唯一 bundle id**（osacompile 默认 `applet`，多个脚本共用会撞图标缓存），
 *   并设 `LSUIElement=true`（后台 Agent，不在 Dock 跳），再用 `lsregister` 注册使图标被识别。
 *
 * 其它平台：linux notify-send；win32 PowerShell NotifyIcon balloon。
 * 任何环节失败均静默，绝不影响代理主流程。
 */
import { execFile, execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface NotifyOptions {
  title: string;
  body: string;
  subtitle?: string;
}

const APPLET_DIR = join(homedir(), '.aicodeswitch', 'notifier');
const APPLET_PATH = join(APPLET_DIR, 'AICodeSwitch.app');
const APPLET_VERSION = '4'; // 改动 applet 结构时 +1，触发重建
const VERSION_FILE = join(APPLET_DIR, '.applet-version');
const TEMP_FILE = join(APPLET_DIR, '.notif.txt'); // applet 与 notifier 约定的传参文件
const PLISTBUDDY = '/usr/libexec/PlistBuddy';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';

function findSourceLogo(): string | null {
  // dev: src/server/assets/logo.png；prod: dist/server/assets/logo.png（构建期复制）
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

/** 强制写入 Plist 字段（Delete 忽略不存在，再 Add） */
function plistForce(plist: string, key: string, type: string, value: string) {
  try { execFileSync(PLISTBUDDY, ['-c', `Delete :${key}`, plist], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  try { execFileSync(PLISTBUDDY, ['-c', `Add :${key} ${type} ${value}`, plist], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
}

let appletCache: string | null | undefined;
/** 一次性生成/复用带 Logo 的 applet；返回路径或 null（工具/源缺失则降级 osascript） */
function ensureApplet(): string | null {
  if (appletCache !== undefined) return appletCache;
  if (process.platform !== 'darwin') { appletCache = null; return null; }

  const curVersion = (() => { try { return readFileSync(VERSION_FILE, 'utf-8').trim(); } catch { return ''; } })();
  if (existsSync(APPLET_PATH) && curVersion === APPLET_VERSION) {
    appletCache = APPLET_PATH;
    return appletCache;
  }

  if (!hasBin('osacompile') || !hasBin('sips') || !existsSync(LSREGISTER)) { appletCache = null; return appletCache; }
  const logo = findSourceLogo();
  if (!logo) { appletCache = null; return appletCache; }

  try {
    mkdirSync(APPLET_DIR, { recursive: true });
    try { rmSync(APPLET_PATH, { recursive: true, force: true }); } catch { /* ignore */ }

    // applet：启动后读取约定临时文件（3 行：title/body/subtitle），发通知并删除文件。
    // 注意：不要用 AppleScript `text item delimiters to linefeed` 解析 `do shell script "cat"` 的
    // 结果——其换行与 AppleScript linefeed 常量不一致，`text items` 会得到单元素列表导致越界。
    // 改用 head/sed 在 shell 侧按行取，稳得多。
    const src = [
      'on run',
      'try',
      'set f to ((POSIX path of (path to home folder)) & ".aicodeswitch/notifier/.notif.txt")',
      'set ttl to do shell script "head -n 1 " & quoted form of f',
      'set msg to do shell script "sed -n 2p " & quoted form of f',
      'set sub to do shell script "sed -n 3p " & quoted form of f',
      'if sub is "" then',
      'display notification msg with title ttl',
      'else',
      'display notification msg with title ttl subtitle sub',
      'end if',
      'do shell script "rm -f " & quoted form of f',
      'end try',
      'end run',
    ];
    const args = ['-o', APPLET_PATH];
    for (const line of src) args.push('-e', line);
    execFileSync('osacompile', args, { stdio: 'ignore', windowsHide: true });
    if (!existsSync(APPLET_PATH)) { appletCache = null; return appletCache; }

    const plist = join(APPLET_PATH, 'Contents', 'Info.plist');
    plistForce(plist, 'CFBundleIdentifier', 'string', 'com.aicodeswitch.notifier'); // 唯一 id，避免与其它 applet 撞图标缓存
    plistForce(plist, 'CFBundleName', 'string', 'AICodeSwitch');
    plistForce(plist, 'CFBundleDisplayName', 'string', 'AICodeSwitch');
    plistForce(plist, 'LSUIElement', 'bool', 'true'); // 后台 Agent：不在 Dock 跳、不抢焦点

    // 覆盖默认图标为我们的 Logo
    const icns = join(APPLET_PATH, 'Contents', 'Resources', 'applet.icns');
    try { execFileSync('sips', ['-s', 'format', 'icns', logo, '--out', icns], { stdio: 'ignore', windowsHide: true }); } catch { /* 图标失败不致命 */ }

    // 注册到 LaunchServices，使 bundle 的图标/名称被系统识别（`open` 与通知中心据此取图标）
    try { execFileSync(LSREGISTER, ['-f', APPLET_PATH], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }

    writeFileSync(VERSION_FILE, APPLET_VERSION, 'utf-8');
    appletCache = APPLET_PATH;
    return appletCache;
  } catch {
    appletCache = null;
    return appletCache;
  }
}

/** 转义 AppleScript 字符串（仅 osascript 回退路径用） */
function escApple(s: string): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function notifyDarwin(opts: NotifyOptions): void {
  const app = ensureApplet();
  if (app) {
    try {
      mkdirSync(APPLET_DIR, { recursive: true });
      // 用临时文件传参（open 无法可靠传 argv），applet 启动后读取
      writeFileSync(TEMP_FILE, `${opts.title}\n${opts.body}\n${opts.subtitle ?? ''}\n`, 'utf-8');
      // 关键：用 open 启动 applet 为独立 App 进程 → 通知归属该 bundle → 图标 = 我们的 Logo
      execFile('open', ['-a', app], { windowsHide: true }, () => { /* ignore */ });
      return;
    } catch { /* 落到回退 */ }
  }
  // 回退：osascript（图标为空占位，但通知能发）
  let script = `display notification "${escApple(opts.body)}" with title "${escApple(opts.title)}"`;
  if (opts.subtitle) script += ` subtitle "${escApple(opts.subtitle)}"`;
  execFile('osascript', ['-e', script], { windowsHide: true }, () => { /* ignore */ });
}

function notifyLinux(opts: NotifyOptions): void {
  execFile('notify-send', ['-a', 'AICodeSwitch', opts.title, opts.body], { windowsHide: true }, () => { /* ignore */ });
}

function notifyWindows(opts: NotifyOptions): void {
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
    stdio: 'ignore', windowsHide: true, detached: true,
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
  } catch { /* ignore */ }
}
