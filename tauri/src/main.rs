// Tauri 应用入口 - 纯启动器 + 浏览器
// 职责：
// 1. 启动 Node.js 后端服务
// 2. 通过 WebView 打开服务器 URL
// 3. 关闭时优雅停止服务

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::io::{BufRead, Write};
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

// ── Node.js 环境探测 ───────────────────────────────────────

/// Node.js 探测结果
struct NodeProbe {
    /// 最终将用于 spawn 的路径
    path: String,
    /// `node --version` 输出（如 "v20.11.0"）；None 表示无法运行
    version: Option<String>,
    /// 失败原因（中文，给用户看）；None 表示通过
    error: Option<String>,
}

/// 从版本字符串解析主版本号（"v20.11.0" → 20）
fn parse_node_major(v: &str) -> Option<u32> {
    v.trim_start_matches('v').split('.').next()?.parse().ok()
}

/// 跨平台解析 Node 路径。Windows 优先用 `where node` 拿绝对路径，避免 GUI 应用 PATH 不全。
fn resolve_node_path() -> String {
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut cmd = Command::new("where");
        cmd.arg("node").creation_flags(CREATE_NO_WINDOW);
        if let Ok(out) = cmd.output() {
            if let Some(first) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let p = first.trim();
                if !p.is_empty() {
                    return p.to_string();
                }
            }
        }
        return "node.exe".to_string();
    }
    #[cfg(not(target_os = "windows"))]
    {
        for path in [
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
            "/home/linuxbrew/.linuxbrew/bin/node",
            "/usr/bin/node",
        ] {
            if std::path::Path::new(path).exists() {
                return path.to_string();
            }
        }
        "node".to_string()
    }
}

/// 运行 `<node> --version`，返回 (版本输出, 是否成功)
fn run_node_version(node_path: &str) -> (Option<String>, bool) {
    let mut cmd = Command::new(node_path);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(out) => {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (if v.is_empty() { None } else { Some(v) }, out.status.success())
        }
        Err(_) => (None, false),
    }
}

