import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import type { RunStatus } from '@purpleflow/core';
import { STATUS_LABEL } from '../lib/format';

type Tone = 'primary' | 'ghost' | 'quiet' | 'danger' | 'approve';

export function Button({
  tone = 'ghost', icon, children, busy, className = '', ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; icon?: ReactNode; busy?: boolean }) {
  return (
    <button {...rest} className={`btn btn-${tone} ${busy ? 'is-busy' : ''} ${className}`} disabled={rest.disabled || busy}>
      {busy ? <span className="spinner" aria-hidden /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Field({ label, hint, children, aside }: { label: string; hint?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-head">
        <span className="field-label">{label}</span>
        {aside}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function Input({ mono, className = '', ...rest }, ref) {
    return <input ref={ref} spellCheck={false} {...rest} className={`input ${mono ? 'mono' : ''} ${className}`} />;
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className = '', ...rest }, ref) {
    return <textarea ref={ref} {...rest} className={`input textarea ${className}`} />;
  },
);

export function StatusPill({ status }: { status: RunStatus }) {
  return (
    <span className={`pill pill-${status}`}>
      <span className="pill-dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Topbar({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>{title}</h1>
        {sub && <div className="topbar-sub">{sub}</div>}
      </div>
      <div className="topbar-actions">{children}</div>
    </header>
  );
}
