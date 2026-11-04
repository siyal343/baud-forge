import React, { useEffect } from 'react';
import { CheckCircle2, AlertTriangle, XOctagon, Info, X } from 'lucide-react';
import { useToastStore, Toast, ToastKind } from '../store/useToastStore';

const KIND_STYLE: Record<ToastKind, { border: string; icon: React.FC<{ className?: string }>; text: string }> = {
  success: { border: 'border-[#10B981]/60', icon: CheckCircle2, text: 'text-[#10B981]' },
  warn: { border: 'border-[#FBBF24]/60', icon: AlertTriangle, text: 'text-[#FBBF24]' },
  error: { border: 'border-[#EF4444]/70', icon: XOctagon, text: 'text-[#EF4444]' },
  info: { border: 'border-[#00E5FF]/50', icon: Info, text: 'text-[#00E5FF]' },
};

const DISMISS_MS = 4500;

const ToastRow: React.FC<{ toast: Toast }> = ({ toast }) => {
  const dismissToast = useToastStore((s) => s.dismissToast);
  const style = KIND_STYLE[toast.kind];
  const Icon = style.icon;

  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(toast.id), DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, dismissToast]);

  return (
    <div
      role="status"
      className={`pointer-events-auto flex items-start gap-2 w-[320px] px-2.5 py-2 bg-[#10141D]/95 backdrop-blur-sm border ${style.border} rounded shadow-lg shadow-black/50 font-mono`}
    >
      <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${style.text}`} />
      <div className="flex-1 min-w-0">
        <div className={`text-[10.5px] font-semibold leading-tight ${style.text}`}>{toast.title}</div>
        {toast.detail && (
          <div className="text-[9.5px] text-[#94A3B8] leading-snug mt-0.5 break-words">{toast.detail}</div>
        )}
      </div>
      <button
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss notification"
        className="text-[#64748B] hover:text-[#E2E8F0] transition-colors shrink-0"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
};

export const ToastHost: React.FC = () => {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-9 right-3 z-[300] flex flex-col-reverse gap-1.5 pointer-events-none">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  );
};
