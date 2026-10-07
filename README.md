# Project Wiki Server

[![CI](https://github.com/xzhaoquan0512-ai/project_wiki_server/actions/workflows/ci.yml/badge.svg)](https://github.com/xzhaoquan0512-ai/project_wiki_server/actions/workflows/ci.yml)

独立的知识与工程上下文 MCP 服务，当前版本 **0.3.0**。知识服务提供 **24 个工具**，工程服务提供 **8 个工具**。服务代码、知识资料与工程配置分别管理；通用部署包提供空库模板和空工程列表，真实运行数据单独保存。

## 快速开始

需要 Node.js >=20（部署时选仍受支持的 LTS）和 npm；Git 查询需要安装 Git，旧工程后端另需 Python。

```sh
npm ci --ignore-scripts
npm run doctor
npm run init:vault
npm test
npm run smoke
```

`init:vault` 只创建新库，目标存在时拒绝覆盖。当前交付目录已经初始化，可直接执行 `npm test` 和 `npm run smoke`；**新克隆的仓库没有 `data/`（它被 `.gitignore` 排除），必须先执行 `npm run init:vault`**，否则 `npm test` 和 `npm run smoke` 会因找不到默认库而报 `ENOENT`。解压干净部署包后再执行完整步骤，CI 也按这个顺序执行。

`doctor` 检查本机解析库、图片原生模块及随依赖安装的中英文 OCR 模型，不进行 OCR、不下载模型、不转换文档。缺少可选 LibreOffice 不影响其他格式；`npm run doctor -- --require-legacy` 则要求旧版 Word/PowerPoint 的转换程序可用。

```sh
node bin/project-wiki-server.mjs wiki
node bin/project-wiki-server.mjs project
```

这两条命令分别通过 stdio 等待 MCP 请求。客户端模板见 [Codex TOML](examples/codex.toml) 和 [通用 MCP JSON](examples/mcp.json)。执行 `npm run tools` 可通过真实 MCP 工具发现查看完整参数；该命令使用临时库，不改正式数据。`npm run panel` 另外启动本地管理面板（只读视图，见下文），不影响这两个 MCP 进程。

## 知识工具：24 个

| 工具 | 用途 |
| --- | --- |
| `wiki_read_rules` | 读取知识整理规范；另提供 `wiki://rules` 资源 |
| `wiki_read_index` | 查看当前知识目录，默认隐藏归档笔记 |
| `wiki_search` | 检索标题、别名、标签、摘要和正文 |
| `wiki_read_note` | 读取笔记、出处、关联、反链和当前 `revision` |
| `wiki_write_note` | 创建或更新笔记，检查来源并自动记录历史、索引和日志 |
| `wiki_append_log` | 补充查询、研究等维护记录 |
| `wiki_status` | 查看活跃/归档笔记及原始资料数量 |
| `wiki_lint` | 检查重名、断链及孤立笔记 |
| `wiki_import_source` | 导入文本或 base64 文件，原件只新增、按 SHA-256 去重 |
| `wiki_register_source` | 登记已放入 `raw/` 的文件和版本指纹 |
| `wiki_list_sources` | 分页列出已登记/未登记资料及完整性状态 |
| `wiki_read_source` | 读取文本原文、清洗 HTML/XML，提取 Office 正文，识别 PDF 扫描页和图片文字 |
| `wiki_check_sources` | 检查资料变化、丢失、新版本及受影响的笔记 |
| `wiki_note_history` | 查看版本列表，或读取某个版本的完整正文 |
| `wiki_restore_note` | 恢复历史内容，或撤销归档 |
| `wiki_rename_note` | 改标题并更新引用，保留原路径及旧标题别名 |
| `wiki_merge_notes` | 保存合并后的正文、合并来源、更新引用并归档旧笔记 |
| `wiki_archive_note` | 归档而不删除，保留出处和可恢复历史 |
| `wiki_rebuild_index` | 显式重建磁盘索引，保留生成区域外的手工文字 |
| `wiki_search_sources` | 在已索引的 PDF 文字中检索，返回原件哈希和物理页码 |
| `wiki_source_outline` | 分页读取 PDF 书签与对应页码，书签不代表已完成摘要 |
| `wiki_index_status` | 查看全文索引覆盖、文字稀少页和截断页 |
| `wiki_compile_queue` | 查看按原件哈希划分的整理任务，笔记修改后回到待复核 |
| `wiki_record_compilation` | 记录实际阅读范围、产出笔记与版本；保留审计和并发检查 |

## 从资料整理成笔记

1. 新资料调用 `wiki_import_source`，传 `filename` 和 `text` 或 `base64`（二选一）。已经放在服务器 `raw/` 中的文件用 `wiki_register_source`，例如 `{"path":"raw/guide.pdf"}`。
2. 返回的 `id` 是 `source:<sha256>`。用 `wiki_read_source` 读取原文，保留页码、行号、段落/工作表/幻灯片等定位信息与来源哈希；已有笔记先检索再更新。
3. `wiki_write_note` 的 `frontmatter.sources` 填来源 ID 或已登记的 `raw/` 相对路径，正文用 `[[笔记标题]]` 关联。服务保存来源版本快照。
4. 新版资料另行导入，并传 `previous` 指向旧来源；用 `wiki_check_sources` 找到需要复核的笔记。服务不改写旧原件，也不自动把旧结论改成新结论。

例如首次整理的工具参数：

```json
{
  "category": "concepts",
  "title": "某项原理",
  "content": "# 某项原理\n\n根据原文整理的解释、适用范围和待核对事项。",
  "frontmatter": {
    "sources": ["raw/guide.pdf"],
    "review_status": "draft",
    "scope": "注明适用设备、版本或场景"
  }
}
```

这里的 `raw/guide.pdf` 必须已经登记。草稿允许暂时没有来源；声明 `review_status: reviewed` 必须提供来源、适用范围 `scope` 和复核说明 `review_note`，它只记录调用者的复核声明，不等于服务器证明技术结论正确。外部 HTTP/HTTPS/npm 来源不会自动下载或验证，记录为 `external_unchecked`。

原件默认上限为 **20 MiB**；可由启动环境 `PROJECT_WIKI_MAX_SOURCE_MIB` 设置为 1～64 的整数。本次服务器设为 32，以接收完整的 RM0090（20.4 MiB），提取输出、像素与超时限制仍独立有效。重复导入可为同一内容补齐尚未登记的 `previous`；已有不同前驱、自指或循环关系会被拒绝，不静默修改版本链。文字提取与知识整理是两步；服务不自动调用大模型整理资料。

### 可以提取哪些资料

| 资料 | 提取内容与定位 | 主要限制 |
| --- | --- | --- |
| TXT、Markdown、CSV、JSON、YAML、代码等文本 | 解码后的原文，行号/字符位置 | 自动采用 BOM、文档编码声明或严格 UTF-8；其他编码需明确指定 |
| HTML、HTM | 标题、段落、列表、表格、图片替代文字；DOM 路径及源行号 | 清除脚本、样式、导航、表单及隐藏元素；不加载链接、CSS 或远程资源，不是网页截图 |
| XML | 按原顺序读取属性、文本及 CDATA；元素/属性路径 | 禁止 DTD、自定义实体和外部实体；命名空间前缀保留 |
| 普通 PDF | 文字层，按页定位 | 不保证表格、公式、图示或版面完整还原 |
| 扫描版 PDF | 本地 OCR，按页定位；与已有文字层分别记录 | 自动模式按文字层多少判断，混合图文页可能需要 `ocr: force`；OCR 结果需核对 |
| PNG、JPEG、WebP、BMP、TIFF | 本地中英文 OCR；图像/帧定位 | TIFF 只读取首帧；图片上限 1600 万像素、单边 16000 像素；识别时可能缩小 |
| Word DOCX | 段落、表格，以及文档关联的页眉页脚、脚注、尾注和批注 | 不还原分页，嵌图、公式及嵌入对象不识别 |
| Excel XLSX、XLS | 工作表、行及单元格位置，文字、存储值、公式和已有缓存值 | 不执行公式或宏，不刷新外部数据；缓存值可能过时，图表和嵌图不 OCR；旧 XLS 每表最多前 10000 行 |
| PowerPoint PPTX | 按幻灯片顺序提取文字、表格和演讲者备注 | 不识别嵌图或图表，不还原视觉排版 |
| 旧 Word DOC、旧 PowerPoint PPT | 由本地 LibreOffice 转成 DOCX/PPTX 后提取 | 需另装 LibreOffice 并配置绝对路径，转换可能改变版式 |
| 音频、视频、普通压缩包 | 可以保存登记 | 本版不做转录、视频分析或通用解包提取 |

Office 文件只解析已知文档结构，不沿原生解析中的外链下载内容。Office 内的图片、图表没有自动 OCR；需要时把图片作为独立原件导入。OCR 支持英文、简体中文及两者组合，不是准确性证明，手写字、表格、公式和低清晰度资料尤其需要对照原件。没有提取文字也不代表原件没有内容。

### 读取、定位与续读

所有读取都要给 `reference`（来源 ID 或已登记 `raw/` 路径）。`max_chars` 限制正文字符数，默认 12000、最高 50000；定位信息与受限元数据另计。`unit_count` 默认 10、最多 100。不同格式的定位参数不能混用；续读时保留原来的编码、OCR 模式及语言选项。

| 格式 | 定位方式 | 续读 |
| --- | --- | --- |
| 普通文本；HTML/XML 的 `view: raw` | `start_line` 或 `offset` | 返回的 `next_offset` |
| PDF | `page`、`page_count`（最多 5 页）、`page_offset` | 返回的 `next` |
| Office、图片、清洗后的 HTML/XML | `unit`、`unit_count`、`unit_offset` | 返回的 `next`；每单元附原件定位信息 |

HTML/XML 默认清洗提取，`view: "raw"` 返回解码后的源文本。自动编码只采信 UTF-8/UTF-16 BOM、HTML charset/XML encoding 声明，或严格 UTF-8 检验；无法确认时不会猜测，可用 `encoding: "gb18030"`、`"gbk"`、`"utf-16le"` 等明确指定。UTF-32 暂不支持。

PDF 的 `ocr` 取 `auto`（默认）、`off` 或 `force`。`auto` 在该页文字层少于 20 个非空白字符时启用 OCR；包含较多文字和扫描图块的页可用 `force`。OCR 不与文字层混成一个来源，返回值标明提取方法和已有文字层的字符数；如需读取文字层，用同一页码加 `ocr: "off"` 单独分页读取。`languages` 取 `eng+chi_sim`（默认）、`eng` 或 `chi_sim`；安装依赖后，识别使用本地模型，不访问模型 CDN。

例如读取 Word、指定中文旧编码和强制识别 PDF 的参数：

```jsonl
{"reference":"raw/guide.docx","unit":1,"unit_count":5,"max_chars":12000}
{"reference":"raw/page.html","encoding":"gb18030","unit":1}
{"reference":"raw/scan.pdf","page":1,"ocr":"force","languages":"eng+chi_sim"}
```

提取在有超时限制的独立进程中运行，并限制节点数、解包体积、图片尺寸及输出。单个服务进程串行提取，最多接受 8 个进行中/排队请求；排队最多等 60 秒，过期任务不会再启动。PDF/图片提取最多执行 60 秒，Office/HTML/XML 最多 90 秒。PDF 最多 2000 页，单次正文和保留文字层合计最多 4 MiB。Office/HTML/XML 提取最多 10000 个单元，正文最多 4 MiB；遇到限制会给出截断状态或错误，不能把截断内容当成整份资料。分页只在已提取结果中续读，不会绕过提取上限。

被截断的单元会在自身定位信息中标记 `truncated: true` 并给出 `truncation_reason`，全局 `metadata.truncated` 只说明发生过截断。因此可以判断是哪一段证据被切短；若达到单元数或总字节上限而后续内容被整体省略，则只有全局标记和 warning 说明原因。

提取缓存保存在 vault 的 `.wiki-server/extractions/`，以原件内容哈希和提取选项区分（页码、OCR 模式、语言、编码等选项都参与键）。缓存是派生数据；停止知识服务后可以清理这个子目录，下次读取会重建。不要因此删除 `.wiki-server/` 的其他内容：来源登记、笔记历史和事务恢复信息不属于可随意清理的缓存。

## 修改、历史和恢复

更新已有笔记前先调用 `wiki_read_note`，将返回的 `revision` 原样作为 `expected_revision`。版本不一致时拒绝写入并返回 `REVISION_CONFLICT` 和当前版本；重新阅读、合并后再提交。

```json
{
  "category": "concepts",
  "title": "某项原理",
  "expected_revision": "替换为刚读到的64位哈希",
  "content": "更新后的完整正文"
}
```

历史从首次由本服务维护时开始保存。`wiki_note_history` 可列出版本；传入 `revision` 可查看当时正文。`wiki_restore_note` 同时需要要恢复的 `revision` 和当前 `expected_revision`。归档工具返回的 `restore_revision` 可用来撤销归档。

如果文件被外部误删，用原来完整的 `wiki/concepts/某项原理.md` 路径查历史，并以 `expected_revision: null` 恢复。它表示“文件必须仍然缺失”；如果已有新文件，恢复会拒绝覆盖。删除文件后不能仅凭标题猜测历史位置。

重命名保持物理文件路径稳定，旧标题成为别名，其他笔记中的 wikilinks 同步更新；代码块和 URL 中的文字不作为引用改写。合并时由调用者提供整理后的 `content`，并提供 `source_revision`、`target_revision`；服务不会自动决定怎样合并知识结论。合并会保留来源笔记并归档。

笔记、来源登记、索引和审计使用统一的跨进程写锁与事务记录。中途失败时保留 journal，下次相关工具调用在锁内检查并完成；如果文件被外部改动，停止恢复并报告冲突。任意外部编辑器不会遵守服务锁，批量外部编辑期间应暂停写入客户端。

进程崩溃后写锁不会按时间自动抢占，可在服务所在机器检查：

```sh
node bin/project-wiki-server.mjs lock-status /path/to/vault
node bin/project-wiki-server.mjs recover-lock /path/to/vault
```

恢复命令仅在锁来自同一主机且原进程明确不存在时移除锁；活进程、不同主机或无法判断时拒绝。随后调用知识工具恢复待完成事务。备份应在停止写入后保存整个 vault，包括隐藏的 `.wiki-server/`，否则无法保留历史、来源登记及恢复记录。

## 本地管理面板

面板是一个只在本机运行的 HTTP 服务，用浏览器查看知识库现状。它不替代知识工具，也不编辑知识：没有笔记编辑、资料导入、归档/合并/重命名/恢复版本，也没有任意命令、构建或部署。

```sh
npm run panel
node bin/project-wiki-server.mjs panel /absolute/path/vault --port=8790
```

`--port=0` 让系统分配空闲端口，`--host` 改变监听地址。**面板没有身份验证**，因此默认只绑定 `127.0.0.1`；绑定其他地址必须显式加 `--allow-remote`，那等于让能访问该端口的人读到这台机器上的知识。面板用固定的资源表提供页面，不把请求路径映射到文件系统，并拒绝跨源请求。

| 标签 | 内容 | 是否取写锁 |
| --- | --- | --- |
| 概览 | 库路径与版本、笔记与原件计数、写锁归属、未被引用的原件 | 状态读取取锁 |
| 笔记 | 目录/检索、单篇正文与出处、出链反链、历史版本只读预览 | 打开笔记与历史取锁，列表不取锁 |
| 原始资料 | `raw/` 清单、登记与完整性、一致性检查 | 检查取锁，清单不取锁 |
| 审计 | `wiki_lint` 与 `wiki_check_sources` 的结果 | 取锁 |
| 维护 | 重建索引、恢复写锁、日志尾部 | 取锁 |
| 目录与规范 | `wiki/index.md` 预览（只在内存渲染，不写入）与库内 `AGENTS.md` | 取锁 |

面板只调用 `NoteStore`、`SourceStore` 和写锁管理已有的接口，因此与 MCP 工具共享同一把跨进程写锁、同一套事务恢复和同样的判定口径：需要一致快照的读取在写锁被占用时返回 `VAULT_LOCKED`（HTTP 409）而不是猜测内容，读取过程中也可能完成此前已计划的待恢复事务（与 MCP 工具一致）。面板不轮询，避免持续争抢写锁。正文和原件按原文展示，界面把库里的每个值都当文本插入，不渲染资料里的 HTML，也不把资料内容当成执行授权。

面板提供的写入只有两个，都需要界面二次确认、并以 `{"confirm":true}` 提交：

- **重建索引**：重写 `wiki/index.md` 的生成区域并追加一行 `wiki/log.md`，不触碰任何笔记正文。
- **恢复写锁**：只在锁来自本机且持有进程确实不存在时移除锁；活进程、不同主机或无法判断时拒绝。

### 部署到服务器

服务器上不要把面板端口对外开放：它没有身份验证，能连上就等于能读整个知识库。推荐让它只监听回环地址，用 SSH 隧道访问：

```sh
# 服务器：安装为常驻服务，只绑定 127.0.0.1
sed -e 's|__SERVICE_ROOT__|/home/ubuntu/project-wiki-server|g' \
    -e 's|__VAULT__|/home/ubuntu/project-wiki-server/data/vault|g' \
    -e 's|__NODE__|/usr/bin/node|g' -e 's|__USER__|ubuntu|g' \
    deploy/systemd/project-wiki-panel.service.in \
  | sudo tee /etc/systemd/system/project-wiki-panel.service
sudo systemctl daemon-reload && sudo systemctl enable --now project-wiki-panel

# 本机：建立隧道后打开 http://127.0.0.1:8790/
ssh -N -L 8790:127.0.0.1:8790 <user>@<host>
```

`deploy/ssh/start-panel.sh` 与 MCP 启动脚本同样读取 `PROJECT_WIKI_NODE`、`PROJECT_WIKI_VAULT`、`PROJECT_WIKI_PANEL_HOST`、`PROJECT_WIKI_PANEL_PORT`，默认 `127.0.0.1:8790`；只有显式设置 `PROJECT_WIKI_PANEL_ALLOW_REMOTE=1` 才会绑定非回环地址，模板 unit 不设置它。面板与 MCP 进程各自独立，互不依赖。

## 工程工具：8 个

| 工具 | 用途 |
| --- | --- |
| `project_list` | 列出登记项目、实际适配器及支持的能力/限制 |
| `project_begin` | 为新任务建立查询会话 |
| `project_search` | 检索工程文本或工程 Wiki |
| `project_read` | 按该适配器支持的路径、行或其他定位方式读取 |
| `project_evidence` | 读取已有验证报告，保留其历史证据性质 |
| `project_git_status` | 固定参数读取 Git 分支、提交和工作区变化 |
| `project_session_status` | 查看会话用量及继续查询的信息 |
| `project_adjust_budget` | 带原因调整原会话预算，保留累计用量 |

### 接入普通工程

在 [config/projects.json](config/projects.json) 添加真实目录；交付配置默认是 `{"projects":[]}`。示例：

```json
{
  "projects": [
    {
      "id": "my-project",
      "root": "/absolute/path/to/project",
      "adapter": "generic"
    }
  ]
}
```

Windows 路径可写为 `D:/Code/my-project`。`adapter` 有三个选项：

| 值 | 行为 |
| --- | --- |
| `generic` | 直接查询普通文件/Git 工程，不需要工程内安装脚本 |
| `context_session` | 使用目标工程已有的 `tools/docs/context_session.py` 协议 |
| `auto`（默认） | 有上述脚本则用原后端，否则用 generic |

完整示例见 [projects.example.json](config/projects.example.json)，不要把不存在的示例工程直接登记。修改配置后重新启动工程 MCP 进程。

`context_session` 后端需要 Python 3。未配置 `python` 时，Windows 使用 `python`，Linux/WSL/macOS 使用 `python3`。可在工程条目中设置 `"python": "/absolute/path/to/python3"` 指定解释器；显式配置始终优先，路径无效会报错，不会自动换用其他解释器。

通用适配器使用 UTF-8 文本和大小写不敏感的字面检索。`kind: docs` 检索允许的源码/文档，`kind: wiki` 仅检索 `wiki/` 和 `docs/wiki/`。会排除生成目录、隐藏目录、依赖、二进制和已知凭据文件；精确限制可在 `project_list.capabilities` 查看。每个文件最多 1 MiB，单次检索最多 8 MiB、2000 个文件和 500 个命中，达到限制会明确返回截断信息。

先 `project_begin`，再沿同一个 `session_id` 读取规则、检索和查询。正文带 SHA-256、读取时间与行列位置，返回 `next_arguments` 时结合原 `project_id/session_id` 继续。`snapshot_id` 表示同一份缓存的历史内容，续读不会悄悄换成改过的新文件；要检查最新版本需发起新读取，可传 `expected_hash` 比较。缓存最多 8 份或 4 MiB，被清理后会报错而不是自动切换内容。

`generic` 仅支持 `query` profile；不支持原后端专用的文档 ID、section、JSON pointer、输出流选择等参数，传入时明确报错。原 `context_session` 适配器保持其会话、定位、可信状态、预算和续读语义。

`context_session` 的返回正文在 `backend` 中，字段沿用目标后端协议。例如后端以 `backend.session` 返回会话 ID 时，将该值作为后续工具的 `session_id`；不要假定它与 `generic` 的 `backend.session_id` 同名。`backend.result.next_line/next_column/next_offset` 等续读字段和 `confidence/freshness/validation` 等状态也按原样保留。续读字段按该次操作实际返回的内容为准：`read`/`search` 给大纲与 `next_offset`，`run`（`project_git_status`）给预览的 `next_line`/`next_column`；服务不假定某个操作一定有某组字段。

`project_evidence` 的文件类型也由适配器决定：`generic` 可读取普通 UTF-8 报告，`context_session` 使用后端支持的正式 RUN/EVD 记录。普通 JSON 报告使用 `project_read`，用 `pointer` 定位所需值。读取成功只证明取得了历史证据，不代表重跑了报告中的检查。

`project_git_status` 默认等待 Git 最多 20 秒。WSL 挂载盘或较大工程可传 `timeout_seconds`（整数，1–120）延长等待；`context_session` 外层进程额外留 10 秒保存回执。客户端的请求超时也应大于这段时间。超时仍返回失败，不能当成工作区干净或查询成功。

`context_session` 的 `project_git_status` 把固定的只读命令 `git status --porcelain=v2 --branch --untracked-files=normal` 写成工程内 `build/docs/mcp/argv/` 下的请求文件交给后端。该文件按调用唯一命名，避免多个 MCP 进程互相覆盖，并在调用结束（含超时、失败）后由服务删除，不留下每次查询的遗留文件；后端会把实际 argv 复制进自己的 capture 目录。

该适配器与本服务之间的接口有回归测试覆盖：`test/context-session.test.mjs` 会生成一个最小的 Python 后端（实现同样的子命令与参数），并断言适配器实际发出的 `--session/--max-chars/--profile/--budget/--reason/--kind/--query/--path/--section/--pointer/--start-line/--command-index/--stream/--argv-file` 等参数、JSON 契约、同一 session 的串行化，以及"非 JSON 输出""非零退出但带回执""无输出"三类失败路径。测试不依赖任何具体工程的 `context_session.py`，只要求本机有 Python；缺少 Python 时按用例粒度跳过并给出原因。适配器本身不校验也不探测后端版本，接口不一致会在调用时以明确错误暴露。

除 fixture 用例外，还有一条默认跳过的真实工程端到端用例 `test/real-project.test.mjs`。设置 `PROJECT_WIKI_REAL_PROJECT` 为本机自带 `tools/docs/context_session.py` 的工程绝对路径后，运行 `node --test test/real-project.test.mjs`。它用同一 query 会话（显式预算 96000 字符）先完整读取 `AGENTS.md`；`PROJECT_WIKI_REAL_RULES` 可用 JSON 字符串数组指定工程要求的其他启动规则路径，按顺序读取并跟随行、列续读，规则缺失或未读完会失败。操作者需先核对目标工程的启动要求并配置这些路径，测试不会解释规则文本或执行其中的命令。

`PROJECT_WIKI_REAL_QUERY`／`PROJECT_WIKI_REAL_PATH`／`PROJECT_WIKI_REAL_EVIDENCE` 分别指定已有检索词、要读取前 40 行的文件与 RUN/EVD 记录；文件读取会跟随截断续页。`PROJECT_WIKI_REAL_PYTHON` 可指定后端解释器，`PROJECT_WIKI_REAL_GIT_TIMEOUT`（默认 30 秒）设置 Git 等待时间，挂载盘或大工程可调至 120 秒。测试核对会话往返、capture 中的 Git 命令与等待时间、预算调整不清空累计、路径与选择器拒绝，以及查询后的请求文件清理。未配置工程、路径不存在、缺少后端脚本或没有解释器时按用例粒度跳过并说明原因；跳过不代表真实联调通过。仓库内不保存工程路径、资料正文、会话或证据内容。Windows 与 WSL 各运行一次可检查两个平台的默认解释器与路径行为。

通用会话保存在服务的 `data/project-sessions/`，可用 `PROJECT_WIKI_STATE` 指向其他绝对目录，必须位于所有登记工程之外；若查询本服务源码本身，也要把会话目录设到外部。通用会话计入整个返回 JSON 的 UTF-16 字符数，传输协议开销另算；原后端保留其预算口径。两个口径都不代表模型实际 token 用量。

工程接口不提供源码编辑、任意命令、构建或烧录。普通目录即使不是 Git 仓库，也能检索和读取文件；Git 状态会明确报告不可用。读取历史测试报告不会重新运行测试，各次文件读取也不是整个工程的一致快照。

### 将工程经验整理回知识库

AI 可组合 `project_read/project_evidence/project_git_status` 与知识写入工具。笔记 `frontmatter.provenance` 支持项目标识、提交、工作区是否有修改、文件位置/哈希、证据时间及适用范围：

```json
{
  "project_id": "my-project",
  "commit": "实际提交ID",
  "dirty": true,
  "file": "docs/result.md",
  "evidence_at": "实际证据产生时间",
  "scope": "该提交及上述条件"
}
```

这是出处记录，服务不会自动核验远端项目或把声明改成“已验证”。重要工程证据还可另存原始快照并登记为 source，保持可读、可复核。

## 目录与部署

```text
bin/                 启动、工具发现、打包命令
src/                 两套 MCP、资料与笔记维护、工程适配器、管理面板服务
config/              工程注册配置
examples/            客户端配置模板
templates/vault/     新知识库的整理规范
templates/panel/     管理面板的单页界面（无构建步骤）
data/vault/raw/      不可改写的原始资料
data/vault/wiki/     笔记、目录及审计日志
data/vault/.wiki-server/  来源登记、历史、事务及锁
data/vault/.wiki-server/extractions/  可重建的资料提取缓存
data/project-sessions/  通用工程查询会话与分页缓存
deploy/ssh/          Linux SSH 启动脚本（wiki、project、panel）
deploy/systemd/      面板常驻服务模板
test/                临时库、实际 stdio、冲突与恢复测试
dist/                生成的干净部署包
```

`PROJECT_WIKI_VAULT` 指定知识库，`PROJECT_WIKI_CONFIG` 指定工程注册文件，`PROJECT_WIKI_STATE` 指定通用查询会话目录，`PROJECT_WIKI_LIBREOFFICE` 指定 `soffice` 可执行文件，`PROJECT_WIKI_MAX_SOURCE_MIB` 指定单个原件上限（1～64 MiB，默认 20）；也可直接给启动命令传路径。**`PROJECT_WIKI_VAULT`、`PROJECT_WIKI_CONFIG` 和 `PROJECT_WIKI_LIBREOFFICE` 必须是绝对路径**：前两者含相对值会被拒绝，因为相对路径会跟着 MCP 客户端的当前目录变化；后者在提取旧格式时按绝对可执行文件校验，相对值会报错。`PROJECT_WIKI_STATE` 允许相对值，但会相对**服务目录**（而不是客户端目录）解析，配置时仍应写成绝对路径，且必须位于所有登记工程之外。`PROJECT_WIKI_MAX_SOURCE_MIB` 取 1～64 以外的整数会在启动时直接报错，不会被静默忽略。未设置时默认位置固定在服务目录下（`data/vault`、`config/projects.json`）。现有空库的 AGENTS.md 不会自动覆盖；升级时可对照 templates/vault/AGENTS.md 人工合并规范。

执行 `npm run bundle` 得到 `dist/project-wiki-server.tar.gz` 和 SHA-256 文件。打包仅包含明确列出的源码、锁文件、模板及空工程配置，不包含运行资料、真实工程注册、node_modules 或凭据。归档时统一写入权限位（文件 0644、脚本 0755），因此以 root 解压也不会得到全局可写的代码。打包依赖本机 Python 3 写归档（平台 `tar` 无法指定权限模式，Windows 的 `tar.exe` 尤其如此）。

在 Linux 解压、安装依赖、初始化空库或指定已有库后，通过 SSH 执行 `bash /path/to/service/deploy/ssh/start-wiki.sh`。`PROJECT_WIKI_NODE` 可指定远端 Node 路径；`PROJECT_WIKI_LIBREOFFICE` 与 `PROJECT_WIKI_STATE` 会在启动脚本中显式导出，因为非交互 SSH 不会加载登录 profile。

客户端通过 SSH 连接远端服务时有一个 Windows 特有的坑：MCP SDK 的 stdio 传输只继承一份固定白名单环境变量，**其中不含 `ProgramData`**，而 Windows 版 `ssh` 缺少它会以 255 退出且不打印任何信息，客户端只看到 `MCP error -32000: Connection closed`。因此这类配置必须在客户端的 `env` 中补上 `ProgramData`（见 examples/ 模板），并使用无口令密钥或 `SSH_ASKPASS`，否则 ssh 无法在无 TTY 环境下完成认证。

### Linux 上启用所有文档格式

Node.js >=20 环境执行 `npm ci --ignore-scripts` 后，现代 Office、文本、HTML/XML、PDF 和图片 OCR 的依赖与中英文模型一起安装。不要用 `--omit=optional` 排除图片原生模块需要的平台包。安装依赖可能访问 npm/SheetJS 下载地址，安装完成后的 OCR 不需要外网下载模型；将整个运行环境预先准备好才能离线安装。每个平台需要安装自己的依赖，不能直接复制 Windows 的 `node_modules` 到 Linux。

只有旧 `.doc`/`.ppt` 额外需要 LibreOffice。Ubuntu/Debian 可安装 Writer、Impress 和中文字库，然后将本机实际可执行文件的绝对路径传给知识服务：

```sh
sudo apt update
sudo apt install libreoffice-writer libreoffice-impress fonts-noto-cjk
export PROJECT_WIKI_LIBREOFFICE=/usr/bin/soffice
npm run doctor -- --require-legacy
bash /path/to/service/deploy/ssh/start-wiki.sh
```

若安装位置不同，请调整路径。Windows 对应设置 `PROJECT_WIKI_LIBREOFFICE` 为例如 `C:/Program Files/LibreOffice/program/soffice.com`；不要把整条命令或参数填入环境变量。**Windows 必须用 `soffice.com` 而不是 `soffice.exe`**：后者是 GUI 存根，`--headless --version` 不会返回，doctor 只会报告超时。进程继承该变量，客户端模板中有可选配置位置。包名可查 [Ubuntu LibreOffice 包说明](https://packages.ubuntu.com/noble/libreoffice)；OCR 本地资源机制见 [Tesseract.js 官方说明](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md)。

本开发目录另外保留了一份 Windows 用的离线运行时：`dist/runtime/` 内的 MSI、管理员解压结果和 `prepare-libreoffice.ps1`。它被 `.gitignore` 排除、不进入部署包，且 `prepare-libreoffice.ps1` 依赖的分片文件在拼出 MSI 后已移除，因此**不能重跑**；换机器时需按上面的 apt/安装包方式重新准备。该运行时本身可用：`soffice.com` 报 LibreOffice 26.8.0，`test/office.test.mjs` 的中文 DOC/PPT 往返用例在把 `PROJECT_WIKI_LIBREOFFICE_TEST` 指向它时会真实通过（本机实测约 93 秒）。该变量必须指向**真实存在的绝对路径**才会启用这条用例：只写一个绝对但不存在的位置（例如在 Windows 上填 POSIX 的 `/usr/bin/soffice`）会被判定为未配置并跳过，而不是报错失败；默认同样跳过。

LibreOffice 转换为每次请求创建独立用户配置和临时目录，关闭宏、活动内容及文档链接更新并设置超时；这不是操作系统网络沙箱。处理不可信旧格式时，如需保证转换进程不能联网，应在服务器容器或系统网络策略中隔离。原生 DOCX/XLSX/PPTX/XLS 解析不调用 LibreOffice，不执行公式或宏，也不跟随外链。

`doctor` 的成功表示依赖可加载、模型文件在本地，并且每种格式实际用到的解析器都能导入（例如 HTML/XML 需要 `parse5` 与 `fast-xml-parser`，XLSX 需要 `fast-xml-parser`，旧 XLS 还需要 `xlsx`）；它不会证明每份资料都能解析，也不会运行重型 OCR 或真实旧文档转换。Linux 部署后仍应在那台机器执行自检。通用部署包不会自行连接服务器或改变远端配置。

知识服务可以部署在 Linux，工程服务留在 Windows，由客户端分别连接。Linux 进程不能直接看到 Windows 上的最新工程目录。服务支持下述显式部署的资料扫描与备份，没有默认复制工程源码或多用户权限；管理面板默认只在本机运行，没有身份验证，不做权限隔离；客户端工具筛选同样不等于服务端权限隔离。

## 全文索引与自动维护

```sh
# 仅在操作员指定的真实路径运行；示例路径需要按部署调整。
PROJECT_WIKI_MAX_SOURCE_MIB=32 node bin/index-sources.mjs /absolute/vault
PROJECT_WIKI_MAX_SOURCE_MIB=32 node bin/maintain-vault.mjs scan /absolute/vault /absolute/incoming
PROJECT_WIKI_MAX_SOURCE_MIB=32 node bin/maintain-vault.mjs backup /absolute/vault /absolute/backups
node bin/maintain-vault.mjs verify /absolute/new-empty-restore-directory
```

PDF 索引按原件 SHA-256 分代保存至 `.wiki-server/fulltext/`，逐页校验，原件变化后不会返回旧内容冒充当前证据。每份 PDF 最多 2000 页、每页 200000 字符、全文 64 MiB；超限或文字稀少需明确处理。当前索引是文字层的字面检索，没有自动理解全部图表或 OCR 全书。单页 OCR 和其他文档格式沿用 `wiki_read_source`。

`scan` 检查 incoming 中已稳定 60 秒的普通文件；上传时可先用 `.part` 后缀，再重命名。相同内容去重，同名不同内容另存，原件不覆盖。不猜测版本关系，需要明确 `previous`。新增受支持的其他格式也进入整理队列，通过原有读取工具逐单元处理。已登记原件的哈希改变、文件丢失或导入异常会使维护返回失败，并保留原件和待办。

PDF 整理任务为连续 20 页，其他格式按来源建立任务。`summarized` 仅表示调用者已完成该范围的草稿笔记；`needs_review` 保留不确定性。记录时检查来源、笔记引用及笔记版本，服务不替调用者理解原文。`wiki_compile_queue` 是语义整理进度入口，引用计数和索引覆盖均不可替代它。

Linux 定时任务样例在 `deploy/maintenance/`。它们示范 ubuntu 用户、固定安装路径、北京时间每 15 分钟扫描和每日 03:15 备份，部署前须调整到真实用户与目录，并创建 incoming、backup、维护锁目录。安装后通过 systemd 检查实际运行结果，不把 timer 启用当成任务成功。

Windows 没有随仓库提供的定时任务，需要自行登记计划任务。`maintain-vault.mjs backup` **只支持 Linux**（它依赖 Linux `tar`），在 Windows 上只能手动执行 `index-sources.mjs` 和 `maintain-vault.mjs scan`，备份请另择方式，并把 vault 整体（含隐藏的 `.wiki-server/`）一起保存：

```powershell
# 每 15 分钟扫描 incoming 并重建全文索引；路径与 MAX_SOURCE_MIB 按实际部署调整
$vault = 'D:\Data\wiki-vault'; $incoming = 'D:\Data\wiki-incoming'
$env:PROJECT_WIKI_MAX_SOURCE_MIB = '32'
Start-Process -Wait -NoNewWindow node -ArgumentList 'bin\maintain-vault.mjs','scan',$vault,$incoming
```

备份在写锁内先做快照，再压缩并解压到独立临时目录逐文件校验；包含原件、笔记、历史、登记、事务和整理记录，排除运行锁及可重建的全文/提取缓存。保留最近 14 份已验证自动备份，再补最近 8 个周区间各一份；不清理人工命名的备份。恢复时使用新的空目录，校验清单、重建缓存、确认后切换服务。异机备份另由操作者或客户端拉取并核对 SHA-256。

AI 整理由获授权的模型客户端消费队列，服务器本身不内置模型或 API 密钥。当前个人部署选择 Codex 每两小时处理至多两段；本机及应用需要可运行，服务器的扫描和备份独立执行。工程联查要同时记录源码版本、工作区变化、产物来源和观察时间，不能把旧 map 当作当前构建验证。

本版兼容原有概念/实体/综合笔记布局，独立维护存储与工具，不再依赖旧 llmwiki 运行包。YAML 解析仅接受数据；PDF 使用 [PDF.js](https://mozilla.github.io/pdf.js/examples/)，OCR 使用 [Tesseract.js](https://github.com/naptha/tesseract.js)，旧 XLS 使用 [SheetJS](https://docs.sheetjs.com/)，元数据解析使用 [yaml](https://eemeli.org/yaml/)。依赖版本由锁文件固定。

## 许可证

服务代码以 [MIT 许可证](LICENSE) 授权，可自由使用、修改与再分发，仅需保留版权与许可声明。

该许可只覆盖本仓库中的代码、模板和文档。它不覆盖任何知识库内容：`data/vault/`、运行数据、原始资料以及各工程自身的代码都不在本仓库内，也不随本许可分发。第三方依赖仍归其各自作者所有，并受各自许可证约束（见上文链接）。
