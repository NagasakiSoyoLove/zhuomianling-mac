import type { AiChatImageAttachment } from "../../shared/types/ai";
import type { ScreenVisionPresentationKind } from "../../shared/types/screen";

export interface ChatMessage {
  id: number;
  role: "user" | "pet";
  text: string;
  status?: "thinking" | "error";
  presentationKind?: ScreenVisionPresentationKind;
  voiceText?: string;
  aiStructuredContent?: string;
  /** Screenshot attached to this exact user message, when it came from vision chat. */
  screenshot?: AiChatImageAttachment;
}
