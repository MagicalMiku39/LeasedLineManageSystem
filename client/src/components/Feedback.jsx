import React from 'react';
import { CircleAlert, CircleCheck, RefreshCw, X } from 'lucide-react';

// A page-level result line under the top bar: import results, save failures and the like.
export function NoticeBar({ notice, onClose }) {
  if (!notice) return null;
  const isError = notice.tone === 'error';
  const Icon = isError ? CircleAlert : CircleCheck;
  return (
    <div className={`notice-bar${isError ? ' notice-error' : ''}`} role={isError ? 'alert' : 'status'}>
      <Icon size={16} aria-hidden="true" />
      <span>{notice.text}</span>
      <button type="button" className="notice-close" aria-label="关闭提示" title="关闭提示" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}

// An error inside the block that failed, with a retry when one makes sense.
export function InlineError({ message, onRetry }) {
  if (!message) return null;
  return (
    <div className="inline-error" role="alert">
      <CircleAlert size={16} aria-hidden="true" />
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="text-button" onClick={onRetry}>
          <RefreshCw size={14} /> 重试
        </button>
      )}
    </div>
  );
}
