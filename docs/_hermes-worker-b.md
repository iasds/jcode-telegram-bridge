## Worker B 报告:jcode-telegram-bridge 能力清单

### 1. 命令面

全部命令由 `commands.ts` 的 `handleCommand` 统一分发,正则 `^\/(\w+)(?:@\w+)?(?:[ \t]+(.*))?$` 解析(支持 `@botname` 后缀与参数)[commands.ts:53-56]。

- `/start`:欢迎语 + HELP 全文,带用户名转义[commands.ts:59-61];在 bridge 侧由 `bot.start` 触发[bridge.ts:134-138]
- `/help`:输出 HELP 常量(9 条命令说明)[commands.ts:9-23, 63-65];由 `bot.help` 触发[bridge.ts:140-144]
- `/status`:bridge-only。调 `client.listSessions()` + `client.ping()`,读 `poll-offset.txt`,输出持久化会话数、绑定 chat 数、poll offset、队列深度、活跃 turn 数;daemon 连接失败时单独报告[commands.ts:67-86]
- `/info`:bridge-only。attach 会话后取 `getRuntimeInfo`,输出 server/protocol/provider/model/workdir/plan 模式[commands.ts:88-100]
- `/clear`:需已有会话(否则提示先发消息);`client.clear` 后回 ✅[commands.ts:102-116]
- `/plan`:切换 normal/plan 模式并持久化到 store;开启/关闭均有提示语[commands.ts:118-128]
- `/model`:无参数时若有 `openModelPicker` hook 则开交互选择器,否则列出前 20 个模型 + `/model <name>` 用法;带参数直接 `setModel`[commands.ts:130-157]
- `/compact`:需已有会话;`client.compact`(异步请求),回复"🧹 Compression requested"[commands.ts:159-173]
- `/cancel`:attach 后 `client.cancel`,再调 `cancelTurn` 关闭 in-flight 子连接,回复"⏹ Cancel request sent."[commands.ts:175-193]

权限:所有命令无独立权限检查,统一由 bridge 层 `allowed()` 把关(bot.start/help/text 入口均先检查)[bridge.ts:119-123, 135, 141, 157]。

### 2. 权限与安全

- 白名单:`TELEGRAM_BOT_ALLOWED_IDS` 逗号分隔,[config.ts:44] 解析(过滤非法值 [config.ts:20-28]);`allowed()` 中**空列表 = 放行所有人**,非空则 `includes` 匹配;未通过者静默丢弃并打日志"[bridge] ignored message from non-allowed user"[bridge.ts:119-123, 157-160]
- 审批流:**无**。README 明确"bridge has no permissions capability; tools run automatically"(全自动批准,仅白名单可达)[README.md:83-84]。SDK 侧 `run()` fallback 用 `autoApprove: true`[bridge.ts:325]
- 群组处理:见第 3 点

### 3. 消息处理

- `bot.on("text")` 唯一文本入口[bridge.ts:152-174];先缓存 ctx[bridge.ts:156],再过白名单[bridge.ts:157]
- 私聊:全部文本进 `route()`[bridge.ts:161-162]
- group/supergroup:仅当 bot 被 @mention 时响应。首次需要时 `getMe` 缓存 bot username,`stripMention` 用正则剥离 `@botname` 前缀(含 `[\s,:-]*` 分隔符),剥离后文本变了才 route[bridge.ts:163-173, 126-130]
- `channel` 类型不处理(未覆盖)
- 未知命令:`route()` 中 `startsWith("/")` 且 `handleCommand` 返回 false 时,回复 "Unknown command: xxx\nSend /help..." 并**拒绝下发给 agent**[bridge.ts:181-192]
- 普通文本:进队列,plan 模式下前置 `planModePrefix`[bridge.ts:198, 226-227]

### 4. 媒体输入

**不支持**。仅注册了 `text` 与 `callback_query` 两个业务 handler[bridge.ts:134-152];`getUpdates` 的 `allowed_updates=` 为空(拉取全部 update 类型)[bridge.ts:392],但 photo/document/audio/video/voice 均无 handler,会被 telegraf 静默丢弃。README 明确:"Media input (photos/documents) is deferred: the current model has no vision capability"[README.md:126-127]。

### 5. 会话管理

