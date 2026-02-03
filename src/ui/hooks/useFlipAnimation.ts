import { useRef, useCallback } from 'react';

interface Position {
  top: number;
  left: number;
  height: number;
  width: number;
}

/**
 * FLIP动画Hook，用于实现元素位置平滑变化的动画
 */
export function useFlipAnimation() {
  const positionsRef = useRef<Map<string, Position>>(new Map());
  const isAnimatingRef = useRef(false);

  /**
   * 记录元素位置（First阶段）
   */
  const recordPositions = useCallback((elementId: string, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const parentRect = element.parentElement?.getBoundingClientRect();

    if (parentRect) {
      positionsRef.current.set(elementId, {
        top: rect.top - parentRect.top,
        left: rect.left - parentRect.left,
        height: rect.height,
        width: rect.width,
      });
    }
  }, []);

  /**
   * 应用动画（Invert和Play阶段）
   */
  const applyAnimation = useCallback(
    (elementId: string, element: HTMLElement, duration: number = 250) => {
      if (isAnimatingRef.current) {
        return;
      }

      const oldPosition = positionsRef.current.get(elementId);
      if (!oldPosition) {
        return;
      }

      const rect = element.getBoundingClientRect();
      const parentRect = element.parentElement?.getBoundingClientRect();

      if (!parentRect) {
        return;
      }

      const newPosition = {
        top: rect.top - parentRect.top,
        left: rect.left - parentRect.left,
        height: rect.height,
        width: rect.width,
      };

      // 计算位置差异
      const deltaTop = oldPosition.top - newPosition.top;
      const deltaLeft = oldPosition.left - newPosition.left;

      // 如果位置没有变化，不需要动画
      if (Math.abs(deltaTop) < 1 && Math.abs(deltaLeft) < 1) {
        positionsRef.current.delete(elementId);
        return;
      }

      // Invert: 应用反转变换，让元素看起来还在原位置
      element.style.transform = `translate(${deltaLeft}px, ${deltaTop}px)`;
      element.style.transition = 'none';
      element.style.willChange = 'transform';

      isAnimatingRef.current = true;

      // Play: 强制浏览器重排后，应用动画（优化为单个 requestAnimationFrame）
      requestAnimationFrame(() => {
        element.style.transition = `transform ${duration}ms cubic-bezier(0.4, 0, 0.2, 1)`;
        element.style.transform = '';

        // 动画结束后清理
        setTimeout(() => {
          positionsRef.current.delete(elementId);
          isAnimatingRef.current = false;
          element.style.willChange = '';
        }, duration);
      });
    },
    []
  );

  /**
   * 清除所有记录的位置
   */
  const clearPositions = useCallback(() => {
    positionsRef.current.clear();
  }, []);

  return {
    recordPositions,
    applyAnimation,
    clearPositions,
  };
}
