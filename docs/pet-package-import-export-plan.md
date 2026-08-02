# 桌宠 `.zmling` 导入导出完整实施计划

> 本文是给后续新 Codex 任务使用的完整交接稿。开始实现前必须先阅读仓库根目录 `AGENTS.md`，并重新检查工作区未提交改动，不能覆盖已有修改。

## 1. 最终产品定义

`.zmling` 是桌面灵的“可分享桌宠安装包”，底层使用流式 ZIP 容器，但用户只接触 `.zmling` 扩展名。

示例文件名：

```text
桌面灵-小桌宠.zmling
```

它需要包含桌宠角色配置和运行资源，但不能包含账号秘密、当前电脑环境、个人记忆及运行期私有状态。

已确定的需求：

- 导入入口放在主页最上方。
- 导出入口放在桌宠编辑器顶栏。
- Live2D 模型及完整依赖必须进入包内。
- AI API、AI 连接信息不进入包内；包内只记录“该桌宠原本是否配置了 AI”。
- GPT-SoVITS 程序根目录不进入包内。
- 启用语音时，SoVITS `.pth`、GPT `.ckpt`、参考音频及宠物自有语音资源进入包内。
- 记忆、来源对话、索引、pending 和记忆设置全部不进入包内。
- 腾讯云配置不导出、不检测，也不进入导入向导。
- 使用六个系统内置主题时不导出主题定义，只保留内置主题枚举值。
- 使用自定义主题时，导出当前宠物内嵌的 `uiSettings.customTheme`。
- 导入后安装到 `%APPDATA%/zhuomianling/pets/<pet-id>/`。
- 原宠物 ID 合法且本机未占用时可以保留；冲突时生成带数字后缀的新 canonical ID。
- 导入必须使用 staging 和事务式提交，失败不得留下半成品宠物、AI 元数据或安全凭据。

## 2. UI 位置和交互

### 2.1 主页导入入口

当前主页顶栏位于 `src/renderer/app/App.tsx`，结构为：

```text
左侧：主页品牌块
右侧：桌宠运行状态
```

在 `appTopbar` 右侧新增操作组，顺序固定为：

```text
[导入桌宠]  [运行状态]
```

“导入桌宠”使用现有 Lucide 图标体系，建议 `PackageOpen` 或 `Import`，显示图标和完整文字，不能只显示图标。按钮是次级操作，不抢占主页选择桌宠的主任务。

交互要求：

- 高度和顶栏现有控件一致，点击区域至少 44px。
- 有 hover、active、focus-visible 和 disabled 状态。
- 点击后由主进程打开 `.zmling` 文件选择框。
- 用户取消文件选择时不显示错误。
- 包检查超过 300ms 时显示明确的“正在检查桌宠包”状态。
- 导入成功后刷新宠物列表、自动选中新宠物并显示成功提示。
- 导入失败后保留可恢复操作，不关闭包含错误详情的向导。

不把导入入口放进左侧桌宠列表底部，因为用户已明确要求放在主页最上面，并且导入属于主页级全局操作。

### 2.2 编辑器导出入口

当前编辑器顶栏位于 `src/renderer/components/PetEditor/PetEditor.tsx`，`editorPageHeader` 已经是三列：

```text
左列：返回按钮、桌宠设置、当前栏目
中列：头像、正在编辑、宠物名称
右列：当前为空
```

导出按钮放在截图所示顶栏最右侧空白列，右对齐：

```text
左侧导航        当前宠物身份        [导出桌宠]
```

按钮文案固定为“导出桌宠”，使用 `PackageUp`、`Archive` 或 `Download` 中与现有图标最一致的一个。使用紧凑次级按钮样式，不改变中间身份卡的居中位置。

按钮启用条件：

- 当前不是尚未保存的 `new-pet`。
- 当前宠物配置已经耐久保存。
- 当前页面没有未保存修改。
- 当前宠物存在可用的 Live2D 模型入口。
- 当前没有另一个导出操作进行中。

禁用时必须给出原因：

- 新建宠物：“请先保存桌宠”。
- 有未保存修改：“请先保存当前修改再导出”。
- 无 Live2D：“请先导入 Live2D 模型”。

点击后先显示导出确认对话框，列出：

