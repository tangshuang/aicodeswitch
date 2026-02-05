// Tauri 应用入口 - 作为壳启动 Node.js 服务并打开 WebView
// 职责：
// 1. 启动 Node.js 后端服务（入口：files/dist/server/main.js）
// 2. 通过 WebView 打开服务器 URL

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// 用于管理 Node.js 进程
struct ServerProcess {
    process: Option<Child>,
}

// 默认服务器配置
const DEFAULT_SERVER_PORT: u16 = 4567;

// 读取配置文件中的端口号
fn read_port_from_config() -> u16 {
    // 获取配置文件路径：~/.aicodeswitch/aicodeswitch.conf
    let home_dir = match std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
    {
        Ok(dir) => dir,
        Err(_) => return DEFAULT_SERVER_PORT,
    };

    let config_path = std::path::Path::new(&home_dir)
        .join(".aicodeswitch")
        .join("aicodeswitch.conf");

    // 读取配置文件
    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return DEFAULT_SERVER_PORT,
    };

    // 解析 PORT=xxxx 格式
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("PORT=") {
            if let Some(port_str) = line.strip_prefix("PORT=") {
                if let Ok(port) = port_str.trim().parse::<u16>() {
                    println!("Read port from config: {}", port);
                    return port;
                }
            }
        }
    }

    DEFAULT_SERVER_PORT
}

// 获取资源根目录
// Tauri 2.0 会将 resources 目录打包到应用中
// 在开发模式下，资源直接在 resource_dir 下
// 在生产模式下，需要检查 resources 目录是否存在
fn get_resource_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;

    let resource_root = resource_dir.join("resources");
    println!("Resource directory: {:?}", resource_dir);
    println!("Resource root (resources): {:?}", resource_root);

    // 检查 resource_root 是否存在，如果不存在，尝试使用 resource_dir
    if !resource_root.exists() {
        println!("Warning: 'resources' directory not found in resource_dir, using resource_dir directly");
        Ok(resource_dir)
    } else {
        Ok(resource_root)
    }
}

// 启动 Node.js 服务器
async fn start_server(
    app: &AppHandle,
    state: &State<'_, Mutex<ServerProcess>>,
    port: u16,
) -> Result<(), String> {
    // 锁定并启动服务器进程
    {
        let mut server = state.lock().unwrap();

        // 检查进程是否已运行
        if server.process.is_some() {
            return Ok(());
        }

        // 获取资源目录和服务器入口文件
        let resource_root = get_resource_root(app)?;
        let server_path = resource_root
            .join("dist")
            .join("server")
            .join("main.js");

        println!("Server path: {:?}", server_path);
        println!("Working directory: {:?}", resource_root);

        // 检查服务器文件是否存在
        if !server_path.exists() {
            return Err(format!(
                "Server entry file not found: {}\nWorking directory: {:?}",
                server_path.display(),
                resource_root
            ));
        }

        // 构建 Node.js 启动命令
        let node_path = get_node_executable();
        println!("Node.js executable: {}", node_path);

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

        println!("Starting Node.js server with command: {:?} {:?}", node_path, server_path);

        // 启动进程
        let child = command
            .spawn()
            .map_err(|e| format!("Failed to start Node.js server: {}", e))?;

        server.process = Some(child);
        println!("Node.js server process spawned (PID: {:?}), waiting for ready on port {}",
                 server.process.as_ref().map(|p| p.id()), port);
    }

    // 等待服务器就绪
    wait_for_server(port).await?;

    Ok(())
}

// 停止服务器进程
fn stop_server(state: &State<'_, Mutex<ServerProcess>>) {
    let mut server = state.lock().unwrap();
    if let Some(mut child) = server.process.take() {
        let _ = child.kill();
        let _ = child.wait();
        println!("Node.js server stopped");
    }
}

// 获取 Node.js 可执行文件路径
fn get_node_executable() -> String {
    #[cfg(target_os = "windows")]
    {
        "node.exe".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "node".to_string()
    }
}

// 检查 Node.js 是否已安装
fn check_nodejs_installed() -> Result<String, String> {
    let node_path = get_node_executable();

    println!("Checking Node.js installation...");

    // 尝试运行 node --version 来检查 Node.js 是否安装
    match Command::new(&node_path).arg("--version").output() {
        Ok(output) => {
            if output.status.success() {
                // Node.js 已安装，返回版本信息
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                println!("✓ Detected Node.js version: {}", version);
                Ok(version)
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let status_code = output.status.code().unwrap_or(-1);
                eprintln!("✗ Node.js executable failed with status code: {}", status_code);
                eprintln!("  stderr: {}", stderr);
                Err(format!(
                    "Node.js 可执行文件执行失败，请检查 Node.js 安装是否正确"
                ))
            }
        }
        Err(e) => {
            // Node.js 未安装或不在 PATH 中
            eprintln!("✗ Failed to execute Node.js: {}", e);
            Err(format!(
                "未检测到 Node.js 安装。\n\n错误信息: {}\n\n请先安装 Node.js 后再运行本应用程序。\n\n安装地址: https://nodejs.org/",
                e
            ))
        }
    }
}

