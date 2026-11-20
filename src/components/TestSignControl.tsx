import { useEffect, useState } from "react";

export const TEST_SIGN_LABEL = "Test sign · no money sent";
export const TEST_SIGN_HELPER =
  "Optional. Selene signs, we check it matches the circle rules, then discard it. Nothing is broadcast.";
export const TEST_SIGN_EXPIRED_LABEL = "Refresh preview first";
export const TEST_SIGN_CHECKED_LABEL = "✓ Signature checked · prepare a fresh preview to send";

type Props = {
  planCreatedAt: number | null;
  disabled: boolean;
  checked: boolean;
  onTest: () => void;
};

/** Presentation only: the no-broadcast verification logic lives in the workspace. */
export function TestSignControl({ planCreatedAt, disabled, checked, onTest }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (planCreatedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [planCreatedAt]);
  const expired = planCreatedAt !== null && now - planCreatedAt > 60_000;
  return (
    <div className="test-sign-control">
      {checked && <span className="test-sign-checked" role="status">{TEST_SIGN_CHECKED_LABEL}</span>}
      {planCreatedAt !== null && (
        <>
          <button type="button" className="secondary-button test-sign-button" disabled={disabled || expired}
            onClick={onTest}>{expired ? TEST_SIGN_EXPIRED_LABEL : TEST_SIGN_LABEL}</button>
          <small className="test-sign-helper">{TEST_SIGN_HELPER}</small>
        </>
      )}
    </div>
  );
}