- 将包含的内容：配置、Live2D、头像、自定义主题（如有）、语音资源（如有）。
- 不包含的内容：AI API、GPT-SoVITS 程序路径、记忆、腾讯云配置。
- 版权提醒：用户必须确认拥有模型和音频的分享权。
- 预计包大小，尤其在包含 `.pth` 和 `.ckpt` 时提醒可能较大。

确认后由主进程打开保存对话框，默认文件名为：

```text
桌面灵-<经过文件名规范化的宠物名称>.zmling
```

## 3. 包格式 v1

推荐目录结构：

```text
manifest.json
pet.json
assets/
  avatar.<ext>
live2d/
  <完整原模型目录结构>
voice/
  models/
    sovits/<model>.pth
    gpt/<model>.ckpt
  reference/<audio>.<ext>
  mood/<range-id>/...
  preset/...
```

不得把整个宠物目录不加筛选地压缩。必须由导出服务根据允许清单和配置引用构建包。

### 3.1 `manifest.json`

建议共享 DTO：

```ts
interface PetPackageManifestV1 {
  kind: "zhuomianling-pet-package";
  formatVersion: 1;
  exportedAt: string;
  appVersion: string;
  pet: {
    originalPetId: string;
    name: string;
  };
  requirements: {
    ai: boolean;
    gptSoVits: boolean;
  };
  entries: Array<{
    path: string;
    size: number;
    sha256: string;
  }>;
}
```

`manifest.json` 不能包含 API、Base URL、模型服务地址、GPT-SoVITS 路径、绝对路径、记忆正文或对话。

### 3.2 `pet.json`

不要直接复制原始 `pet.local.json`。新增明确的 `PortablePetDefinitionV1`，通过白名单从 `PetDefinition` 构建。

便携配置应去除或替换：

- 去除 `id`，原 ID 仅保留在 manifest 中作为候选 ID。
- 去除原 `modelPath`，改由包内 Live2D 入口描述。
- 去除 `avatarImage` 这类运行时展开值。
- 去除 `memorySettings`。
- 去除 `uiSettings.desktopPosition`。
- 去除 `voiceInputSettings`，不携带腾讯云凭据及当前设备录音配置。
- 将 `voiceModelSettings.connected` 固定为 `false`。
- 去除 `gptSoVitsRootPath`。
- 去除 `sovitsModelPath`、`gptModelPath`、`referenceAudioPath` 的原绝对路径，改成受控包内相对引用。
- `isLocal` 不从包中信任，导入后固定为 `true`。

保留：

- 名称、描述、头像引用。
- 人设、回复语言和角色配置。
- 台词、事件、动作、表情、表现效果。
- 心情规则、区间配置和心情语音资源，但不保留当前实时心情数值。
- 字幕设置。
- UI 设置中的主题、点击穿透透明度、光标跟随、桌面比例。
- 自定义主题（仅当前选择为自定义主题时）。
- 六个内置主题只保留枚举值，必须删除残留 `customTheme`。
- Live2D 扫描结果和映射，但运行时路径需在导入后重建。
- GPT-SoVITS 的模型版本、参考文本、语言、推理设备、半精度、同步文字等非路径设置。

## 4. 导出能力检测

### 4.1 AI 检测

不能使用 `capabilities.chat` 单独判断，因为聊天 UI 存在不代表 AI 已配置。

调用现有 `getAiConnectionSummary(petId)`，只有以下条件同时成立时：

```text
存在连接摘要
Base URL 非空
model 非空
hasApiKey = true
```

才写入：

```json
"requirements": { "ai": true }
```

包内不能保存该摘要的其他字段。

### 4.2 GPT-SoVITS 检测

以下条件同时成立时写入 `gptSoVits: true`：

```ts
pet.capabilities.voiceOutput === true &&
pet.voiceModelSettings?.enabled === true
```

不能使用 `connected` 判断，因为它是运行态。

导出前复用并加强当前语音资源校验：

- `modelVersion` 属于支持枚举。
- SoVITS 文件是可读 `.pth`。
- GPT 文件是可读 `.ckpt`。
- 参考音频类型受支持且时长为 3-10 秒。
- 参考文本非空。
- 所有被引用的心情语音、预设语音文件可读。

验证通过后将资源复制到包内标准位置。原 GPT-SoVITS 程序目录永远不进入包。

### 4.3 Live2D 检测

