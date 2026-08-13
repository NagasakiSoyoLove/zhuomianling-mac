import { ArrowLeft, ArrowRight, Quote } from "lucide-react";
import { Fragment, useMemo, type ReactNode } from "react";
import type { HelpArticleDefinition } from "../../../docs/help/nav";
import aiCapabilitiesImage from "./images/ai-capabilities.png";
import aiConnectionImage from "./images/ai-connection.png";
import createPetFormImage from "./images/create-pet-form.png";
import eventsEditorImage from "./images/events-editor.png";
import expressionMappingImage from "./images/expression-mapping.png";
import homeOverviewImage from "./images/home-overview.png";
import importPetAiConfigImage from "./images/import-pet-ai-config.png";
import importPetPackageCheckImage from "./images/import-pet-package-check.png";
import live2dImportImage from "./images/live2d-import.png";
import memoryBookImage from "./images/memory-book.png";
import moodEditorImage from "./images/mood-editor.png";
import personaEditorImage from "./images/persona-editor.png";
import presetVoiceImage from "./images/preset-voice.png";
import quickActionsImage from "./images/quick-actions.png";
import themeStyleImage from "./images/theme-style.png";
import visionCheckImage from "./images/vision-check.png";
import visionMonitorMenuImage from "./images/vision-monitor-menu.png";
import voiceInputConnectionImage from "./images/voice-input-connection.png";
import voiceInputOptionsImage from "./images/voice-input-options.png";
import voiceModelOutputImage from "./images/voice-model-output.png";
import voiceModelResourcesImage from "./images/voice-model-resources.png";
import tencentApiKeyManagementImage from "./images/tencent-api-key-management.png";
import tencentAsrOverviewImage from "./images/tencent-asr-overview.png";
import tencentSecretKeyCreatedImage from "./images/tencent-secret-key-created.png";

export interface HelpHeading {
  readonly id: string;
  readonly level: 2 | 3;
  readonly text: string;
}

type MarkdownBlock =
  | { readonly type: "heading"; readonly id: string; readonly level: 2 | 3; readonly text: string }
  | { readonly type: "paragraph"; readonly lines: readonly string[] }
  | { readonly type: "unordered-list"; readonly items: readonly string[] }
  | { readonly type: "ordered-list"; readonly items: readonly string[] }
  | { readonly type: "blockquote"; readonly lines: readonly string[] }
  | { readonly type: "code"; readonly language: string; readonly value: string }
  | { readonly type: "image"; readonly alt: string; readonly source: string }
  | { readonly type: "rule" };

const helpImageSources: Readonly<Record<string, string>> = {
  "./images/ai-capabilities.png": aiCapabilitiesImage,
  "./images/ai-connection.png": aiConnectionImage,
  "./images/create-pet-form.png": createPetFormImage,
  "./images/events-editor.png": eventsEditorImage,
  "./images/expression-mapping.png": expressionMappingImage,
  "./images/home-overview.png": homeOverviewImage,
  "./images/import-pet-ai-config.png": importPetAiConfigImage,
  "./images/import-pet-package-check.png": importPetPackageCheckImage,
  "./images/live2d-import.png": live2dImportImage,
  "./images/memory-book.png": memoryBookImage,
  "./images/mood-editor.png": moodEditorImage,
  "./images/persona-editor.png": personaEditorImage,
  "./images/preset-voice.png": presetVoiceImage,
  "./images/quick-actions.png": quickActionsImage,
  "./images/theme-style.png": themeStyleImage,
  "./images/vision-check.png": visionCheckImage,
  "./images/vision-monitor-menu.png": visionMonitorMenuImage,
  "./images/voice-input-connection.png": voiceInputConnectionImage,
  "./images/voice-input-options.png": voiceInputOptionsImage,
  "./images/voice-model-output.png": voiceModelOutputImage,
  "./images/voice-model-resources.png": voiceModelResourcesImage,
  "./images/tencent-api-key-management.png": tencentApiKeyManagementImage,
  "./images/tencent-asr-overview.png": tencentAsrOverviewImage,
  "./images/tencent-secret-key-created.png": tencentSecretKeyCreatedImage
};

