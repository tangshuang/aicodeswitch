// Tauri 应用入口 - 纯启动器 + 浏览器
// 职责：
// 1. 启动 Node.js 后端服务
// 2. 通过 WebView 打开服务器 URL
// 3. 关闭时优雅停止服务

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// 管理 Node.js 子进程
struct ServerProcess {
    process: Option<Child>,
}

/// 默认服务器端口
const DEFAULT_SERVER_PORT: u16 = 4567;

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
            return Ok(());
        }

        let resource_root = get_resource_root(app)?;
        let server_path = resource_root.join("dist").join("server").join("main.js");

        if !server_path.exists() {
            return Err(format!("Server entry file not found: {}", server_path.display()));
        }

        let node_path = get_node_executable();
        let mut command = Command::new(&node_path);
        command
            .arg(&server_path)
            .current_dir(&resource_root)
            .env("PORT", port.to_string())
            .env("NODE_ENV", "production");

        // Windows 下隐藏控制台窗口
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let child = command
            .spawn()
            .map_err(|e| format!("Failed to start Node.js server: {}", e))?;

        println!("Node.js server spawned (PID: {:?})", child.id());
        server.process = Some(child);
    }

    // 等待服务器就绪
    wait_for_server(port).await
}

/// 通过 HTTP /api/shutdown 优雅停止服务器，失败则强制终止
async fn stop_server(state: &State<'_, Mutex<ServerProcess>>, port: u16) {
    // 先取出子进程，释放锁后再做异步操作
    let mut child = {
        let mut server = state.lock().unwrap();
        match server.process.take() {
            Some(c) => c,
            None => return,
        }
    };

    // Step 1: 尝试 HTTP 优雅关闭
    let shutdown_url = format!("http://localhost:{}/api/shutdown", port);
    let graceful = match tokio::time::timeout(
        std::time::Duration::from_secs(8),
        reqwest::Client::new().post(&shutdown_url).send(),
    )
    .await
    {
        Ok(Ok(_)) => {
            println!("Server acknowledged shutdown request");
            true
        }
        _ => {
            eprintln!("HTTP shutdown failed or timed out, forcing termination");
            false
        }
    };

    // Step 2: 等待进程退出
    if graceful {
        for _ in 0..30 {
            match child.try_wait() {
                Ok(Some(_)) => {
                    println!("Server exited gracefully");
                    return;
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(_) => return,
            }
        }
    }

    // Step 3: 强制终止
    #[cfg(unix)]
    {
        let pid = child.id();
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
    println!("Node.js server stopped (forced)");
}

// ── 健康检查 ─────────────────────────────────────────────

/// 轮询 /health 端点，等待服务器就绪（最多 15 秒）
async fn wait_for_server(port: u16) -> Result<(), String> {
    let health_url = format!("http://localhost:{}/health", port);
    let max_attempts = 30;

    for attempt in 1..=max_attempts {
        match reqwest::get(&health_url).await {
            Ok(response) if response.status().is_success() => {
                println!("Server ready (attempt {}/{})", attempt, max_attempts);
                return Ok(());
            }
            _ => {
                if attempt % 6 == 0 {
                    println!("Waiting... attempt {}/{}", attempt, max_attempts);
                }
            }
        }

        if attempt < max_attempts {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }

    Err(format!(
        "Server failed to start within {} seconds",
        max_attempts / 2
    ))
}

/// 快速探测服务器是否已运行（1-2 秒内）
async fn is_server_ready(port: u16) -> bool {
    let health_url = format!("http://localhost:{}/health", port);
    for _ in 0..3 {
        match tokio::time::timeout(
            std::time::Duration::from_millis(500),
            reqwest::get(&health_url),
        )
        .await
        {
            Ok(Ok(response)) if response.status().is_success() => return true,
            _ => {}
        }
    }
    false
}

// ── 主入口 ───────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(ServerProcess { process: None }))
        .setup(|app| {
            // 开发模式：Tauri 直接加载 Vite dev server，无需管理 Node.js 进程
            if cfg!(debug_assertions) {
                return Ok(());
            }

            let app_handle = app.handle().clone();
            let window = match app.get_webview_window("main") {
                Some(w) => w,
                None => {
                    eprintln!("Failed to get main window");
                    return Ok(());
                }
            };

            let port = read_port_from_config();

            tauri::async_runtime::spawn(async move {
                let state = app_handle.state::<Mutex<ServerProcess>>();
                let server_url = format!("http://localhost:{}", port);

                // 先检测是否已有服务在运行
                if is_server_ready(port).await {
                    println!("Server already running, navigating directly");
                    let _ = window.navigate(server_url.parse().unwrap());
                    return;
                }

                // 启动新服务器
                match start_server(&app_handle, &state, port).await {
                    Ok(_) => {
                        println!("Server started, navigating to: {}", server_url);
                        let _ = window.navigate(server_url.parse().unwrap());
                    }
                    Err(e) => {
                        eprintln!("Failed to start server: {}", e);
                        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                        let _ = app_handle
                            .dialog()
                            .message(&format!(
                                "无法启动后端服务器：\n\n{}\n\n请检查 Node.js 是否已正确安装。",
                                e
                            ))
                            .title("服务器启动失败")
                            .kind(MessageDialogKind::Error)
                            .show(|_| {});
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();

                let window_clone = window.clone();
                let app_handle = window.app_handle().clone();

                tauri::async_runtime::spawn(async move {
                    // 生产模式下优雅停止服务器
                    if !cfg!(debug_assertions) {
                        let port = read_port_from_config();
                        let state = app_handle.state::<Mutex<ServerProcess>>();
                        stop_server(&state, port).await;
                    }

                    let _ = window_clone.destroy();
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