必须包含完整 Live2D 文件夹，并支持：

- Cubism 2：`model.json`、`.moc`、贴图、`.mtn`、`.exp.json` 等。
- Cubism 4/5：`.model3.json`、`.moc3`、贴图、motion、expression、pose、physics 等。

导出服务必须从入口 JSON 扫描全部依赖，并做词法 containment 与逐层 realpath containment。遇到缺失依赖、越界、symlink/junction 或绝对外部依赖时拒绝导出，不能生成残缺包。

## 5. 导出服务实现

新增目录建议：

```text
src/main/services/petPackage/
  petPackageExportService.ts
  petPackageImportService.ts
  petPackageArchive.ts
  petPackagePaths.ts
  petPackageTransaction.ts
```

共享类型与验证：

```text
src/shared/types/petPackage.ts
src/shared/validation/petPackage.ts
```

实现要求：

- 使用流式 ZIP 写入，禁止一次性把大模型加载到内存。
- 不使用会整包读入内存的简单 ZIP 库。
- 优先选择经过审查、支持流式写入和逐 entry 读取的运行时依赖，例如 `yazl` + `yauzl`；实际添加前检查 Node/Electron 兼容性和许可证。
- 依赖必须进入 `dependencies`，不能只放 `devDependencies`。
- 输出先写同目录临时文件，完成后 `fsync`、原子 rename、同步父目录。
- 用户取消或失败时删除严格匹配的临时导出文件。
- 文件名需移除 Windows 非法字符、尾随点和空格，并设置合理长度上限。
- 压缩和写入进度必须按已处理字节数上报，不能按文件数量计算；不得输出路径和角色内容到日志。

## 6. 导入向导

导入建议使用主页级模态向导 `PetPackageImportDialog`，不要塞入 `PetEditor.tsx`。

步骤按条件动态组成：

```text
检查桌宠包
→ AI 配置（仅 requirements.ai = true）
→ GPT-SoVITS 配置（仅 requirements.gptSoVits = true）
→ 确认并安装
```

向导必须：

- 显示当前步骤和总步骤。
- 支持返回修改配置。
- 支持取消，并清理当前 import session staging。
- 错误显示在对应字段或当前步骤，不只显示通用 toast。
- 异步按钮进入 loading 并禁止重复提交。
- Escape 和关闭按钮可退出；已经填写但未提交的 API Key 只保留在当前组件内存中。
- 焦点进入对话框，关闭后返回“导入桌宠”按钮。

### 6.1 长任务进度、取消和任务栏反馈

导入导出必须提供独立进度界面。完整 Live2D 加上 `.pth`、`.ckpt` 和参考音频后，包可能达到几百 MB 或数 GB，处理时间可能从数秒增加到数分钟，不能只使用 toast 或无说明的 spinner。

进度计算原则：

- 文件压缩、复制、解压和 SHA-256 校验统一按已处理字节数计算真实进度。
- 禁止按文件数量计算百分比，因为单个模型权重可能大于其余所有文件之和。
- 导出开始前先枚举允许资源并统计总字节数。
- 导入使用 manifest 中所有 entry 的 `size` 总和作为解压和校验阶段的总量，并在读取时继续执行硬上限检查，不能盲目信任 manifest。
- 百分比必须单调递增，切换阶段时不能倒退。
- 如果操作在 300ms 内完成，可以直接显示结果，避免进度框闪烁；超过 300ms 必须显示进度反馈。

导出阶段建议：

```text
检查桌宠资源
→ 计算校验并压缩资源
→ 写入桌宠包
→ 安全保存
```

导出界面至少显示：

```text
正在导出“小桌宠”
██████████████░░░░░░ 68%
正在压缩资源
已处理 826 MB / 1.2 GB
```

导入阶段建议：

```text
读取桌宠包
→ 解压并验证文件
→ 检查 Live2D 和语音资源
→ 配置 AI / GPT-SoVITS
→ 安装桌宠
```

AI 网络探测和 GPT-SoVITS 真实合成无法准确预测完成时间。这两步不能显示虚假的持续百分比，应切换为步骤状态和不确定进度：

```text
✓ 桌宠包检查完成
✓ 资源解压完成
● 正在测试 GPT-SoVITS
○ 等待安装
```

