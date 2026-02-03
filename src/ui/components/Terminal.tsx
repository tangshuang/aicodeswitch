import { useEffect, useRef, useState } from 'react';

interface TerminalProps {
  output: string[];
  onInput?: (input: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  waitingForInput?: boolean;
}

export default function Terminal({
  output,
  onInput,
  readOnly = true,
  placeholder = '$ ',
  waitingForInput = false,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState('');

  // 自动滚动到底部
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [output, inputValue]);

  // 当等待输入时，自动聚焦输入框
  useEffect(() => {
    if (waitingForInput && !readOnly && inputRef.current) {
      inputRef.current.focus();
    }
  }, [waitingForInput, readOnly]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && onInput) {
      const input = inputValue;
      if (input.trim()) {
        onInput(input + '\n');
        setInputValue('');
      }
    }
  };

  return (
    <div
      ref={containerRef}
      style={{
        backgroundColor: '#1e1e1e',
        color: '#d4d4d4',
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize: '14px',
        padding: '16px',
        borderRadius: '8px',
        overflow: 'auto',
        maxHeight: '400px',
        minHeight: '200px',
        border: waitingForInput ? '2px solid #4ec9b0' : '1px solid #3e3e3e',
        cursor: 'text',
        transition: 'border-color 0.3s',
      }}
    >
      {output.map((line, index) => (
        <div
          key={index}
          style={{
            marginBottom: '4px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {line}
        </div>
      ))}
      {!readOnly && onInput && (
        <div style={{ display: 'flex', alignItems: 'center', marginTop: '8px' }}>
          <span style={{ marginRight: '8px', color: '#4ec9b0' }}>{placeholder}</span>
          <input
            ref={inputRef}
            type="password"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              color: '#d4d4d4',
              fontFamily: 'Consolas, "Courier New", monospace',
              fontSize: '14px',
              outline: 'none',
              flex: 1,
            }}
            autoFocus
            placeholder={waitingForInput ? '请输入密码...' : ''}
          />
        </div>
      )}
      {waitingForInput && (
        <div style={{ marginTop: '8px', fontSize: '12px', color: '#4ec9b0' }}>
          💡 请输入您的系统密码以继续安装
        </div>
      )}
    </div>
  );
}
