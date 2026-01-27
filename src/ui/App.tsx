import { useState, useEffect } from 'react';
import { HashRouter as Router, Routes, Route, NavLink, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { api } from './api/client';
import VendorsPage from './pages/VendorsPage';
import RouteGroupsPage from './pages/RoutesPage';
import LogsPage from './pages/LogsPage';
import SettingsPage from './pages/SettingsPage';
import WriteConfigPage from './pages/WriteConfigPage';
import UsagePage from './pages/UsagePage';
import StatisticsPage from './pages/StatisticsPage';
import { ToastContainer } from './components/Toast';
import { ConfirmProvider } from './components/Confirm';
import './styles/App.css';

function AppContent() {
  const navigate = useNavigate();
  const [theme, setTheme] = useState('light');
  const [showVendorModal, setShowVendorModal] = useState(false);
  const [hasCheckedVendors, setHasCheckedVendors] = useState(false);

  // 版本更新相关状态
  const [hasUpdate, setHasUpdate] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  // 鉴权相关状态
  const [authEnabled, setAuthEnabled] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  // Migration 相关状态
  const [showMigrationModal, setShowMigrationModal] = useState(false);
  const [migrationContent, setMigrationContent] = useState('');
  const [hasCheckedMigration, setHasCheckedMigration] = useState(false);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
    document.documentElement.setAttribute('data-theme', savedTheme);
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

  // 检查 migration
  useEffect(() => {
    const checkMigration = async () => {
      if (hasCheckedMigration) return;

      try {
        const migration = await api.getMigration();
        if (migration.shouldShow && migration.content) {
          setMigrationContent(migration.content);
          setShowMigrationModal(true);
        }
        setHasCheckedMigration(true);
      } catch (error) {
        console.error('Failed to check migration:', error);
      }
    };

    checkMigration();
  }, [hasCheckedMigration]);

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

  const handleVendorModalConfirm = () => {
    setShowVendorModal(false);
    navigate('/vendors');
  };

  const handleMigrationModalClose = async () => {
    try {
      await api.acknowledgeMigration();
    } catch (error) {
      console.error('Failed to acknowledge migration:', error);
    }
    setShowMigrationModal(false);
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
      <nav className="sidebar">
        <div className="logo">
          <h2>AI Code Switch</h2>
        </div>
         <ul className="nav-menu">
          <li>
            <NavLink to="/">🌏 路由管理</NavLink>
          </li>
          <li>
            <NavLink to="/vendors">🏭 供应商管理</NavLink>
          </li>
          <li>
            <NavLink to="/statistics">📊 数据统计</NavLink>
          </li>
          <li>
            <NavLink to="/logs">🪵 日志</NavLink>
          </li>
          <li>
            <NavLink to="/settings">⚙️ 设置</NavLink>
          </li>
          <li>
            <NavLink to="/usage">📖 使用说明</NavLink>
          </li>
        </ul>

        {hasUpdate && (
          <div className="update-notification">
            <div className="update-notification-content">
              <span className="update-icon">⬆️</span>
              <div className="update-text">
                <div className="update-title">新版本可用</div>
                <div className="update-versions">
                  {currentVersion} → {latestVersion}
                </div>
                <div className="update-message">
                  命令行执行如下更新到最新版本<br />
                  <code>npm i -g aicodeswitch</code>
                </div>
              </div>
            </div>
            <a
              href="https://npmjs.com/package/aicodeswitch"
              target="_blank"
              rel="noopener noreferrer"
              className="update-link"
            >
              查看详情
            </a>
          </div>
        )}

        <div className="theme-toggle">
          <button
            onClick={toggleTheme}
          >
            {theme === 'dark' ? '🌙' : '☀️'}
          </button>
          {currentVersion && (
            <div className="version-info">
              v{currentVersion}
            </div>
          )}
        </div>
      </nav>
      <main className="main-content">
          <Routes>
            <Route path="/" element={<RouteGroupsPage />} />
            <Route path="/statistics" element={<StatisticsPage />} />
            <Route path="/routes" element={<RouteGroupsPage />} />
            <Route path="/vendors" element={<VendorsPage />} />
            <Route path="/logs" element={<LogsPage />} />
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
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowVendorModal(false)}>稍后</button>
                <button type="button" className="btn btn-primary" onClick={handleVendorModalConfirm}>前往供应商管理</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showMigrationModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: '800px', maxHeight: '80vh', overflow: 'auto' }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>📋 升级提示</h2>
              </div>
              <div className="modal-body">
                <div className="markdown-content">
                  <ReactMarkdown>{migrationContent}</ReactMarkdown>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-primary" onClick={handleMigrationModalClose}>我知道了</button>
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
        <AppContent />
        <ToastContainer />
      </ConfirmProvider>
    </Router>
  );
}

export default App;
