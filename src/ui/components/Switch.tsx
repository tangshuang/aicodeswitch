import type { TargetType } from '../../types';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  labelPosition?: 'left' | 'right';
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  labelPosition = 'right',
}: SwitchProps) {
  const content = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`switch ${checked ? 'active' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
    >
      <span
        className="switch-thumb"
        style={{
          position: 'absolute',
          top: '2px',
          left: checked ? '22px' : '2px',
          width: '20px',
          height: '20px',
          borderRadius: '10px',
          backgroundColor: '#fff',
          transition: 'left 0.2s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }}
      />
    </button>
  );

  if (!label) {
    return content;
  }

  if (labelPosition === 'left') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: disabled ? 'not-allowed' : 'pointer' }}>
        <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>{label}</span>
        {content}
      </label>
    );
  }

  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: disabled ? 'not-allowed' : 'pointer' }}>
      {content}
      <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>{label}</span>
    </label>
  );
}

interface SkillSwitchProps {
  skillId: string;
  targetType: TargetType;
  enabled: boolean;
  onChange: (skillId: string, targetType: TargetType, enabled: boolean) => void;
  disabled?: boolean;
}

export function SkillSwitch({ skillId, targetType, enabled, onChange, disabled }: SkillSwitchProps) {
  const label = targetType === 'claude-code' ? 'Claude Code' : 'Codex';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <Switch
        checked={enabled}
        onChange={(checked) => onChange(skillId, targetType, checked)}
        disabled={disabled}
        label={label}
        labelPosition="right"
      />
    </div>
  );
}
