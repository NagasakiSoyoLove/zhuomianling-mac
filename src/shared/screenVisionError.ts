import type { ScreenVisionFailureCode } from "./types/screen";

const screenVisionFailureMessages: Record<ScreenVisionFailureCode, string> = {
  "vision-unavailable": "视觉功能未开启或视觉模型尚未通过检测。",
  "screen-source-unavailable": "没有可用的整个屏幕来源。",
  "capture-failed": "屏幕捕获失败，未能生成截图。",
  "frame-encoding-failed": "截图编码失败，未发送给 AI。",
  "frame-transfer-failed": "截图没有成功送达主进程。",
  "frame-invalid": "截图数据无效，无法提交给视觉服务。",
  "session-invalid": "屏幕识别会话已失效，请重新发起。",
  "request-canceled": "识屏请求已取消。",
  "provider-authentication": "视觉服务认证失败，请检查 API Key。",
  "provider-rate-limit": "视觉服务触发限流，请稍后重试。",
  "provider-network": "无法连接视觉服务或请求超时。",
  "provider-server": "视觉服务暂时不可用，请稍后重试。",
  "provider-unsupported": "视觉服务拒绝了当前图片请求或模型不支持图片。",
  "visual-uncertain": "视觉模型没有确认足够的屏幕内容。",
  "response-empty": "视觉服务没有返回可见回答。",
  "response-invalid": "视觉服务返回了无法识别的结果。",
  unknown: "识屏失败，请稍后重试。"
};

export function getScreenVisionFailureMessage(code: ScreenVisionFailureCode): string {
  return screenVisionFailureMessages[code];
}

export class ScreenVisionRequestError extends Error {
  public readonly code: ScreenVisionFailureCode;

  public constructor(code: ScreenVisionFailureCode, message = getScreenVisionFailureMessage(code)) {
    super(message);
    this.name = "ScreenVisionRequestError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isScreenVisionRequestError(value: unknown): value is ScreenVisionRequestError {
  return value instanceof ScreenVisionRequestError;
}
