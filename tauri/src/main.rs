// Tauri 应用入口 - 纯启动器 + 浏览器
// 职责：
// 1. 启动 Node.js 后端服务
// 2. 通过 WebView 打开服务器 URL
// 3. 关闭时优雅停止服务

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::io::Write;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// 管理 Node.js 子进程
struct ServerProcess {
    process: Option<Child>,
}

/// 默认服务器端口
const DEFAULT_SERVER_PORT: u16 = 4567;

// ── 启动调试日志 ──────────────────────────────────────────

/// 获取日志文件路径：~/.aicodeswitch/app-launch-debug.log
fn log_file_path() -> std::path::PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    std::path::Path::new(&home)
        .join(".aicodeswitch")
        .join("app-launch-debug.log")
}

/// 初始化日志文件（每次启动截断重写）
fn init_debug_log() {
    let path = log_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::File::create(&path);
    debug_log(&format!(
        "=== AICodeSwitch Tauri 启动日志 ===\n日志文件: {}\n",
        path.display()
    ));
}

/// 写入一条调试日志（追加模式，带时间戳）
fn debug_log(msg: &str) {
    let path = log_file_path();
    if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(&path) {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let secs = (timestamp % 3600) / 60;
        let mins = timestamp % 60;
        let _ = writeln!(file, "[{:02}:{:02}] {}", secs, mins, msg);
    }
    // 同时输出到 stdout（终端可见）
    println!("{}", msg);
}

// ── 配置读取 ─────────────────────────────────────────────

/// 从 ~/.aicodeswitch/aicodeswitch.conf 读取端口号
fn read_port_from_config() -> u16 {
    let home_dir = match std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
    {
        Ok(dir) => dir,
        Err(_) => return DEFAULT_SERVER_PORT,
    };

    let config_path = std::path::Path::new(&home_dir)
        .join(".aicodeswitch")
        .join("aicodeswitch.conf");

    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return DEFAULT_SERVER_PORT,
    };

    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("PORT=") {
            if let Some(port_str) = line.strip_prefix("PORT=") {
                if let Ok(port) = port_str.trim().parse::<u16>() {
                    return port;
                }
            }
        }
    }

    DEFAULT_SERVER_PORT
}

// ── 资源路径 ─────────────────────────────────────────────

/// 解析打包资源目录
fn get_resource_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;

    let resource_root = resource_dir.join("resources");
    if !resource_root.exists() {
        Ok(resource_dir)
    } else {
        Ok(resource_root)
    }
}

// ── Node.js 可执行文件 ────────────────────────────────────

/// 获取 Node.js 可执行文件路径
fn get_node_executable() -> String {
    #[cfg(target_os = "windows")]
    {
        "node.exe".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let possible_paths = vec![
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
            "/home/linuxbrew/.linuxbrew/bin/node",
            "/usr/bin/node",
            "node",
        ];

        for path in possible_paths {
            if std::path::Path::new(path).exists() {
                return path.to_string();
            }
        }
        "node".to_string()
    }
}

// ── 服务器进程管理 ────────────────────────────────────────

