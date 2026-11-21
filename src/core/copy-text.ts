/**
 * Copy text to the clipboard. Tries the modern Clipboard API first, then
 * falls back to a hidden text field + execCommand("copy"), which still works
 * in many in-app and mobile browsers where the Clipboard API is blocked.
 * Resolves true when the text was copied.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText && (typeof window === "undefined" || window.isSecureContext !== false)) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.left = "0";
  field.style.opacity = "0";
  field.style.fontSize = "16px"; // stops iOS zooming in
  document.body.appendChild(field);
  const previousFocus = document.activeElement as HTMLElement | null;
  try {
    field.focus();
    field.select();
    field.setSelectionRange(0, text.length); // iOS needs an explicit range
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(field);
    previousFocus?.focus?.();
  }
}
