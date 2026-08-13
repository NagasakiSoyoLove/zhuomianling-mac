import createPetContent from "./basic/create-pet.md?raw";
import importLive2dContent from "./basic/import-live2d.md?raw";
import configureAiContent from "./basic/configure-ai.md?raw";
import importPetContent from "./basic/import-pet.md?raw";
import homeContent from "./features/home.md?raw";
import themeContent from "./features/theme.md?raw";
import shortcutsContent from "./features/shortcuts.md?raw";
import visionContent from "./features/vision.md?raw";
import personaContent from "./features/persona.md?raw";
import eventsContent from "./features/events.md?raw";
import expressionContent from "./features/expression.md?raw";
import voiceInputContent from "./features/voice-input.md?raw";
import voiceModelContent from "./features/voice-model.md?raw";
import presetVoiceContent from "./features/preset-voice.md?raw";
import moodContent from "./features/mood.md?raw";
import memoryBookContent from "./features/memory-book.md?raw";

export type HelpTopLevelSectionId = "basics" | "advanced";
export type HelpArticleGroupId = "quick-start" | "features";

export interface HelpArticleDefinition {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly group: HelpArticleGroupId;
  readonly icon: string;
  readonly content: string;
}

export interface HelpArticleGroup {
  readonly id: HelpArticleGroupId;
  readonly title: string;
  readonly articles: readonly HelpArticleDefinition[];
}

export interface HelpNavigationSection {
  readonly id: HelpTopLevelSectionId;
  readonly title: string;
  readonly description: string;
  readonly groups: readonly HelpArticleGroup[];
}

const quickStartArticles: readonly HelpArticleDefinition[] = [
  {
    slug: "create-pet",
    title: "创建桌宠",
    summary: "从一个空白配置开始，建立第一只本地桌宠。",
    group: "quick-start",
    icon: "sparkles",
    content: createPetContent
  },
  {
    slug: "import-live2d",
    title: "导入 Live2D",
    summary: "为当前桌宠导入并检查 Live2D 模型。",
    group: "quick-start",
    icon: "box",
    content: importLive2dContent
  },
  {
    slug: "configure-ai",
    title: "配置 AI",
    summary: "连接兼容的 AI 服务，让桌宠能够聊天。",
    group: "quick-start",
    icon: "bot",
    content: configureAiContent
  },
  {
    slug: "import-pet",
    title: "导入桌宠",
    summary: "导入完整桌宠包，也可以把配置导出备份。",
    group: "quick-start",
    icon: "package",
    content: importPetContent
  }
];

const featureArticles: readonly HelpArticleDefinition[] = [
  {
    slug: "home",
    title: "主页",
    summary: "了解主页、桌宠列表和桌宠设置。",
    group: "features",
    icon: "house",
    content: homeContent
  },
  {
    slug: "theme",
    title: "主题风格",
    summary: "调整主窗口与桌宠聊天界面的整体风格。",
    group: "features",
    icon: "palette",
    content: themeContent
  },
  {
    slug: "shortcuts",
    title: "快捷操作",
    summary: "设置桌宠比例、穿透和鼠标跟随等常用操作。",
    group: "features",
    icon: "wand",
    content: shortcutsContent
  },
  {
    slug: "vision",
    title: "视觉功能",
    summary: "区分聊天识图与持续观察，并选择适合你的观察模式。",
    group: "features",
    icon: "scan",
    content: visionContent
  },
  {
    slug: "persona",
    title: "人设配置",
    summary: "设置桌宠的身份、语气和互动边界。",
    group: "features",
    icon: "book",
    content: personaContent
  },
  {
    slug: "events",
    title: "事件配置",
    summary: "让桌宠在启动、闲置和交互时做出表现。",
    group: "features",
    icon: "list-checks",
    content: eventsContent
  },
  {
    slug: "expression",
    title: "表现映射",
    summary: "把 AI 情绪或事件映射到动作、表情和台词。",
    group: "features",
    icon: "smile",
    content: expressionContent
  },
  {
    slug: "voice-input",
    title: "语音输入",
    summary: "使用麦克风把语音转换成桌宠可以理解的文字。",
    group: "features",
    icon: "mic",
    content: voiceInputContent
  },
  {
    slug: "voice-model",
    title: "声音模型",
    summary: "配置可选的声音合成服务和参考音频。",
    group: "features",
    icon: "volume-2",
    content: voiceModelContent
  },
  {
    slug: "preset-voice",
    title: "预设台词语音",
    summary: "为常用台词准备可重复播放的语音资源。",
    group: "features",
    icon: "audio-lines",
    content: presetVoiceContent
  },
  {
    slug: "mood",
    title: "心情配置",
    summary: "设置心情区间、变化事件和对应表现。",
    group: "features",
    icon: "gauge",
    content: moodContent
  },
  {
    slug: "memory-book",
    title: "记忆书",
    summary: "查看、搜索、编辑、导出和管理桌宠记忆。",
    group: "features",
    icon: "notebook-tabs",
    content: memoryBookContent
  }
];

export const helpNavigation: readonly HelpNavigationSection[] = [
  {
    id: "basics",
    title: "基础设置",
    description: "先把桌宠顺利运行起来",
    groups: [
      {
        id: "quick-start",
        title: "快速开始",
        articles: quickStartArticles
      }
    ]
  },
  {
    id: "advanced",
    title: "详细功能教学",
    description: "按需了解桌宠的各项功能",
    groups: [
      {
        id: "features",
        title: "详细功能",
        articles: featureArticles
      }
    ]
  }
];

export const helpArticles: readonly HelpArticleDefinition[] = [
  ...quickStartArticles,
  ...featureArticles
];

export function getHelpArticle(slug: string | undefined): HelpArticleDefinition {
  return helpArticles.find((article) => article.slug === slug) ?? helpArticles[0];
}

export function getHelpArticlePath(slug: string): string {
  return `#/docs/${slug}`;
}
