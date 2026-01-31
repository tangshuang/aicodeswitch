import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { InstalledSkill, SkillCatalogItem, TargetType } from '../../types';
import { toast } from '../components/Toast';


type InstallState = {
  skill: SkillCatalogItem | null;
  isInstalling: boolean;
  targetType: TargetType | null;
};

function SkillsPage() {
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);

  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SkillCatalogItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [installState, setInstallState] = useState<InstallState>({
    skill: null,
    isInstalling: false,
    targetType: null,
  });

  const loadInstalledSkills = async () => {
    try {
      setLoadingInstalled(true);
      const skills = await api.getInstalledSkills();
      setInstalledSkills(skills);
    } catch (error) {
      console.error('Failed to load installed skills:', error);
      toast.error('加载已安装 Skills 失败');
    } finally {
      setLoadingInstalled(false);
    }
  };

  useEffect(() => {
    loadInstalledSkills();
  }, []);

  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query) {
      toast.warning('请输入需求描述后再搜索');
      return;
    }

    try {
      setSearching(true);
      setHasSearched(true);
      const results = await api.searchSkills(query);
      console.debug('Reuslts:', results)
      setSearchResults(results);
    } catch (error) {
      console.error('Failed to search skills:', error);
      toast.error('搜索失败，请稍后重试');
    } finally {
      setSearching(false);
    }
  };

  const openInstallDialog = (skill: SkillCatalogItem) => {
    setInstallState({ skill, isInstalling: false, targetType: null });
  };

  const closeInstallDialog = () => {
    if (installState.isInstalling) {
      return;
    }
    setInstallState({ skill: null, isInstalling: false, targetType: null });
  };

  const handleInstall = async (targetType: TargetType) => {
    if (!installState.skill) {
      return;
    }

    try {
      setInstallState((prev) => ({ ...prev, isInstalling: true, targetType }));
      const response = await api.installSkill(installState.skill, targetType);
      if (response.success) {
        toast.success(`已安装到 ${targetType === 'claude-code' ? 'Claude Code' : 'Codex'}`);
        await loadInstalledSkills();
      } else {
        toast.error(response.message || '安装失败');
      }
    } catch (error) {
      console.error('Failed to install skill:', error);
      toast.error('安装失败，请稍后重试');
    } finally {
      setInstallState({ skill: null, isInstalling: false, targetType: null });
    }
  };

  const renderInstalled = () => {
    if (loadingInstalled) {
      return (
        <div className="empty-state">
          <p>正在加载已安装 Skills...</p>
        </div>
      );
    }

    if (installedSkills.length === 0) {
      return (
        <div className="empty-state">
          <p>当前没有检测到全局 Skills</p>
          <span>你可以在“发现”中搜索并安装新的 Skills。</span>
        </div>
      );
    }

    return (
      <div className="skills-grid">
        {installedSkills.map((skill) => (
          <div className="card skill-card" key={skill.id}>
            <div>
              <div className="skill-title">{skill.name}</div>
              <div className="skill-description">
                {skill.description || '暂无描述'}
              </div>
            </div>
            <div className="skill-tags">
              {skill.targets.includes('claude-code') && (
                <span className="badge badge-claude-code">Claude Code</span>
              )}
              {skill.targets.includes('codex') && (
                <span className="badge badge-codex">Codex</span>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderDiscover = () => (
    <div className="skills-discover">
      <div className="card skills-search-card">
        <div className="skills-search-header">
          <h3>描述你的需求，我会帮你找到你需要的 Skills</h3>
          <p>例如：帮我写 TypeScript 类型定义、自动生成测试用例、优化 React 性能</p>
        </div>
        <textarea
          rows={4}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="请输入你的需求..."
          className="skills-search-input"
        />
        <div className="skills-search-actions">
          <button
            className="btn btn-primary"
            onClick={handleSearch}
            disabled={searching}
          >
            {searching ? '搜索中...' : '搜索'}
          </button>
        </div>
      </div>

      <div className="skills-results">
        {searching && (
          <div className="empty-state">
            <p>正在进行 AI 搜索...</p>
          </div>
        )}

        {!searching && hasSearched && searchResults.length === 0 && (
          <div className="empty-state">
            <p>没有找到匹配的 Skills</p>
            <span>试试换个描述或添加更多细节。</span>
          </div>
        )}

        {!searching && searchResults.length > 0 && (
          <div className="skills-grid">
            {searchResults.map((skill) => {
              return (
                <div className="card skill-card" key={skill.id}>
                  <div className="skill-title">{skill.name}</div>
                  {skill.tags && skill.tags.length > 0 && (
                    <div className="skill-tags">
                      {skill.tags.map((tag) => (
                        <span className="badge badge-secondary" key={tag}>{tag}</span>
                      ))}
                    </div>
                  )}
                  <div className="skill-description">
                    {skill.description || '暂无描述'}
                  </div>
                  <div className="skills-result-actions">
                    {skill.url ? (
                      <a
                        className="btn btn-secondary"
                        href={skill.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ marginLeft: '8px' }}
                      >
                        查看
                      </a>
                    ) : null}
                    <button className="btn btn-secondary" onClick={() => openInstallDialog(skill)}>
                      安装
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div>
      <div className="skills-header-row">
        <div className="page-header">
          <h1>Skills 管理</h1>
          <p>管理 Claude Code 与 Codex 的全局技能，并发现新的生产力增强 Skills。</p>
        </div>
        <div className="skills-header-actions">
          <button
            className="btn btn-primary skills-discover-btn"
            onClick={() => setIsDiscovering((prev) => !prev)}
          >
            {isDiscovering ? '返回' : '发现'}
          </button>
        </div>
      </div>

      {isDiscovering ? renderDiscover() : renderInstalled()}

      {installState.skill && (
        <div className="modal-overlay" style={{ zIndex: 10000 }}>
          <button
            type="button"
            className="modal-close-btn"
            onClick={closeInstallDialog}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal" style={{ maxWidth: '520px' }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>选择安装目标</h2>
              </div>
              <div className="modal-body" style={{ padding: '0 20px 10px' }}>
                <p style={{ marginBottom: '12px', color: 'var(--text-muted)' }}>
                  即将安装：<strong>{installState.skill.name}</strong>
                </p>
              </div>
              <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
                <button className="btn btn-secondary" onClick={closeInstallDialog} disabled={installState.isInstalling}>
                  取消
                </button>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    className="btn btn-primary"
                    onClick={() => handleInstall('claude-code')}
                    disabled={installState.isInstalling}
                  >
                    安装到 Claude Code
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => handleInstall('codex')}
                    disabled={installState.isInstalling}
                  >
                    安装到 Codex
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SkillsPage;
