// Tauri 应用入口 - 作为壳启动 Node.js 服务并打开 WebView
// 职责：
// 1. 启动 Node.js 后端服务（入口：files/dist/server/main.js）
// 2. 通过 WebView 打开服务器 URL

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

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

// 获取资源根目录（bundle 后的 files 目录）
fn get_resource_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;
    Ok(resource_dir.join("files"))
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

        // 检查服务器文件是否存在
        if !server_path.exists() {
            return Err(format!(
                "Server entry file not found: {}",
                server_path.display()
            ));
        }

        // 构建 Node.js 启动命令
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

        // 启动进程
        let child = command
            .spawn()
            .map_err(|e| format!("Failed to start Node.js server: {}", e))?;

        server.process = Some(child);
        println!("Node.js server started on port {}", port);
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

    // 尝试运行 node --version 来检查 Node.js 是否安装
    match Command::new(&node_path).arg("--version").output() {
        Ok(output) => {
            if output.status.success() {
                // Node.js 已安装，返回版本信息
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                println!("Detected Node.js version: {}", version);
                Ok(version)
            } else {
                Err(format!(
                    "Node.js 可执行文件执行失败，请检查 Node.js 安装是否正确"
                ))
            }
        }
        Err(e) => {
            // Node.js 未安装或不在 PATH 中
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

    // 尝试连接健康检查端点，超时时间短一些（1秒）
    match tokio::time::timeout(
        std::time::Duration::from_secs(1),
        reqwest::get(&health_url),
    )
    .await
    {
        Ok(Ok(response)) if response.status().is_success() => {
            println!("Detected existing server on port {}", port);
            true
        }
        _ => false,
    }
}

// 等待服务器就绪（检查健康端点）
async fn wait_for_server(port: u16) -> Result<(), String> {
    let health_url = format!("http://localhost:{}/health", port);
    let max_attempts = 30;
    let retry_delay = std::time::Duration::from_millis(500);

    for attempt in 1..=max_attempts {
        match reqwest::get(&health_url).await {
            Ok(response) if response.status().is_success() => {
                println!("Server is ready at http://localhost:{}", port);
                return Ok(());
            }
            _ => {
                if attempt < max_attempts {
                    tokio::time::sleep(retry_delay).await;
                }
            }
        }
    }

    Err(format!(
        "Server failed to start within {} seconds",
        max_attempts / 2
    ))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(ServerProcess { process: None }))
        .setup(|app| {
            // 开发模式下，Tauri 会自动加载 devUrl，不需要手动启动服务器
            if cfg!(debug_assertions) {
                println!("Running in dev mode - using Vite dev server");
                return Ok(());
            }

            // 检查 Node.js 是否已安装
            if let Err(e) = check_nodejs_installed() {
                // 显示错误对话框
                use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                app.dialog()
                    .message(&e)
                    .title("Node.js 未安装")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});

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

            // 读取配置文件中的端口号
            let port = read_port_from_config();
            let server_url = format!("http://localhost:{}", port);

            println!("Running in production mode - using port: {}", port);

            // 异步检查服务状态并启动/连接
            tauri::async_runtime::spawn(async move {
                let state = app_handle.state::<Mutex<ServerProcess>>();

                // 先检查是否已有服务在运行
                if is_server_running(port).await {
                    println!("Using existing server, skipping Node.js process startup");
                    // 已有服务在运行，直接加载 URL
                    if let Err(e) = window.eval(&format!("window.location.href = '{}'", server_url)) {
                        eprintln!("Failed to load server URL: {}", e);
                    }
                    return;
                }

                // 没有服务在运行，启动新的服务器
                match start_server(&app_handle, &state, port).await {
                    Ok(_) => {
                        // 服务器启动成功，加载 URL
                        if let Err(e) = window.eval(&format!("window.location.href = '{}'", server_url)) {
                            eprintln!("Failed to load server URL: {}", e);
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to start server: {}", e);
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

