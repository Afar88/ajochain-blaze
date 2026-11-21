import { noticeAutoClears } from "./notice-display";

/**
 * A status line under a circle workspace. Notices that stay on screen (a
 * transaction ID, a link, or a next step) get a close button.
 */
export function WorkspaceNotice({ notice, className, onClose }: {
  notice: string;
  className: string;
  onClose: () => void;
}) {
  if (!notice) return null;
  const stays = !noticeAutoClears(notice);
  return (
    <div className={className + " workspace-notice"} role="status">
      <span>{notice}</span>
      {stays && (
        <button type="button" className="inline-dismiss notice-dismiss" aria-label="Close message" onClick={onClose}>×</button>
      )}
    </div>
  );
}