AI/GPT-SoVITS 检测必须继续使用各自的有界 timeout。超时后显示具体阶段、错误类别和“重试”操作，不能无限旋转。

取消规则：

- 资源扫描、hash、压缩、写临时包、解压和能力测试阶段允许取消。
- 取消必须通过 `AbortController` 真实停止当前文件流、hash、ZIP reader/writer、AI 请求和本软件启动的 GPT-SoVITS 测试。
- 取消导出后删除本次严格识别的临时导出文件，原目标文件不存在时不能生成空文件。
- 取消导入后清理本次 import session staging、内存中的 API Key 和受控测试资源。
- 进入最终原子 rename、配置耐久写入和安全凭据提交阶段后暂时禁用取消，文案显示“正在完成安装，请勿关闭”。该不可取消阶段必须尽量短。
- 关闭主窗口或应用退出时，统一取消尚未进入最终提交的操作，并等待已有耐久提交完成或按事务规则回滚。

Windows 任务栏反馈：

- 在有确定百分比的压缩、写入、解压和校验阶段，使用主窗口 `BrowserWindow.setProgressBar(progress)` 同步任务栏进度。
- 不确定的 AI/GPT-SoVITS 检测阶段使用 indeterminate 模式，或保留上一步已完成状态并在窗口内显示 spinner。
- 失败时可短暂显示 error 状态，取消或完成后调用 `setProgressBar(-1)` 清除任务栏进度。
- 任务栏和窗口内进度必须来自同一主进程 operation 状态，不能分别计算。

IPC 进度事件只允许返回：

- operation ID / import session ID。
- 当前安全阶段枚举。
- 已处理字节数、总字节数和可选百分比。
- 是否允许取消。
- 成功、失败、取消状态及受控错误码。

不得通过进度事件返回本机完整路径、模型正文、角色配置、API Key、记忆或底层错误堆栈。

## 7. 导入包安全检查

选择 `.zmling` 后，主进程创建严格命名的 staging，例如：

```text
%APPDATA%/zhuomianling/pets/.importing-<uuid>/
```

放在 `pets` 同级父目录内是为了最终可以同卷原子 rename，但宠物列表扫描必须忽略 `.importing-*`。

检查项目：

- ZIP magic、中央目录和文件结束完整。
- `manifest.json` 存在且 schema/version 合法。
- entry 只能使用 `/` 分隔的规范化相对路径。
- 拒绝 `..`、绝对路径、盘符、UNC、NUL、保留设备名。
- 拒绝 symlink、junction、hardlink 语义和特殊文件。
- Windows 下拒绝大小写折叠后重复的路径。
- 拒绝重复 ZIP entry。
- 拒绝清单之外的未知顶层目录。
- 每个文件边解压边计算 SHA-256，与 manifest 比较。
- 解压后再次执行 lexical containment、realpath containment 和文件类型检查。
- `pet.json` 通过专用 portable schema 校验，不能直接交给宽松旧配置兼容逻辑。
- 扫描 JSON 字符串，拒绝 API Key 字段、秘密字段和本机绝对路径。
- Live2D 入口和所有依赖必须位于 staging 的 `live2d/`。

建议明确有界限制，并作为共享常量测试：

```text
最大压缩包：8 GiB
最大解压总量：12 GiB
最大单文件：6 GiB
最大 entry 数：10,000
最大压缩比：200:1
manifest 最大：256 KiB
pet.json 最大：1 MiB
```

如果产品预期语音权重可能超过这些边界，应调整常量和文档，不能取消边界。

应用启动时只清理格式严格、无 symlink、含有效 import marker 的 `.importing-*`；遇到未知内容必须保留并报告，不能递归误删。

## 8. pet ID 分配与路径重建

导入检查完成后先计算候选 ID：

1. manifest 中的原 ID 满足 `src/shared/validation/petId.ts` canonical 规则且未占用时保留。
2. 原 ID 非法时，根据宠物名称生成 canonical ID。
3. 已占用时追加 `-2`、`-3` 等安全后缀，直到未占用。
4. 正式提交前在 per-pet 写锁内再次检查，防止并发冲突。

资源文件本身不写 pet ID。最终提交时只需要重建：