- 每 chat 一个固定 jcode session:`SessionStore` 维护 `Record<chatId, ChatState>`,含 sessionId/mode/workdir/createdAt[sessions.ts:7-12, 31-48]
- 持久化:`state.json`(默认 `~/jcode-telegram-bridge/state.json`[config.ts:39-40]),600 权限;防抖 500ms 落盘 + `persistNow()` 同步落盘[sessions.ts:132-149]
- 队列:`enqueue(chatId, fn, limit)` 每 chat 串行 FIFO(前一个无论成败都接续),`depths` 记录运行+待处理数,超 `QUEUE_LIMIT`(默认 5)抛 `QueueFullError`[sessions.ts:86-103];bridge 侧捕获后回复 "⏳ Queue is full (N turns max)..."[bridge.ts:344-354]
- 并发:turn 为 fire-and-forget(`void store.enqueue`),telegraf 继续处理 update(保证 /cancel 响应);attach 在队列内执行,避免并发 double-create[bridge.ts:194-199]
- plan 模式:`ChatState.mode`(normal|plan),toggle 持久化[commands.ts:118-128, sessions.ts:5]
- clear:见第 1 点
- 超时:`TURN_TIMEOUT_MS` 默认 10 分钟[config.ts:48],watchdog 见第 10 点
- 轮换:attach 失败(会话损坏/被 daemon 重置)时删映射重建,保留 plan 模式;连接 close 时轮换最后 attach 的会话[bridge.ts:73-87, 207-225]

### 6. 流式输出(stream.ts,注释明确"ported 1:1 from hermes GatewayStreamConsumer + Telegram adapter streaming-edit path"[stream.ts:5-21])

- 节流间隔:`EDIT_INTERVAL_MS = 800ms`[stream.ts:23]
- 缓冲阈值:`BUFFER_THRESHOLD = 24` 码点(用 `[...accumulated].length` 数码点)[stream.ts:24, 102-112]
- 光标:`CURSOR = " ▉"` 追加在每次编辑后,`finish()` 时去掉[stream.ts:25, 110, 132-140]
- 工具分段:`onToolStart` 先把当前段用 MarkdownV2 定稿,发 `🔧 [name]` 行,再发新光标消息续流,清空缓冲与节流计时[stream.ts:115-129]
- flood 回退:`MAX_FLOOD_STRIKES = 3`,429 时读 `retry_after`(默认 2s)退避重试,3 连击后 `failed=true`,调用方改为收全文一次性投递[stream.ts:26-32, 65-99, 102-103]
- 编辑策略:`editMessageText`,流式期间用纯文本(未闭合 markdown 不会 400),`not modified` 视为成功(省 flood 额度),MarkdownV2 被拒时回退 `stripMdv2` 纯文本[stream.ts:65-99]
- 分块 4096:`finish()` 用 `truncateMessage(formatMessage(text))` 分块,首块编辑替换,后续块 `sendChunk` 发送(带 429 退避与纯文本回退)[stream.ts:132-173];`MAX_MESSAGE_LENGTH = 4096`[truncate.ts:13]

### 7. Markdown 渲染

`markdown.ts` 为 hermes `adapter.py format_message()` 12 步管线移植(注释自述)[markdown.ts:1-10]:

- 0) GFM 表格 → 加粗标题 + 圆点组(`convertTableToBullets`,跳过代码围栏内)[markdown.ts:136, 81-116; 表格渲染 44-78]
- 1) 保护 fenced code blocks(```),内部转义 `\` 和 `` ` ``[markdown.ts:139-147]
- 2) 保护 inline code,转义 `\`[markdown.ts:150]
- 3) 转换链接 `[text](url)`,转义显示文本与 URL 中 `\` `)`[markdown.ts:153-157]
- 4) 标题 `#` → 加粗 `*...*`[markdown.ts:160-163]
- 5) 粗体 `**` → `*`[markdown.ts:166]
- 6) 斜体 `*` → `_`(仅单行,保留列表)[markdown.ts:169]
- 7) 删除线 `~~` → `~`[markdown.ts:172]
- 8) 剧透 `||` → `||`(占位保护防 `|` 转义)[markdown.ts:175]
- 9) 引用块 `>` 行首保护[markdown.ts:178-183]
- 10) 转义剩余特殊字符 `escapeMdv2`[markdown.ts:186, 12-16]
- 11) 逆序恢复占位符(嵌套引用可解析)[markdown.ts:189-191]
- 12) 安全网:代码段外裸 `( ) { }` 转义(跳过已转义、链接开括号、平衡 `](` 后的 `)`)[markdown.ts:194-227]
- 附带:`stripMdv2` 逆渲染(纯文本 fallback)[markdown.ts:18-26]