const allowedExternalHelpLinks = new Set(["https://console.cloud.tencent.com/asr"]);

export interface HelpArticleProps {
  readonly article: HelpArticleDefinition;
  readonly previousArticle?: HelpArticleDefinition;
  readonly nextArticle?: HelpArticleDefinition;
  readonly onNavigate: (article: HelpArticleDefinition) => void;
}

function slugifyHeading(text: string, index: number): string {
  const normalized = text
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${normalized || "section"}-${index + 1}`;
}

function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraphLines: string[] = [];
  let listItems: string[] = [];
  let listType: "unordered-list" | "ordered-list" | undefined;
  let quoteLines: string[] = [];
  let codeLines: string[] | undefined;
  let codeLanguage = "";

  const flushParagraph = (): void => {
    if (paragraphLines.length > 0) {
      blocks.push({ type: "paragraph", lines: paragraphLines });
      paragraphLines = [];
    }
  };

  const flushList = (): void => {
    if (listItems.length > 0 && listType) {
      blocks.push({ type: listType, items: listItems });
      listItems = [];
      listType = undefined;
    }
  };

  const flushQuote = (): void => {
    if (quoteLines.length > 0) {
      blocks.push({ type: "blockquote", lines: quoteLines });
      quoteLines = [];
    }
  };

  lines.forEach((line, index) => {
    if (codeLines) {
      if (/^```/.test(line.trim())) {
        blocks.push({ type: "code", language: codeLanguage, value: codeLines.join("\n") });
        codeLines = undefined;
        codeLanguage = "";
      } else {
        codeLines.push(line);
      }
      return;
    }

    const trimmed = line.trim();
    const codeStart = trimmed.match(/^```\s*([\w-]*)\s*$/);

    if (codeStart) {
      flushParagraph();
      flushList();
      flushQuote();
      codeLines = [];
      codeLanguage = codeStart[1] ?? "";
      return;
    }

    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (image) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({
        type: "image",
        alt: image[1]?.trim() || "教程截图",
        source: image[2] ?? ""
      });
      return;
    }

    if (trimmed === "") {
      flushParagraph();
      flushList();
      flushQuote();
      return;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = Math.min(3, Math.max(2, heading[1].length)) as 2 | 3;
      blocks.push({
        type: "heading",
        level,
        text: heading[2].trim(),
        id: slugifyHeading(heading[2], index)
      });
      return;
    }

    if (/^(---|\*\*\*)$/.test(trimmed)) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({ type: "rule" });
      return;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      quoteLines.push(quote[1]);
      return;
    }

    const unorderedItem = trimmed.match(/^[-*]\s+(.+)$/);
    const orderedItem = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (unorderedItem || orderedItem) {
      flushParagraph();
      flushQuote();
      const nextType = unorderedItem ? "unordered-list" : "ordered-list";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((unorderedItem ?? orderedItem)?.[1] ?? "");
      return;
    }

    flushList();
    flushQuote();
    paragraphLines.push(trimmed);
  });

  if (codeLines) {
    blocks.push({ type: "code", language: codeLanguage, value: codeLines.join("\n") });
  }
  flushParagraph();
  flushList();
  flushQuote();

  return blocks;
}

export function extractHelpHeadings(source: string): HelpHeading[] {
  return parseMarkdown(source)
    .filter((block): block is Extract<MarkdownBlock, { type: "heading" }> => block.type === "heading")
    .map(({ id, level, text }) => ({ id, level, text }));
}

function renderInline(text: string): ReactNode[] {
  const tokenPattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[([^\]]+)\]\(([^)]+)\))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];

    if (token.startsWith("`")) {
      nodes.push(<code key={`code-${match.index}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={`strong-${match.index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={`em-${match.index}`}>{token.slice(1, -1)}</em>);
    } else if (match[2] && match[3]) {
      const href = match[3].trim();
      const isExternal = allowedExternalHelpLinks.has(href);
      const safeHref = href.startsWith("#") || isExternal ? href : undefined;
      nodes.push(
        safeHref ? (
          <a
            key={`link-${match.index}`}
            href={safeHref}
            target={isExternal ? "_blank" : undefined}
            rel={isExternal ? "noreferrer" : undefined}
          >
            {match[2]}
          </a>
        ) : (
          <span key={`link-${match.index}`} className="helpMarkdownLinkText">{match[2]}</span>
        )
      );
    }

    cursor = match.index + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderMarkdown(source: string): JSX.Element {
  const blocks = parseMarkdown(source);

  return (
    <div className="helpMarkdown">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading": {
            const Tag = block.level === 2 ? "h2" : "h3";
            return <Tag id={block.id} key={block.id}>{renderInline(block.text)}</Tag>;
          }
          case "paragraph":
            return (
              <p key={`paragraph-${index}`}>
                {block.lines.map((line, lineIndex) => (
                  <Fragment key={`line-${lineIndex}`}>
                    {lineIndex > 0 ? <br /> : null}
                    {renderInline(line)}
                  </Fragment>
                ))}
              </p>
            );
          case "unordered-list":
            return (
              <ul key={`unordered-${index}`}>
                {block.items.map((item, itemIndex) => <li key={`item-${itemIndex}`}>{renderInline(item)}</li>)}
              </ul>
            );
          case "ordered-list":
            return (
              <ol key={`ordered-${index}`}>
                {block.items.map((item, itemIndex) => <li key={`item-${itemIndex}`}>{renderInline(item)}</li>)}
              </ol>
            );
          case "blockquote":
            return (
              <aside className="helpMarkdownQuote" key={`quote-${index}`}>
                <span className="helpMarkdownQuoteIcon" aria-hidden="true"><Quote size={15} /></span>
                <div>{block.lines.map((line, lineIndex) => <p key={`quote-line-${lineIndex}`}>{renderInline(line)}</p>)}</div>
              </aside>
            );
          case "code":
            return (
              <pre key={`code-block-${index}`}>
                {block.language ? <span className="helpMarkdownCodeLanguage">{block.language}</span> : null}
                <code>{block.value}</code>
              </pre>
            );
          case "image": {
            const source = helpImageSources[block.source];
            if (!source) return null;

            return (
              <figure className="helpMarkdownFigure" key={`image-${index}`}>
                <img src={source} alt={block.alt} loading="lazy" decoding="async" />
                <figcaption>{block.alt}</figcaption>
              </figure>
            );
          }
          case "rule":
            return <hr key={`rule-${index}`} />;
        }
      })}
    </div>
  );
}