- 正式目录名 `pets/<final-pet-id>/`。
- `pet.local.json` 中的 `id`。
- Live2D `modelPath`：`pet-resource://local/<id>/live2d/<entry>`。
- 头像资源 URL：`pet-resource://local/<id>/assets/<file>`。
- 语音模型和参考音频在正式宠物目录内的绝对主进程路径。

Live2D JSON、贴图、动作、表情、`.moc/.moc3`、`.pth`、`.ckpt` 和音频二进制文件原样复制，不进行内容替换。

## 9. AI 导入检测

仅当 `requirements.ai = true` 时显示。

字段：

- Base URL
- API Key（密码输入，可显示/隐藏）
- 模型

检测复用当前 v3 AI 能力链路：

- URL 和必填字段校验。
- 固定、无用户数据的模型列表请求。
- 选择模型后依次探测 JSON Schema、JSON Object 和兼容文本。
- 检测流式和完整回复。
- 认证、限流、服务端错误不得伪装成格式降级。
- 探测不得进入聊天、TTS 或记忆。

导入测试阶段不要提前生成宠物聊天记录或记忆。API Key 不进入 `.zmling`、日志、argv 或明文配置。

正式提交时使用最终 pet ID 调用现有安全存储和 AI 元数据服务。若之后的文件提交失败，必须调用 `deleteAiConnection(finalPetId)` 等补偿操作清理元数据和安全凭据。

## 10. GPT-SoVITS 导入检测

仅当 `requirements.gptSoVits = true` 时显示。

用户只选择 GPT-SoVITS 完整文件夹路径，例如：

```text
D:\gpt\GPT-SoVITS-v2pro
```

不要求用户重新选择 `.pth`、`.ckpt` 或参考音频，因为它们已经在包内。

检测：

- 目录存在、可读且是文件夹。
- 存在 `runtime/python.exe`。
- 存在 `api_v2.py`。
- 包内模型扩展名、模型版本、参考音频和参考文本合法。
- 参考音频时长为 3-10 秒。
- 使用包内 staging 资源生成受控临时配置。
- 尝试启动或复用 GPT-SoVITS。
- 使用固定测试文本完成一次真实合成。
- 验证返回内容是可解码音频，不只是端口可连接。

复用 `testLocalPetVoiceModelConnection` 的校验和启动能力，但不要在正式提交前把 staging 绝对路径耐久写进宠物配置。导入取消时停止本次由软件启动的测试实例，不能杀死用户自己启动的服务。

## 11. 正式存储结构

导入完成后：

```text
%APPDATA%/zhuomianling/pets/<final-pet-id>/
├─ pet.local.json
├─ assets/
│  └─ avatar.<ext>
├─ live2d/
│  └─ <完整模型目录>
└─ voice/
   ├─ models/
   │  ├─ sovits/<model>.pth
   │  └─ gpt/<model>.ckpt
   ├─ reference/<audio>.<ext>
   ├─ mood/...
   └─ preset/...
```

原始 `.zmling` 保留在用户选择的位置，应用不删除。

AI Key 进入系统安全存储；AI 非秘密元数据进入现有 AI 设置文件。GPT-SoVITS 程序仍位于用户选择的外部目录，只在导入后的 `pet.local.json` 中保存当前宠物需要的本机路径。

不创建或导入 `memory/`。

## 12. 事务提交与回滚

为每次导入建立 import session，绑定主窗口 `WebContents`、session ID 和最终候选 pet ID。renderer 不能提供 staging 路径。

推荐提交顺序：

1. 完成包检查、AI 探测和 GPT-SoVITS 探测。
2. 在 staging 内生成最终 `pet.local.json`。
3. 对 staging 做最后一次完整性和 realpath 检查。
4. 进入 final pet ID 的 per-pet 写锁。
5. 再次确认目标目录不存在。
6. 原子 rename `.importing-*` 到 `pets/<final-id>`。
7. 写入 AI 安全凭据和元数据。
8. 若 AI 写入失败，将目录改回 staging 或删除严格识别的本次新目录，并清理已写安全数据。
9. 所有步骤成功后关闭 session，广播配置变化并刷新主页。

如果选择先写 AI 再 rename，也必须实现反向补偿；关键验收标准是任何失败点都不能留下可见半成品或孤立密钥。

导出和导入的 `pet.local.json` 最终写入继续复用 `durableJsonFile.ts`，单宠物 mutation 复用 `petConfigWriteQueue.ts`。