`truncate.ts` 分块逻辑:

- 4096 上限,保留 10 字符放 "(XX/XX)" 指示器,代码围栏预留关闭/重开空间[truncate.ts:13-15, 28-47]
- 优先自然断点(newline → space),避免 inline code 内切分(奇数反斜杠感知 backtick 计数)[truncate.ts:48-70]
- 跨块围栏:块尾在 fenced code 内则补 `\n````,下一块用 `\`\`\`lang` 重开,`carryLang` 跨块传递[truncate.ts:72-100]
- 多块时追加 `(i/N)`[truncate.ts:103-107]

### 8. 管理运维

- `/status` 内容:bridge running / daemon online / 持久化会话数 / 绑定 chat 数 / poll offset / 队列深度 / 活跃 turn 数;daemon 挂时显示失败原因[commands.ts:67-86]
- 日志:console 输出启动信息(`bot=xxx allowed=... workdir=...`)[bridge.ts:369]、stream 阶段日志 `[stream] connect→connected→attach→attached→consuming events→turn_done→loop end→finished`[bridge.ts:235-306]、轮换警告[bridge.ts:77-79, 213-214]、错误日志[bridge.ts:30-31, 356, 372, 461-462]
- offset 持久化:`poll-offset.txt`(路径随 stateFile 目录派生[config.ts:47]),0600 权限;`advanceOffset` 空 batch 不动 offset(防重启重放),`parseOffset` 非法值归 0[bridge.ts:416-429; logic.ts:16-30]
- systemd:两个用户服务 + 两个 root/系统版。`jcode-tg-bridge.service` 依赖 api-bridge、`Restart=always`、`RestartSec=3`、120s StartLimitIntervalSec[deploy/jcode-tg-bridge.service:1-14];`jcode-api-bridge.service` 跑 `jcode api-bridge`[deploy/jcode-api-bridge.service:1-11];root 版附加 `JCODE_HOME`/`JCODE_RUNTIME_DIR` env[deploy/jcode-tg-bridge-system.conf:12-14, jcode-api-bridge-system.conf:9-10];`install.sh` 一键装 user 服务 + enable-linger 提示[deploy/install.sh:1-11]

### 9. 配置

env 变量全集(9 个,config.ts 实读):

| 变量 | 默认 | 出处 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 必填,缺失即 throw | config.ts:31-34 |
| `TELEGRAM_BOT_ALLOWED_IDS` | 空=全放行 | config.ts:44 |
| `WORKING_DIR` | `homedir()` | config.ts:36-38 |
| `STATE_FILE` | `~/jcode-telegram-bridge/state.json` | config.ts:39-40 |
| `TURN_TIMEOUT_MS` | 600000 | config.ts:48 |
| `QUEUE_LIMIT` | 5 | config.ts:49 |
| `PLAN_PROMPT` | 内置英文 prompt(仅文档用途,运行时未用) | config.ts:50-52 |
| `PLAN_MODE_PREFIX` | `"[Plan mode] Plan only, do not execute."` | config.ts:53-54 |
| `DISABLE_LINK_PREVIEWS` | false | config.ts:55 |

注意:`.env.example` 只写了 6 个变量,缺 `STATE_FILE`/`PLAN_PROMPT`/`PLAN_MODE_PREFIX`。轮询参数:`timeout=15`(Telegram 侧短轮询)+ `allowed_updates=`(空 = 拉取全部类型)[bridge.ts:392];本地请求整体超时 `AbortSignal.timeout(45_000)`[bridge.ts:455];https agent socket `timeout: 60s, keepAlive`[bridge.ts:113]。

### 10. 错误处理