/// 完整探测 Node：解析路径 → 跑 --version → 校验版本
fn resolve_and_verify_node() -> NodeProbe {
    let path = resolve_node_path();
    debug_log(&format!("Node.js 候选路径: {}", path));

    let (version, ok) = run_node_version(&path);
    debug_log(&format!(
        "Node.js 版本检测: version={:?} run_ok={}",
        version, ok
    ));

    let version_ok = match &version {
        Some(v) if ok => parse_node_major(v).map(|m| m >= 18).unwrap_or(false),
        _ => false,
    };

    let error = if !ok {
        Some(format!(
            "无法运行 Node.js（执行 \"{} --version\" 失败）。请确认 Node.js 已正确安装并加入系统 PATH。",
            path
        ))
    } else if !version_ok {
        Some(format!(
            "Node.js 版本过低（{}），需要 v18 或以上，请到 https://nodejs.org/ 升级。",
            version.as_deref().unwrap_or("未知")
        ))
    } else {
        None
    };

    NodeProbe {
        path,
        version,
        error,
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

        // spawn 前主动探测并校验 Node，失败立即返回（不进入健康检查轮询）
        let node_probe = resolve_and_verify_node();
        let _ = app.emit(
            "startup-log",
            format!(
                "Node.js: {}",
                node_probe.version.as_deref().unwrap_or("未检测到")
            ),
        );
        if let Some(err) = &node_probe.error {
            debug_log(&format!("✗ {}", err));
            return Err(err.clone());
        }
        let node_path = node_probe.path.clone();
        debug_log(&format!("Node.js 路径: {}", node_path));
        let _ = app.emit("startup-log", format!("正在启动服务 (端口: {})...", port));

        let mut command = Command::new(&node_path);
        command
            .arg(&server_path)
            .current_dir(&resource_root)
            .env("PORT", port.to_string())
            .env("NODE_ENV", "production")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        // Windows 下隐藏控制台窗口
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        debug_log(&format!("执行: {} {} (PORT={}, NODE_ENV=production)", node_path, server_path.display(), port));

        let mut child = command
            .spawn()
            .map_err(|e| {
                let err = format!("Failed to start Node.js server: {}", e);
                debug_log(&format!("✗ {}", err));
                err
            })?;

        let pid = child.id();
        debug_log(&format!("✓ Node.js 进程已启动 (PID: {})", pid));

        // 后台线程：将 Node.js stdout/stderr 逐行写入启动日志
        if let Some(stdout) = child.stdout.take() {
            std::thread::spawn(move || {
                let reader = std::io::BufReader::new(stdout);
                for line in reader.lines().map_while(Result::ok) {
                    debug_log(&format!("[node:out] {}", line));
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    debug_log(&format!("[node:err] {}", line));
                }
            });
        }

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

/// 健康检查最大尝试次数。
/// 优先环境变量 `AIC_STARTUP_TIMEOUT`（秒）；否则默认 60 次（每次 0.5s ≈ 30 秒）。
fn read_max_attempts() -> u32 {
    std::env::var("AIC_STARTUP_TIMEOUT")
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .map(|secs| secs.saturating_mul(2))
        .unwrap_or(60)
}

/// 轮询 /health 端点，等待服务器就绪
async fn wait_for_server(app: &AppHandle, port: u16) -> Result<(), String> {
    let health_url = format!("http://localhost:{}/health", port);
    let max_attempts = read_max_attempts();

    for attempt in 1..=max_attempts {
        // 每次健康检查最多等 2 秒，防止 reqwest 永久阻塞
        let check_result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            reqwest::get(&health_url),
        ).await;

        match check_result {
            Ok(Ok(response)) if response.status().is_success() => {
                debug_log(&format!("✓ 服务就绪! (第 {}/{} 次尝试)", attempt, max_attempts));
                return Ok(());
            }
            Ok(Ok(response)) => {
                let status = response.status();
                if attempt <= 3 || attempt % 6 == 0 {
                    debug_log(&format!("健康检查返回 {} (第 {}/{} 次)", status, attempt, max_attempts));
                }
            }
            Ok(Err(e)) => {
                if attempt <= 3 || attempt % 6 == 0 {
                    debug_log(&format!("健康检查失败: {} (第 {}/{} 次)", e, attempt, max_attempts));
                }
            }
            Err(_) => {
                // timeout
                if attempt <= 3 || attempt % 6 == 0 {
                    debug_log(&format!("健康检查超时 (2s) (第 {}/{} 次)", attempt, max_attempts));
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

/// 验证后端数据就绪（健康检查通过后调用，确保 API 可正常返回数据）
async fn verify_data_ready(port: u16) -> bool {
    let ready_url = format!("http://localhost:{}/api/ready", port);
    debug_log(&format!("正在验证数据就绪: {} ...", ready_url));
    match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        reqwest::get(&ready_url),
    )
    .await
    {
        Ok(Ok(response)) if response.status().is_success() => {
            debug_log("✓ 数据就绪验证通过");
            true
        }
        Ok(Ok(response)) => {
            debug_log(&format!("⚠ 数据就绪验证返回 {}", response.status()));
            false
        }
        Ok(Err(e)) => {
            debug_log(&format!("⚠ 数据就绪验证请求失败: {}", e));
            false
        }
        Err(_) => {
            debug_log("⚠ 数据就绪验证超时 (5s)");
            false
        }
    }
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

/// 优雅关闭占用端口的已有服务（上次未正常退出的、或 `aicos start` 启动的）。
/// 优先 POST `/api/shutdown`，让旧服务走统一的 shutdown 流程（恢复配置 + 退出）；
/// 若不响应则按端口强杀（此时旧服务的配置可能来不及恢复，属极端兜底）。
async fn shutdown_existing_server(port: u16) {
    let shutdown_url = format!("http://localhost:{}/api/shutdown", port);
    debug_log(&format!("请求旧服务关闭: POST {}", shutdown_url));
    let graceful = matches!(
        tokio::time::timeout(
            std::time::Duration::from_secs(8),
            reqwest::Client::new().post(&shutdown_url).send(),
        )
        .await,
        Ok(Ok(_))
    );
    if graceful {
        debug_log("旧服务已收到关闭请求，等待其退出...");
    } else {
        debug_log("⚠ 旧服务未响应 /api/shutdown，稍后将按端口强杀");
    }

    // 轮询 /health，等待旧服务退出（最多约 10 秒）
    for i in 0..20 {
        if !is_server_ready(port).await {
            debug_log(&format!("✓ 旧服务已退出 (第 {}/20 次探测)", i + 1));
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    debug_log("⚠ 旧服务仍未退出，按端口强制清理");
    kill_process_on_port(port);
}

/// 跨平台强杀占用指定端口的进程（最后手段）。
#[cfg(unix)]
fn kill_process_on_port(port: u16) {
    if let Ok(out) = Command::new("lsof")
        .arg("-t")
        .arg("-i")
        .arg(format!("tcp:{}", port))
        .output()
    {
        let stdout = String::from_utf8_lossy(&out.stdout);
        for pid_str in stdout.split_whitespace() {
            if let Ok(pid) = pid_str.parse::<u32>() {
                debug_log(&format!("kill -9 {}", pid));
                let _ = Command::new("kill")
                    .arg("-9")
                    .arg(pid.to_string())
                    .status();
            }
        }
    }
}

#[cfg(windows)]
fn kill_process_on_port(port: u16) {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    // netstat -ano 最后一列为 PID，筛选出 LISTENING 该端口的行
    let mut cmd = Command::new("cmd");
    cmd.arg("/C")
        .arg(format!("netstat -ano -p TCP | findstr :{}", port))
        .creation_flags(CREATE_NO_WINDOW);
    let mut pids: Vec<u32> = Vec::new();
    if let Ok(out) = cmd.output() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        pids = stdout
            .lines()
            .filter(|line| line.contains("LISTENING"))
            .filter_map(|line| line.split_whitespace().last())
            .filter_map(|s| s.parse::<u32>().ok())
            .collect();
    }
    pids.sort();
    pids.dedup();
    for pid in pids {
        debug_log(&format!("taskkill /PID {} /F", pid));
        let _ = Command::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/F")
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

// ── 启动失败诊断 ────────────────────────────────────────────

/// 读取启动日志尾部 N 行（采集线程正在追加写入，读快照安全，无需加锁）
fn read_log_tail(n: usize) -> String {
    let path = log_file_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            let lines: Vec<&str> = content.lines().collect();
            let start = lines.len().saturating_sub(n);
            lines[start..].join("\n")
        }
        Err(e) => format!("(无法读取日志: {})", e),
    }
}

/// 查端口占用情况（跨平台）。无占用时返回 "(无占用)"。
fn probe_port_occupancy(port: u16) -> String {
    #[cfg(unix)]
    {
        if let Ok(out) = Command::new("lsof")
            .args(["-i", &format!("tcp:{}", port)])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if s.is_empty() {
                return "(无占用)".to_string();
            }
            return s;
        }
        return "(无法检测)".to_string();
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut cmd = Command::new("cmd");
        cmd.arg("/C")
            .arg(format!("netstat -ano -p TCP | findstr :{}", port))
            .creation_flags(CREATE_NO_WINDOW);
        if let Ok(out) = cmd.output() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if s.is_empty() {
                return "(无占用)".to_string();
            }
            return s;
        }
        return "(无法检测)".to_string();
    }
}

/// 组装启动失败的诊断报告（中文、分段纯文本，前端 pre-wrap 直接展示）。
/// 在 setup 钩子（锁外）调用；内部查询子进程状态会短暂加锁。
fn build_failure_report(app: &AppHandle, port: u16, short_reason: &str) -> String {
    let probe = resolve_and_verify_node();
    let resource_root = get_resource_root(app).unwrap_or_default();
    let entry_path = resource_root.join("dist").join("server").join("main.js");
    let entry_exists = entry_path.exists();

    let child_state = {
        let state = app.state::<Mutex<ServerProcess>>();
        let mut server = state.lock().unwrap();
        match server.process.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => format!("已退出 (code={})", status),
                Ok(None) => format!("仍在运行 (PID {})", child.id()),
                Err(e) => format!("未知 ({})", e),
            },
            None => "未启动".to_string(),
        }
    };

    let port_info = probe_port_occupancy(port);

    let mut s = String::new();
    s.push_str(&format!("启动失败：{}\n\n", short_reason));
    s.push_str("【诊断信息】\n");
    s.push_str(&format!("Node 路径: {}\n", probe.path));
    s.push_str(&format!(
        "Node 版本: {}\n",
        probe.version.as_deref().unwrap_or("未检测到 / 不可运行")
    ));
    s.push_str(&format!(
        "入口文件 dist/server/main.js: {} ({})\n",
        if entry_exists { "存在" } else { "缺失" },
        entry_path.display()
    ));
    s.push_str(&format!("子进程: {}\n", child_state));
    s.push_str(&format!("端口 {} 占用:\n{}\n", port, port_info));
    s.push_str("\n【最近日志（app-launch-debug.log 尾部）】\n");
    s.push_str(&read_log_tail(40));
    s
}

/// 失败路径专用：强制清理已 spawn 的 Node 子进程（不走 HTTP，避免 stop_server 的 8s 白等）。
fn force_kill_child(state: &State<'_, Mutex<ServerProcess>>) {
    let mut child_opt = {
        let mut server = state.lock().unwrap();
        server.process.take()
    };
    if let Some(child) = child_opt.as_mut() {
        let pid = child.id();
        #[cfg(unix)]
        {
            let _ = Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .status();
        }
        let _ = child.kill();
        let _ = child.wait();
        debug_log(&format!("✓ 已强制终止残留子进程 (PID {})", pid));
    } else {
        debug_log("失败清理: 无子进程需要终止");
    }
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
                    // 兜底：拿不到主窗口时，也尽力 emit 一个错误，避免启动页无限转圈。
                    // （若无窗口则该事件无监听者，属 best-effort。）
                    debug_log("✗ 无法获取主窗口");
                    let _ = app_handle.emit(
                        "startup-error",
                        "无法获取主窗口，界面未能初始化，请改用 CLI 版本（见错误面板）。",
                    );
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

                // 检测是否已有服务在运行 → 优雅关闭旧服务后再启动新的，
                // 避免复用旧代码（升级后旧服务挡道，导致新版本不生效）
                if is_server_ready(port).await {
                    debug_log(&format!("检测到已有服务运行 (端口 {}) → 关闭旧服务后重启", port));
                    let _ = app_handle.emit("startup-log", "检测到已有服务，正在关闭旧服务...");
                    shutdown_existing_server(port).await;
                    // 等待端口释放，避免新服务绑定失败
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                }

                // 启动新服务器
                match start_server(&app_handle, &state, port).await {
                    Ok(_) => {
                        debug_log(&format!("服务启动成功 → 导航到 {}", server_url));
                        let _ = app_handle.emit("startup-log", "正在验证数据就绪...");
                        let _ = verify_data_ready(port).await;
                        let _ = app_handle.emit("startup-log", "服务已就绪，正在加载...");
                        match window.navigate(server_url.parse().unwrap()) {
                            Ok(_) => debug_log("✓ 导航成功"),
                            Err(e) => {
                                // 关键兜底：服务已就绪但无法打开管理界面时，必须 emit 错误，
                                // 否则启动页会一直停在“服务已就绪，正在加载…”后冻结。
                                debug_log(&format!("✗ 导航失败: {}", e));
                                let reason = format!("服务已就绪，但无法打开管理界面：{}", e);
                                let report = build_failure_report(&app_handle, port, &reason);
                                debug_log(&format!("✗ 启动失败诊断报告:\n{}", report));
                                force_kill_child(&state);
                                let _ = app_handle.emit("startup-error", &report);
                            }
                        }
                    }
                    Err(e) => {
                        debug_log(&format!("✗ 服务启动失败: {}", e));
                        // 收集诊断报告 + 清理残留子进程，再展示给用户
                        let report = build_failure_report(&app_handle, port, &e);
                        debug_log(&format!("✗ 启动失败诊断报告:\n{}", report));
                        force_kill_child(&state);
                        let _ = app_handle.emit("startup-error", &report);
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
