import { useEffect } from "react";

/** How long a short confirmation stays on screen before it fades. */
export const NOTICE_FADE_MS = 4_000;

const TXID_PATTERN = /\b[0-9a-f]{64}\b/i;
const LINK_PATTERN = /https?:\/\/|#\/|\binvite (link|route):/i;
const INSTRUCTION_PATTERN = /\b(select|confirm|review|approve|check the|check its|before continuing|save and share|copy (it|the address) manually)\b/i;

/**
 * Short confirmations ("Address copied.") fade on their own. Anything the
 * person may still need (a transaction ID, a link, a step to follow, or a
 * message saying we are waiting on their wallet) stays until they close it
 * or start the next action.
 */
export function noticeAutoClears(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (TXID_PATTERN.test(value)) return false;
  if (LINK_PATTERN.test(value)) return false;
  if (INSTRUCTION_PATTERN.test(value)) return false;
  if (/(…|\.\.\.)$/.test(value)) return false;
  return true;
}

/** Fade a notice after NOTICE_FADE_MS only when it is a short confirmation. */
export function useNoticeFade(notice: string, clear: () => void): void {
  useEffect(() => {
    if (!notice || !noticeAutoClears(notice)) return;
    const timer = window.setTimeout(clear, NOTICE_FADE_MS);
    return () => window.clearTimeout(timer);
    // Re-arm only when the text changes; `clear` only resets state.
  }, [notice]);
}
