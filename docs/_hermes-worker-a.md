# Worker A 报告:hermes telegram gateway 能力清单

> 只读分析,未修改任何源码。证据全部经 grep/read 验证,行号与当前 checkout 一致(2026-08-16)。
> 文件简称:adapter.py = `plugins/platforms/telegram/adapter.py`;network.py = `plugins/platforms/telegram/telegram_network.py`;ids.py = `plugins/platforms/telegram/telegram_ids.py`;commands.py = `hermes_cli/commands.py`;sc.py = `gateway/slash_commands.py`;run.py = `gateway/run.py`;session.py = `gateway/session.py`;approval.py = `tools/approval.py`;consumer.py = `gateway/stream_consumer.py`;gconfig.py = `gateway/config.py`;docs = `website/docs/user-guide/messaging/telegram.md`(1326 行)。

---

### 1. 命令面

命令面不是 telegram 插件自带一套,而是**中央 COMMAND_REGISTRY + gateway runner 分发**:`hermes_cli/commands.py:142` 定义全部 `CommandDef`(名称/别名/参数提示/busy_policy/busy_handler/gateway_only/cli_only);Telegram 启动时把菜单注册到 Bot(adapter.py:3943-3990);收到 `/xxx` 走 `_handle_command`(adapter.py:9527)→ `handle_message` → run.py 命令分发(约 run.py:16857 起按 canonical 名分派到 sc.py 各 handler)。

可枚举的命令(COMMAND_REGISTRY,commands.py:142-390;gateway_only 命令 / 各 handler):

- `/start`:平台 ping,直接吞掉不回复(run.py:16878;busy 时 `_busy_start_command` run.py:15788)
- `/new`(别名 `/reset`):新会话 + 清历史;Telegram topic root lobby 时改提示 `_telegram_topic_root_new_message`(run.py:16864);破坏性确认 `_maybe_confirm_destructive_slash`(run.py:22915);busy 时先中断再重置(run.py:15801)
- `/topic`:DM 多会话模式(见 §12),handler sc.py:4469
- `/approve`:批准挂起的危险命令,支持 `[session|always]`、`all`、`all always` 等(sc.py:5642,用法注释 5646-5658)
- `/deny`:拒绝挂起命令,支持 `[all] [reason≤280字]`(sc.py:5700)
- `/restart`:排空后优雅重启(见 §8),sc.py:1582
- `/stop`:杀掉当前会话所有运行进程,busy 时强制清 running-agent 槽(run.py:15791)
- `/pause [reason]` / `/pause off`:全局急停 estop(run.py:15761)
- `/sethome`(别名 `set-home`):设置当前 chat 为 home channel(见 §8),sc.py:3128
- `/update`:后台跑 `hermes update --gateway`(见 §8),sc.py:5806
- `/commands [page]`:分页浏览命令,Telegram 页大小 15(sc.py:1711)
- `/help`:帮助,走 `execute_command("help", surface="gateway")`(sc.py:1700)
- `/platform list|pause|resume <name>`:平台适配器运维(sc.py:1489)
- `/status`:会话/模型/上下文/token/队列深度/已连平台(sc.py:576)
- `/whoami`:显示本 scope 的 admin/user/unrestricted 层级与可用命令(sc.py:408)
- `/context`:上下文窗口详情(sc.py:780)、`/agents`(sc.py:1255)、`/egress`、`/profile`(sc.py:355)、`/version`(sc.py:1694)
- 会话类:`/resume [name]`(sc.py:4708)、`/sessions`(sc.py:4876)、`/branch`(sc.py:4947)、`/compress`(别名 compact,`here [N]`/`--preview`;sc.py:4085)、`/retry`(sc.py:2616)、`/undo [N]`(sc.py:3079)、`/title [name]`(sc.py:4636)、`/save`(sc.py:4558)
- 队列/并发:`/background <prompt>`(sc.py:3438)、`/queue <prompt>`(别名 q,busy handler run.py:15814)、`/steer`(run.py:15879 起)、`/goal`、`/heartbeat`、`/loop`、`/subgoal`
- 模型/配置:`/model [name] [--global]`(sc.py:1731,Telegram 无参时出 inline picker)、`/reasoning`、`/fast`、`/codex-runtime`、`/personality`、`/yolo`、`/approvals [manual|smart|off]`(sc.py:3901)、`/footer`、`/verbose`
- 工具/技能:`/learn`、`/init`、`/skills`、`/memory`、`/bundles`、`/kanban`、`/reload-mcp`、`/reload-skills`、`/curator`、`/suggestions`、`/blueprint`
- 信息类:`/usage [reset]`、`/insights [days]`、`/debug`、`/diff`
- CLI-only(Telegram 不注册):`/clear` `/redraw` `/history` `/prompt` `/snapshot` `/export` `/import` `/plugins` `/tools` `/toolsets` `/quit` `/skin` `/statusbar` `/battery` `/timestamps` `/wake` `/busy` `/copy` `/paste` `/image` `/browser` `/cron` `/subscription` `/topup` 等(commands.py:149-389 的 `cli_only=True`)

