// Tauri 应用入口
// 负责管理 Node.js 后端进程的生命周期

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, State};

// 用于管理 Node.js 进程
struct ServerProcess {
    process: Option<Child>,
}

#[tauri::command]
async fn start_server(
    state: State<'_, Mutex<ServerProcess>>,
    port: u16,
) -> Result<String, String> {
    let mut server = state.lock().unwrap();

    // 检查进程是否已运行
    if server.process.is_some() {
        return Ok("Server already running".to_string());
    }

    // 获取 Node.js 可执行文件路径
    let node_path = get_node_executable();

    // 获取应用资源目录
    let resource_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let server_path = resource_dir.join("server").join("main.js");

    // 启动 Node.js 后端进程
    let child = Command::new(&node_path)
        .arg(server_path)
        .env("PORT", port.to_string())
        .env("NODE_ENV", "production")
        .spawn()
        .map_err(|e| format!("Failed to start server: {}", e))?;

    server.process = Some(child);

    // 等待服务启动完成（检查端口是否可用）
    wait_for_server(port).await?;

    Ok(format!("Server started on port {}", port))
}

#[tauri::command]
async fn stop_server(state: State<'_, Mutex<ServerProcess>>) -> Result<String, String> {
    let mut server = state.lock().unwrap();

    if let Some(mut child) = server.process.take() {
        let _ = child.kill();
        let _ = child.wait();
        Ok("Server stopped".to_string())
    } else {
        Err("Server is not running".to_string())
    }
}

#[tauri::command]
async fn get_server_status(state: State<'_, Mutex<ServerProcess>>) -> Result<bool, String> {
    let server = state.lock().unwrap();
    Ok(server.process.is_some())
}

#[tauri::command]
async fn check_node_installed() -> Result<String, String> {
    let output = if cfg!(target_os = "windows") {
        Command::new("cmd").args(&["/C", "node", "--version"]).output()
    } else {
        Command::new("node").arg("--version").output()
    };

    match output {
        Ok(result) if result.status.success() => {
            let version = String::from_utf8_lossy(&result.stdout);
            Ok(format!("Node.js {} found", version.trim()))
        }
        _ => Err("Node.js not found. Please install from https://nodejs.org/".to_string()),
    }
}

// 获取 Node.js 可执行文件路径（使用系统已安装的 Node.js）
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

// 等待服务启动完成
async fn wait_for_server(port: u16) -> Result<(), String> {
    let url = format!("http://localhost:{}/health", port);

    for attempt in 0..30 {
        if let Ok(response) = reqwest::get(&url).await {
            if response.status().is_success() {
                return Ok(());
            }
        }

        if attempt < 29 {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }
    }

    Err("Server failed to start within timeout".to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(ServerProcess { process: None }))
        .invoke_handler(tauri::generate_handler![
            start_server,
            stop_server,
            get_server_status,
            check_node_installed,
        ])
        .setup(|app| {
            // 应用启动时自动启动 Node.js 后端
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // 先检查 Node.js 是否安装
                match app_handle.state::<Mutex<ServerProcess>>().lock() {
                    Ok(_) => {
                        // 尝试启动服务器
                        let state = app_handle.state::<Mutex<ServerProcess>>();
                        if let Err(e) = start_server(state, 4567).await {
                            eprintln!("Failed to start server: {}", e);
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to acquire lock: {}", e);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|event| match event.event() {
            tauri::WindowEvent::CloseRequested { .. } => {
                // 窗口关闭时停止服务
                println!("Window close requested, stopping server...");
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