export function HelpArticle({
  article,
  previousArticle,
  nextArticle,
  onNavigate
}: HelpArticleProps): JSX.Element {
  const articleBody = useMemo(() => renderMarkdown(article.content), [article.content]);

  return (
    <article className="helpArticlePage" aria-labelledby="help-article-title">
      <div className="helpArticleMeta">
        <span className="helpArticleMetaDot" aria-hidden="true" />
        <span>{article.group === "quick-start" ? "基础设置" : "详细功能教学"}</span>
      </div>
      <h1 id="help-article-title" tabIndex={-1}>{article.title}</h1>
      <p className="helpArticleSummary">{article.summary}</p>
      <div className="helpArticleRule" aria-hidden="true" />
      {articleBody}

      <nav className="helpArticlePagination" aria-label="文章切换">
        {previousArticle ? (
          <button className="helpArticlePaginationButton is-previous" type="button" onClick={() => onNavigate(previousArticle)}>
            <ArrowLeft size={16} aria-hidden="true" />
            <span><small>上一篇</small><strong>{previousArticle.title}</strong></span>
          </button>
        ) : <span />}
        {nextArticle ? (
          <button className="helpArticlePaginationButton is-next" type="button" onClick={() => onNavigate(nextArticle)}>
            <span><small>下一篇</small><strong>{nextArticle.title}</strong></span>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        ) : <span />}
      </nav>
      <p className="helpArticleFooterNote">教程内容会随桌面灵功能更新逐步补充。</p>
    </article>
  );
}
