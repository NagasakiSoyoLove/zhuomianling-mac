import { Menu, PanelLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getHelpArticle,
  getHelpArticlePath,
  helpArticles,
  helpNavigation,
  type HelpArticleDefinition
} from "../../../docs/help/nav";
import { HelpArticle, extractHelpHeadings, type HelpHeading } from "./HelpArticle";
import { HelpSidebar } from "./HelpSidebar";

const firstArticle = helpArticles[0];

function readArticleSlugFromHash(hash: string): string | undefined {
  const prefix = "#/docs/";
  if (!hash.startsWith(prefix)) return undefined;

  try {
    return decodeURIComponent(hash.slice(prefix.length));
  } catch {
    return undefined;
  }
}

function findArticleContext(article: HelpArticleDefinition): {
  readonly sectionTitle: string;
  readonly groupTitle: string;
} {
  for (const section of helpNavigation) {
    for (const group of section.groups) {
      if (group.articles.some((candidate) => candidate.slug === article.slug)) {
        return { sectionTitle: section.title, groupTitle: group.title };
      }
    }
  }

  return { sectionTitle: "基础设置", groupTitle: "快速开始" };
}

function scrollToHeading(heading: HelpHeading): void {
  const element = document.getElementById(heading.id);
  element?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function HelpApp(): JSX.Element {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const articleViewportRef = useRef<HTMLElement>(null);
  const [activeSlug, setActiveSlug] = useState(() => readArticleSlugFromHash(window.location.hash) ?? firstArticle.slug);
  const [query, setQuery] = useState("");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const activeArticle = getHelpArticle(activeSlug);
  const activeArticleIndex = helpArticles.findIndex((article) => article.slug === activeArticle.slug);
  const context = findArticleContext(activeArticle);
  const headings = useMemo(() => extractHelpHeadings(activeArticle.content), [activeArticle.content]);

  useEffect(() => {
    const nextHash = getHelpArticlePath(activeArticle.slug);
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }

    const handleHashChange = (): void => {
      const nextSlug = readArticleSlugFromHash(window.location.hash);
      setActiveSlug(getHelpArticle(nextSlug).slug);
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [activeArticle.slug]);

  useEffect(() => {
    articleViewportRef.current?.scrollTo({ top: 0, behavior: "auto" });
    window.requestAnimationFrame(() => document.getElementById("help-article-title")?.focus());
    setMobileSidebarOpen(false);
  }, [activeArticle.slug]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (event.key === "Escape" && mobileSidebarOpen) {
        setMobileSidebarOpen(false);
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [mobileSidebarOpen]);

  const selectArticle = (article: HelpArticleDefinition): void => {
    setQuery("");
    const nextHash = getHelpArticlePath(article.slug);
    if (window.location.hash === nextHash) {
      articleViewportRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    window.location.hash = nextHash.slice(1);
  };

  const previousArticle = activeArticleIndex > 0 ? helpArticles[activeArticleIndex - 1] : undefined;
  const nextArticle = activeArticleIndex >= 0 && activeArticleIndex < helpArticles.length - 1
    ? helpArticles[activeArticleIndex + 1]
    : undefined;

  return (
    <div className="helpApp">
      <div className="helpAmbientGlow helpAmbientGlowOne" aria-hidden="true" />
      <div className="helpAmbientGlow helpAmbientGlowTwo" aria-hidden="true" />

      <HelpSidebar
        activeSlug={activeArticle.slug}
        query={query}
        searchInputRef={searchInputRef}
        mobileOpen={mobileSidebarOpen}
        onQueryChange={setQuery}
        onSelectArticle={selectArticle}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />

      <div className="helpMain">
        <header className="helpTopbar">
          <div className="helpTopbarLeading">
            <button
              className="helpIconButton helpMobileMenuButton"
              type="button"
              aria-label="打开帮助导航"
              title="打开帮助导航"
              onClick={() => setMobileSidebarOpen(true)}
            >
              <Menu size={19} aria-hidden="true" />
            </button>
            <div className="helpBreadcrumbs" aria-label="当前位置">
              <span>桌面灵</span>
              <span className="helpBreadcrumbSlash" aria-hidden="true">/</span>
              <span>{context.sectionTitle}</span>
              <span className="helpBreadcrumbSlash" aria-hidden="true">/</span>
              <strong>{activeArticle.title}</strong>
            </div>
          </div>

          <div className="helpTopbarActions">
            <button
              className="helpIconButton helpTopbarSearchButton"
              type="button"
              aria-label="搜索教程"
              title="搜索教程（Ctrl/⌘ K）"
              onClick={() => searchInputRef.current?.focus()}
            >
              <Search size={17} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="helpContentLayout">
          <main className="helpArticleViewport" ref={articleViewportRef}>
            <HelpArticle
              article={activeArticle}
              previousArticle={previousArticle}
              nextArticle={nextArticle}
              onNavigate={selectArticle}
            />
          </main>

          <aside className="helpToc" aria-label="当前文章目录">
            <div className="helpTocLabel">
              <PanelLeft size={14} aria-hidden="true" />
              <span>本页目录</span>
            </div>
            {headings.length > 0 ? (
              <nav className="helpTocNav">
                {headings.map((heading) => (
                  <button
                    className={`helpTocItem level-${heading.level}`}
                    type="button"
                    key={heading.id}
                    onClick={() => scrollToHeading(heading)}
                  >
                    {heading.text}
                  </button>
                ))}
              </nav>
            ) : null}
            <div className="helpTocTip">
              <span className="helpTocTipLine" aria-hidden="true" />
              <span>内容会随版本逐步补充</span>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
