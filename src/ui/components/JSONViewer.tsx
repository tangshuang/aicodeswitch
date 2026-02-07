import { useState } from 'react';

interface JSONViewerProps {
  data: string | Record<string, any> | any[];
  title?: string;
  collapsed?: boolean;
}

// 敏感字段列表（不区分大小写）
// 注意：这里使用精确匹配或特定前缀/后缀匹配，避免误伤 max_tokens 等字段
const SENSITIVE_KEYS = [
  'authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'auth-token',
  // 移除 'token' 因为它太宽泛，会匹配到 max_tokens、input_tokens、output_tokens 等字段
  // 'token',
  'secret',
  'password',
  'api_secret',
  // 只匹配以下特定的 token 相关字段（鉴权类）
  'jwt',
  'csrf_token',
  'xsrf_token',
  'auth_token',
  'session_token',
  'private_key',
  'client_secret',
];

/**
 * 检查键名是否为敏感字段
 * 使用精确匹配或特定的前缀/后缀匹配规则
 */
const isSensitiveKey = (key: string): boolean => {
  const lowerKey = key.toLowerCase();
  // 精确匹配
  if (SENSITIVE_KEYS.some(sensitive => lowerKey === sensitive)) {
    return true;
  }
  // 特定前缀匹配（如 api_key, api_secret 等）
  if (lowerKey.startsWith('api_') && (lowerKey.endsWith('_key') || lowerKey.endsWith('_secret'))) {
    return true;
  }
  // 特定后缀匹配（鉴权相关的字段）
  if (lowerKey.endsWith('_token') || lowerKey.endsWith('_key') || lowerKey.endsWith('_secret')) {
    // 排除 max_tokens、input_tokens、output_tokens 等技术字段
    const exclusionPatterns = ['max_tokens', 'input_tokens', 'output_tokens', 'completion_tokens', 'prompt_tokens', 'cachereadinputtokens', 'totaltokens'];
    if (!exclusionPatterns.some(pattern => lowerKey.replace(/_/g, '').includes(pattern.replace(/_/g, '')))) {
      return true;
    }
  }
  return false;
};

/**
 * 脱敏处理敏感数据
 */
const maskSensitiveValue = (value: string): string => {
  if (!value || value.length <= 8) {
    return '***';
  }
  // 保留前4个字符和后4个字符，中间用星号代替
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(value.length - 8, 20))}${value.slice(-4)}`;
};

/**
 * 递归清理对象中的敏感数据
 */
const sanitizeData = (data: any): any => {
  if (data === null || data === undefined) {
    return data;
  }

  // 处理数组
  if (Array.isArray(data)) {
    return data.map(item => sanitizeData(item));
  }

  // 处理对象
  if (typeof data === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(data)) {
      if (isSensitiveKey(key)) {
        // 对敏感字段进行脱敏
        sanitized[key] = typeof value === 'string' ? maskSensitiveValue(value) : '***';
      } else if (typeof value === 'object') {
        // 递归处理嵌套对象
        sanitized[key] = sanitizeData(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  return data;
};

const JSONViewer: React.FC<JSONViewerProps> = ({ data, title, collapsed = false }) => {
  const [isExpanded, setIsExpanded] = useState(!collapsed);
  const [copySuccess, setCopySuccess] = useState(false);

  // 格式化 JSON 数据（带脱敏处理）
  const formatJSON = (input: string | Record<string, any> | any[]): string => {
    try {
      let jsonData: any;
      if (typeof input === 'string') {
        jsonData = JSON.parse(input);
      } else {
        jsonData = input;
      }
      // 对敏感数据进行脱敏处理
      const sanitizedData = sanitizeData(jsonData);
      return JSON.stringify(sanitizedData, null, 2);
    } catch (error) {
      return typeof input === 'string' ? input : String(input);
    }
  };

  // 复制到剪贴板
  const handleCopy = () => {
    const formatted = formatJSON(data);
    navigator.clipboard.writeText(formatted)
      .then(() => {
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      })
      .catch((error) => {
        console.error('Failed to copy JSON:', error);
      });
  };

  const formattedJSON = formatJSON(data);

  return (
    <div className="json-viewer">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        {title && (
          <h4 style={{ margin: 0, fontSize: '14px', color: 'var(--text-primary)' }}>
            {title}
          </h4>
        )}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="btn btn-sm btn-secondary"
            style={{ fontSize: '12px', padding: '2px 8px' }}
          >
            {isExpanded ? '折叠' : '展开'}
          </button>
          <button
            onClick={handleCopy}
            className="btn btn-sm btn-primary"
            style={{ fontSize: '12px', padding: '2px 8px' }}
          >
            {copySuccess ? '已复制' : '复制'}
          </button>
        </div>
      </div>
      {isExpanded && (
        <pre style={{
          background: 'var(--bg-code)',
          border: '1px solid var(--border-primary)',
          borderRadius: '8px',
          padding: '12px',
          overflowX: 'auto',
          fontSize: '12px',
          lineHeight: '1.4',
          color: 'var(--text-primary)',
          maxHeight: '400px',
          overflowY: 'auto',
          margin: 0
        }}>
          <code>{formattedJSON}</code>
        </pre>
      )}
    </div>
  );
};

export default JSONViewer;
