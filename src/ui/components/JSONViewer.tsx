import { useState } from 'react';

interface JSONViewerProps {
  data: string | Record<string, any> | any[];
  title?: string;
  collapsed?: boolean;
}

const JSONViewer: React.FC<JSONViewerProps> = ({ data, title, collapsed = false }) => {
  const [isExpanded, setIsExpanded] = useState(!collapsed);
  const [copySuccess, setCopySuccess] = useState(false);

  // 格式化 JSON 数据
  const formatJSON = (input: string | Record<string, any> | any[]): string => {
    try {
      let jsonData: any;
      if (typeof input === 'string') {
        jsonData = JSON.parse(input);
      } else {
        jsonData = input;
      }
      return JSON.stringify(jsonData, null, 2);
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
