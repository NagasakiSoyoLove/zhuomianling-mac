import {
  AudioLines,
  BookOpenText,
  Bot,
  Box,
  ChevronDown,
  CircleDot,
  Gauge,
  House,
  ListChecks,
  Mic,
  NotebookPen,
  PackageOpen,
  Palette,
  ScanEye,
  Search,
  Smile,
  Sparkles,
  Volume2,
  WandSparkles,
  X,
  type LucideIcon
} from "lucide-react";
import { useMemo, useState, type RefObject } from "react";
import { helpNavigation, type HelpArticleDefinition } from "../../../docs/help/nav";

interface HelpSidebarProps {
  readonly activeSlug: string;
  readonly query: string;
  readonly searchInputRef: RefObject<HTMLInputElement>;
  readonly mobileOpen: boolean;
  readonly onQueryChange: (query: string) => void;
  readonly onSelectArticle: (article: HelpArticleDefinition) => void;
  readonly onCloseMobile: () => void;
}

const iconMap: Readonly<Record<string, LucideIcon>> = {
  "audio-lines": AudioLines,
  book: BookOpenText,
  bot: Bot,
  box: Box,
  gauge: Gauge,
  house: House,
  "list-checks": ListChecks,
  mic: Mic,
  "notebook-tabs": NotebookPen,
  package: PackageOpen,
  palette: Palette,
  scan: ScanEye,
  smile: Smile,
  sparkles: Sparkles,
  "volume-2": Volume2,
  wand: WandSparkles
};

function getArticleIcon(iconName: string): LucideIcon {
  return iconMap[iconName] ?? CircleDot;
}

export function HelpSidebar({
  activeSlug,
  query,
  searchInputRef,
  mobileOpen,
  onQueryChange,
  onSelectArticle,
  onCloseMobile
}: HelpSidebarProps): JSX.Element {
  const [collapsedSections, setCollapsedSections] = useState<Readonly<Record<string, boolean>>>({});
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const visibleNavigation = useMemo(
    () =>
      helpNavigation
        .map((section) => ({
          ...section,
          groups: section.groups
            .map((group) => ({
              ...group,
              articles: group.articles.filter((article) => {
                if (!normalizedQuery) return true;
                return `${article.title}\n${article.summary}`
                  .toLocaleLowerCase()
                  .includes(normalizedQuery);
              })
            }))
            .filter((group) => group.articles.length > 0)
        }))
        .filter((section) => section.groups.length > 0),
    [normalizedQuery]
  );

  const toggleSection = (sectionId: string): void => {
    setCollapsedSections((current) => ({
      ...current,
      [sectionId]: !current[sectionId]
    }));
  };

  return (
    <>
      {mobileOpen ? (
        <button
          className="helpSidebarBackdrop"
          type="button"
          aria-label="关闭帮助导航"
          onClick={onCloseMobile}
        />
      ) : null}

      <aside className={`helpSidebar${mobileOpen ? " is-open" : ""}`} aria-label="帮助网站导航">
        <div className="helpSidebarBrandRow">
          <a className="helpSidebarBrand" href="#/docs/create-pet" onClick={onCloseMobile}>
            <span className="helpSidebarLogo" aria-hidden="true">
              <span className="helpSidebarLogoDot" />
              <span className="helpSidebarLogoLine" />
            </span>
            <span className="helpSidebarBrandText">
              <small>桌面灵</small>
              <strong>使用教程</strong>
            </span>
          </a>
          <button
            className="helpIconButton helpSidebarClose"
            type="button"
            aria-label="关闭导航"
            title="关闭导航"
            onClick={onCloseMobile}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="helpSidebarIntro">
          <span className="helpSidebarIntroMark" aria-hidden="true">01</span>
          <div>
            <strong>从这里开始</strong>
            <span>按顺序完成桌宠配置</span>
          </div>
        </div>

        <label className="helpSidebarSearch">
          <Search size={17} aria-hidden="true" />
          <span className="srOnly">搜索教程</span>
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            placeholder="搜索教程"
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <kbd>/</kbd>
        </label>

        <div className="helpSidebarScroll">
          <nav className="helpSidebarNav" aria-label="教程目录">
            {visibleNavigation.length > 0 ? (
              visibleNavigation.map((section) => {
                const isCollapsed = collapsedSections[section.id] ?? false;

                return (
                  <section className="helpSidebarSection" key={section.id}>
                    <button
                      className="helpSidebarSectionHeader"
                      type="button"
                      aria-expanded={!isCollapsed}
                      onClick={() => toggleSection(section.id)}
                    >
                      <span className="helpSidebarSectionTitle">
                        <span className="helpSidebarSectionDot" aria-hidden="true" />
                        <strong>{section.title}</strong>
                      </span>
                      <span className="helpSidebarSectionDescription">{section.description}</span>
                      <ChevronDown
                        className={isCollapsed ? "is-collapsed" : ""}
                        size={16}
                        aria-hidden="true"
                      />
                    </button>

                    {!isCollapsed ? (
                      <div className="helpSidebarSectionBody">
                        {section.groups.map((group) => (
                          <div className="helpSidebarGroup" key={group.id}>
                            <div className="helpSidebarGroupTitle">{group.title}</div>
                            <div className="helpSidebarItems">
                              {group.articles.map((article) => {
                                const Icon = getArticleIcon(article.icon);
                                const isActive = article.slug === activeSlug;

                                return (
                                  <button
                                    className={`helpSidebarItem${isActive ? " is-active" : ""}`}
                                    type="button"
                                    key={article.slug}
                                    aria-current={isActive ? "page" : undefined}
                                    onClick={() => onSelectArticle(article)}
                                  >
                                    <span className="helpSidebarItemIcon" aria-hidden="true">
                                      <Icon size={16} strokeWidth={1.8} />
                                    </span>
                                    <span className="helpSidebarItemCopy">
                                      <strong>{article.title}</strong>
                                      {isActive ? <small>{article.summary}</small> : null}
                                    </span>
                                    {isActive ? <CircleDot className="helpSidebarItemActiveDot" size={9} aria-hidden="true" /> : null}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </section>
                );
              })
            ) : (
              <div className="helpSidebarEmpty">
                <Search size={18} aria-hidden="true" />
                <strong>没有找到相关教程</strong>
                <span>换一个关键词试试。</span>
              </div>
            )}
          </nav>
        </div>

      </aside>
    </>
  );
}
