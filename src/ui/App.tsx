import { useState, useEffect, useRef } from 'react';
import { HashRouter as Router, Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { api } from './api/client';
import VendorsPage from './pages/VendorsPage';
import RouteGroupsPage from './pages/RoutesPage';
import LogsPage from './pages/LogsPage';
import SessionsPage from './pages/SessionsPage';
import SettingsPage from './pages/SettingsPage';
import WriteConfigPage from './pages/WriteConfigPage';
import UsagePage from './pages/UsagePage';
import StatisticsPage from './pages/StatisticsPage';
import SkillsPage from './pages/SkillsPage';
import MCPPage from './pages/MCPPage';
import AccessKeysPage from './pages/AccessKeysPage';
import AccessKeyDetailPage from './pages/AccessKeyDetailPage';
import { ToastContainer } from './components/Toast';
import { ConfirmProvider } from './components/Confirm';
import ToolsInstallModal from './components/ToolsInstallModal';
import NotificationBar from './components/NotificationBar';
import NavItemWithTooltip from './components/Tooltip';
import QuickSetupModal from './components/QuickSetupModal';
import type { ToolInstallationStatus } from '../types';
import './styles/App.css';
import logoImage from './assets/logo.png';
import { useUpgradeNotes } from './hooks/docs';
import { RulesStatusProvider } from './hooks/useRulesStatus';
import upgradMd from '../../UPGRADE.md?raw';

function AppContent() {
  const navigate = useNavigate();
  const [theme, setTheme] = useState('light');
  const [showVendorModal, setShowVendorModal] = useState(false);
  const [hasCheckedVendors, setHasCheckedVendors] = useState(false);
  const [showQuickSetupModal, setShowQuickSetupModal] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // 版本更新相关状态
  const [hasUpdate, setHasUpdate] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const upgradeNotes = useUpgradeNotes();

  // 鉴权相关状态
  const [authEnabled, setAuthEnabled] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  // Upgrade 相关状态
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [upgradeContent, setUpgradeContent] = useState('');
  const [hasCheckedUpgrade, setHasCheckedUpgrade] = useState(false);

  // 工具安装检测相关状态
  const [showToolsInstallModal, setShowToolsInstallModal] = useState(false);
  const [showNotification, setShowNotification] = useState(false);
  const [toolsStatus, setToolsStatus] = useState<ToolInstallationStatus | null>(null);
  const [hasCheckedTools, setHasCheckedTools] = useState(false);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
    document.documentElement.setAttribute('data-theme', savedTheme);

    const savedSidebarState = localStorage.getItem('sidebar-collapsed');
    if (savedSidebarState === 'true') {
      setSidebarCollapsed(true);
    }
  }, []);

  // 版本检查 - 每1分钟检查一次
  useEffect(() => {
    const checkVersion = async () => {
      try {
        const versionInfo = await api.checkVersion();
        setHasUpdate(versionInfo.hasUpdate);
        setLatestVersion(versionInfo.latestVersion);
        setCurrentVersion(versionInfo.currentVersion);
      } catch (error) {
        console.error('Failed to check version:', error);
      }
    };

    // 立即检查一次
    checkVersion();

    // 每1分钟检查一次
    const intervalId = setInterval(checkVersion, 60000);

    return () => clearInterval(intervalId);
  }, []);

  // 检查鉴权状态
  useEffect(() => {
    const checkAuth = async () => {
      try {
        // 1. 检查是否启用鉴权
        const authStatus = await api.getAuthStatus();
        setAuthEnabled(authStatus.enabled);

        if (!authStatus.enabled) {
          // 未启用鉴权,直接标记为已认证
          setIsAuthenticated(true);
          setIsCheckingAuth(false);
          return;
        }

        // 2. 如果启用鉴权,检查本地是否有 token
        const token = localStorage.getItem('auth_token');
        if (!token) {
          // 没有 token,不设置为已认证
          setIsCheckingAuth(false);
          return;
        }

        // 3. 有 token,尝试调用 API 验证 token 有效性
        try {
          await api.getVendors(); // 调用任意需要鉴权的 API
          setIsAuthenticated(true);
        } catch (error) {
          // Token 无效,不设置为已认证
        }
      } catch (error) {
        console.error('Failed to check auth status:', error);
      } finally {
        setIsCheckingAuth(false);
      }
    };

    checkAuth();
  }, []);

  // 检查 upgrade
  useEffect(() => {
    const checkUpgrade = async () => {
      if (hasCheckedUpgrade) return;

      try {
        const upgrade = await api.getUpgrade();
        if (upgrade.shouldShow && upgrade.content) {
          setUpgradeContent(upgrade.content);
          setShowUpgradeModal(true);
        }
        setHasCheckedUpgrade(true);
      } catch (error) {
        console.error('Failed to check upgrade:', error);
      }
    };

    checkUpgrade();
  }, [hasCheckedUpgrade]);

  // 检查工具安装状态
  useEffect(() => {
    const checkTools = async () => {
      if (hasCheckedTools) return;

      // 检查工具是否已经完成安装
      const installCompleted = localStorage.getItem('tools_install_completed');
      if (installCompleted === 'true') {
        setHasCheckedTools(true);
        return;
      }

      try {
        const status = await api.getToolsStatus();
        setToolsStatus(status);

        // 如果有任何工具未安装，显示通知
        if (!status.claudeCode.installed || !status.codex.installed) {
          setShowNotification(true);
        } else {
          // 如果工具都已安装，也标记为已完成
          localStorage.setItem('tools_install_completed', 'true');
        }

        setHasCheckedTools(true);
      } catch (error) {
        console.error('Failed to check tools status:', error);
        setHasCheckedTools(true);
      }
    };

    // 等待认证完成后再检查工具
    if (!isCheckingAuth && isAuthenticated) {
      checkTools();
    } else if (!isCheckingAuth && !authEnabled) {
      checkTools();
    }
  }, [hasCheckedTools, isCheckingAuth, isAuthenticated, authEnabled]);

  useEffect(() => {
    const checkVendors = async () => {
      try {
        const vendors = await api.getVendors();
        if (vendors.length === 0 && !hasCheckedVendors) {
          setShowVendorModal(true);
          setHasCheckedVendors(true);
        }
      } catch (error) {
        console.error('Failed to check vendors:', error);
      }
    };

    checkVendors();
  }, [hasCheckedVendors]);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
  };

  const toggleSidebar = () => {
    setSidebarCollapsed(!sidebarCollapsed);
    localStorage.setItem('sidebar-collapsed', (!sidebarCollapsed).toString());
  };

  // 侧边栏菜单滚动状态检测：当菜单项溢出时可滚动时，显示阴影 + 滚轮提示
  const navMenuRef = useRef<HTMLUListElement>(null);
  const [navScrollState, setNavScrollState] = useState({ scrollable: false, atTop: true, atBottom: true });

  useEffect(() => {
    const el = navMenuRef.current;
    if (!el) return;
    const update = () => {
      const scrollable = el.scrollHeight - el.clientHeight > 2;
      setNavScrollState({
        scrollable,
        atTop: el.scrollTop <= 1,
        atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
      });
    };
    update();
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  }, [authEnabled, sidebarCollapsed]);

  // 折叠态菜单 overflow 为 visible（不滚动），此时不显示滚动提示
  const showNavScrollHint = !sidebarCollapsed && navScrollState.scrollable;

  const handleVendorModalConfirm = () => {
    setShowVendorModal(false);
    navigate('/vendors');
  };

  const handleUpgradeModalClose = async () => {
    try {
      await api.acknowledgeUpgrade();
    } catch (error) {
      console.error('Failed to acknowledge upgrade:', error);
    }
    setShowUpgradeModal(false);
  };

  const handleNotificationClose = () => {
    setShowNotification(false);
  };

  const handleNotificationClick = () => {
    setShowNotification(false);
    setShowToolsInstallModal(true);
  };

  const handleToolsInstallModalClose = () => {
    setShowToolsInstallModal(false);
    // 注意：安装完成后是否显示通知由 handleToolsInstallComplete 处理
    // 这里不再重新显示通知，避免重复
  };

  const handleToolsInstallComplete = async () => {
    // 重新检测工具状态
    try {
      const newStatus = await api.getToolsStatus();
      setToolsStatus(newStatus);

      // 如果所有工具都安装了，标记为已完成
      if (newStatus.claudeCode.installed && newStatus.codex.installed) {
        localStorage.setItem('tools_install_completed', 'true');
        setShowNotification(false);
      }

      // 无论是否所有工具都安装完成，都关闭模态框
      setTimeout(() => {
        setShowToolsInstallModal(false);
        // 如果还有未安装的工具，显示通知栏
        if (!newStatus.claudeCode.installed || !newStatus.codex.installed) {
          setShowNotification(true);
        }
      }, 500); // 0.5秒后关闭模态框（在ToolsInstallModal的1.5秒自动关闭之前）
    } catch (error) {
      console.error('Failed to refresh tools status:', error);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');

    if (!authCode.trim()) {
      setLoginError('请输入鉴权码');
      return;
    }

    try {
      const response = await api.login(authCode);
      localStorage.setItem('auth_token', response.token);
      setIsAuthenticated(true);
      setAuthCode('');
    } catch (error) {
      if (error instanceof Error) {
        setLoginError(error.message || '登录失败,请检查鉴权码');
      } else {
        setLoginError('登录失败,请检查鉴权码');
      }
    }
  };

  // 如果正在检查鉴权状态,显示加载中
  if (isCheckingAuth) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        fontSize: '18px',
        color: 'var(--text-secondary)'
      }}>
        加载中...
      </div>
    );
  }

  // 如果启用鉴权且未认证,只显示登录弹层
  if (authEnabled && !isAuthenticated) {
    return (
      <div className="modal-overlay">
        <button
          type="button"
          className="modal-close-btn"
          onClick={() => {}}
          aria-label="关闭"
          disabled
          style={{ opacity: 0.3, cursor: 'not-allowed' }}
        >
          ×
        </button>
        <div className="modal" style={{ maxWidth: '400px' }}>
          <div className="modal-container">
            <div className="modal-header">
              <h2>🔐 系统鉴权</h2>
            </div>
          <form onSubmit={handleLogin}>
            <div style={{ padding: '20px 0' }}>
              <p style={{ marginBottom: '16px', lineHeight: '1.6', color: 'var(--text-secondary)' }}>
                系统已启用鉴权保护,请输入鉴权码以继续访问。
              </p>
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>
                  鉴权码
                </label>
                <input
                  type="password"
                  value={authCode}
                  onChange={(e) => setAuthCode(e.target.value)}
                  placeholder="请输入鉴权码"
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    fontSize: '14px',
                    boxSizing: 'border-box'
                  }}
                  autoFocus
                />
              </div>
              {loginError && (
                <div style={{
                  padding: '10px 12px',
                  backgroundColor: '#fee',
                  border: '1px solid #fcc',
                  borderRadius: '6px',
                  color: '#c33',
                  fontSize: '14px',
                  marginBottom: '16px'
                }}>
                  {loginError}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                登录
              </button>
            </div>
          </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="logo">
          <img src={logoImage} alt="AI Code Switch Logo" className="logo-image" />
          <h2>AI Code Switch</h2>
        </div>
        <div className="nav-menu-wrap">
        <ul className="nav-menu" ref={navMenuRef}>
          <li>
            <NavItemWithTooltip text="路由管理" showTooltip={sidebarCollapsed}>
              <NavLink to="/"><span className="nav-icon">🌏</span><span className="nav-text">路由管理</span></NavLink>
            </NavItemWithTooltip>
          </li>
          <li>
            <NavItemWithTooltip text="供应商管理" showTooltip={sidebarCollapsed}>
              <NavLink to="/vendors"><span className="nav-icon">🏭</span><span className="nav-text">供应商管理</span></NavLink>
            </NavItemWithTooltip>
          </li>
          <li>
            <NavItemWithTooltip text="Skills 管理" showTooltip={sidebarCollapsed}>
              <NavLink to="/skills"><span className="nav-icon">🧩</span><span className="nav-text">Skills 管理</span></NavLink>
            </NavItemWithTooltip>
          </li>
          <li>
            <NavItemWithTooltip text="MCP 管理" showTooltip={sidebarCollapsed}>
              <NavLink to="/mcp"><span className="nav-icon">🧰</span><span className="nav-text">MCP 管理</span></NavLink>
            </NavItemWithTooltip>
          </li>
          {authEnabled && (
            <>
              <li className="nav-divider"><hr style={{ border: 'none', borderTop: '1px solid var(--border-primary)', margin: '4px 8px' }} /></li>
              <li>
                <NavItemWithTooltip text="API Key" showTooltip={sidebarCollapsed}>
                  <NavLink to="/access-keys"><span className="nav-icon">🔑</span><span className="nav-text">API Key</span></NavLink>
                </NavItemWithTooltip>
              </li>
            </>
          )}
          <li className="nav-divider"><hr style={{ border: 'none', borderTop: '1px solid var(--border-primary)', margin: '4px 8px' }} /></li>
          <li>
            <NavItemWithTooltip text="数据统计" showTooltip={sidebarCollapsed}>
              <NavLink to="/statistics"><span className="nav-icon">📊</span><span className="nav-text">数据统计</span></NavLink>
            </NavItemWithTooltip>
          </li>
          {!authEnabled && (
            <>
              <li>
                <NavItemWithTooltip text="会话" showTooltip={sidebarCollapsed}>
                  <NavLink to="/sessions"><span className="nav-icon">💬</span><span className="nav-text">会话</span></NavLink>
                </NavItemWithTooltip>
              </li>
              <li>
                <NavItemWithTooltip text="日志" showTooltip={sidebarCollapsed}>
                  <NavLink to="/logs"><span className="nav-icon">🪵</span><span className="nav-text">日志</span></NavLink>
                </NavItemWithTooltip>
              </li>
            </>
          )}
          <li>
            <NavItemWithTooltip text="设置" showTooltip={sidebarCollapsed}>
              <NavLink to="/settings"><span className="nav-icon">⚙️</span><span className="nav-text">设置</span></NavLink>
            </NavItemWithTooltip>
          </li>
          <li>
            <NavItemWithTooltip text="使用说明" showTooltip={sidebarCollapsed}>
              <NavLink to="/usage"><span className="nav-icon">📖</span><span className="nav-text">使用说明</span></NavLink>
            </NavItemWithTooltip>
          </li>
        </ul>
        {showNavScrollHint && (
          <>
            <div className={`nav-scroll-shadow nav-scroll-shadow--top${navScrollState.atTop ? ' is-hidden' : ''}`} aria-hidden="true" />
            <div className={`nav-scroll-shadow nav-scroll-shadow--bottom${navScrollState.atBottom ? ' is-hidden' : ''}`} aria-hidden="true">
              <span className="nav-scroll-wheel">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="6" y="3" width="12" height="18" rx="6" />
                  <line x1="12" y1="7" x2="12" y2="11" />
                </svg>
              </span>
            </div>
          </>
        )}
        </div>

        <div className="theme-toggle">
          <button
            onClick={toggleTheme}
            className="theme-mode-btn"
          >
            {theme === 'dark' ? '🌙' : '☀️'}
          </button>
          <a
            href="https://github.com/tangshuang/aicodeswitch"
            target="_blank"
            rel="noopener noreferrer"
            className="github-link"
            title="GitHub"
          >
            <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
          </a>
          {currentVersion && (
            <div
              className={`version-info-wrapper ${hasUpdate ? 'has-update' : ''}`}
              onClick={() => setShowVersionModal(true)}
              style={{ cursor: 'pointer' }}
            >
              <div className="version-info">
                v{currentVersion}
                {hasUpdate && <span className="version-badge"></span>}
              </div>
            </div>
          )}
          <button
            onClick={toggleSidebar}
            className="sidebar-toggle-btn"
            title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          >
            {sidebarCollapsed ? '»' : '«'}
          </button>
        </div>
      </nav>
      <main className="main-content">
          <Routes>
            <Route path="/" element={<RouteGroupsPage />} />
            <Route path="/statistics" element={<StatisticsPage />} />
            <Route path="/routes" element={<RouteGroupsPage />} />
            <Route path="/vendors" element={<VendorsPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/mcp" element={<MCPPage />} />
            <Route path="/access-keys" element={authEnabled ? <AccessKeysPage /> : <Navigate to="/" />} />
            <Route path="/access-keys/:id" element={authEnabled ? <AccessKeyDetailPage /> : <Navigate to="/" />} />
            <Route path="/sessions" element={!authEnabled ? <SessionsPage /> : <Navigate to="/" />} />
            <Route path="/logs" element={!authEnabled ? <LogsPage /> : <Navigate to="/" />} />
            <Route path="/write-config" element={<WriteConfigPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/usage" element={<UsagePage />} />
          </Routes>
      </main>

      {showVendorModal && (
        <div className="modal-overlay">
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setShowVendorModal(false)}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal">
            <div className="modal-container">
              <div className="modal-header">
                <h2>⚠️ 需要配置供应商</h2>
              </div>
              <div style={{ padding: '20px 0' }}>
                <p style={{ marginBottom: '16px', lineHeight: '1.6' }}>
                  检测到系统中没有配置任何API供应商。在没有供应商的情况下，路由将无法正常工作。
                </p>
                <p style={{ marginBottom: '0', lineHeight: '1.6', fontWeight: '500' }}>
                  请先添加至少一个供应商，然后再配置路由规则。
                </p>
              </div>
              <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
                <button type="button" className="btn" style={{ background: 'linear-gradient(135deg, #8B5CF6, #7C3AED)', color: 'white', position: 'relative', overflow: 'hidden' }} onClick={() => { setShowVendorModal(false); setShowQuickSetupModal(true); }}>一键配置</button>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowVendorModal(false)}>稍后</button>
                  <button type="button" className="btn btn-secondary" onClick={handleVendorModalConfirm}>前往供应商管理</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <QuickSetupModal
        show={showQuickSetupModal}
        onClose={() => setShowQuickSetupModal(false)}
        onComplete={() => setHasCheckedVendors(true)}
      />

      {showUpgradeModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: '800px', maxHeight: '80vh', overflow: 'auto' }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>📋 升级提示</h2>
              </div>
              <div className="modal-body">
                <div className="markdown-content">
                  <ReactMarkdown>{upgradeContent}</ReactMarkdown>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-primary" onClick={handleUpgradeModalClose}>我知道了</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showNotification && toolsStatus && (
        <NotificationBar
          toolName={!toolsStatus.claudeCode.installed && !toolsStatus.codex.installed
            ? 'both'
            : !toolsStatus.claudeCode.installed
            ? 'claude-code'
            : 'codex'}
          onInstallClick={handleNotificationClick}
          onClose={handleNotificationClose}
        />
      )}

      {showToolsInstallModal && toolsStatus && (
        <ToolsInstallModal
          status={toolsStatus}
          onClose={handleToolsInstallModalClose}
          onInstallComplete={handleToolsInstallComplete}
        />
      )}

      {showVersionModal && (
        <div className="modal-overlay">
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setShowVersionModal(false)}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal" style={{ maxWidth: '700px', maxHeight: '80vh', overflow: 'auto' }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>📦 版本信息</h2>
              </div>
              <div style={{ padding: '20px 0' }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '16px',
                  backgroundColor: 'var(--bg-secondary)',
                  borderRadius: '8px',
                  marginBottom: '20px'
                }}>
                  <div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                      当前版本
                    </div>
                    <div style={{ fontSize: '18px', fontWeight: '600' }}>
                      v{currentVersion}
                    </div>
                  </div>
                  {hasUpdate ? (
                    <>
                      <div style={{ fontSize: '24px', color: 'var(--text-secondary)' }}>→</div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                          最新版本
                        </div>
                        <div style={{ fontSize: '18px', fontWeight: '600' }}>
                          v{latestVersion}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div style={{
                      padding: '6px 12px',
                      backgroundColor: '#d4edda',
                      color: '#155724',
                      borderRadius: '4px',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}>
                      已是最新版本
                    </div>
                  )}
                </div>
                {hasUpdate && (
                  <div style={{
                    padding: '16px',
                    backgroundColor: 'var(--bg-info-blue)',
                    border: '1px solid var(--border-info-blue)',
                    borderRadius: '8px',
                    marginBottom: '20px'
                  }}>
                    <div style={{ fontSize: '14px', marginBottom: '8px', fontWeight: '500', color: 'var(--text-primary)' }}>
                      更新命令：
                    </div>
                    <code style={{
                      display: 'block',
                      padding: '8px 12px',
                      backgroundColor: 'var(--bg-secondary)',
                      border: '1px solid var(--border-primary)',
                      borderRadius: '4px',
                      fontSize: '13px',
                      color: 'var(--accent-danger)'
                    }}>
                      npm i -g aicodeswitch@latest
                    </code>
                  </div>
                )}
                {hasUpdate ? (upgradeNotes ? (
                  <div className="markdown-content" style={{ maxHeight: '400px', overflow: 'auto' }}>
                    <ReactMarkdown>{upgradeNotes}</ReactMarkdown>
                  </div>
                ) : null) : (upgradMd ? (
                  <div className="markdown-content">
                    <h4 style={{ marginBottom: 12 }}>当前版本提示：</h4>
                    <ReactMarkdown>{upgradMd}</ReactMarkdown>
                  </div>
                ) : null)}
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-primary" onClick={() => setShowVersionModal(false)}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <Router>
      <ConfirmProvider>
        <RulesStatusProvider>
          <AppContent />
          <ToastContainer />
        </RulesStatusProvider>
      </ConfirmProvider>
    </Router>
  );
}

export default App;