// 检查端口是否已经有服务在运行
async fn is_server_running(port: u16) -> bool {
    let health_url = format!("http://localhost:{}/health", port);

    println!("Checking if server is already running on port {}...", port);

    // 尝试连接健康检查端点，超时时间短一些（1秒）
    match tokio::time::timeout(
        std::time::Duration::from_secs(1),
        reqwest::get(&health_url),
    )
    .await
    {
        Ok(Ok(response)) if response.status().is_success() => {
            println!("✓ Detected existing server on port {}", port);
            true
        }
        Ok(Ok(response)) => {
            println!("✗ Server responded with status: {}", response.status());
            false
        }
        Ok(Err(e)) => {
            println!("✗ Health check failed: {}", e);
            false
        }
        Err(_) => {
            println!("✗ Health check timeout");
            false
        }
    }
}

// 等待服务器就绪（检查健康端点）
async fn wait_for_server(port: u16) -> Result<(), String> {
    let health_url = format!("http://localhost:{}/health", port);
    let max_attempts = 30;
    let retry_delay = std::time::Duration::from_millis(500);

    println!("Waiting for server to be ready (max {} seconds)...", max_attempts / 2);

    for attempt in 1..=max_attempts {
        match reqwest::get(&health_url).await {
            Ok(response) if response.status().is_success() => {
                println!("✓ Server is ready at http://localhost:{} (after {} attempts)",
                         port, attempt);
                return Ok(());
            }
            Ok(response) => {
                if attempt % 6 == 0 { // 每3秒打印一次
                    println!("Waiting... attempt {}/{} (status: {})",
                             attempt, max_attempts, response.status());
                }
            }
            Err(e) => {
                if attempt % 6 == 0 { // 每3秒打印一次
                    println!("Waiting... attempt {}/{} (error: {})",
                             attempt, max_attempts, e);
                }
            }
        }

        if attempt < max_attempts {
            tokio::time::sleep(retry_delay).await;
        }
    }

    Err(format!(
        "Server failed to start within {} seconds\nLast health check URL: {}",
        max_attempts / 2, health_url
    ))
}

// 用于跟踪是否已经导航到服务器 URL（避免重复导航）
struct NavigationState {
    has_navigated: Arc<AtomicBool>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(ServerProcess { process: None }))
        .manage(NavigationState {
            has_navigated: Arc::new(AtomicBool::new(false)),
        })
        .setup(|app| {
            // 开发模式下，Tauri 会自动加载 devUrl，不需要手动启动服务器
            if cfg!(debug_assertions) {
                println!("Running in dev mode - using Vite dev server");
                return Ok(());
            }

            println!("Running in production mode - frontend will load immediately, Node.js check in background");

            let app_handle = app.handle().clone();
            let window = match app.get_webview_window("main") {
                Some(w) => w,
                None => {
                    eprintln!("Failed to get main window");
                    return Ok(());
                }
            };

            // 读取配置文件中的端口号
            let port = read_port_from_config();
            let server_url = format!("http://localhost:{}", port);

            println!("Configured server port: {}", port);

            // 克隆 app_handle 用于异步任务
            let app_handle_for_async = app_handle.clone();
            let window_for_async = window.clone();

            // 获取导航状态
            let nav_state = app_handle.state::<NavigationState>();
            let has_navigated = nav_state.has_navigated.clone();

            // 异步检查 Node.js 并启动/连接服务（不阻塞界面显示）
            tauri::async_runtime::spawn(async move {
                // 检查 Node.js 是否已安装
                if let Err(e) = check_nodejs_installed() {
                    // 显示错误对话框
                    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                    let _ = app_handle_for_async
                        .dialog()
                        .message(&e)
                        .title("Node.js 未安装")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                    return;
                }

                let state = app_handle_for_async.state::<Mutex<ServerProcess>>();

                // 先检查是否已有服务在运行
                if is_server_running(port).await {
                    println!("Using existing server, skipping Node.js process startup");
                    // 已有服务在运行，使用 navigate 方法加载 URL
                    println!("Navigating to: {}", server_url);
                    let url = server_url.parse().unwrap();
                    if let Err(e) = window_for_async.navigate(url) {
                        eprintln!("Failed to navigate to server URL: {}", e);
                    } else {
                        has_navigated.store(true, Ordering::SeqCst);
                    }
                    return;
                }

                // 没有服务在运行，启动新的服务器
                println!("No existing server detected, starting new Node.js process...");
                match start_server(&app_handle_for_async, &state, port).await {
                    Ok(_) => {
                        // 服务器启动成功，使用 navigate 方法加载 URL
                        println!("Server started successfully, navigating to: {}", server_url);
                        let url = server_url.parse().unwrap();
                        if let Err(e) = window_for_async.navigate(url) {
                            eprintln!("Failed to navigate to server URL: {}", e);
                        } else {
                            has_navigated.store(true, Ordering::SeqCst);
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to start server: {}", e);
                        // 显示错误对话框
                        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                        let _ = app_handle_for_async
                            .dialog()
                            .message(&format!("无法启动后端服务器：\n\n{}\n\n请检查 Node.js 是否已正确安装。", e))
                            .title("服务器启动失败")
                            .kind(MessageDialogKind::Error)
                            .show(|_| {});
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // 只在生产模式下停止服务器
                if !cfg!(debug_assertions) {
                    let state = window.state::<Mutex<ServerProcess>>();
                    stop_server(&state);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

