import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from '../store/useSettingsStore';

interface TooltipState {
  visible: boolean;
  text: string;
  shortcut?: string;
  targetRect: DOMRect | null;
}

export const TooltipOverlay: React.FC = () => {
  const tooltipsEnabled = useSettingsStore((s) => s.settings.tooltipsEnabled);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    text: '',
    targetRect: null,
  });

  const tooltipRef = useRef<HTMLDivElement>(null);
  const activeTargetRef = useRef<HTMLElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  useEffect(() => {
    // Disabled in Settings: stand down entirely. Native `title` attributes
    // keep working because the migration below no longer strips them.
    if (!tooltipsEnabled) {
      activeTargetRef.current = null;
      setTooltip((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      return;
    }

    const handleMouseOver = (e: MouseEvent) => {
      const target = (e.target as HTMLElement | null)?.closest?.(
        '[data-tooltip], [title]'
      ) as HTMLElement | null;

      if (!target) return;

      // If already hovering over the same active target, do nothing
      if (activeTargetRef.current === target && tooltip.visible) {
        return;
      }

      activeTargetRef.current = target;
      if (hideTimerRef.current) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }

      // Suppress browser default OS tooltip by migrating title to data-tooltip
      let text = target.getAttribute('data-tooltip');
      const titleAttr = target.getAttribute('title');
      if (!text && titleAttr) {
        text = titleAttr;
        target.setAttribute('data-tooltip', titleAttr);
        target.removeAttribute('title');
      }

      if (!text || !text.trim()) {
        setTooltip((prev) => ({ ...prev, visible: false }));
        return;
      }

      const shortcut = target.getAttribute('data-tooltip-shortcut') || undefined;
      const targetRect = target.getBoundingClientRect();

      setTooltip({
        visible: true,
        text,
        shortcut,
        targetRect,
      });
    };

    const handleMouseOut = (e: MouseEvent) => {
      const currentTarget = activeTargetRef.current;
      if (!currentTarget) return;

      const related = e.relatedTarget as Node | null;
      // Only hide if mouse actually left the target element and its descendants
      if (!related || !currentTarget.contains(related)) {
        if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = window.setTimeout(() => {
          activeTargetRef.current = null;
          setTooltip((prev) => ({ ...prev, visible: false }));
        }, 50);
      }
    };

    document.addEventListener('mouseover', handleMouseOver, true);
    document.addEventListener('mouseout', handleMouseOut, true);

    return () => {
      document.removeEventListener('mouseover', handleMouseOver, true);
      document.removeEventListener('mouseout', handleMouseOut, true);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [tooltipsEnabled, tooltip.visible]);

  // Compute exact position with guaranteed screen clamping
  useLayoutEffect(() => {
    if (!tooltip.visible || !tooltip.targetRect || !tooltipRef.current) return;

    const el = tooltipRef.current;
    const ttWidth = el.offsetWidth;
    const ttHeight = el.offsetHeight;
    const rect = tooltip.targetRect;
    const margin = 8;
    const padding = 6;

    // Center horizontally on target element
    let left = rect.left + rect.width / 2 - ttWidth / 2;

    // Prefer positioning below target; flip above if clipping bottom
    let top = rect.bottom + padding;
    if (top + ttHeight + margin > window.innerHeight) {
      top = rect.top - ttHeight - padding;
    }

    // Clamp horizontally strictly within viewport boundaries [margin, window.innerWidth - ttWidth - margin]
    left = Math.max(margin, Math.min(window.innerWidth - ttWidth - margin, left));

    // Clamp vertically strictly within viewport boundaries [margin, window.innerHeight - ttHeight - margin]
    top = Math.max(margin, Math.min(window.innerHeight - ttHeight - margin, top));

    setCoords({ left, top });
  }, [tooltip.visible, tooltip.targetRect, tooltip.text]);

  if (!tooltip.visible || !tooltip.text) return null;

  return createPortal(
    <div
      ref={tooltipRef}
      style={{
        position: 'fixed',
        left: `${coords.left}px`,
        top: `${coords.top}px`,
        zIndex: 1000000,
      }}
      className="max-w-[420px] bg-bf-surface/95 backdrop-blur-md text-bf-body border border-bf-line-strong rounded px-2.5 py-1.5 font-mono text-[9.5px] leading-tight shadow-[0_12px_28px_rgb(var(--bf-shadow-rgb)/0.9)] pointer-events-none flex items-center gap-2 whitespace-normal break-words"
    >
      <span className="text-bf-body leading-snug">{tooltip.text}</span>
      {tooltip.shortcut && (
        <span className="shrink-0 px-1 py-0.2 rounded bg-bf-cyan/15 text-bf-cyan border border-bf-cyan/30 font-bold text-[8.5px]">
          {tooltip.shortcut}
        </span>
      )}
    </div>,
    document.body
  );
};
