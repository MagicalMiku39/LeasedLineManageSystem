import { useEffect } from 'react';

// Closes a popover when the pointer goes down outside `ref` or Escape is pressed.
export function useDismiss(ref, open, onDismiss) {
  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (ref.current && !ref.current.contains(event.target)) onDismiss();
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') onDismiss();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [ref, open, onDismiss]);
}