/// 启动 Node.js 服务器并等待就绪
async fn start_server(
    app: &AppHandle,
    state: &State<'_, Mutex<ServerProcess>>,
    port: u16,
) -> Result<(), String> {
    {
        let mut server = state.lock().unwrap();
        if server.process.is_some() {
            debug_log("start_server: 进程已存在，跳过");
            return Ok(());
        }

        let resource_root = get_resource_root(app)?;
        debug_log(&format!("资源目录: {}", resource_root.display()));

        // 列出资源目录内容（帮助排查文件缺失）
        if let Ok(entries) = std::fs::read_dir(&resource_root) {
            let names: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            debug_log(&format!("资源目录内容: {:?}", names));
        } else {
            debug_log("⚠ 无法读取资源目录");
        }

        let server_path = resource_root.join("dist").join("server").join("main.js");
        debug_log(&format!("服务入口: {}", server_path.display()));
        let _ = app.emit("startup-log", "正在定位服务文件...");

        if !server_path.exists() {
            let err = format!("Server entry file not found: {}", server_path.display());
            debug_log(&format!("✗ {}", err));
            return Err(err);
        }
        debug_log("✓ 服务入口文件存在");

        let node_path = get_node_executable();
        debug_log(&format!("Node.js 路径: {}", node_path));
        let _ = app.emit("startup-log", format!("正在启动服务 (端口: {})...", port));

        let mut command = Command::new(&node_path);
        command
            .arg(&server_path)
            .current_dir(&resource_root)
            .env("PORT", port.to_string())
            .env("NODE_ENV", "production");

        // 将 Node.js 子进程的 stdout/stderr 重定向到启动日志文件
        let node_log_path = log_file_path();
        match std::fs::OpenOptions::new().append(true).open(&node_log_path) {
            Ok(log_file) => {
                let child_stdin = std::process::Stdio::null();
                command.stdin(child_stdin);
                match log_file.try_clone() {
                    Ok(log_copy) => {
                        command.stdout(log_file);
                        command.stderr(log_copy);
                        debug_log("✓ Node.js 输出将写入启动日志");
                    }
                    Err(e) => {
                        debug_log(&format!("⚠ 无法复制日志文件句柄: {}, stdout/stderr 将丢失", e));
                    }
                }
            }
            Err(e) => {
                debug_log(&format!("⚠ 无法打开日志文件: {}, stdout/stderr 将丢失", e));
            }
        }

        // Windows 下隐藏控制台窗口
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        debug_log(&format!("执行: {} {} (PORT={}, NODE_ENV=production)", node_path, server_path.display(), port));

        let child = command
            .spawn()
            .map_err(|e| {
                let err = format!("Failed to start Node.js server: {}", e);
                debug_log(&format!("✗ {}", err));
                err
            })?;

        let pid = child.id();
        debug_log(&format!("✓ Node.js 进程已启动 (PID: {})", pid));
        server.process = Some(child);
    }

    // 等待服务器就绪（带进程存活检查）
    debug_log("开始等待服务就绪...");
    let _ = app.emit("startup-log", "正在等待服务就绪...");
    let result = wait_for_server(app, port).await;

    // 如果健康检查失败，检查进程是否还活着
    if result.is_err() {
        let state2 = app.state::<Mutex<ServerProcess>>();
        let mut server2 = state2.lock().unwrap();
        if let Some(ref mut child) = server2.process {
            match child.try_wait() {
                Ok(Some(status)) => {
                    debug_log(&format!("✗ Node.js 进程已退出! 退出状态: {}", status));
                    debug_log(">>> 检查上方日志中 Node.js 的输出以获取错误详情 <<<");
                }
                Ok(None) => {
                    debug_log(&format!("⚠ Node.js 进程仍在运行 (PID: {}) 但健康检查未通过", child.id()));
                }
                Err(e) => {
                    debug_log(&format!("⚠ 无法检查进程状态: {}", e));
                }
            }
        }
    }

    result
}

