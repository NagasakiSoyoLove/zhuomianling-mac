export interface ScreenPermissionDecision {
  allowDisplayCapture: boolean;
  allowAudioOnly: boolean;
  allowed: boolean;
}

export function decideScreenPermission(
  permission: string,
  mediaTypes: readonly string[],
  isPetWindow: boolean
): ScreenPermissionDecision {
  const isAudioOnlyRequest = mediaTypes.length > 0 && mediaTypes.every((mediaType) => mediaType === "audio");
  // Electron 43 reports getDisplayMedia's preflight as a media request without mediaTypes.
  const isUntypedDisplayCaptureRequest = permission === "media" && mediaTypes.length === 0;
  const allowDisplayCapture =
    isPetWindow && (permission === "display-capture" || isUntypedDisplayCaptureRequest);
  const allowAudioOnly = permission === "media" && isAudioOnlyRequest && isPetWindow;
  return {
    allowDisplayCapture,
    allowAudioOnly,
    allowed: allowDisplayCapture || allowAudioOnly
  };
}