权限要求:所有命令先过用户授权(见 §2);`user_allowed_commands` 白名单之外的非 admin 用户只能跑 `/help` `/whoami` 加显式放行的命令(sc.py:408 的 floor 逻辑;docs:1075-1118)。busy 时的行为按 `busy_policy`:`dispatch`(可直接跑,如 /status /approve /restart /pause /background)、`interrupt_then_dispatch`(/new /stop)、`reject`(/model /moa /codex-runtime 有定制文案);分发表 run.py:15670-15760。

### 2. 权限与安全

- **token**:`TELEGRAM_BOT_TOKEN`(plugin.yaml requires_env;`_is_connected` adapter.py:10666 要求 token 非空)
- **白名单机制**:
  - env:`TELEGRAM_ALLOWED_USERS`(全局)、`TELEGRAM_GROUP_ALLOWED_USERS`(仅群组发送者)、`TELEGRAM_GROUP_ALLOWED_CHATS`(整群)、`TELEGRAM_ALLOW_ALL_USERS`、`GATEWAY_ALLOWED_USERS/GATEWAY_ALLOW_ALL_USERS`(adapter.py:1338-1349)
  - adapter extra:`allow_from`(DM+群)、`group_allow_from`(仅群)、`group_allowed_chats`(整群)、`allow_admin_from`/`group_allow_admin_from`(admin 全集)、`user_allowed_commands`(docs:1075-1118;adapter.py:1426-1433 的 allow_from/group_allow_from 优先)
  - 决策链:`_is_user_authorized_from_message`(adapter.py:1384,在文本批处理/事件构造**之前**的 intake 预过滤,#40863)→ runner 全链 `_is_user_authorized` → env 兜底;无白名单时未知 DM 放行给 pairing 流(`_should_pass_unauthorized_dm_for_pairing` adapter.py:1350);fail-closed 逻辑:有 env 白名单且不在内 → 拒
- **home channel**:`/sethome`(sc.py:3128)持久化 `HomeChannel`(platform/chat_id/name/thread_id/user_id/scope_id)+ 兼容 env `TELEGRAM_HOME_CHANNEL[_NAME]`、`TELEGRAM_HOME_CHANNEL_THREAD_ID`、cron 专用 `TELEGRAM_CRON_THREAD_ID`(docs:328-352)
- **审批流(核心)**:
  - 挂起队列:`tools/approval.py` 的 `_pending: dict[session_key, approval]`(approval.py:2349)、`submit_pending`(2714)、`resolve_gateway_approval`(2634,choice=once/session/always/deny)、`has_blocking_approval`(2692);等待超时 = `approvals.timeout`(超时自动按 deny 处理,adapter.py:7083-7089 注释)
  - 内联按钮:`send_exec_approval`(adapter.py:6140)发 HTML 消息 + `ea:once/session/always/deny:{id}` 按钮,`_approval_state[id]→session_key`;回调 `_handle_callback_query`(adapter.py:7008-7120),点击者须过 `_is_callback_user_authorized`(1172,先 resolve 再渲染,避免过期 tap 谎报 Approved)
  - 文本路径:`/approve` `/deny`(sc.py:5642/5700)调同一 resolve;`smart_denied` 只留 Allow Once + Deny(adapter.py:6168-6178)
  - slash 确认三键(`sc:once/always/cancel`):`send_slash_confirm`(adapter.py:6216)、回调 7152-7200,用于 `/new`、`/reload-mcp` 等破坏性命令(`_request_slash_confirm` run.py:23027)
- **群组权限**:`allowed_chats` 硬门 + `guest_mode` 白名单外 @mention 才放行(adapter.py:9370-9375、docs:1047-1073);`group_allowed_chats` 放行整群成员;`exclusive_bot_mentions`(默认开)多 bot 群按显式 @ 路由(adapter.py:8507、8963);`ignored_threads` 指定 topic 静默(8604);DM 与 group 的 admin 列表互相独立(docs:1090)
- **管理员角色**:`allow_admin_from` / `group_allow_admin_from` 分层,`/whoami` 展示(sc.py:408;gateway/slash_access.py `policy_for_source`)
- 未授权 DM 也可按 `unauthorized_dm_behavior=pair` 进入 pairing 握手(adapter.py:1350-1383)

### 3. 消息处理

- **handler 注册**(adapter.py:4200-4229):TEXT&~COMMAND、COMMAND、LOCATION|VENUE、PHOTO|VIDEO|AUDIO|VOICE|Document|Sticker、CallbackQuery、group=99 的 `TypeHandler(Update)` 观察者(`_on_platform_update` 4018,把 reaction/message_edited 规范化为 `gateway_platform_event` 事件,4097/4148)
- **私聊**:DM 无限制(`_should_process_message` adapter.py:9376 `if not self._is_group_chat(message): return True`);`ignore_root_dm` 可把根 DM 变 lobby(9386-9392);DM topic 见 §12
- **群/超群**:群消息按序过 8 道门(adapter.py:9365-9445):own-message 过滤 → allowed_topics → ignored_threads → exclusive_bot_mentions → allowed_chats(硬门,guest_mention 例外)→ free_response_chats/topics → require_mention(关则全收)→ reply-to-bot → @mention → `mention_patterns` 正则醒词(`_compile_mention_patterns` 8625,大小写不敏感,支持 caption)
- **@mention 触发**:`_observe_bot_identity_from_message`(8729)实时学 BotFather 改名后的 handle(含非 `bot` 结尾的 Fragment 用户名);`_message_mentions_bot`(8880)解析 `mention`/`bot_command` 实体,支持 `/cmd@botname`;`_extract_bot_mention_usernames`(8798)
- **reply 行为**:回复 bot 的消息可触发(`_is_reply_to_bot` 8791);`_build_message_event`(10366)提取 `reply_to_message_id/text`,优先 Telegram 原生局部引用 `message.quote`(TextQuote),回退全文/富文本回显/本地 `rich_sent_store`(10428-10470);回复锚丢失自动去掉 reply_to 重发(send 5269-5288)
- **消息节流/去重**:
  - 文本分片聚合:Telegram 长消息>4096 拆多条,`_enqueue_text_event`(9628)+ `_flush_text_batch`(9664)按安静期合并;自适应延迟:末块≥4000 → 长延迟(`_text_batch_split_delay_seconds`),≤320cp → 0.18s,≤1024cp → 0.24s,否则配置上限(adapter.py:658-690、9664-9690);长命令(≥`_SPLIT_THRESHOLD` 4000)也走批处理防止续片打断 agent(9530-9538)
  - 照片连发/相册:`_photo_batch_key`(9723)+ `_flush_photo_batch`(9736,默认 0.8s)
  - 媒体组:`_queue_media_group_event`/`_flush_media_group_event`(10081/10110,`MEDIA_GROUP_WAIT_SECONDS=0.8`)合并成一个事件防中断
  - 断连窗口:held-inbound 队列上限 `HELD_INBOUND_MAX=64`(`_hold_inbound_event` 1005,旧事件先丢,重连重放 `_redispatch_held_inbound` 1066)
- **频道/匿名 admin**:channel post 无 from_user → 用 sender_chat 授权(`_source_from_message_for_auth` adapter.py:1242-1255);reaction 用 actor(user 或匿名 admin chat)授权(`_source_from_reaction_for_auth` 1284)

### 4. 媒体输入

`_handle_media_message`(adapter.py:9781)统一入口,全部先授权再下载到本地 cache(绕过 Telegram 文件 URL ~1h 过期):

- **照片**:取最大 PhotoSize → `download_as_bytearray` → `cache_image_from_bytes`(ext 从 file_path 猜),`event.media_urls=[cached_path]`,`media_types=["image/…"]`;相册/连发走批处理(9841-9863)
- **语音**:voice → `cache_audio_from_bytes(.ogg)`(9900-9915);audio → `.mp3`(9917-9931);STT 开则转文本,关则 agent 收到 `[The user sent a voice message: <path>.ogg]` 标记(docs:363-381)
- **视频**:video → `cache_video_from_bytes`(SUPPORTED_VIDEO_TYPES 匹配 ext)(9934-9950)
- **文档**:任意类型都收(授权即门槛);图片型文档(ext/mime 命中 image)转走图片路径防绕过 20MB 限制(9968-9994);文本类(ext 或 text/* mime)且 ≤100KB 内联注入 `[Content of <name>]:\n...` 到 event.text(10033-10059);二进制只给缓存路径;超限给 "Maximum: N MB" 提示(9954-9964)
- **尺寸上限**:`_max_doc_bytes` = 有 `base_url`(本地 Bot API server)→ 2GB,否则 20MB(adapter.py:877-881;docs:401-528);`_telegram_media_size_allowed`(7529)
- **贴纸**:静态 webp → 视觉工具描述 + 按 `file_unique_id` 缓存(`_handle_sticker` 10133);动图/video sticker 只注入 emoji 占位;失败回落 emoji 描述
- **位置/Venue**:转文本坐标 + Google Maps 链接(`_handle_location_message` 9561)
- **出站媒体**(agent 回复 `MEDIA:/path` 提取后):`send_voice`(7543)、`send_multiple_images`(7694,相册)、`send_image_file`(7830)、`send_document`(7924)、`send_video`(7979)、`send_image`(8030)、`send_animation`(8131);支持 ext 表见 docs:229-244;Docker 终端下文件路径须宿主可见(docs:197-228)

### 5. 会话管理

- **持久化**:`SessionStore`(session.py:1238)SQLite `SessionDB`(state.db 的 gateway_routing/transcripts)+ JSONL 兜底(`write_sessions_json` 兼容镜像);`get_or_create_session`(2428)、`switch_session`(3364)、`list_sessions`(3434)、`prune_old_entries`(3145)
- **会话 key**:`build_session_key`(session.py:1090):命名空间(profile)→ DM 按 chat_id(+thread_id 区分 topic);群组按 chat_id + 用户(组共享/每用户由 `group_sessions_per_user` 控制,默认 True;thread 默认跨用户共享 `thread_sessions_per_user=False` → 每个 Telegram forum topic 一个共享会话)
- **会话列表/恢复**:`/sessions`(sc.py:4876,SQL 层分页,跨源列表仅 admin)、`/resume`(sc.py:4708)、`/branch`(sc.py:4947);`/topic <session-id>` 把历史会话绑回 topic(§12)
- **队列/并发**:每个 session key 同时最多一个 agent(`_running_agents` 槽 + `_AGENT_PENDING_SENTINEL` run.py:2620-2624);`/queue` FIFO 排队(不打断,run.py:15814),上限 `_BUSY_QUEUE_MAX_PENDING=32`(run.py:9622,9670);`/steer` 在工具调用之间注入;`/background` 独立后台 turn(sc.py:3438),结果回发原 chat/topic
- **压缩/清除**:`/compress`(`here [N]` 保留近 N 轮、`focus topic`、`--preview`;sc.py:4085);`/clear`(CLI only);`/new` 清历史;超时:clarify `agent.clarify_timeout` 默认 600s(docs:1271-1282)、审批超时自动 deny
- **DM topics 绑定**:SQLite `telegram_dm_topic_mode`/`telegram_dm_topic_bindings`(ON DELETE CASCADE),首次 `/topic` 才迁移(docs:830-844);adapter 侧 `_create_dm_topic`(3602)、`ensure_dm_topic`(3671)、`rename_dm_topic`(3724,会话自动起名后同步改 topic 名,`disable_topic_auto_rename` 可关)、`_setup_dm_topics`(3821)

### 6. 流式输出

`gateway/stream_consumer.py` 的 `GatewayStreamConsumer`(consumer.py:156)通用实现,`run()`(781)消费队列:

- **节流间隔/缓冲阈值**:默认 `edit_interval=0.8s`、`buffer_threshold=24 字符`、`cursor=" ▉"`(gconfig.py:760-762);`StreamConsumerConfig`(consumer.py:128-149);按 token 间隔或字符数触发 edit(consumer.py:884-896)
- **缓冲/工具分段**:队列哨兵 `_DONE`/`_NEW_SEGMENT`(工具边界)/`_COMMENTARY`(旁白)/`_FLUSH`(阻塞屏障,consumer.py:806-837);`_send_commentary`(1833);`_flush_think_buffer`(769)在 done 时把残留 partial-tag 冲掉;`_suppress_silence_marker`(2042)抑制 NO_REPLY/[SILENT] 之类空回复标记
- **光标**:`_try_strip_cursor`(1812)在段结束/收尾清光标;`_MIN_NEW_MSG_CHARS=4` 防 "X ▉" 豆腐块新消息(2146-2154)
- **编辑 vs 新消息**:首帧 send + 后续 editMessageText;adapter 声明 `REQUIRES_EDIT_FINALIZE=True`(adapter.py:672,确保最终 edit 从纯文本转 MarkdownV2)、`FALLBACK_ON_FINAL_EDIT_FLOOD=True`(674,最终 edit 撞 flood 直接走 fallback 新消息)、`RESEND_FINAL_ON_EMPTY_STREAM_FALLBACK=True`(676)
- **fresh-final**:长驻预览在完成时以新消息重发 + 删旧预览(`_try_fresh_final` 1964;Telegram 因富文本渲染升级所以 `prefers_fresh_final_streaming` 为 True,adapter.py:2063;`delete_message` 5901)
- **flood 回退**:连续 flood 编辑失败 → `_flood_strikes` 计数、`_current_edit_interval` 翻倍至 10s 上限(consumer.py:2332-2346);超 `_MAX_FLOOD_STRIKES` 后永久禁用编辑进入 fallback(只发缺失尾部,`_fallback_final_send`);fallback 重试等待 ≤5s(`_max_fallback_flood_retry_seconds=5.0` consumer.py:260;`_fallback_flood_retry_delay` 1674)
- **超长分块**:`_truncate_for_stream`(1357)/`_split_text_chunks`(1332,平衡代码围栏)、溢出头块密封为固定消息、尾块继续编辑(consumer.py:921-1020);adapter `edit_message`(5477)对 >4096 用 `_edit_overflow_split`(5699)拆续文,`_truncate_stream_overflow_preview`(5684)+ 饱和预览去重防 flood(5548-5582)
- **Draft 流(原生)**:`supports_draft_streaming` 仅 DM(adapter.py:5926)、`send_draft`(5959,`sendMessageDraft`/`sendRichMessageDraft`),transport=auto/draft/edit/off(gconfig.py:767-830;docs:932-959);draft 帧失败自动降级回 edit 流
- **富文本流**:rich 快路径 `_try_send_rich`(2197)/`_try_edit_rich`(2304,editMessageText 的 rich_message 参数)、`_should_attempt_rich`(2055)、32768 字符上限 `RICH_MESSAGE_MAX_CHARS`(adapter.py:652)

### 7. Markdown 渲染

Telegram 侧管线 = `format_message`(adapter.py:8298)12 步 MarkdownV2 转换:

1. **表格**:GFM 管道表 → Telegram 友好行组(`_wrap_markdown_tables`,`pretty_tables` 默认 true;docs:960-990:小表拍扁成表头+行组 bullet,大/宽表回落对齐代码块)
2. 保护围栏代码块(`\` 与 `` ` `` 转义,placeholder 化)
3. 保护行内代码
4. 链接转换(显示文本转义,URL 只转义 `)` `\`)
5. 标题 `##` → 粗体
6. 粗体 `**`→`*`
7. 斜体 `*`→`_`(不跨行防列表破坏)
8. 删除线 `~~`→`~`
9. 剧透 `||…||` 保护
10. 引用块(含 `**>` 可展开,前缀保留)
11. 转义剩余特殊字符
12. 恢复占位符(逆序,嵌套安全)+ 兜底转义 `(){}`(跳过代码区)

配套:utf16 长度计算分块(`send` 5116 用 `utf16_len`,分块加 `(1/2)` 指示并转义括号,5160-5167);parse 失败自动落纯文本(`_strip_mdv2` 473);Rich 路径发**原始 markdown** 经 `sendRichMessage`(表格/任务列表/`<details>`/块级数学原生渲染,`rich_messages` opt-in,默认关,docs:960-990);`_escape_mdv2`(468)、`_separate_chunk_indicator_from_fence`(500,防止 `(1/2)` 在围栏内出问题);链接预览 `_link_preview_kwargs`(1921,`disable_link_previews` 关预览)。

### 8. 管理运维

- **`/update`**(sc.py:5806):仅消息平台;非 git 仓库/托管环境拒绝;写 `.update_pending.json` + `.update_output.txt` + `.update_exit_code`,`setsid` 脱离进程跑 `hermes update --gateway`(文件 IPC 交互),更新完成由当前或新进程回 chat;交互提示走 `send_update_prompt`(adapter.py:6087,Yes/No 内联按钮)
- **`/restart`**(sc.py:1582):`_is_stale_restart_redelivery` 防 PTB 优雅停机 ACK 失败导致的重复重启;写 `.restart_notify.json`(重启后通知)与 `.restart_last_processed.json`(去重);systemd/container 下 exit 75 走服务重启,否则 detached 子进程;有在跑 agent 时返回 "draining (N)"
- **`/sethome`**(sc.py:3128):写 HomeChannel + 兼容 env + 运行时 config 同步
- **`/platform`**(sc.py:1489):列出 connected/failed/paused,暂停/恢复重连 watcher
- **`/status`**(sc.py:576):session_id/title/created/last_activity、model+provider+base_url、context used/total(百分比)、token 合计(读 SessionDB)、agent running、队列深度、已连平台列表
- **命令菜单**:启动后置任务注册 `set_my_commands`(adapter.py:3943-3990),按 scope(global + 每个 forum 群 chat 懒注册 `_ensure_forum_commands` 9459),默认上限 60(`telegram_menu_max_commands` commands.py:776;`command_menu.max_commands/priority_mode/priority` 可配,docs:82-106);`/commands` 看全量
- **状态指示**:`_set_status_indicator`(adapter.py:4795)用 `set_my_short_description` 写 Online/Offline(`status_indicator` extra,≤120 字符,docs:51-81)
- **日志/健康**:连接重试阶梯(8 次、`HERMES_TELEGRAM_INIT_TIMEOUT` 默认 30s、总 watchdog 上限,adapter.py:4590-4700);轮询心跳 `_polling_heartbeat_loop`(3033,`_probe_pending_updates` 3147,断连检测);getUpdates 进度验证 `_schedule_polling_progress_verifier`(2647,冷启动 15s 无进展即失败,#67498);`_verify_polling_after_reconnect`(3255);reactions 作为处理生命周期视觉反馈(§11)

### 9. 配置

- **token**:`TELEGRAM_BOT_TOKEN`(plugin.yaml;`interactive_setup` adapter.py:10720 向导;`_apply_yaml_config` 10732 把 YAML `platforms.telegram` 映射到 env/extra;`register(ctx)` 10861 插件注册)
- **轮询 vs webhook**:默认长轮询;设 `TELEGRAM_WEBHOOK_URL` 即 webhook(adapter.py:4230-4238,4477-4652):`TELEGRAM_WEBHOOK_PORT`(8443)/`TELEGRAM_WEBHOOK_HOST`/`TELEGRAM_WEBHOOK_SECRET`(必填,无 secret 拒启,GHSA-3vpc-7q5r-276h),webhook 的 `allowed_updates=Update.ALL_TYPES`(4658);轮询同样 ALL_TYPES(2626)
- **连接参数**:PTB `HTTPXRequest`:`connection_pool_size`(512)、`pool_timeout`(8s)、`connect_timeout`(10s)、`read/write_timeout`(20s)、`media_write_timeout`(60s),均可用 `HERMES_TELEGRAM_HTTP_*` 覆盖(adapter.py:4303-4360);httpx keepalive 调优防 CLOSE_WAIT fd 泄漏(4334-4358)
- **本地 Bot API server**:`base_url`/`base_file_url`/`local_mode` extra(adapter.py:4265-4277;20MB→2GB 自动抬升;docs:401-528)
- **网络**:`TELEGRAM_PROXY` > `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY`(network.py:57-64;docs:305-327、1165-1198);fallback IP:`TELEGRAM_FALLBACK_IPS` / 自动 DoH(Google+Cloudflare)发现 / 种子 IP `149.154.166.110,149.154.167.220` / sticky IP(network.py:78-330;`_fallback_ips` adapter.py:1763;`HERMES_TELEGRAM_DISABLE_FALLBACK_IPS`、`HERMES_TELEGRAM_FALLBACK_DISCOVERY_TIMEOUT`)
- **通知/表现**:`HERMES_TELEGRAM_NOTIFICATIONS` / `display.platforms.telegram.notifications`(important|all,`_resolve_notifications_mode` 10629);`TELEGRAM_REACTIONS`
- **批处理延迟**:`HERMES_TELEGRAM_MEDIA_BATCH_DELAY_SECONDS`(0.8)、`HERMES_TELEGRAM_TEXT_BATCH_*`(adapter.py:768-792)
- **每平台 extra 键全表**(adapter.py:10852 附近 + docs):`allow_from/allow_admin_from/group_allow_from/group_allowed_chats/user_allowed_commands/group_user_allowed_commands/group_allow_admin_from`、`dm_policy/group_policy`、`dm_topics/group_topics`(技能绑定)、`channel_prompts`、`mention_patterns/ignored_threads/free_response_chats/free_response_topics`、`require_mention/exclusive_bot_mentions/observe_unmentioned_group_messages/guest_mode`、`reactions/status_indicator/status_online/status_offline`、`rich_messages/rich_drafts/pretty_tables/disable_link_previews`、`command_menu`、`fallback_ips/base_url/base_file_url/local_mode/proxy_url`、`unauthorized_dm_behavior/ignore_root_dm/disable_topic_auto_rename/typing_cooldown_seconds`
- **YAML 坑**:只有 `platforms.<name>.extra` 深合并,顶层 `telegram.extra` 被静默丢弃(docs:483)

### 10. 错误处理

- **发送重试**(`send` adapter.py:5116-5433):每块最多 3 次,指数退避 `2^attempt`;`retry_after` 识别 flood 并按 Telegram 指定秒数等;BadRequest 细分类:`thread not found`(同 thread 重试一次→无 thread 重发+剪除过期绑定)、`reply target not found`(丢 reply_to 重发);`TimedOut` 非重试(可能已送达),ConnectTimeout/PoolTimeout 可重试且 pool timeout 会先 drain 连接池;`message_too_long` 返回 `too_long` 让流消费者走续发
- **错误分类器**:`_looks_like_auth_error/network_error/connect_timeout/pool_timeout`(adapter.py:1780-1887);`_set_fatal_error`(931)/`_is_permanent_fatal`(949):token 被 revoke(InvalidToken/Forbidden)标 non-retryable,不再无限重连
- **轮询重连**:`_handle_polling_network_error`(2912,重连阶梯)、`_handle_polling_conflict`(3409,409 冲突:先 disarm PTB 内部重试环,再按退避重试,`RETRY_DELAY` 递增等 Telegram 服务端 getUpdates 会话过期)、`_schedule_polling_recovery`(2716)、`_start_polling_resilient`(2781,冷启动严格门 15s 无进展即失败)
- **fallback transport**:主路径失败 → 逐 IP 重试,sticky IP,失败的池丢弃防 CLOSE_WAIT 泄漏(`_reset_fallback` network.py:135-159);pool 上限 8/4(network.py:80)
- **半途失败**:held-inbound 队列(断连时缓存的入站事件,`HELD_INBOUND_MAX=64`,adapter.py:1005-1157)重连后重放;`_cancel_pending_delivery_tasks`(4824)/`disconnect`(4943)防止 teardown 后向死会话分发
- **流内**:flood 自适应退避、编辑禁用 fallback(§6);fallback 只发缺失尾部防重复(`_fallback_prefix`/`_fallback_preserve_partial_messages`)
- **媒体缓存失败**:`_surface_media_cache_failure`(9272)给用户可见错误信息而非静默丢

### 11. 通知

- **通知模式**(docs:1284-1309;adapter.py:1157-1171 + 10629):`important`(默认)只对最终回复、审批提示、slash 确认响铃,其余(tool 进度、流式帧、状态消息)`disable_notification=true`;`all` 全响铃;`metadata["notify"]` 显式请求可覆盖
- **处理生命周期反应**:`on_processing_start` 👀(adapter.py:10576)、`on_processing_complete` ✅/❌(10585;CANCELLED 清空),`set_message_reaction` 幂等替换(非叠加),`TELEGRAM_REACTIONS` 默认关(10536)
- **进度消息**:tool 进度气泡经 stream events;`send_or_update_status`(5443)按 `(chat_id, status_key)` 编辑同一条状态气泡("Compressing context…" 等,docs:1310-1313)
- **工作消息**:`send_typing`(8222)typing 指示(带 cooldown `typing_cooldown_seconds`、DM topic 失败回落);审批/澄清/选择器均为内联按钮交互(§1、§2)
- **docs 声称的 pin 入站消息**(docs:1314-1316 "Pin incoming user message during agent turn")在 adapter/run.py/base.py 中未找到实现,疑似文档超前或已移除——对比时注意口径

### 12. 其他 Telegram 特有

- **BotFather 配置**:`/newbot` 建号;`/setdescription /setabouttext /setuserpic /setcommands /setprivacy /setprivacy_policy`(docs:29-49);`/revoke` 撤销 token(docs:19-26);群隐私模式默认开——bot 只能看到命令/回复自己/服务消息/频道(admin 例外),须 BotFather 关或提升群 admin,且改后要移除重加(docs:107-165);`/topic` 需要 BotFather Threads Settings(Threaded Mode + 允许用户建 topic),不满足发设置页截图(docs:754-762)
- **Webhook 支持**:见 §9;secret 必填、路径自动提取、IPv4+IPv6 双栈绑定(adapter.py:4515-4525)
- **长轮询参数**:PTB 默认 + 自定义超时;`drop_pending_updates` 语义:冷启动丢旧队列、重连保留(connect 4240-4250);409 冲突恢复(§10)
- **allowed_updates**:`Update.ALL_TYPES`(2626 轮询 / 4658 webhook),同时以 `gateway_platform_event` 观察者消费 reaction/edited_message(4018-4200)
- **chat_id 规范化**:数字(含负群 ID)过 int,`@username` 原样透传(`normalize_telegram_chat_id` ids.py:22-32;`telegram_chat_id_key` 38、`looks_like_telegram_username` 43)
- **DM Topics(Bot API 9.4)** 与多会话 `/topic`(docs:631-860):operator 配置 `extra.dm_topics`(固定 topic 列表+技能绑定+icon_color)与用户自驱 `/topic`(任意建 topic、自动改名、session 恢复、`/topic off` 关闭;根 DM 变系统 lobby,非命令消息被拒,提示限流 30s/条);降级/升级兼容
- **Draft 流(Bot API 9.5)** 与 **Rich Messages(Bot API 10.1)**:见 §6/§7
- **Privacy mode 影响**:决定群消息是否可达(docs:580-604 排查表)
- **多 bot 共群**:每 profile 独立 token;同 token 并发轮询会被 Telegram 拒(409);`exclusive_bot_mentions` 默认开(docs:547-580)
- **本地 Bot API server**:20MB→2GB 上限、`logOut` 迁移、`local_mode` 磁盘读(adapter.py:4265-4277;docs:401-528)
- **账号身份自动学习**:BotFather 改名后无需重启即跟随新 handle 路由(adapter.py:8729-8760、8936)
- **限流细节**:root lobby 提示 30s/chat、BotFather 截图 5min/chat(docs:842-843);编辑限速与 flood 预算(§6);`_GENERAL_TOPIC_THREAD_ID="1"`(adapter.py:663)

---

## 总体定位(对比基准)

hermes telegram gateway 是"通用 agent gateway 的 Telegram 传输层":斜杠命令/审批/会话/流式全在 gateway 层实现,Telegram 插件专注 Bot API 适配(轮询/webhook、媒体缓存、MarkdownV2/Rich 渲染、群组触发门、inline 键盘交互、DM topics、flood/断线恢复)。

**对 jcode-telegram-bridge 比对最有价值的差异点**:

1. 中央 COMMAND_REGISTRY(命令面与 CLI 同源,commands.py:142)
2. 审批队列在 `tools/approval.py`,按钮渲染在 adapter(松耦合,超时自动 deny)
3. 流式由通用 `stream_consumer` 驱动,Telegram 只贡献钩子(REQUIRES_EDIT_FINALIZE / FALLBACK_ON_FINAL_EDIT_FLOOD / prefers_fresh_final_streaming / draft streaming / supports_draft_streaming)
4. Rich Messages 双轨:MarkdownV2 预览(edit 路径)+ sendRichMessage 终稿,32768 上限 + 自动回落
5. 媒体:20MB 公共 API 上限 / 2GB 本地 Bot API server;文本文档 ≤100KB 内联注入;贴纸走视觉描述缓存
6. 网络:DoH fallback IP + sticky IP + 代理链(HTTPS_PROXY/TELEGRAM_PROXY)
7. 群组触发 8 道门 + `exclusive_bot_mentions` 多 bot 路由
8. DM Topics 双模式(operator `dm_topics` vs 用户 `/topic`)与 SQLite 绑定表

**已知口径差异**:docs:1314 声称的"pin incoming user message during agent turn"在代码中无实现,比对时需按文档口径或代码口径二选一。

---

*验证方式:对 adapter.py(10881 行)做 outline + 逐段阅读;对 commands.py COMMAND_REGISTRY、slash_commands.py 各 handler、run.py 分发/busy/queue、session.py SessionStore、approval.py 审批队列、stream_consumer.py 流式、telegram_network.py 传输、telegram.md 文档均以 grep 定位行号并 read 验证。全文只读,未修改/未提交任何文件。*