## 13. IPC 与 preload

所有 IPC 必须在 `src/main/ipc.ts` 的统一 wrapper 注册，先校验 sender、参数数量、结构、字符串长度和对象预算。只允许主窗口调用，桌宠 preload 不得暴露。

建议通道：

```text
pet-package:export
pet-package:begin-import
pet-package:test-import-ai
pet-package:pick-gpt-sovits-root
pet-package:test-import-voice
pet-package:commit-import
pet-package:cancel-import
pet-package:progress
```

可以根据现有 API 风格合并，但必须保持职责清晰。

preload 只暴露受控方法，不暴露 Node、ZIP 路径、staging 路径或任意文件读写能力。导出结果只返回：

- 成功/取消状态
- 文件名
- 包大小
- 包含能力摘要

导入检查结果只返回：

- session ID
- 包显示名称
- 宠物名称和安全头像预览
- requirements
- 包含内容摘要
- 错误码和用户可操作信息

不向 renderer 返回解压路径、内部文件列表中的本机路径或秘密。

## 14. React 组件拆分

不要继续膨胀 `App.tsx` 和 `PetEditor.tsx`。建议新增：

```text
src/renderer/components/PetPackage/
  PetPackageImportDialog.tsx
  PetPackageImportSteps.tsx
  PetPackageExportDialog.tsx
  petPackageState.ts
```

接入点：

- `App.tsx` 只管理主页导入对话框开关、成功后刷新和选中。
- `PetSelector` 不承担导入逻辑。
- `PetEditor.tsx` 只传当前宠物、未保存状态及导出回调到导出按钮/对话框。
- 长流程状态使用 `useReducer` 或纯状态机，避免散落多个相互矛盾的 boolean。
- IPC 监听只注册一次，最新回调通过 layout effect 更新 ref。

样式按现有入口顺序新增到 `src/renderer/styles/components/` 或现有 import surface 文件，不能破坏 `styles.css` 的 unlayered import 顺序和 Apple material 最终覆盖顺序。

## 15. 测试计划

### 15.1 共享 schema

- v1 manifest 正常解析。
- 未知版本、未知 kind、超长字符串、对象超预算被拒绝。
- portable pet 不允许 memory、secret、绝对路径。
- 内置主题仅保留枚举且无 `customTheme`。
- 自定义主题经过现有规范化后保留。

### 15.2 导出

- 无 AI、无语音桌宠。
- 无 AI、无语音桌宠。
- 仅 AI、仅语音、AI + 语音。
- Cubism 2 和 Cubism 4/5 完整依赖。
- 缺贴图、motion、expression、pose、physics 时受控失败。
- Live2D symlink/junction 越界被拒绝。
- `.pth`、`.ckpt`、参考音频正确进入包。
- API、Base URL、GPT-SoVITS 根目录、memory、腾讯云字段不出现在 ZIP 字节或 JSON 中。
- 内置主题不携带定义；自定义主题完整携带。
- 大文件流式导出，内存不随文件大小线性增长。
- 用户取消、磁盘满、只读目录、rename 失败时不留下正式包。

### 15.3 导入安全

- 非 ZIP、截断 ZIP、错误 hash、重复 entry。
- `../`、绝对路径、UNC、盘符、NUL、保留设备名。
- symlink/junction、大小写碰撞、未知顶层目录。
- entry 数量、单文件、总量、压缩比超限。
- manifest 与实际 voice requirement 不一致。
- Live2D 依赖缺失或越界。
- 包中藏有 API、memory 或绝对路径时拒绝。

### 15.4 能力向导

- requirements 都为 false 时直接进入确认。
- 仅 AI 时只出现 AI 步骤。
- 仅 GPT-SoVITS 时只出现语音步骤。
- 两者都有时顺序正确。
- AI 认证、限流、服务端、格式能力失败正确分类。
- GPT 根目录缺 `runtime/python.exe` 或 `api_v2.py` 时就地报错。
- 真实语音测试失败时不能提交。
- 腾讯云配置永远不出现。

### 15.5 pet ID 与事务

- 原 ID 未占用时保留。
- 冲突时生成 `-2`、`-3`。
- 非 canonical 原 ID 根据名称生成。
- 最终 `pet-resource://` URL 使用新 ID。
- AI 元数据和安全凭据使用新 ID。
- 任一提交步骤失败时目录、AI 元数据和密钥全部回滚。
- 应用崩溃后只清理可确认属于导入 staging 的目录。