/// 通过 HTTP /api/shutdown 优雅停止服务器，失败则强制终止
async fn stop_server(state: &State<'_, Mutex<ServerProcess>>, port: u16) {
    debug_log("正在停止服务器...");

    // 先取出子进程，释放锁后再做异步操作
    let mut child = {
        let mut server = state.lock().unwrap();
        match server.process.take() {
            Some(c) => c,
            None => {
                debug_log("无运行中的进程");
                return;
            }
        }
    };

    // Step 1: 尝试 HTTP 优雅关闭
    let shutdown_url = format!("http://localhost:{}/api/shutdown", port);
    debug_log(&format!("调用 {} ...", shutdown_url));
    let graceful = match tokio::time::timeout(
        std::time::Duration::from_secs(8),
        reqwest::Client::new().post(&shutdown_url).send(),
    )
    .await
    {
        Ok(Ok(_)) => {
            debug_log("✓ 服务端已确认关闭请求");
            true
        }
        _ => {
            debug_log("⚠ HTTP 关闭失败或超时，将强制终止");
            false
        }
    };

    // Step 2: 等待进程退出
    if graceful {
        for i in 0..30 {
            match child.try_wait() {
                Ok(Some(status)) => {
                    debug_log(&format!("✓ 服务进程已退出 (status: {})", status));
                    return;
                }
                Ok(None) => {
                    if i % 10 == 0 {
                        debug_log(&format!("等待进程退出... ({}/30)", i + 1));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => {
                    debug_log(&format!("⚠ try_wait 错误: {}", e));
                    return;
                }
            }
        }
    }

    // Step 3: 强制终止
    #[cfg(unix)]
    {
        let pid = child.id();
        debug_log(&format!("发送 SIGTERM 到 PID {} ...", pid));
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();
        for _ in 0..50 {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(_) => break,
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    debug_log("✓ 进程已强制终止");
}

// ── 健康检查 ─────────────────────────────────────────────

/// 轮询 /health 端点，等待服务器就绪（最多 15 秒）
async fn wait_for_server(app: &AppHandle, port: u16) -> Result<(), String> {
    let health_url = format!("http://localhost:{}/health", port);
    let max_attempts = 30;

    for attempt in 1..=max_attempts {
        match reqwest::get(&health_url).await {
            Ok(response) if response.status().is_success() => {
                debug_log(&format!("✓ 服务就绪! (第 {}/{} 次尝试)", attempt, max_attempts));
                return Ok(());
            }
            Ok(response) => {
                let status = response.status();
                if attempt <= 3 || attempt % 6 == 0 {
                    debug_log(&format!("健康检查返回 {} (第 {}/{} 次)", status, attempt, max_attempts));
                }
            }
            Err(e) => {
                if attempt <= 3 || attempt % 6 == 0 {
                    debug_log(&format!("健康检查失败: {} (第 {}/{} 次)", e, attempt, max_attempts));
                }
            }
        }

        if attempt % 4 == 0 {
            let msg = format!("等待服务启动中... ({}/{})", attempt, max_attempts);
            let _ = app.emit("startup-log", &msg);
        }

        if attempt < max_attempts {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }

    let err = format!("服务在 {} 秒内未启动", max_attempts / 2);
    debug_log(&format!("✗ {}", err));
    Err(err)
}

/// 快速探测服务器是否已运行（1-2 秒内）
async fn is_server_ready(port: u16) -> bool {
    let health_url = format!("http://localhost:{}/health", port);
    for i in 0..3 {
        match tokio::time::timeout(
            std::time::Duration::from_millis(500),
            reqwest::get(&health_url),
        )
        .await
        {
            Ok(Ok(response)) if response.status().is_success() => {
                debug_log(&format!("快速探测成功 (第 {}/3 次)", i + 1));
                return true;
            }
            _ => {}
        }
    }
    debug_log("快速探测: 端口上无运行中的服务");
    false
}

// ── 主入口 ───────────────────────────────────────────────

/// 判断是否为开发模式（由 beforeDevCommand 通过环境变量控制）
fn is_dev_mode() -> bool {
    std::env::var("TAURI_DEV_SERVER").is_ok()
}

fn main() {
    // 初始化调试日志（每次启动截断）
    init_debug_log();

    let dev_mode = is_dev_mode();
    debug_log(&format!("开发模式: {}", dev_mode));
    debug_log(&format!("TAURI_DEV_SERVER 环境变量: {}", std::env::var("TAURI_DEV_SERVER").unwrap_or_else(|_| "未设置".to_string())));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(ServerProcess { process: None }))
        .setup(move |app| {
            // 开发模式：Tauri 直接加载 Vite dev server，无需管理 Node.js 进程
            if dev_mode {
                debug_log("开发模式 → 跳过服务器管理，使用 beforeDevCommand 启动的外部服务");
                return Ok(());
            }

            debug_log("生产模式 → Rust 端管理服务器生命周期");

            let app_handle = app.handle().clone();
            let window = match app.get_webview_window("main") {
                Some(w) => {
                    debug_log("✓ 获取到主窗口");
                    w
                }
                None => {
                    debug_log("✗ 无法获取主窗口");
                    return Ok(());
                }
            };

            let port = read_port_from_config();
            debug_log(&format!("配置端口: {}", port));

            tauri::async_runtime::spawn(async move {
                let state = app_handle.state::<Mutex<ServerProcess>>();
                let server_url = format!("http://localhost:{}", port);

                debug_log("开始启动流程...");
                let _ = app_handle.emit("startup-log", "正在检查服务状态...");

                // 先检测是否已有服务在运行
                if is_server_ready(port).await {
                    debug_log(&format!("检测到已有服务运行 → 导航到 {}", server_url));
                    let _ = app_handle.emit("startup-log", "检测到已有服务运行，正在加载...");
                    match window.navigate(server_url.parse().unwrap()) {
                        Ok(_) => debug_log("✓ 导航成功"),
                        Err(e) => debug_log(&format!("✗ 导航失败: {}", e)),
                    }
                    return;
                }

                // 启动新服务器
                match start_server(&app_handle, &state, port).await {
                    Ok(_) => {
                        debug_log(&format!("服务启动成功 → 导航到 {}", server_url));
                        let _ = app_handle.emit("startup-log", "服务已就绪，正在加载...");
                        match window.navigate(server_url.parse().unwrap()) {
                            Ok(_) => debug_log("✓ 导航成功"),
                            Err(e) => debug_log(&format!("✗ 导航失败: {}", e)),
                        }
                    }
                    Err(e) => {
                        debug_log(&format!("✗ 服务启动失败: {}", e));
                        let _ = app_handle.emit("startup-error", &e);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                debug_log("窗口关闭请求 → 开始关闭流程");

                let window_clone = window.clone();
                let app_handle = window.app_handle().clone();

                tauri::async_runtime::spawn(async move {
                    // 非开发模式下优雅停止服务器
                    if !is_dev_mode() {
                        let port = read_port_from_config();
                        let state = app_handle.state::<Mutex<ServerProcess>>();
                        stop_server(&state, port).await;
                    }

                    debug_log("关闭窗口");
                    let _ = window_clone.destroy();
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
