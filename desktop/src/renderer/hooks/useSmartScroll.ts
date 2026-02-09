import { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react';

/**
 * Smart auto-scroll hook: auto-scrolls to bottom when the user is already
 * near the bottom, but stops auto-scrolling when the user scrolls up to
 * read earlier content. Re-engages when the user scrolls back to the bottom
 * (or clicks "scroll to bottom").
 *
 * Uses requestAnimationFrame to debounce scroll checks and avoid layout
 * thrashing from reading scrollHeight on every scroll event.
 */
export function useSmartScroll<T>(dep: T) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const rafCheckRef = useRef(0);

  // Flag to distinguish programmatic scrolls (auto-scroll / scrollToBottom)
  // from user-initiated scrolls. Without this, auto-scroll can race with
  // the scroll-position check and falsely disengage.
  const programmaticScrollRef = useRef(false);

  // Threshold in pixels: if the user is within this distance of the bottom,
  // we consider them "at the bottom" and keep auto-scrolling.
  const THRESHOLD = 60;

  // Debounced scroll-position check via rAF to avoid layout thrashing.
  // Multiple scroll events in the same frame collapse into one DOM read.
  const onScroll = useCallback(() => {
    if (rafCheckRef.current) return; // already scheduled
    rafCheckRef.current = requestAnimationFrame(() => {
      rafCheckRef.current = 0;

      // If this scroll event was triggered by our own auto-scroll,
      // skip the check — we know we're pinned to the bottom.
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        return;
      }

      const el = scrollRef.current;
      if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD;
      isAtBottomRef.current = atBottom;
      setShowScrollButton(!atBottom);
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (rafCheckRef.current) cancelAnimationFrame(rafCheckRef.current);
    };
  }, [onScroll]);

  // Auto-scroll when dependency changes, but only if user is at bottom.
  // useLayoutEffect fires synchronously after React commits DOM mutations,
  // so scrollHeight reflects the newly rendered content.
  useLayoutEffect(() => {
    if (!isAtBottomRef.current) return;
    const el = scrollRef.current;
    if (el) {
      programmaticScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
    }
  }, [dep]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    isAtBottomRef.current = true;
    setShowScrollButton(false);
  }, []);

  return { scrollRef, showScrollButton, scrollToBottom };
}
