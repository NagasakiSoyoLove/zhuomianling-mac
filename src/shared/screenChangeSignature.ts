/**
 * Small transient RGB feature used only by the local screen-change detector.
 * It is derived from the decoded Canvas frame and never persisted.
 */
export const screenChangeSignatureWidth = 32 as const;
export const screenChangeSignatureHeight = 18 as const;
export const screenChangeSignatureChannels = 3 as const;
export const screenChangeSignatureByteLength =
  screenChangeSignatureWidth * screenChangeSignatureHeight * screenChangeSignatureChannels;