### 15.6 UI 与可访问性

- 主页顶栏导入按钮键盘可达并有可见焦点。
- 编辑器右侧导出按钮不破坏中间身份卡居中。
- 920px 最小窗口宽度下不溢出。
- loading、disabled、error、success 状态完整。
- 大文件导入导出显示按字节计算且单调递增的真实进度。
- AI/GPT-SoVITS 检测使用步骤状态，不显示虚假百分比，并能在 timeout 后重试。
- 可取消阶段会真实中止文件流和请求并清理临时文件；最终提交阶段正确禁用取消。
- Windows 任务栏进度与窗口内状态同步，完成、失败或取消后正确清除。
- 对话框焦点圈闭、Escape、关闭后焦点恢复。
- 不仅依赖颜色表示步骤或错误。
- `prefers-reduced-motion` 下无非必要动画。

## 16. 实施顺序

### 阶段 A：协议和纯验证

1. 新增 manifest、portable pet、IPC DTO 类型。
2. 新增严格 schema、大小预算、路径和 ID 重建纯函数。
3. 写完共享单元测试。

### 阶段 B：流式归档与导出

1. 选定流式 ZIP 依赖并记录许可证。
2. 实现资源枚举、Live2D 依赖检查、主题清理、AI/语音 requirement 检测。
3. 实现临时文件、hash、原子保存和进度。
4. 写导出与敏感信息泄漏回归测试。

### 阶段 C：安全导入和 staging

1. 实现 ZIP entry 安全检查和有界解压。
2. 实现 import session、staging 生命周期、启动清理。
3. 实现 portable 配置到最终 `PetDefinition` 的物化和路径重建。
4. 写恶意包、ID 冲突和崩溃恢复测试。

### 阶段 D：AI、GPT-SoVITS 和事务提交

1. 接入 AI 固定探测，不提前持久化秘密。
2. 接入 GPT 根目录选择和真实合成测试。
3. 实现最终 rename、AI 写入和补偿回滚。
4. 写故障注入测试。

### 阶段 E：IPC、preload 和 UI

1. 在统一 wrapper 注册主窗口专属 IPC。
2. 扩展主窗口 preload，桌宠 preload 保持不变。
3. 在主页顶栏右侧加入“导入桌宠”。
4. 在编辑器顶栏右侧空白列加入“导出桌宠”。
5. 新增独立导入向导和导出确认对话框。
6. 接入刷新、选中、toast、焦点和进度状态。

### 阶段 F：完整验证和文档

1. `npm run typecheck`。
2. `npm test`。
3. `npm run build` 和发布资源检查。
4. 使用 Cubism 2、Cubism 4/5、带自定义主题、带语音的大包做真实往返。
5. 在全新 `%APPDATA%/zhuomianling` 测试首次导入。
6. 验证打包版，不只验证 Vite dev。
7. 更新 `docs/user-guide.md` 和资源政策文档，明确 `.zmling` 不是加密或 DRM，用户必须拥有分享权。

## 17. 完成定义

只有满足以下全部条件才算完成：

- 用户能从主页最上方选择 `.zmling` 并完成导入。
- 用户能从编辑器顶栏右侧导出当前已保存桌宠。
- Live2D、头像、角色配置、自定义主题和允许的语音资源能完整往返。
- 六个内置主题不复制主题定义，导入后视觉一致。
- API、AI 连接信息、腾讯云、GPT-SoVITS 程序路径和记忆不会进入包。
- 需要 AI/语音时导入向导准确出现，缺少时准确跳过。
- GPT-SoVITS 必须经过真实合成检测。
- pet ID 冲突安全解决，资源 URL 和外部绑定使用最终 ID。
- 导入后文件位于 `%APPDATA%/zhuomianling/pets/<final-id>/`。
- 失败、取消、崩溃不会留下半成品、孤立密钥或不安全 staging。
- 大文件操作有按字节计算的进度、阶段说明、受控取消和 Windows 任务栏反馈。
- 所有新增 IPC 只对主窗口开放并通过统一校验 wrapper。
- 全量类型检查、单元测试、构建和打包验证通过。