- 连接重试:`connectWithRetry` 6 次、间隔 5s,全失败才 throw[bridge.ts:20-37]
- getMe 退避:启动时最多 10 次,间隔 `min(3000*n, 15000)`,超限 `fatalExit`(防瞬态代理抖动触发重启循环)[bridge.ts:431-448]
- getUpdates 退避:连续 5 次失败 `fatalExit`,间隔同样指数退避封顶 15s[bridge.ts:450-466]
- 429 重试:渲染器 `sendRetry` 3 次(events.ts:19, 70-90)、流式编辑 3 次(stream.ts:75-85)、流式分块 3 次(stream.ts:148-173),均读 `retry_after`
- 断线重连:SDK `error`/`close` 事件 → 关闭时轮换最后 attach 的会话 → `fatalExit` → systemd `Restart=always` 拉起新进程[bridge.ts:49-87, 53-56]
- watchdog:每 turn 起 `setTimeout(turnTimeoutMs)`,到时标记 timedOut、`stream.finish()`、发 "⏱ Turn timed out, interrupted. Try again or /clear."、关子连接[bridge.ts:248-258]
- 半途失败保护:`turnStarted` 置位后绝不重跑;仅当 turn 从未启动时 `canFallbackToRun` 才允许 `run()` 兜底,防双执行双回复[bridge.ts:269-275, 322-338; logic.ts:41-47]
- 致命错误识别:`FATAL_CODES = {disconnected, connect_failed}`,队列层捕获后 `fatalExit`[logic.ts:8; bridge.ts:319, 357-359]
- 轮询自愈:挂死请求被 45s 超时打断(覆盖整段 body 读取,修补 telegraf 只覆盖请求头的缺陷)[bridge.ts:378-408, 455]

### 11. 通知

- working 消息:"⏳ Working…",返回 msgId 供最终答案原位替换[events.ts:45-57, 100-109]
- 工具行:`🔧 [name]`(run 路径 events.ts:60-68;流式路径 stream.ts:121)
- Cancelled:"⏹ Cancelled."(流式干净关闭与异常两条路径都会发,并 finalize 部分文本)[bridge.ts:291-299, 308-317];命令回执 "⏹ Cancel request sent."[commands.ts:191]
- 超时:"⏱ Turn timed out, interrupted. Try again or /clear."[bridge.ts:255]
- 队列满:"⏳ Queue is full (N turns max). Wait for the current turn, then retry."[bridge.ts:348-351]
- 错误:"⚠️ {jcode error [code]: msg}"[bridge.ts:333, 364]
- 流式 start 失败 → 收集全文一次投递[bridge.ts:266, 300-307]

### 12. 其他

- 链接预览:run() 渲染路径支持 `DISABLE_LINK_PREVIEWS`(传 `link_preview_options: { is_disabled: true }`)[events.ts:40-42, 98, 107, 117, 140, 150];**流式路径(stream.ts)未应用该选项**(编辑/分块均未传 link_preview_options)
- markdown fallback:MarkdownV2 被 400 拒绝时 `stripMdv2` 转纯文本并重新分块[events.ts:111-123, 144-155; stream.ts:87-94, 159-168]
- UTF-16 安全分块:`customUnitToCp` 按 UTF-16 预算取最大码点边界切片,不切破代理对;注释明确 JS `.length` 正是 Telegram 计数单位[truncate.ts:9-10, 17-26]
- 未知命令拒绝:不落 agent,直接回 "Unknown command"[bridge.ts:186-191]
- 流式光标 finalize:`finish()` 用 `accumulated.trim() || "*(no output)*"` 定稿,去掉 ▉,4096 分块[stream.ts:132-140]
- 重复回复防护:offset 持久化 + 空 batch 不动 offset,注释直指"bot loops sending the same message"bug[bridge.ts:411-415; logic.ts:10-19]
- 会话中毒自愈:连接 close/attach 失败即轮换会话,防重启死循环[bridge.ts:64-87, 207-225]
- 交互式 /model 选择器:provider→model 两级下钻、分页(10/8)、✓ 当前标记、◀ Back / ✗ Cancel、就地编辑、过期提示[model-picker.ts:5-10, 52-105, 138-178, 181-274]
- 命令与 TUI 对齐说明:`/status` `/info` 为 bridge-only,其余对齐 jcode TUI;未知命令拒绝[README.md:118-119]
- 测试:40 用例(markdown 14、stream 14、truncate、logic 12),`node --test`[README.md:88-90, package.json]

**差异提示(相对 hermes 维度清单)**:媒体输入不支持(hermes 支持);无审批流(hermes 有);`PLAN_PROMPT` 定义了但运行时未用;流式路径链接预览禁用未生效。未修改/提交任何文件。
