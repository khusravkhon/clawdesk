// The panel inside the ClawDesk desktop app (a Tauri window): native notifications. In a browser
// window.__TAURI__ does not exist and these do nothing. The desktop app lets panel windows use notifications
// only (apps/desktop/src-tauri/capabilities/panel.json).

type TauriNotification = {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<string>;
  sendNotification(options: { title: string; body?: string }): void;
};

const tauriNotification = (): TauriNotification | undefined =>
  (window as unknown as { __TAURI__?: { notification?: TauriNotification } }).__TAURI__?.notification;

export const inDesktopApp = (): boolean => tauriNotification() !== undefined;

/** A system notification, when the panel's window is not the one the person is looking at. */
export async function desktopNotify(title: string, body: string): Promise<void> {
  const n = tauriNotification();
  if (!n || (document.hasFocus() && !document.hidden)) return;
  try {
    if (!(await n.isPermissionGranted()) && (await n.requestPermission()) !== "granted") return;
    n.sendNotification({ title, body });
  } catch {
    // Notifications off in the system: the in-panel notice is still there.
  }
}
