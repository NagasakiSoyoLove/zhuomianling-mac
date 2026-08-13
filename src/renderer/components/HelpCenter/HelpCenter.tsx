import {
  ArrowRight,
  BookOpenText,
  ChevronDown,
  CircleHelp,
  Code2,
  LifeBuoy,
  ListChecks,
  Search,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type HelpSection = "developer" | "tutorial" | "faq";

interface HelpCenterProps {
  onClose: () => void;
}

interface HelpNavItem {
  id: HelpSection;
  label: string;
  description: string;
  icon: typeof LifeBuoy;
}

const helpNavItems: readonly HelpNavItem[] = [
  {
    id: "developer",
    label: "开发者声明",
    description: "项目边界、资源与隐私说明。",
    icon: Code2
  },
  {
    id: "tutorial",
    label: "使用教程",
    description: "基础使用与详细功能教学。",
    icon: BookOpenText
  },
  {
    id: "faq",
    label: "常见问题",
    description: "快速查找使用中的疑问。",
    icon: CircleHelp
  }
];

const faqItems = [
  {
    id: "model-display-error",
    question: "模型导入后黑屏、白屏或贴图缺失怎么办？",
    answer: "请确认选择的是完整的模型文件夹，而不是单个文件。主模型文件（model.json 或 .model3.json）需要和贴图、动作等配套文件保持原有位置。回到编辑器重新导入并等待检查完成；如果仍然异常，通常是模型文件不完整或模型本身不兼容。"
  },
  {
    id: "model-action-error",
    question: "为什么模型的动作、表情或物理效果没有生效？",
    answer: "动作和表情来自模型自带的文件。请在编辑器的动作、表情列表中重新检查已导入模型并逐项预览；如果列表为空或只有部分内容可用，请检查对应文件是否随模型一起导入，且没有被移动或重命名。"
  },
  {
    id: "ai-request-error",
    question: "AI 配置正确但仍然无法回复怎么办？",
    answer: "先在 AI 设置中点击“测试 AI 回复”。测试失败时，请检查 API 地址、模型名称、API Key、网络或代理设置，以及服务商的额度和运行状态。账号验证失败、使用量超限或服务中断时，需要先处理服务商那边的问题；测试成功后，请确认当前桌宠使用的是刚保存的连接。"
  },
  {
    id: "ai-key",
    question: "AI Key 会保存在哪里？",
    answer: "AI Key 只保存在本机的应用安全配置中，不会写进项目示例、桌宠包或发布包。导出桌宠包时不会包含 Key；换电脑或重新安装后，需要重新填写。"
  },
  {
    id: "screen-monitor-no-reply",
    question: "屏幕监测为什么没有立即让桌宠说话？",
    answer: "屏幕监测不是逐帧实时播报。首次开启会先进行一次观察，之后会按当前模式隔一段时间检查；画面没有明显变化、刚刚已经提醒过同一画面，或桌宠判断这次不需要打扰时，它可能不会发言。这不代表屏幕读取失败。"
  },
  {
    id: "privacy",
    question: "屏幕监测会一直录制屏幕吗？",
    answer: "不会。只有你主动开启屏幕监测后，应用才会请求屏幕捕获；停止观察后会结束这次观察的屏幕读取。如果你还打开了“持续开启屏幕捕获”，屏幕捕获可能继续保持，关闭该选项后才会完全停止。未开启时不会在后台监听，也不会保存连续录像。"
  },
  {
    id: "screen-data",
    question: "屏幕截图和聊天内容会被上传或保存吗？",
    answer: "使用 AI 聊天时，当前对话会按你的配置发送给对应服务；只有在你主动使用识屏或开启屏幕监测时，当前截图才会发送给视觉 AI 服务。普通聊天不会自动变成长期记忆，只有开启自动整理后才会提取记忆；来源对话只有开启“保留来源”才会保存。应用不会保存连续录像，第三方服务是否留存发送的内容则以其隐私政策为准。"
  },
  {
    id: "voice-recording-privacy",
    question: "语音输入会在我不知情时录音吗？",
    answer: "不会。录音必须由你在聊天界面主动点击开始，关闭聊天、停止录音、开启点击穿透或关闭窗口后都会停止录音并释放麦克风。"
  },
  {
    id: "voice-synthesis-error",
    question: "语音合成失败时，应该检查什么？",
    answer: "请先确认语音服务地址和模型版本正确，再检查参考音频是否在电脑上存在、应用能打开且时长为 3–10 秒。连接测试或试听可以帮助区分配置问题和服务临时故障；取消操作不会被当作失败重试。"
  },
  {
    id: "memory-not-recalled",
    question: "记忆没有被召回或自动整理失败怎么办？",
    answer: "记忆功能默认关闭，需要在记忆书中明确启用召回或自动整理。即使已经启用，也只有与当前对话高度相关的内容才会被参考。记忆功能暂时不可用时，聊天仍可继续；记忆书会提示正在准备或需要修复，已经保存的记忆不会因此被清空。"
  },
  {
    id: "memory-delete",
    question: "如何删除一条记忆或清空全部记忆？",
    answer: "在记忆书中可以逐条选择“忘记”，并在短暂撤销时间内恢复；清空记忆书需要再次确认。确认完成后，会同时删除这只桌宠的记忆、来源和用于查找的内容；已经导出的文件不会被自动删除。"
  },
  {
    id: "config-recovery",
    question: "配置损坏或桌宠无法启动怎么办？",
    answer: "请不要删除桌宠目录，也不要直接重新导入模型覆盖原配置。应用会保留最近一次有效备份，并在页面提供恢复入口；如果没有可用备份，请使用之前导出的桌宠包或外部备份恢复。"
  },
  {
    id: "startup-error",
    question: "应用启动白屏、模型加载卡住或占用过高怎么办？",
    answer: "先关闭多余的桌宠窗口并重新启动应用。如果只有某只桌宠出现问题，请在编辑器中检查模型资源，再从最近有效备份恢复配置或重新导入模型。仍无法恢复时，请保留页面上的错误提示，便于进一步排查。"
  }
] as const;

function getHelpNavItem(section: HelpSection): HelpNavItem {
  return helpNavItems.find((item) => item.id === section) ?? helpNavItems[0];
}

export function HelpCenter({ onClose }: HelpCenterProps): JSX.Element {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [activeSection, setActiveSection] = useState<HelpSection>("developer");
  const [faqQuery, setFaqQuery] = useState("");
  const [openFaqId, setOpenFaqId] = useState<string>(faqItems[0].id);

  useEffect(() => {
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const filteredFaqItems = useMemo(() => {
    const keyword = faqQuery.trim().toLocaleLowerCase();

    if (!keyword) {
      return faqItems;
    }

    return faqItems.filter((item) =>
      `${item.question}\n${item.answer}`.toLocaleLowerCase().includes(keyword)
    );
  }, [faqQuery]);

  const activeNavItem = getHelpNavItem(activeSection);

  const selectSection = (section: HelpSection): void => {
    setActiveSection(section);
  };

  return (
    <div
      className="helpCenterOverlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className={`helpCenterDialog helpCenterDialog-${activeSection}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-center-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <aside className="helpCenterSidebar">
          <div className="helpCenterBrand">
            <span className="helpCenterBrandIcon" aria-hidden="true">
              <LifeBuoy size={20} />
            </span>
            <span>
              <small>桌面灵</small>
              <strong>帮助中心</strong>
            </span>
          </div>

          <nav className="helpCenterNav" aria-label="帮助中心导航">
            <span className="helpCenterNavLabel">文档导航</span>
            {helpNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = item.id === activeSection;

              return (
                <button
                  className={`helpCenterNavItem${isActive ? " active" : ""}`}
                  type="button"
                  key={item.id}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => selectSection(item.id)}
                >
                  <span className="helpCenterNavIcon" aria-hidden="true">
                    <Icon size={17} />
                  </span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                  {isActive ? <ArrowRight size={15} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </nav>

          <div className="helpCenterSidebarNote">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>配置说明随时可查</span>
          </div>
        </aside>

        <div className="helpCenterMain">
          <header className="helpCenterHeader">
            <div className="helpCenterHeaderCopy">
              <span className="eyebrow">帮助中心</span>
              <h1 id="help-center-title">{activeNavItem.label}</h1>
              <p>{activeNavItem.description}</p>
            </div>
            <button
              ref={closeButtonRef}
              className="helpCenterCloseButton"
              type="button"
              aria-label="关闭帮助中心"
              title="关闭帮助中心"
              onClick={onClose}
            >
              <X size={19} />
            </button>
          </header>

          <div className="helpCenterContent">
            {activeSection === "developer" ? <DeveloperStatement /> : null}
            {activeSection === "tutorial" ? <TutorialOverview /> : null}
            {activeSection === "faq" ? (
              <FaqSection
                query={faqQuery}
                items={filteredFaqItems}
                openFaqId={openFaqId}
                onQueryChange={setFaqQuery}
                onToggle={(id) => setOpenFaqId((currentId) => (currentId === id ? "" : id))}
              />
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function DeveloperStatement(): JSX.Element {
  return (
    <article className="helpArticle helpDeveloperArticle">
      <section className="helpDeveloperHero" aria-labelledby="developer-statement-heading">
        <span className="helpDeveloperHeroIcon" aria-hidden="true">
          <ShieldCheck size={25} />
        </span>
        <div className="helpDeveloperHeroCopy">
          <span className="helpContentEyebrow">开发者声明</span>
          <h2 id="developer-statement-heading">桌面灵 · 开发者声明</h2>
          <p>“桌面灵”是一个开源、可配置的 Electron 桌宠框架，支持透明桌面窗口、Live2D 模型、字幕、事件、AI 聊天、视觉功能（屏幕捕获）及可选的语音功能。</p>
        </div>
      </section>

      <section className="helpDeveloperProfile" aria-label="开发者信息">
        <div className="helpDeveloperProfileItem">
          <span>作者/开发者</span>
          <strong>七月的忧伤</strong>
        </div>
        <div className="helpDeveloperProfileItem">
          <span>B 站账号</span>
          <strong>470575394</strong>
        </div>
        <div className="helpDeveloperProfileItem">
          <span>企鹅讨论群</span>
          <strong>1058554206</strong>
        </div>
      </section>

      <div className="helpDeveloperSections">
        <section className="helpDeveloperSection helpDeveloperSectionWide">
          <div className="helpDeveloperSectionHeading">
            <span className="helpDeveloperSectionIcon" aria-hidden="true">
              <Code2 size={18} />
            </span>
            <h3>项目归属</h3>
          </div>
          <p>本人是“桌面灵”项目的作者及主要维护者，负责项目的整体设计、开发和维护。除特别注明外，项目中的原创代码、界面设计和文档由本人创作。</p>
        </section>

        <section className="helpDeveloperSection">
          <div className="helpDeveloperSectionHeading">
            <span className="helpDeveloperSectionIcon" aria-hidden="true">
              <ShieldCheck size={18} />
            </span>
            <h3>资源与版权</h3>
          </div>
          <p>本项目不内置或发布受版权限制的角色模型、声音资源、参考音频、AI Key 或云服务密钥。用户自行导入的 Live2D 模型、图片、音频、API 配置及其他资源，应确保来源合法，并遵守相关许可证及服务条款。第三方代码、运行时、模型和资源的权利归其原作者所有。</p>
        </section>

        <section className="helpDeveloperSection">
          <div className="helpDeveloperSectionHeading">
            <span className="helpDeveloperSectionIcon" aria-hidden="true">
              <Sparkles size={18} />
            </span>
            <h3>AI、语音与第三方服务</h3>
          </div>
          <p>涉及 AI、语音、Live2D 及第三方云服务的功能，可能受到网络状态、服务商政策、模型能力和用户配置影响。AI 生成内容仅供参考，开发者不保证其准确性、完整性或适用于特定用途。</p>
        </section>

        <section className="helpDeveloperSection">
          <div className="helpDeveloperSectionHeading">
            <span className="helpDeveloperSectionIcon" aria-hidden="true">
              <ShieldCheck size={18} />
            </span>
            <h3>隐私与使用责任</h3>
          </div>
          <p>本软件不会在未经用户明确操作的情况下录音、捕获屏幕或进行后台监听。用户应妥善保管自己的 API Key、账号信息和本地资源，并对使用本软件产生的内容和行为承担相应责任。</p>
        </section>

        <section className="helpDeveloperSection">
          <div className="helpDeveloperSectionHeading">
            <span className="helpDeveloperSectionIcon" aria-hidden="true">
              <CircleHelp size={18} />
            </span>
            <h3>官方身份与开源许可</h3>
          </div>
          <p>B 站账号主要用于发布项目开发记录、功能演示和更新信息。未经本人授权，任何个人或组织不得冒用作者身份、项目官方身份或相关账号。</p>
          <p>本项目按照仓库中附带的开源许可证发布。具体权利和义务以项目许可证及相关第三方许可证为准。</p>
        </section>
      </div>

      <footer className="helpDeveloperFooter">
        <span>最后更新</span>
        <strong>2026 年 8 月 8 日</strong>
      </footer>
    </article>
  );
}

function TutorialOverview(): JSX.Element {
  const [openError, setOpenError] = useState<string>();

  const openLocalHelp = async (): Promise<void> => {
    const result = await window.desktopPet?.appWindow.openLocalHelp();

    if (!result?.ok) {
      setOpenError(result?.message ?? "教程页面暂时无法打开，请稍后重试。");
    }
  };

  return (
    <article className="helpArticle helpSimpleArticle helpTutorialArticle">
      <div className="helpWelcomeCard helpTutorialIntro">
        <span className="helpWelcomeIcon" aria-hidden="true">
          <BookOpenText size={25} />
        </span>
        <div>
          <span className="helpContentEyebrow">学习路径</span>
          <h2>基础使用与详细功能教学</h2>
          <p>先完成桌宠的基础配置，再按需了解各项功能。完整教程支持按目录浏览和关键词搜索。</p>
        </div>
      </div>

      <div className="helpEntryGrid helpTutorialTracks">
        <section className="helpEntryCard helpTutorialTrack">
          <div className="helpEntryCardTopline">
            <span className="helpTutorialTrackLabel">入门路径</span>
            <span className="helpEntryCardIcon" aria-hidden="true">
              <Sparkles size={19} />
            </span>
          </div>
          <div className="helpEntryCardCopy">
            <strong>基础使用</strong>
            <small>从创建桌宠开始，完成模型导入、AI 连接和桌宠包导入导出。</small>
          </div>
          <ul className="helpTutorialTopics" aria-label="基础使用内容">
            <li>创建桌宠</li>
            <li>导入 Live2D</li>
            <li>配置 AI</li>
            <li>导入与导出</li>
          </ul>
        </section>

        <section className="helpEntryCard helpTutorialTrack helpTutorialTrackFeature">
          <div className="helpEntryCardTopline">
            <span className="helpTutorialTrackLabel">功能路径</span>
            <span className="helpEntryCardIcon" aria-hidden="true">
              <ListChecks size={19} />
            </span>
          </div>
          <div className="helpEntryCardCopy">
            <strong>详细功能教学</strong>
            <small>按需了解主题、快捷操作、视觉、语音、人设、事件、心情和记忆书。</small>
          </div>
          <ul className="helpTutorialTopics" aria-label="详细功能教学内容">
            <li>主题与快捷操作</li>
            <li>视觉功能</li>
            <li>人设、事件与表现</li>
            <li>语音、心情与记忆书</li>
          </ul>
        </section>
      </div>

      <div className="helpTutorialActions">
        <div className="helpArticleNote helpArticleNoteAccent">
          <BookOpenText size={16} aria-hidden="true" />
          <span>打开完整教程后，可以从左侧目录切换章节，也可以直接搜索功能名称。</span>
        </div>
        <button
          className="primaryAction helpOpenGuideButton"
          type="button"
          onClick={() => void openLocalHelp()}
        >
          <BookOpenText size={17} aria-hidden="true" />
          进入完整教程
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
      {openError ? <p className="helpLocalHelpNotice" role="status">{openError}</p> : null}
    </article>
  );
}

function FaqSection({
  query,
  items,
  openFaqId,
  onQueryChange,
  onToggle
}: {
  query: string;
  items: readonly (typeof faqItems)[number][];
  openFaqId: string;
  onQueryChange: (query: string) => void;
  onToggle: (id: string) => void;
}): JSX.Element {
  return (
    <article className="helpArticle helpFaqArticle">
      <div className="helpArticleLead">
        <span className="helpContentEyebrow">快速检索</span>
        <h2>常见问题</h2>
        <p>输入关键词，快速定位模型、AI、语音、记忆和隐私相关的问题。</p>
      </div>

      <label className="helpSearchBox">
        <Search size={18} aria-hidden="true" />
        <span className="srOnly">搜索常见问题</span>
        <input
          type="search"
          value={query}
          placeholder="搜索问题，例如：模型、AI、记忆…"
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label>

      <div className="helpFaqList">
        {items.length ? (
          items.map((item) => {
            const isOpen = item.id === openFaqId;

            return (
              <section className={`helpFaqItem${isOpen ? " open" : ""}`} key={item.id}>
                <button
                  className="helpFaqQuestion"
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`help-faq-answer-${item.id}`}
                  onClick={() => onToggle(item.id)}
                >
                  <span>{item.question}</span>
                  <ChevronDown size={18} aria-hidden="true" />
                </button>
                {isOpen ? (
                  <p className="helpFaqAnswer" id={`help-faq-answer-${item.id}`}>
                    {item.answer}
                  </p>
                ) : null}
              </section>
            );
          })
        ) : (
          <div className="helpFaqEmpty">
            <CircleHelp size={22} aria-hidden="true" />
            <strong>没有找到匹配的问题</strong>
            <span>换一个关键词试试。</span>
          </div>
        )}
      </div>
    </article>
  );
}
