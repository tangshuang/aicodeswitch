import { useState } from 'react';
import type { RequestLog, ErrorLog } from '../../types';
import dayjs from 'dayjs';
import JSONViewer from './JSONViewer';
import { TARGET_TYPE } from '../constants';
import { toast } from './Toast';
import {
  parseSSEChunks,
  assembleStreamText,
  assembleResponseBody,
  formatRequestLogAsMarkdown,
  formatErrorLogAsMarkdown,
} from '../utils/log-utils';
import type { ParsedSSEEvent } from '../utils/log-utils';

const DEFAULT_Z_INDEX = 1000000;

interface LogDetailModalProps {
  log: RequestLog | ErrorLog;
  onClose: () => void;
  zIndex?: number;
}

/**
 * 判断是否为 ErrorLog（ErrorLog 有 errorMessage 字段，RequestLog 用 error 字段）
 */
function isErrorLog(log: RequestLog | ErrorLog): log is ErrorLog {
  return 'errorMessage' in log;
}

/**
 * 拼装文本展示组件（从 downstreamResponseBody 解析）
 */
function AssembledTextViewFromDownstream({ events }: { events: ParsedSSEEvent[] }) {
  const { text, thinking } = assembleStreamText(events);
  console.log('AssembledTextViewFromDownstream', { text, thinking });

  if (!text && !thinking) {
    return <div style={{ color: '#7f8c8d', fontStyle: 'italic' }}>无法解析出文本内容</div>;
  }

  return (
    <div className="assembled-text-view">
      {thinking && (
        <details
          style={{
            marginBottom: '15px',
            border: '1px solid var(--border-thinking-box)',
            borderRadius: '8px',
            padding: '10px',
            backgroundColor: 'var(--bg-thinking-box)'
          }}
          open
        >
          <summary
            style={{
              cursor: 'pointer',
              fontWeight: 'bold',
              color: 'var(--text-thinking-title)',
              userSelect: 'none'
            }}
          >
            思考内容 ({thinking.length} 字符)
          </summary>
          <pre
            style={{
              marginTop: '10px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'monospace',
              fontSize: '13px',
              color: 'var(--text-thinking-content)',
              backgroundColor: 'var(--bg-thinking-content)',
              padding: '10px',
              borderRadius: '4px',
              border: '1px solid var(--border-thinking-content)'
            }}
          >
            {thinking}
          </pre>
        </details>
      )}
      {text && (
        <div>
          <div style={{ fontWeight: 'bold', marginBottom: '8px', color: 'var(--text-reply-title)' }}>
            回复内容 ({text.length} 字符)
          </div>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'monospace',
              fontSize: '13px',
              color: 'var(--text-reply-content)',
              backgroundColor: 'var(--bg-reply-content)',
              padding: '10px',
              borderRadius: '4px',
              border: '1px solid var(--border-reply-content)'
            }}
          >
            {text}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * 请求日志详情
 */
function RequestLogDetail({ log }: { log: RequestLog }) {
  const [chunksExpanded, setChunksExpanded] = useState(false);
  const [assembledTextExpanded, setAssembledTextExpanded] = useState(true);

  return (
    <>
      <div className="form-group">
        <label>日志ID</label>
        <input type="text" value={log.id} readOnly />
      </div>
      <div className="form-group">
        <label>时间</label>
        <input type="text" value={dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss')} readOnly />
      </div>
      {log.targetType && (
        <div className="form-group">
          <label>客户端类型</label>
          <input type="text" value={TARGET_TYPE[log.targetType] || '-'} readOnly />
        </div>
      )}
      {log.tags && log.tags.length > 0 && (
        <div className="form-group">
          <label>标签</label>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
            {log.tags.map((tag, index) => (
              <span
                key={index}
                style={{
                  padding: '4px 12px',
                  backgroundColor: '#3498db',
                  color: 'white',
                  borderRadius: '12px',
                  fontSize: '13px',
                  fontWeight: '500'
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}
      {log.requestModel && (
        <div className="form-group">
          <label>请求模型</label>
          <input type="text" value={log.requestModel} readOnly />
        </div>
      )}
      {log.vendorName && (
        <div className="form-group">
          <label>供应商</label>
          <input type="text" value={log.vendorName} readOnly />
        </div>
      )}
      {log.targetServiceName && (
        <div className="form-group">
          <label>供应商API服务</label>
          <input type="text" value={log.targetServiceName} readOnly />
        </div>
      )}
      {log.targetModel && (
        <div className="form-group">
          <label>供应商模型</label>
          <input type="text" value={log.targetModel} readOnly />
        </div>
      )}
      <div className="form-group">
        <label>请求方法</label>
        <input type="text" value={log.method} readOnly />
      </div>
      <div className="form-group">
        <label>请求路径</label>
        <input type="text" value={log.path} readOnly />
      </div>
      {log.headers && (
        <div className="form-group">
          <label>请求头</label>
          <JSONViewer data={log.headers} collapsed />
        </div>
      )}
      {log.body && (
        <div className="form-group">
          <label>请求体</label>
          <JSONViewer data={log.body} collapsed />
        </div>
      )}
      {log.upstreamRequest && (
        <div className="form-group">
          <label>实际转发的请求信息</label>
          <JSONViewer data={log.upstreamRequest} />
        </div>
      )}
      <div className="form-group">
        <label>状态码</label>
        <input type="text" value={log.statusCode || 'Error'} readOnly />
      </div>
      <div className="form-group">
        <label>响应时间</label>
        <input type="text" value={log.responseTime ? `${log.responseTime}ms` : '-'} readOnly />
      </div>
      {log.responseHeaders && (
        <div className="form-group">
          <label>响应头</label>
          <JSONViewer data={log.responseHeaders} collapsed />
        </div>
      )}
      {(() => {
        const assembledBody = assembleResponseBody(log);
        console.log('[RequestLogDetail] assembledBody:', assembledBody);
        if (!assembledBody) {
          return (
            <div className="form-group">
              <label>响应体</label>
              <div style={{ padding: '10px', color: '#7f8c8d', fontStyle: 'italic' }}>
                无响应体数据
                {log.streamChunks === undefined && log.responseBody === undefined && (
                  <div style={{ marginTop: '5px', fontSize: '12px', color: '#e74c3c' }}>
                    ⚠️ 该日志不包含响应数据（可能是旧版本记录）
                  </div>
                )}
              </div>
            </div>
          );
        }
        return (
          <div className="form-group">
            <label>响应体</label>
            <JSONViewer data={assembledBody} />
          </div>
        );
      })()}
      {log.usage && (
        <div className="form-group">
          <label>Token 使用</label>
          <textarea
            rows={4}
            value={
              `输入: ${log.usage.inputTokens}\n` +
              `输出: ${log.usage.outputTokens}\n` +
              (log.usage.totalTokens !== undefined ? `总计: ${log.usage.totalTokens}\n` : '') +
              (log.usage.cacheReadInputTokens !== undefined ? `缓存读取: ${log.usage.cacheReadInputTokens}` : '')
            }
            readOnly
          />
        </div>
      )}
      {log.error && (
        <div className="form-group">
          <label>错误信息</label>
          <textarea rows={4} value={log.error} readOnly style={{ color: 'red' }} />
        </div>
      )}
      {log.downstreamResponseBody && (
        <div className="form-group">
          <label>实际转发的响应体</label>
          <JSONViewer data={log.downstreamResponseBody} collapsed />
        </div>
      )}
      {(() => {
        // 从 downstreamResponseBody 解析流式事件
        const downstreamBody = log.downstreamResponseBody;
        if (!downstreamBody) {
          return null;
        }

        // 判断是否为流式响应（字符串类型且包含 SSE 格式标记）
        const isStreaming = typeof downstreamBody === 'string' &&
          (downstreamBody.includes('event:') || downstreamBody.includes('data:'));

        if (!isStreaming) {
          return null;
        }

        // 解析 SSE 事件
        const events = parseSSEChunks(downstreamBody);

        return (
          <div className="form-group">
            <label>
              Stream Events ({events.length}个)
              <button
                onClick={() => setChunksExpanded(!chunksExpanded)}
                style={{ marginLeft: '10px', padding: '2px 8px', fontSize: '12px' }}
                className='btn btn-sm btn-secondary'
              >
                {chunksExpanded ? '折叠' : '展开'}
              </button>
              <button
                onClick={() => setAssembledTextExpanded(!assembledTextExpanded)}
                style={{ marginLeft: '5px', padding: '2px 8px', fontSize: '12px' }}
                className='btn btn-sm btn-primary'
              >
                {assembledTextExpanded ? '隐藏拼装结果' : '查看拼装结果'}
              </button>
            </label>
            {chunksExpanded && (
              <div style={{ maxHeight: '400px', overflowY: 'auto', border: '1px solid #ddd', padding: '10px', borderRadius: '4px' }}>
                {events.map((event, index) => (
                  <div key={index} style={{ marginBottom: '10px' }}>
                    <div style={{ fontWeight: 'bold', fontSize: '12px', color: '#7f8c8d', marginBottom: '4px' }}>
                      Event #{index + 1} {event.event && `[${event.event}]`}
                    </div>
                    <JSONViewer data={event.data || event.raw} collapsed={true} />
                  </div>
                ))}
              </div>
            )}
            {assembledTextExpanded && (
              <div style={{
                marginTop: '10px',
                maxHeight: '400px',
                overflowY: 'auto',
                border: '1px solid var(--border-secondary)',
                padding: '10px',
                borderRadius: '4px',
                backgroundColor: 'var(--bg-assembled-text)'
              }}>
                <AssembledTextViewFromDownstream events={events} />
              </div>
            )}
          </div>
        );
      })()}
    </>
  );
}

/**
 * 错误日志详情
 */
function ErrorLogDetail({ log }: { log: ErrorLog }) {
  return (
    <>
      <div className="form-group">
        <label>ID</label>
        <input type="text" value={log.id} readOnly />
      </div>
      <div className="form-group">
        <label>时间</label>
        <input type="text" value={dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss')} readOnly />
      </div>
      {log.targetType && (
        <div className="form-group">
          <label>客户端类型</label>
          <input type="text" value={TARGET_TYPE[log.targetType] || '-'} readOnly />
        </div>
      )}
      {log.tags && log.tags.length > 0 && (
        <div className="form-group">
          <label>标签</label>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
            {log.tags.map((tag, index) => (
              <span
                key={index}
                style={{
                  padding: '4px 12px',
                  backgroundColor: '#3498db',
                  color: 'white',
                  borderRadius: '12px',
                  fontSize: '13px',
                  fontWeight: '500'
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}
      {log.requestModel && (
        <div className="form-group">
          <label>请求模型</label>
          <input type="text" value={log.requestModel} readOnly />
        </div>
      )}
      {log.vendorName && (
        <div className="form-group">
          <label>供应商</label>
          <input type="text" value={log.vendorName} readOnly />
        </div>
      )}
      {log.targetServiceName && (
        <div className="form-group">
          <label>供应商API服务</label>
          <input type="text" value={log.targetServiceName} readOnly />
        </div>
      )}
      {log.targetModel && (
        <div className="form-group">
          <label>供应商模型</label>
          <input type="text" value={log.targetModel} readOnly />
        </div>
      )}
      <div className="form-group">
        <label>请求方法</label>
        <input type="text" value={log.method} readOnly />
      </div>
      <div className="form-group">
        <label>请求路径</label>
        <input type="text" value={log.path} readOnly />
      </div>
      <div className="form-group">
        <label>状态码</label>
        <input type="text" value={log.statusCode || '-'} readOnly />
      </div>
      <div className="form-group">
        <label>响应时间</label>
        <input type="text" value={log.responseTime ? `${log.responseTime}ms` : '-'} readOnly />
      </div>
      <div className="form-group">
        <label>错误信息</label>
        <textarea rows={4} value={log.errorMessage} readOnly style={{ color: '#e74c3c' }} />
      </div>
      {log.errorStack && (
        <div className="form-group">
          <label>错误堆栈</label>
          <textarea rows={8} value={log.errorStack} readOnly style={{ fontSize: '12px', color: '#7f8c8d' }} />
        </div>
      )}
      {log.requestHeaders && (
        <div className="form-group">
          <label>请求头</label>
          <JSONViewer data={log.requestHeaders} collapsed />
        </div>
      )}
      {log.requestBody && (
        <div className="form-group">
          <label>请求体</label>
          <JSONViewer data={log.requestBody} collapsed />
        </div>
      )}
      {log.upstreamRequest && (
        <div className="form-group">
          <label>实际转发的请求信息</label>
          <JSONViewer data={log.upstreamRequest} />
        </div>
      )}
      {log.responseHeaders && (
        <div className="form-group">
          <label>响应头</label>
          <JSONViewer data={log.responseHeaders} collapsed />
        </div>
      )}
      {log.responseBody && (
        <div className="form-group">
          <label>响应体</label>
          <JSONViewer data={log.responseBody} />
        </div>
      )}
    </>
  );
}

/**
 * 日志详情公共弹窗组件
 * 支持 RequestLog 和 ErrorLog 两种类型
 */
export default function LogDetailModal({ log, onClose, zIndex }: LogDetailModalProps) {
  const z = zIndex ?? DEFAULT_Z_INDEX;
  const isErr = isErrorLog(log);

  const handleCopy = () => {
    const markdown = isErr
      ? formatErrorLogAsMarkdown(log)
      : formatRequestLogAsMarkdown(log);
    navigator.clipboard.writeText(markdown).then(() => {
      toast.success('复制成功');
    }).catch(() => {
      toast.error('复制失败');
    });
  };

  return (
    <div className="modal-overlay" style={{ zIndex: z }}>
      <button
        type="button"
        className="modal-close-btn"
        onClick={onClose}
        aria-label="关闭"
        style={{ zIndex: z + 1 }}
      >
        ×
      </button>
      <div className="modal modal--sticky-layout" style={{ width: '800px', zIndex: z }}>
        <div className="modal-header">
          <h2>{isErr ? '错误日志详情' : '请求详情'}</h2>
        </div>
        <div className="modal-body-scrollable">
          {isErr
            ? <ErrorLogDetail log={log} />
            : <RequestLogDetail log={log} />
          }
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={handleCopy}>
            复制
          </button>
          <button className="btn btn-secondary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
