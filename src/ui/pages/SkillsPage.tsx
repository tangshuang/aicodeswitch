import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { InstalledSkill, SkillCatalogItem, TargetType } from '../../types';
import { toast } from '../components/Toast';
import { SkillSwitch } from '../components/Switch';
import { Modal } from '../components/Modal';


type InstallState = {
  skill: SkillCatalogItem | null;
  isInstalling: boolean;
  targetType: TargetType | null;
  status: 'idle' | 'preparing' | 'downloading' | 'extracting' | 'verifying' | 'completed' | 'error';
  message: string;
  progress: number;
  selectedTargets: TargetType[];
};

interface DeleteConfirmState {
  skillId: string | null;
  skillName: string;
  isDeleting: boolean;
}

interface CreateSkillFormData {
  name: string;
  description: string;
  instruction: string;
  link: string;
  targets: TargetType[];
}

function SkillsPage() {
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    skillId: null,
    skillName: '',
    isDeleting: false,
  });
  const [createSkillModalOpen, setCreateSkillModalOpen] = useState(false);
  const [createSkillForm, setCreateSkillForm] = useState<CreateSkillFormData>({
    name: '',
    description: '',
    instruction: '',
    link: '',
    targets: [],
  });
  const [createSkillLoading, setCreateSkillLoading] = useState(false);
  const [parseSkillModalOpen, setParseSkillModalOpen] = useState(false);
  const [parseSkillContent, setParseSkillContent] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SkillCatalogItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [installState, setInstallState] = useState<InstallState>({
    skill: null,
    isInstalling: false,
    targetType: null,
    status: 'idle',
    message: '',
    progress: 0,
    selectedTargets: [],
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
      // 按评分数倒序排序
      const sortedResults = results.sort((a, b) => {
        const starsA = a.stars ?? 0;
        const starsB = b.stars ?? 0;
        return starsB - starsA;
      });
      setSearchResults(sortedResults);
    } catch (error) {
      console.error('Failed to search skills:', error);
      toast.error('搜索失败，请稍后重试');
    } finally {
      setSearching(false);
    }
  };

  const openInstallDialog = (skill: SkillCatalogItem) => {
    setInstallState({ skill, isInstalling: false, targetType: null, status: 'idle', message: '', progress: 0, selectedTargets: [] });
  };

  const closeInstallDialog = () => {
    if (installState.isInstalling) {
      return;
    }
    setInstallState({ skill: null, isInstalling: false, targetType: null, status: 'idle', message: '', progress: 0, selectedTargets: [] });
  };

  const handleTargetCheckboxChange = (targetType: TargetType, checked: boolean) => {
    setInstallState((prev) => ({
      ...prev,
      selectedTargets: checked
        ? [...prev.selectedTargets, targetType]
        : prev.selectedTargets.filter((t) => t !== targetType),
    }));
  };

  const handleInstall = async () => {
    if (!installState.skill) {
      return;
    }

    try {
      setInstallState((prev) => ({
        ...prev,
        isInstalling: true,
        status: 'preparing',
        message: '正在准备安装...',
        progress: 0,
      }));

      setInstallState((prev) => ({
        ...prev,
        status: 'downloading',
        message: '正在从GitHub下载...',
      }));

      const response = await api.installSkill(installState.skill, installState.selectedTargets[0]);

      if (response.success) {
        const targets = installState.selectedTargets;
        const installedSkillId = response.installedSkill?.id;

        if (!installedSkillId) {
          setInstallState((prev) => ({
            ...prev,
            status: 'error',
            message: '安装返回数据异常',
          }));
          toast.error('安装返回数据异常');
          return;
        }

        let enabledCount = 0;

        for (const target of targets) {
          const result = await api.enableSkill(installedSkillId, target);
          if (result.success) {
            enabledCount++;
          }
        }

        setInstallState((prev) => ({
          ...prev,
          status: 'completed',
          message: targets.length > 0
            ? `安装完成！已启用 ${enabledCount}/${targets.length} 个目标`
            : '安装完成！可在列表中启用目标',
          progress: 100,
        }));
        if (targets.length > 0) {
          toast.success(`已安装到 ${targets.map(t => t === 'claude-code' ? 'Claude Code' : 'Codex').join(', ')}`);
        } else {
          toast.success('安装完成！可在列表中启用目标');
        }
        await loadInstalledSkills();
      } else {
        setInstallState((prev) => ({
          ...prev,
          status: 'error',
          message: response.message ? `${response.message}。如多次失败，可尝试在设置中配置代理` : '安装失败，请稍后重试',
        }));
        toast.error(response.message ? `${response.message}。如多次失败，可尝试在设置中配置代理` : '安装失败，请稍后重试');
      }
    } catch (error) {
      console.error('Failed to install skill:', error);
      setInstallState((prev) => ({
        ...prev,
        status: 'error',
        message: '安装失败，请稍后重试。如多次失败，可尝试在设置中配置代理',
      }));
      toast.error('安装失败，请稍后重试。如多次失败，可尝试在设置中配置代理');
    } finally {
      setTimeout(() => {
        setInstallState((prev) => ({
          ...prev,
          skill: null,
          isInstalling: false,
          targetType: null,
          status: 'idle',
          message: '',
          progress: 0,
          selectedTargets: [],
        }));
      }, 2000);
    }
  };

  const handleSkillSwitchChange = async (skillId: string, targetType: TargetType, enabled: boolean) => {
    try {
      if (enabled) {
        await api.enableSkill(skillId, targetType);
        toast.success(`已启用 ${targetType === 'claude-code' ? 'Claude Code' : 'Codex'}`);
      } else {
        await api.disableSkill(skillId, targetType);
        toast.success(`已禁用 ${targetType === 'claude-code' ? 'Claude Code' : 'Codex'}`);
      }
      await loadInstalledSkills();
    } catch (error) {
      console.error('Failed to toggle skill:', error);
      toast.error('操作失败，请稍后重试');
    }
  };

  const openDeleteConfirm = (skill: InstalledSkill) => {
    setDeleteConfirm({ skillId: skill.id, skillName: skill.name, isDeleting: false });
  };

  const closeDeleteConfirm = () => {
    if (!deleteConfirm.isDeleting) {
      setDeleteConfirm({ skillId: null, skillName: '', isDeleting: false });
    }
  };

  const handleDeleteSkill = async () => {
    if (!deleteConfirm.skillId) {
      return;
    }

    try {
      setDeleteConfirm((prev) => ({ ...prev, isDeleting: true }));
      await api.deleteSkill(deleteConfirm.skillId);
      toast.success('已删除 Skill');
      await loadInstalledSkills();
      closeDeleteConfirm();
    } catch (error) {
      console.error('Failed to delete skill:', error);
      toast.error('删除失败，请稍后重试');
      setDeleteConfirm((prev) => ({ ...prev, isDeleting: false }));
    }
  };

  const handleParseSkill = () => {
    try {
      const content = parseSkillContent.trim();

      if (!content) {
        toast.error('请粘贴 SKILL.md 内容');
        return;
      }

      let name = '';
      let description = '';
      let instruction = content;

      if (content.startsWith('---')) {
        const frontmatterEnd = content.indexOf('---', 3);
        if (frontmatterEnd !== -1) {
          const frontmatter = content.slice(3, frontmatterEnd);
          const titleMatch = content.match(/^#\s+(.+)$/m);
          name = titleMatch ? titleMatch[1].trim() : '';

          const yamlLines = frontmatter.split('\n');
          for (const line of yamlLines) {
            if (line.startsWith('name:')) {
              name = line.replace('name:', '').trim();
            } else if (line.startsWith('description:')) {
              description = line.replace('description:', '').trim();
            }
          }

          instruction = content.slice(frontmatterEnd + 3).trim();
          instruction = instruction.replace(/^##\s+指令\n*/, '').trim();
        }
      } else {
        const titleMatch = content.match(/^#\s+(.+)$/m);
        if (titleMatch) {
          name = titleMatch[1].trim();
        }
      }

      if (!name) {
        toast.error('无法解析 Skill 名称');
        return;
      }

      setCreateSkillForm((prev) => ({
        ...prev,
        name,
        description: description || prev.description,
        instruction: instruction || prev.instruction,
      }));

      setParseSkillModalOpen(false);
      setParseSkillContent('');
      toast.success('解析成功');
    } catch (error) {
      console.error('Failed to parse skill:', error);
      toast.error('解析失败，请检查格式');
    }
  };

  const handleCreateSkill = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!createSkillForm.name.trim()) {
      toast.error('请填写 Skill 名称');
      return;
    }
    if (!createSkillForm.description.trim()) {
      toast.error('请填写描述');
      return;
    }
    if (!createSkillForm.instruction.trim()) {
      toast.error('请填写指令');
      return;
    }

    try {
      setCreateSkillLoading(true);
      const response = await api.createLocalSkill({
        name: createSkillForm.name.trim(),
        description: createSkillForm.description.trim(),
        instruction: createSkillForm.instruction.trim(),
        link: createSkillForm.link.trim() || undefined,
        targets: createSkillForm.targets,
      });

      if (response.success) {
        toast.success('Skill 创建成功');
        setCreateSkillModalOpen(false);
        setCreateSkillForm({
          name: '',
          description: '',
          instruction: '',
          link: '',
          targets: [],
        });
        await loadInstalledSkills();

        for (const target of createSkillForm.targets) {
          if (response.installedSkill?.id) {
            await api.enableSkill(response.installedSkill.id, target);
          }
        }
      } else {
        toast.error(response.message || '创建失败');
      }
    } catch (error) {
      console.error('Failed to create skill:', error);
      toast.error('创建失败，请稍后重试');
    } finally {
      setCreateSkillLoading(false);
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
          <div className="card skill-card" key={skill.id} style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
              <div className="skill-title" style={{ flex: 1 }}>{skill.name}</div>
              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                {skill.githubUrl && (
                  <a
                    href={skill.githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-secondary"
                    style={{ padding: '6px 12px', fontSize: '12px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                  >
                    查看详情
                  </a>
                )}
                <button
                  className="btn btn-danger"
                  onClick={() => openDeleteConfirm(skill)}
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                >
                  删除
                </button>
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div className="skill-description">
                {skill.description || '暂无描述'}
              </div>
              <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
                安装时间: {new Date(skill.installedAt).toLocaleDateString('zh-CN')}
              </div>
            </div>
            <div style={{ marginTop: 'auto', paddingTop: '16px', borderTop: '1px solid var(--border-color)', display: 'flex', gap: '24px' }}>
              <SkillSwitch
                skillId={skill.id}
                targetType="claude-code"
                enabled={skill.enabledTargets.includes('claude-code')}
                onChange={handleSkillSwitchChange}
              />
              <SkillSwitch
                skillId={skill.id}
                targetType="codex"
                enabled={skill.enabledTargets.includes('codex')}
                onChange={handleSkillSwitchChange}
              />
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                    <div className="skill-title" style={{ flex: 1 }}>{skill.name}</div>
                    {skill.stars !== undefined && skill.stars > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#f39c12', fontSize: '14px', flexShrink: 0 }}>
                        <span>⭐</span>
                        <span style={{ fontWeight: '600' }}>{skill.stars}</span>
                      </div>
                    )}
                  </div>
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
          {!isDiscovering && (
            <button
              className="btn btn-secondary skills-discover-btn"
              onClick={() => setCreateSkillModalOpen(true)}
              style={{ marginRight: '8px' }}
            >
              新增
            </button>
          )}
          <button
            className="btn btn-secondary skills-discover-btn"
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
            disabled={installState.isInstalling}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal" style={{ maxWidth: '520px' }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>{installState.status === 'idle' ? '选择安装目标' : installState.status === 'completed' ? '安装完成' : installState.status === 'error' ? '安装失败' : '正在安装'}</h2>
              </div>
              <div className="modal-body" style={{ padding: '0 20px 10px' }}>
                {installState.status === 'idle' ? (
                  <>
                    <p style={{ marginBottom: '12px', color: 'var(--text-muted)' }}>
                      即将安装：<strong>{installState.skill.name}</strong>
                    </p>
                    {installState.skill.description && (
                      <p style={{ marginBottom: '12px', color: 'var(--text-muted)', fontSize: '14px' }}>
                        {installState.skill.description}
                      </p>
                    )}
                    <div style={{ marginTop: '20px' }}>
                      <p style={{ fontSize: '14px', color: 'var(--text-muted)', marginBottom: '12px' }}>
                        选择安装目标（可多选）：
                      </p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={installState.selectedTargets.includes('claude-code')}
                            onChange={(e) => handleTargetCheckboxChange('claude-code', e.target.checked)}
                            style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                          />
                          <span style={{ fontSize: '14px' }}>Claude Code</span>
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={installState.selectedTargets.includes('codex')}
                            onChange={(e) => handleTargetCheckboxChange('codex', e.target.checked)}
                            style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                          />
                          <span style={{ fontSize: '14px' }}>Codex</span>
                        </label>
                      </div>
                    </div>
                  </>
                ) : (
                  <div style={{ padding: '20px 0' }}>
                    <div style={{
                      height: '8px',
                      backgroundColor: 'var(--bg-secondary)',
                      borderRadius: '4px',
                      overflow: 'hidden',
                      marginBottom: '16px'
                    }}>
                      <div style={{
                        width: `${installState.progress}%`,
                        height: '100%',
                        backgroundColor: installState.status === 'error' ? 'var(--error-color)' : 'var(--primary-color)',
                        transition: 'width 0.3s ease'
                      }} />
                    </div>
                    <p style={{ textAlign: 'center', color: 'var(--text-muted)', marginBottom: '8px' }}>
                      {installState.message}
                    </p>
                    {installState.status === 'error' && (
                      <p style={{ textAlign: 'center', color: 'var(--error)', fontSize: '14px' }}>
                        {installState.message}
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div className="modal-footer" style={{ justifyContent: installState.status !== 'idle' ? 'center' : 'space-between' }}>
                {installState.status === 'idle' ? (
                  <>
                    <button className="btn btn-secondary" onClick={closeInstallDialog} disabled={installState.isInstalling}>
                      取消
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={handleInstall}
                      disabled={installState.isInstalling}
                    >
                      确定安装
                    </button>
                  </>
                ) : installState.status === 'completed' || installState.status === 'error' ? (
                  <button
                    className="btn btn-primary"
                    onClick={closeInstallDialog}
                  >
                    关闭
                  </button>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div className="spinner" style={{ width: '16px', height: '16px', border: '2px solid var(--bg-secondary)', borderTopColor: 'var(--primary-color)', borderRadius: '50%' }} />
                    <span style={{ color: 'var(--text-muted)' }}>正在处理...</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm.skillId && (
        <div className="modal-overlay" style={{ zIndex: 10001 }}>
          <button
            type="button"
            className="modal-close-btn"
            onClick={closeDeleteConfirm}
            disabled={deleteConfirm.isDeleting}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal" style={{ maxWidth: '400px' }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>确认删除</h2>
              </div>
              <div className="modal-body" style={{ padding: '0 20px 10px' }}>
                <p style={{ color: 'var(--text-muted)' }}>
                  确定要删除 Skill <strong>{deleteConfirm.skillName}</strong> 吗？
                </p>
                <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '8px' }}>
                  这将删除该Skill及其所有平台的软链接，且无法恢复。
                </p>
              </div>
              <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
                <button
                  className="btn btn-secondary"
                  onClick={closeDeleteConfirm}
                  disabled={deleteConfirm.isDeleting}
                >
                  取消
                </button>
                <button
                  className="btn btn-danger"
                  onClick={handleDeleteSkill}
                  disabled={deleteConfirm.isDeleting}
                >
                  {deleteConfirm.isDeleting ? '删除中...' : '确认删除'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {createSkillModalOpen && (
        <Modal
          isOpen={createSkillModalOpen}
          onClose={() => setCreateSkillModalOpen(false)}
          title="新增 Skill"
          closeOnOverlayClick={false}
        >
          <form onSubmit={handleCreateSkill}>
            <div style={{ padding: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <small style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                  从其他来源复制的 SKILL.md 内容可直接粘贴解析
                </small>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setParseSkillModalOpen(true)}
                  style={{ padding: '6px 16px', fontSize: '13px' }}
                >
                  解析
                </button>
              </div>

              <div className="form-group">
                <label>名称 <span style={{ color: '#e74c3c' }}>*</span></label>
                <input
                  type="text"
                  value={createSkillForm.name}
                  onChange={(e) => setCreateSkillForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="输入 Skill 名称"
                  required
                />
              </div>

              <div className="form-group">
                <label>描述 <span style={{ color: '#e74c3c' }}>*</span></label>
                <input
                  type="text"
                  value={createSkillForm.description}
                  onChange={(e) => setCreateSkillForm(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="简要描述这个 Skill 的功能"
                  required
                />
              </div>

              <div className="form-group">
                <label>指令 <span style={{ color: '#e74c3c' }}>*</span></label>
                <small style={{ display: 'block', marginBottom: '8px', color: '#666', fontSize: '12px', lineHeight: '1.5' }}>
                  当这个 Skill 被触发时，你希望模型遵循哪些规则或信息
                </small>
                <textarea
                  value={createSkillForm.instruction}
                  onChange={(e) => setCreateSkillForm(prev => ({ ...prev, instruction: e.target.value }))}
                  placeholder={`当这个 Skill 被触发时，你希望模型遵循哪些规则或信息，例如：
# codemap
## 命令
## 使用场景
## 输出解释
## 示例`}
                  rows={10}
                  style={{ fontFamily: 'monospace', fontSize: '13px' }}
                  required
                />
              </div>

              <div className="form-group">
                <label>链接（可选）</label>
                <input
                  type="url"
                  value={createSkillForm.link}
                  onChange={(e) => setCreateSkillForm(prev => ({ ...prev, link: e.target.value }))}
                  placeholder="https://example.com 或 GitHub 仓库地址"
                />
                <small style={{ display: 'block', marginTop: '4px', color: '#666', fontSize: '12px' }}>
                  Skill 相关文档或资源链接
                </small>
              </div>

              <div className="form-group">
                <label>安装目标 <span style={{ color: '#e74c3c' }}>*</span></label>
                <div style={{ display: 'flex', gap: '20px', marginTop: '8px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    <input
                      type="checkbox"
                      checked={createSkillForm.targets.includes('claude-code')}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setCreateSkillForm(prev => ({ ...prev, targets: [...prev.targets, 'claude-code'] }));
                        } else {
                          setCreateSkillForm(prev => ({ ...prev, targets: prev.targets.filter(t => t !== 'claude-code') }));
                        }
                      }}
                    />
                    Claude Code
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={createSkillForm.targets.includes('codex')}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setCreateSkillForm(prev => ({ ...prev, targets: [...prev.targets, 'codex'] }));
                        } else {
                          setCreateSkillForm(prev => ({ ...prev, targets: prev.targets.filter(t => t !== 'codex') }));
                        }
                      }}
                    />
                    Codex
                  </label>
                </div>
              </div>

              <div style={{ marginTop: '16px', padding: '12px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                <small style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.6' }}>
                  💡 提示：Skill 创建后，可通过 <code style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: '4px' }}>~/.aicodeswitch/skills/{createSkillForm.name || 'skill-name'}</code> 路径对 Skill 内容进行二次编辑
                </small>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setCreateSkillModalOpen(false)}
                disabled={createSkillLoading}
              >
                取消
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={createSkillLoading}
              >
                {createSkillLoading ? '创建中...' : '确认创建'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {parseSkillModalOpen && (
        <Modal
          isOpen={parseSkillModalOpen}
          onClose={() => {
            setParseSkillModalOpen(false);
            setParseSkillContent('');
          }}
          title="解析 SKILL.md"
          closeOnOverlayClick={false}
        >
          <div style={{ padding: '20px' }}>
            <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '12px' }}>
              直接粘贴从其他地方复制的 SKILL.md 内容，系统将自动解析填充到表单中。
            </p>
            <textarea
              value={parseSkillContent}
              onChange={(e) => setParseSkillContent(e.target.value)}
              placeholder={`---
name: skill-name
description: Skill 描述
---

# Skill 名称

Skill 描述

## 指令

技能指令内容...`}
              rows={15}
              style={{
                width: '100%',
                fontFamily: 'monospace',
                fontSize: '13px',
                padding: '12px',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                background: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                resize: 'vertical',
              }}
            />
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setParseSkillModalOpen(false);
                setParseSkillContent('');
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleParseSkill}
            >
              解析并填充
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default SkillsPage;
