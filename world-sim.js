// ============================================================
// 世界模拟器 (酒馆助手 脚本，与【此间小镇HereBetween】预设配套)
// 本体代码，由 loader.js 通过 import() 从 jsDelivr 动态加载。
// 升级流程：改这个文件 → git commit → 打新 tag → push → 改 loader.js 里
// 那一行的 tag 版本号即可，不需要重新贴整段代码。
// ------------------------------------------------------------
// 职责边界：
//   1. 背景模拟自己的系统提示词，完全不引用/不携带此间小镇预设的98条prompt。
//   2. 每次正常RP生成时，只把"世界状态数据"注入聊天(通过 setExtensionPrompt，
//      对齐预设里 现实层/<World_Current> 那个插槽的同一位置：in-chat depth 10)，
//      不会把"你是世界模拟器/如何推演世界"这类指令文字注入进RP。
//   3. 只追踪"重要角色"：有名字、跟玩家/主线有牵扯的角色；店员、路人等
//      一次性打酱油角色一律不建档、不追踪。
// ============================================================

(() => {
  'use strict';

  if (window.__world_sim_instance__) {
    window.__world_sim_instance__.destroy();
  }

  if (typeof window.jQuery !== 'function') {
    console.error('[世界模拟器] 找不到 jQuery，无法建立界面');
    return;
  }
  const $ = window.jQuery;

  // ---------- 酒馆助手接口解析 ----------
  // 本文件是被 import() 动态加载的独立模块，酒馆助手注入到"脚本作用域"里的裸函数
  // (getVariables / eventOn ...) 在这里不一定看得到，所以统一从 window 或
  // window.TavernHelper 上解析，取不到时给出明确报错而不是整个模块炸掉。
  const _TH = window.TavernHelper || {};
  const _missing = [];
  function _pick(name) {
    if (typeof window[name] === 'function') return window[name].bind(window);
    if (typeof _TH[name] === 'function') return _TH[name].bind(_TH);
    _missing.push(name);
    return () => { throw new Error('酒馆助手接口不可用：' + name); };
  }
  const API = {
    getVariables: _pick('getVariables'),
    insertOrAssignVariables: _pick('insertOrAssignVariables'),
    generateRaw: _pick('generateRaw'),
    getChatMessages: _pick('getChatMessages'),
    eventOn: _pick('eventOn'),
    eventRemoveListener: _pick('eventRemoveListener'),
    triggerSlash: _pick('triggerSlash'),
    getWorldbook: _pick('getWorldbook'),
    getGlobalWorldbookNames: _pick('getGlobalWorldbookNames'),
    getCharWorldbookNames: _pick('getCharWorldbookNames'),
    getChatWorldbookName: _pick('getChatWorldbookName'),
    tavern_events: window.tavern_events || _TH.tavern_events
      || (window.SillyTavern && window.SillyTavern.getContext
          ? window.SillyTavern.getContext().eventTypes : null)
      || {},
  };
  if (!API.tavern_events.MESSAGE_RECEIVED) {
    console.warn('[世界模拟器] 找不到 tavern_events.MESSAGE_RECEIVED，「每 N 楼」触发会失效，请改用「每 N 分钟」');
  }
  if (_missing.length) {
    console.warn('[世界模拟器] 这些酒馆助手接口没找到，相关功能会失效：', _missing);
  }

  const SCRIPT_VERSION = "1.1.1";
  const INJECT_KEY = 'world_sim_current';
  const INJECT_TAG = 'World_Current';
  const MAX_EVENTS = 12;
  const MAX_CONSEQUENCES = 12;
  const MAX_REL_EVENTS = 30;
  const MAX_WORLDBOOK_NAMES = 60;

  const DEFAULT_SETTINGS = {
    apiMode: 'shared',        // 'shared' = 沿用ST当前连线 | 'custom' = 自定义反代
    customUrl: '',
    customKey: '',
    customModel: 'gemini-3.1-pro-preview',
    triggerMode: 'floor',     // 'floor' | 'minute'
    triggerN: 10,
    historyN: 30,             // 每次模拟参考最近几楼聊天记录
    autoNarration: true,      // 重要事件是否用 /sys 插一条旁白
    injectState: true,        // 是否把世界状态注入到正式RP生成里
    injectRelations: true,    // 关系网是否也一起注入(你的好感度世界书若已涵盖可关掉)
    injectDepth: 10,          // 注入聊天记录的第几层（对齐"现实层"预设卡）
    whitelist: '',            // 手动指定/升级的重要角色，逗号分隔
    useWorldTime: true,       // 是否读取预设的 TimeLocation 变量作为时间锚点
    useWorldbookNames: true,  // 是否读取世界书条目名称作为"已知世界元素"参考
    running: false,
    ballX: null,              // 悬浮球位置记忆
    ballY: null,
  };

  const DEFAULT_STATE = {
    characters: {}, worldEvents: [], consequences: [], relationshipEvents: [], elapsedTicks: 0,
  };

  // 关系状态 → 颜色（关键字匹配，AI 输出中文标签时用来上色）
  const REL_COLORS = [
    [/结婚|夫妻|已婚|伴侣/, '#e05a7a'],
    [/订婚|未婚/, '#e0728a'],
    [/交往|恋人|情侣|在一起/, '#e07a9a'],
    [/暧昧|喜欢|单恋|心动/, '#d38ab5'],
    [/闺蜜|好兄弟|挚友|死党/, '#4fb06a'],
    [/朋友|友好|交好/, '#5a9e5f'],
    [/家人|亲人|兄妹|姐弟|父|母/, '#d99a4e'],
    [/师徒|同事|同学|同僚|搭档/, '#5b7fc7'],
    [/赌气|冷战|闹别扭|疏远|尴尬/, '#c9a227'],
    [/冲突|不和|敌对|仇|讨厌|反目/, '#c05050'],
    [/绝交|断绝|决裂/, '#8a3a3a'],
  ];

  function relColor(type) {
    const t = String(type || '');
    for (const [re, color] of REL_COLORS) {
      if (re.test(t)) return color;
    }
    return '#6b6c78';
  }

  let settings = { ...DEFAULT_SETTINGS };
  let floorCounter = 0;
  let minuteTimer = null;
  let isTicking = false;
  let msgListenerHandle = null;
  let cachedState = { ...DEFAULT_STATE };
  let activeTab = 'npc';
  let expandedNpc = null;

  // ---------- 设置持久化(全局变量) ----------
  async function loadSettings() {
    try {
      const vars = await API.getVariables({ type: 'global' });
      if (vars && vars.world_sim_settings) {
        settings = { ...DEFAULT_SETTINGS, ...vars.world_sim_settings };
      }
    } catch (e) {
      log('读取设置失败，使用默认值：' + e.message);
    }
  }

  async function saveSettings() {
    try {
      await API.insertOrAssignVariables({ world_sim_settings: settings }, { type: 'global' });
    } catch (e) {
      log('保存设置失败：' + e.message);
    }
  }

  // ---------- 世界状态持久化(聊天变量，跟着当前RP走) ----------
  async function loadWorldState() {
    try {
      const vars = await API.getVariables({ type: 'chat' });
      cachedState = { ...DEFAULT_STATE, ...(vars && vars.world_sim_state) };
    } catch (e) {
      log('读取世界状态失败：' + e.message);
      cachedState = { ...DEFAULT_STATE };
    }
    return cachedState;
  }

  async function saveWorldState(state) {
    cachedState = state;
    try {
      await API.insertOrAssignVariables({ world_sim_state: state }, { type: 'chat' });
    } catch (e) {
      log('保存世界状态失败：' + e.message);
    }
    updateInjection(state);
  }

  // ---------- 历史压缩：避免 worldEvents/consequences 无限膨胀 ----------
  function compressList(list, maxLen, archiveBuilder) {
    if (!list || list.length <= maxLen) return list || [];
    const excess = list.length - maxLen;
    const old = list.slice(0, excess);
    const keep = list.slice(excess);
    return [archiveBuilder(old), ...keep];
  }

  function compressWorldState(state) {
    state.worldEvents = compressList(state.worldEvents, MAX_EVENTS, old => ({
      summary: '（历史归档）' + old.map(e => e.summary).join('；'),
      status: 'resolved',
      archived: true,
    }));
    state.consequences = compressList(state.consequences, MAX_CONSEQUENCES, old => ({
      origin: '（历史归档）',
      currentDevelopment: old.map(c => `${c.origin}→${c.currentDevelopment}`).join('；'),
      status: 'resolved',
      archived: true,
    }));
    // 关系变动时间线只保留最近 N 条（旧的直接丢弃，当前关系已存在角色身上）
    if ((state.relationshipEvents || []).length > MAX_REL_EVENTS) {
      state.relationshipEvents = state.relationshipEvents.slice(-MAX_REL_EVENTS);
    }
    return state;
  }

  // ---------- 注入正式RP：只塞状态数据，不塞指令 ----------
  function updateInjection(state) {
    try {
      const ctx = SillyTavern.getContext();
      if (!settings.injectState) {
        ctx.setExtensionPrompt(INJECT_KEY, '', ctx.extension_prompt_types.IN_CHAT, settings.injectDepth, false, ctx.extension_prompt_roles.SYSTEM);
        return;
      }
      const text = formatWorldStateForInjection(state);
      const block = `<${INJECT_TAG}>\n${text}\n</${INJECT_TAG}>`;
      ctx.setExtensionPrompt(
        INJECT_KEY,
        block,
        ctx.extension_prompt_types.IN_CHAT,
        settings.injectDepth,
        false,
        ctx.extension_prompt_roles.SYSTEM
      );
    } catch (e) {
      log('注入世界状态失败：' + e.message);
    }
  }

  function formatWorldStateForInjection(state) {
    const lines = [];
    const chars = Object.entries(state.characters || {});
    if (chars.length) {
      lines.push('[重要角色现状]');
      for (const [name, c] of chars) {
        const withWho = c.with ? `，正与${c.with}互动` : '';
        lines.push(`- ${name}：在${c.location || '未知处'}，${c.activity || '状态不明'}${withWho}。（${c.lastEvent || ''}）`);
        if (c.pregnancy) lines.push(`  · 身孕：${c.pregnancy}`);
        if ((c.children || []).length) lines.push(`  · 子女：${c.children.join('、')}`);
        if (settings.injectRelations && (c.relationships || []).length) {
          const rel = c.relationships
            .map(r => `${r.target}[${r.type || '未定'}]${r.relation ? '：' + r.relation : ''}`)
            .join('；');
          lines.push(`  · 关系：${rel}`);
        }
      }
    }
    if ((state.worldEvents || []).length) {
      lines.push('[世界大小事]');
      for (const ev of state.worldEvents) {
        lines.push(`- ${ev.summary}（${ev.status === 'resolved' ? '已了结' : '进行中'}）`);
      }
    }
    if ((state.consequences || []).length) {
      lines.push('[过往行为的后续影响]');
      for (const c of state.consequences) {
        lines.push(`- 起因：${c.origin}｜现状：${c.currentDevelopment}（${c.status === 'resolved' ? '已了结' : '进行中'}）`);
      }
    }
    if (settings.injectRelations && (state.relationshipEvents || []).length) {
      lines.push('[最近的关系变动]');
      for (const e of state.relationshipEvents.slice(-5)) {
        lines.push(`- ${e.a} 与 ${e.b}：${e.from || '?'} → ${e.to}${e.reason ? '（' + e.reason + '）' : ''}`);
      }
    }
    return lines.join('\n') || '（世界暂无值得一提的变化）';
  }

  // ---------- 取得目前聊天里的主要角色卡 ----------
  function getMainCastNames() {
    try {
      const ctx = SillyTavern.getContext();
      if (ctx.groupId && ctx.groups) {
        const group = ctx.groups.find(g => g.id === ctx.groupId);
        if (group && group.members) {
          return group.members
            .map(avatar => ctx.characters.find(c => c.avatar === avatar))
            .filter(Boolean)
            .map(c => c.name);
        }
      }
      const single = ctx.characters && ctx.characters[ctx.characterId];
      return single ? [single.name] : [];
    } catch (e) {
      log('读取角色卡失败：' + e.message);
      return [];
    }
  }

  // ---------- 时间锚点：读取预设自带的 TimeLocation 变量 ----------
  async function getStoryTime() {
    if (!settings.useWorldTime) return '';
    try {
      const vars = await API.getVariables({ type: 'chat' });
      return (vars && vars.TimeLocation) || '';
    } catch (e) {
      return '';
    }
  }

  // ---------- 已知世界元素：从绑定的世界书抓条目名称，减少AI瞎编地名/设定 ----------
  async function getKnownWorldbookNames() {
    if (!settings.useWorldbookNames) return [];
    const names = new Set();
    try {
      const ctx = SillyTavern.getContext();
      const bookNames = new Set();
      try { (await API.getGlobalWorldbookNames() || []).forEach(n => bookNames.add(n)); } catch (e) { /* ignore */ }
      try {
        const charName = ctx.characters?.[ctx.characterId]?.name;
        if (charName) {
          const cw = await API.getCharWorldbookNames(charName);
          if (cw) {
            if (cw.primary) bookNames.add(cw.primary);
            (cw.additional || []).forEach(n => bookNames.add(n));
          }
        }
      } catch (e) { /* ignore */ }
      try {
        const chatName = ctx.chatId;
        if (chatName) {
          const cn = await API.getChatWorldbookName(chatName);
          if (cn) bookNames.add(cn);
        }
      } catch (e) { /* ignore */ }

      for (const bn of bookNames) {
        try {
          const entries = await API.getWorldbook(bn);
          (entries || []).forEach(e => {
            if (e.enabled !== false && e.name) names.add(e.name);
          });
        } catch (e) { /* 单本世界书读取失败就跳过 */ }
      }
    } catch (e) {
      log('读取世界书条目失败：' + e.message);
    }
    return [...names].slice(0, MAX_WORLDBOOK_NAMES);
  }

  async function getRecentHistoryText(n) {
    try {
      const msgs = await API.getChatMessages(`0-${n}`, { role: 'all', hide_state: 'unhidden' });
      return (msgs || [])
        .slice(-n)
        .map(m => `${m.name}: ${String(m.message || '').slice(0, 300)}`)
        .join('\n');
    } catch (e) {
      log('读取历史消息失败：' + e.message);
      return '';
    }
  }

  // ---------- 组 Prompt(仅用于背景模拟的AI调用，跟正式RP的预设完全隔离) ----------
  function buildPrompt(mainCast, worldState, recentText, storyTime, knownElements) {
    const whitelist = settings.whitelist.split(',').map(s => s.trim()).filter(Boolean);

    const sys = [
      '你是"世界模拟器"，负责推演玩家没有直接互动的这段时间里，世界与角色发生了什么。',
      '严格只输出一个 JSON 对象，不要输出 JSON 以外的任何文字，不要用代码块包裹。',
      '',
      '追踪范围铁律：',
      '- 只处理"重要角色"：主线角色卡、跟玩家/剧情有实质牵连、有名字且会反复出现的角色。',
      '- 绝对不要建立或提及路人、店员、服务生等一次性打酱油角色，哪怕他们在历史记录里被提到过一次。',
      whitelist.length ? `- 本次额外指定只关心这些角色：${whitelist.join('、')}。` : '',
      storyTime ? `- 当前故事内时间/地点锚点：${storyTime}。角色的活动要符合这个时间点(比如深夜不该在上课)。` : '',
      knownElements.length ? `- 已知世界元素参考(可能是地点/人物/设定，非全部)：${knownElements.join('、')}。描述地点或事物时优先从中选取，避免凭空发明明显矛盾的新地名。` : '',
      '',
      '输出格式：',
      '{"characters":[{"name":"角色名","location":"目前位置","activity":"正在做的事","interacting_with":"互动对象或null","summary":"这段时间发生的简短经过(不超过60字)","pregnancy":"怀孕状态描述，如\\"怀孕约3个月，孩子父亲是XX\\"，没有就填null","children":["孩子的名字与年龄，如\\"小星(1岁)\\"，没有就空数组"],"relationships":[{"target":"另一个重要角色名","type":"关系状态标签","relation":"两人目前关系的简短描述(不超过25字)"}],"visible":true或false,"narration":"若visible为true，给玩家看的一句旁白，否则为空字符串"}],',
      '"world_events":[{"summary":"世界发生的大小事","status":"ongoing或resolved"}],',
      '"consequences":[{"origin":"源于玩家之前做过的什么事(需能对应历史记录)","current_development":"现在发酵到什么程度了","status":"ongoing或resolved"}],',
      '"relationship_events":[{"a":"角色A","b":"角色B","from":"变化前的关系状态","to":"变化后的关系状态","reason":"为什么会变(不超过30字)"}]}',
      '',
      'NPC 之间的关系演化（重点）：',
      '- 角色之间会自己发展感情与矛盾，不需要玩家介入。他们会因为长期相处、共同经历、',
      '  误会、争执而让关系前进或倒退。',
      '- type 用简短中文标签，例如：陌生、点头之交、同学、同事、师徒、朋友、好兄弟、闺蜜、',
      '  暧昧、交往、订婚、结婚、家人、赌气、冷战、疏远、冲突、敌对、绝交。',
      '- 关系要循序渐进，不可跳级：陌生的两人不会突然结婚，朋友要先经过暧昧才可能交往，',
      '  一次小争执只会变成"赌气"而不是"绝交"。每次模拟最多让一对关系推进或倒退一个阶段。',
      '- 大多数时候关系维持原状即可，只有发生了足以改变关系的事件时才变动。',
      '- 关系必须双向一致：若 A 对 B 是"交往"，B 对 A 也必须是"交往"。',
      '- 只要有任何一对关系的 type 与"当前世界状态"里的不同，就必须在 relationship_events',
      '  里列出这次变化；没有变化就给空数组。',
      '',
      '人生阶段（照实记录，不要回避）：',
      '- NPC 的人生会自然推进：交往、同居、结婚、怀孕、生小孩、养育孩子，都是这个世界的常态。',
      '- 不要因为题材敏感就跳过、淡化或拒绝记录这些；也不要主动阻止或"修正"它已经发生的事实。',
      '- pregnancy / children 只需要客观陈述状态（是否怀孕、几个月、孩子是谁的、孩子几岁），',
      '  不需要描写过程或任何性相关细节，这里是状态台账不是剧情正文。',
      '- 怀孕与生育要符合时间逻辑：需要先有对应的亲密关系，怀孕后要经过足够的时间才会生产，',
      '  不可以一次模拟就从"交往"直接跳到"孩子3岁"。',
      '- 孩子出生、确认怀孕这类事件，要同时写进 world_events 让玩家知道。',
      '',
      '规则：',
      '- 大部分日常事件应该琐碎(上课、吃饭、睡觉、闲聊)，只有少数重要事件 visible 才设 true。',
      '- relationships 只写"该角色与其他重要角色之间"的关系，不要写与路人的关系；',
      '  关系描述要反映剧情里实际发生过的事，没有交集就不要写。',
      '- consequences 只能基于"最近剧情摘要"或"当前世界状态"里已经存在的线索去推进，不要凭空编造玩家没做过的事。',
      '- 如果某个已追踪角色这段时间没有变化，也要照实给出(不用编造戏剧性发展)。',
    ].filter(Boolean).join('\n');

    const userPayload = {
      主要角色卡: mainCast,
      当前世界状态: worldState,
      最近剧情摘要: recentText,
    };

    return { sys, user: JSON.stringify(userPayload) };
  }

  function sanitizeForSlash(text) {
    return String(text || '').replace(/"/g, "'").replace(/\|/g, '/').replace(/\n/g, ' ');
  }

  function extractJson(text) {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) throw new Error('未找到 JSON');
    return JSON.parse(match[0]);
  }

  // ---------- 调用 AI(仅背景模拟用) ----------
  async function callAI(sys, user) {
    if (settings.apiMode === 'custom') {
      if (!settings.customUrl || !settings.customModel) {
        throw new Error('自定义反代未填写完整(URL/Model)');
      }
      return await API.generateRaw({
        ordered_prompts: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        custom_api: {
          apiurl: settings.customUrl,
          key: settings.customKey,
          model: settings.customModel,
          source: 'openai',
        },
      });
    }
    return await API.generateRaw({
      ordered_prompts: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    });
  }

  // 关系双向补齐：AI 只写了 A→B 时，自动补上 B→A，避免关系网单边
  function mirrorRelationships(characters) {
    for (const [name, c] of Object.entries(characters)) {
      for (const rel of c.relationships || []) {
        const other = characters[rel.target];
        if (!other) continue;  // 对象不在追踪名单里就不补
        other.relationships = other.relationships || [];
        const back = other.relationships.find(r => r.target === name);
        if (!back) {
          other.relationships.push({ target: name, type: rel.type, relation: rel.relation });
        } else if (!back.type && rel.type) {
          back.type = rel.type;
        }
      }
    }
  }

  function mergeByKey(existingList, incomingList, keyFn) {
    const map = new Map((existingList || []).filter(x => !x.archived).map(x => [keyFn(x), x]));
    const archived = (existingList || []).filter(x => x.archived);
    for (const item of incomingList || []) {
      map.set(keyFn(item), item);
    }
    return [...archived, ...map.values()];
  }

  // ---------- 主循环 ----------
  async function runWorldTick(manual = false) {
    if (isTicking) {
      log('上一次模拟还没跑完，跳过本次');
      return;
    }
    isTicking = true;
    setBallBusy(true);
    log(manual ? '手动触发模拟…' : '世界演化中…');
    try {
      const mainCast = getMainCastNames();
      const worldState = await loadWorldState();
      const recentText = await getRecentHistoryText(settings.historyN);
      const storyTime = await getStoryTime();
      const knownElements = await getKnownWorldbookNames();
      const { sys, user } = buildPrompt(mainCast, worldState, recentText, storyTime, knownElements);

      const raw = await callAI(sys, user);
      const text = typeof raw === 'string' ? raw : raw?.content || '';
      const result = extractJson(text);

      worldState.characters = worldState.characters || {};
      worldState.elapsedTicks = (worldState.elapsedTicks || 0) + 1;

      for (const c of result.characters || []) {
        worldState.characters[c.name] = {
          location: c.location,
          activity: c.activity,
          with: c.interacting_with || null,
          lastEvent: c.summary || '',
          pregnancy: c.pregnancy || null,
          children: Array.isArray(c.children) ? c.children.filter(Boolean) : (worldState.characters[c.name]?.children || []),
          relationships: Array.isArray(c.relationships)
            ? c.relationships.filter(r => r && r.target).map(r => ({
                target: r.target, type: r.type || '', relation: r.relation || '',
              }))
            : (worldState.characters[c.name]?.relationships || []),
          updatedAt: Date.now(),
        };
        if (settings.autoNarration && c.visible && c.narration) {
          const safe = sanitizeForSlash(c.narration);
          await API.triggerSlash(`/sys "${safe}"`);
        }
        log(`· ${c.name}：${c.activity}${c.location ? '(' + c.location + ')' : ''}`);
      }

      worldState.worldEvents = mergeByKey(
        worldState.worldEvents,
        (result.world_events || []).map(e => ({ summary: e.summary, status: e.status || 'ongoing' })),
        e => e.summary
      );
      worldState.consequences = mergeByKey(
        worldState.consequences,
        (result.consequences || []).map(c => ({
          origin: c.origin,
          currentDevelopment: c.current_development,
          status: c.status || 'ongoing',
        })),
        c => c.origin
      );

      mirrorRelationships(worldState.characters);

      // 关系变动：追加到时间线，并广播到日志
      const relEvents = (result.relationship_events || [])
        .filter(e => e && e.a && e.b)
        .map(e => ({
          a: e.a, b: e.b, from: e.from || '', to: e.to || '',
          reason: e.reason || '', tick: worldState.elapsedTicks, at: Date.now(),
        }));
      if (relEvents.length) {
        worldState.relationshipEvents = [...(worldState.relationshipEvents || []), ...relEvents];
        for (const e of relEvents) {
          log(`💞 ${e.a} 与 ${e.b}：${e.from || '?'} → ${e.to}`);
        }
      }

      compressWorldState(worldState);
      await saveWorldState(worldState);
      renderActiveTab();
      log('本轮模拟完成 ✓');
    } catch (e) {
      log('模拟出错：' + e.message);
    } finally {
      isTicking = false;
      setBallBusy(false);
    }
  }

  // ---------- 触发器 ----------
  function registerFloorTrigger() {
    if (msgListenerHandle) return;
    msgListenerHandle = () => {
      if (!settings.running || settings.triggerMode !== 'floor') return;
      floorCounter++;
      if (floorCounter >= settings.triggerN) {
        floorCounter = 0;
        runWorldTick();
      }
    };
    API.eventOn(API.tavern_events.MESSAGE_RECEIVED, msgListenerHandle);
  }

  function startMinuteTimer() {
    stopMinuteTimer();
    if (settings.triggerMode === 'minute' && settings.running) {
      minuteTimer = setInterval(() => runWorldTick(), Math.max(1, settings.triggerN) * 60000);
    }
  }

  function stopMinuteTimer() {
    if (minuteTimer) {
      clearInterval(minuteTimer);
      minuteTimer = null;
    }
  }

  // ---------- 小工具 ----------
  function esc(text) {
    return $('<div>').text(text == null ? '' : String(text)).html();
  }

  function log(text) {
    const $log = $('#wsp-log');
    if ($log.length) {
      const time = new Date().toLocaleTimeString();
      $log.prepend(`<div>[${time}] ${esc(text)}</div>`);
      while ($log.children().length > 40) $log.children().last().remove();
    }
    console.log('[世界模拟器]', text);
  }

  function setBallBusy(busy) {
    $('#wsp-ball').toggleClass('wsp-busy', !!busy);
  }

  // ---------- 样式 ----------
  function injectStyle() {
    $('#wsp-style').remove();
    $(`<style id="wsp-style">
      #wsp-ball {
        position: fixed; z-index: 10000; width: 52px; height: 52px; border-radius: 50%;
        background: linear-gradient(145deg, #5b7fc7, #35508c);
        color: #fff; display: flex; align-items: center; justify-content: center;
        font-size: 24px; cursor: grab; user-select: none;
        box-shadow: 0 4px 14px rgba(0,0,0,.45); transition: transform .15s;
      }
      #wsp-ball:hover { transform: scale(1.08); }
      #wsp-ball.wsp-busy { animation: wsp-spin 1.4s linear infinite; }
      @keyframes wsp-spin { to { transform: rotate(360deg); } }

      #wsp-panel {
        position: fixed; z-index: 10000; width: 560px; height: 460px;
        background: #1b1b1f; color: #e8e8ea; border-radius: 10px;
        box-shadow: 0 8px 30px rgba(0,0,0,.55); font-size: 13px;
        font-family: system-ui, sans-serif; display: none; overflow: hidden;
        flex-direction: column; border: 1px solid #33343a;
      }
      #wsp-panel.wsp-open { display: flex; }
      #wsp-titlebar {
        height: 34px; flex: none; display: flex; align-items: center; justify-content: space-between;
        padding: 0 10px; background: #232429; cursor: move; font-weight: 600;
        border-bottom: 1px solid #33343a;
      }
      #wsp-titlebar .wsp-close { cursor: pointer; opacity: .7; font-size: 16px; }
      #wsp-titlebar .wsp-close:hover { opacity: 1; }
      #wsp-main { flex: 1; display: flex; min-height: 0; }
      #wsp-tabs {
        width: 120px; flex: none; background: #202127; border-right: 1px solid #33343a;
        padding: 8px 0; display: flex; flex-direction: column; gap: 2px;
      }
      .wsp-tab {
        padding: 9px 12px; cursor: pointer; border-left: 3px solid transparent;
        color: #a8a9b4; white-space: nowrap;
      }
      .wsp-tab:hover { background: #282a31; color: #ddd; }
      .wsp-tab.active { background: #2b2d36; color: #fff; border-left-color: #5b7fc7; }
      #wsp-content { flex: 1; overflow-y: auto; padding: 12px; min-width: 0; }

      #wsp-content h3 { margin: 0 0 8px; font-size: 13px; color: #9fb4e0; font-weight: 600; }
      #wsp-content .wsp-sec { margin-bottom: 16px; }
      #wsp-content label { display: block; margin-bottom: 8px; color: #c9cad2; }
      #wsp-content input[type=text], #wsp-content input[type=password],
      #wsp-content input[type=number], #wsp-content select, #wsp-content textarea {
        width: 100%; box-sizing: border-box; margin-top: 3px; padding: 5px 7px;
        background: #16171b; color: #e8e8ea; border: 1px solid #3a3b43; border-radius: 4px;
      }
      #wsp-content input[type=checkbox] { margin-right: 6px; vertical-align: -1px; }
      #wsp-content button {
        padding: 6px 10px; background: #394260; color: #e8e8ea;
        border: 1px solid #4a5478; border-radius: 4px; cursor: pointer;
      }
      #wsp-content button:hover { background: #455075; }

      .wsp-npc { border: 1px solid #33343a; border-radius: 6px; margin-bottom: 6px; overflow: hidden; }
      .wsp-npc-head {
        padding: 8px 10px; cursor: pointer; display: flex; justify-content: space-between;
        align-items: center; background: #232429;
      }
      .wsp-npc-head:hover { background: #2a2c33; }
      .wsp-npc-name { font-weight: 600; }
      .wsp-npc-brief { color: #8f909b; font-size: 12px; }
      .wsp-npc-body { padding: 10px; background: #1d1e23; display: none; }
      .wsp-npc.open .wsp-npc-body { display: block; }
      .wsp-field { margin-bottom: 6px; }
      .wsp-field b { color: #9fb4e0; font-weight: 600; margin-right: 4px; }
      .wsp-rel { padding: 4px 8px; margin: 3px 0; background: #24262d; border-radius: 4px;
                 border-left: 2px solid #5b7fc7; }
      .wsp-empty { color: #71727d; text-align: center; padding: 24px 0; }
      .wsp-item { padding: 8px 10px; margin-bottom: 6px; background: #232429;
                  border-radius: 5px; border-left: 3px solid #5b7fc7; }
      .wsp-item.done { border-left-color: #4a7c59; opacity: .72; }
      .wsp-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px;
                   background: #394260; color: #c3cbe6; margin-left: 6px; }
      #wsp-log { max-height: 160px; overflow-y: auto; background: #131418;
                 padding: 6px; border-radius: 4px; font-size: 11px;
                 font-family: monospace; color: #8f909b; }
      #wsp-editor { height: 200px; font-family: monospace; font-size: 11px; color: #8fd98f; }
      .wsp-row { display: flex; gap: 6px; align-items: center; }
      .wsp-row > * { flex: 1; }
      .wsp-row > button { flex: none; }
    </style>`).appendTo('head');
  }

  // ---------- 分页渲染 ----------
  function renderSettingsTab() {
    const s = settings;
    return `
      <div class="wsp-sec">
        <h3>运行控制</h3>
        <div class="wsp-row" style="margin-bottom:10px;">
          <button id="wsp-toggle">${s.running ? '⏸ 停止' : '▶ 开始'}</button>
          <button id="wsp-run-now">⚡ 立即跑一次</button>
        </div>
        <label>触发方式
          <div class="wsp-row">
            <select id="wsp-mode">
              <option value="floor"${s.triggerMode === 'floor' ? ' selected' : ''}>每 N 楼</option>
              <option value="minute"${s.triggerMode === 'minute' ? ' selected' : ''}>每 N 分钟</option>
            </select>
            <input type="number" id="wsp-n" min="1" value="${s.triggerN}">
          </div>
        </label>
        <label>参考最近几楼历史
          <input type="number" id="wsp-historyN" min="5" value="${s.historyN}">
        </label>
      </div>

      <div class="wsp-sec">
        <h3>API 来源（背景模拟用）</h3>
        <label>
          <select id="wsp-apiMode">
            <option value="shared"${s.apiMode === 'shared' ? ' selected' : ''}>沿用 ST 当前连线</option>
            <option value="custom"${s.apiMode === 'custom' ? ' selected' : ''}>自定义反代</option>
          </select>
        </label>
        <div id="wsp-custom-fields" style="display:${s.apiMode === 'custom' ? 'block' : 'none'};">
          <label>Base URL
            <input type="text" id="wsp-url" value="${esc(s.customUrl)}" placeholder="https://gcli.ggchan.dev/v1">
          </label>
          <label>API Key
            <input type="password" id="wsp-key" value="${esc(s.customKey)}">
          </label>
          <label>Model
            <input type="text" id="wsp-model" value="${esc(s.customModel)}" placeholder="gemini-3.1-pro-preview">
          </label>
        </div>
      </div>

      <div class="wsp-sec">
        <h3>注入与行为</h3>
        <label><input type="checkbox" id="wsp-inject"${s.injectState ? ' checked' : ''}>把世界状态注入正式RP（只含状态，不含指令）</label>
        <label><input type="checkbox" id="wsp-injectrel"${s.injectRelations ? ' checked' : ''}>关系网也一起注入（好感度世界书已涵盖可关掉）</label>
        <label><input type="checkbox" id="wsp-narration"${s.autoNarration ? ' checked' : ''}>重要事件自动插入旁白到聊天</label>
        <label><input type="checkbox" id="wsp-usetime"${s.useWorldTime ? ' checked' : ''}>读取预设 TimeLocation 作为时间锚点</label>
        <label><input type="checkbox" id="wsp-useworldbook"${s.useWorldbookNames ? ' checked' : ''}>读取世界书条目名称避免瞎编地名</label>
        <label>注入深度（对齐预设"现实层"插槽）
          <input type="number" id="wsp-depth" min="0" value="${s.injectDepth}">
        </label>
      </div>
    `;
  }

  function renderNpcTab() {
    const chars = Object.entries(cachedState.characters || {});
    let html = `
      <div class="wsp-sec">
        <h3>加入追踪</h3>
        <div class="wsp-row">
          <input type="text" id="wsp-promote-name" placeholder="角色名">
          <button id="wsp-promote-btn">➕ 加入</button>
        </div>
      </div>
      <div class="wsp-sec">
        <h3>NPC 状态（${chars.length}）</h3>
    `;

    if (!chars.length) {
      html += `<div class="wsp-empty">还没有任何 NPC 资料<br>先按「设置 → 立即跑一次」推演世界</div>`;
    } else {
      for (const [name, c] of chars) {
        const isOpen = expandedNpc === name;
        const rels = c.relationships || [];
        html += `
          <div class="wsp-npc${isOpen ? ' open' : ''}" data-npc="${esc(name)}">
            <div class="wsp-npc-head">
              <span class="wsp-npc-name">${esc(name)}${c.pregnancy ? ' 🤰' : ''}${(c.children || []).length ? ' 👶' : ''}</span>
              <span class="wsp-npc-brief">${esc(c.location || '未知')} · ${esc(c.activity || '状态不明')}</span>
            </div>
            <div class="wsp-npc-body">
              <div class="wsp-field"><b>位置</b>${esc(c.location || '未知')}</div>
              <div class="wsp-field"><b>行为</b>${esc(c.activity || '状态不明')}</div>
              <div class="wsp-field"><b>互动对象</b>${esc(c.with || '无')}</div>
              <div class="wsp-field"><b>近况</b>${esc(c.lastEvent || '—')}</div>
              ${c.pregnancy ? `<div class="wsp-field"><b>身孕</b><span style="color:#e08ab5;">${esc(c.pregnancy)}</span></div>` : ''}
              ${(c.children || []).length ? `<div class="wsp-field"><b>子女</b>${c.children.map(k => `<span class="wsp-badge" style="background:#d99a4e;color:#fff;">${esc(k)}</span>`).join(' ')}</div>` : ''}
              <div class="wsp-field"><b>关系网</b>${rels.length ? '' : '（尚无记录）'}</div>
              ${rels.map(r => `
                <div class="wsp-rel" style="border-left-color:${relColor(r.type)};">
                  <b>${esc(r.target)}</b>
                  <span class="wsp-badge" style="background:${relColor(r.type)};color:#fff;">${esc(r.type || '未定')}</span>
                  ${r.relation ? `<div style="margin-top:2px;color:#a8a9b4;">${esc(r.relation)}</div>` : ''}
                </div>
              `).join('')}
              <div style="margin-top:10px;">
                <button class="wsp-remove-npc" data-npc="${esc(name)}">🗄 移出追踪</button>
              </div>
            </div>
          </div>
        `;
      }
    }
    html += '</div>';
    return html;
  }

  function renderRelationsTab() {
    const relEvents = [...(cachedState.relationshipEvents || [])].reverse();
    const chars = Object.entries(cachedState.characters || {});

    // 汇总所有关系对（去重，A-B 只显示一次）
    const pairs = new Map();
    for (const [name, c] of chars) {
      for (const r of c.relationships || []) {
        const key = [name, r.target].sort().join(' ');
        if (!pairs.has(key)) {
          pairs.set(key, { a: name, b: r.target, type: r.type, relation: r.relation });
        }
      }
    }

    let html = `<div class="wsp-sec"><h3>关系变动时间线（${relEvents.length}）</h3>`;
    if (!relEvents.length) {
      html += `<div class="wsp-empty">还没有关系变动<br><span style="font-size:11px;">NPC 之间会随着相处自己发展感情或产生矛盾</span></div>`;
    } else {
      for (const e of relEvents) {
        html += `<div class="wsp-item" style="border-left-color:${relColor(e.to)};">
          <div><b>${esc(e.a)}</b> 与 <b>${esc(e.b)}</b></div>
          <div style="margin-top:3px;">
            <span class="wsp-badge" style="background:#3a3b43;">${esc(e.from || '?')}</span>
            <span style="color:#71727d;">→</span>
            <span class="wsp-badge" style="background:${relColor(e.to)};color:#fff;">${esc(e.to)}</span>
          </div>
          ${e.reason ? `<div style="margin-top:3px;color:#a8a9b4;font-size:12px;">${esc(e.reason)}</div>` : ''}
        </div>`;
      }
    }
    html += '</div>';

    html += `<div class="wsp-sec"><h3>目前的关系一览（${pairs.size}）</h3>`;
    if (!pairs.size) {
      html += `<div class="wsp-empty">尚无关系记录</div>`;
    } else {
      for (const p of pairs.values()) {
        html += `<div class="wsp-rel" style="border-left-color:${relColor(p.type)};">
          <b>${esc(p.a)}</b> ↔ <b>${esc(p.b)}</b>
          <span class="wsp-badge" style="background:${relColor(p.type)};color:#fff;">${esc(p.type || '未定')}</span>
          ${p.relation ? `<div style="margin-top:2px;color:#a8a9b4;">${esc(p.relation)}</div>` : ''}
        </div>`;
      }
    }
    html += '</div>';
    return html;
  }

  function renderWorldTab() {
    const events = cachedState.worldEvents || [];
    const cons = cachedState.consequences || [];
    let html = `<div class="wsp-sec"><h3>世界大小事（${events.length}）</h3>`;
    if (!events.length) {
      html += `<div class="wsp-empty">尚无世界事件记录</div>`;
    } else {
      for (const ev of events) {
        const done = ev.status === 'resolved';
        html += `<div class="wsp-item${done ? ' done' : ''}">
          ${esc(ev.summary)}<span class="wsp-badge">${done ? '已了结' : '进行中'}</span>
        </div>`;
      }
    }
    html += '</div>';

    html += `<div class="wsp-sec"><h3>我做过的事的后续发酵（${cons.length}）</h3>`;
    if (!cons.length) {
      html += `<div class="wsp-empty">尚无后续影响记录</div>`;
    } else {
      for (const c of cons) {
        const done = c.status === 'resolved';
        html += `<div class="wsp-item${done ? ' done' : ''}">
          <div><b style="color:#9fb4e0;">起因</b> ${esc(c.origin)}</div>
          <div style="margin-top:3px;"><b style="color:#9fb4e0;">现状</b> ${esc(c.currentDevelopment)}
            <span class="wsp-badge">${done ? '已了结' : '进行中'}</span></div>
        </div>`;
      }
    }
    html += '</div>';
    return html;
  }

  function renderAdvancedTab() {
    return `
      <div class="wsp-sec">
        <h3>手动修正世界状态（JSON）</h3>
        <textarea id="wsp-editor"></textarea>
        <div class="wsp-row" style="margin-top:6px;">
          <button id="wsp-editor-save">💾 保存修改</button>
          <button id="wsp-editor-reload">🔄 重新载入</button>
        </div>
      </div>
      <div class="wsp-sec">
        <h3>运行日志</h3>
        <div id="wsp-log"></div>
      </div>
    `;
  }

  const TABS = [
    { id: 'npc', label: '🧑 NPC 状态', render: renderNpcTab },
    { id: 'relations', label: '💞 关系网', render: renderRelationsTab },
    { id: 'world', label: '🌍 世界大小事', render: renderWorldTab },
    { id: 'settings', label: '⚙️ 设置', render: renderSettingsTab },
    { id: 'advanced', label: '🛠 高级/日志', render: renderAdvancedTab },
  ];

  function renderActiveTab() {
    const tab = TABS.find(t => t.id === activeTab) || TABS[0];
    $('#wsp-content').html(tab.render());
    $('.wsp-tab').removeClass('active').filter(`[data-tab="${activeTab}"]`).addClass('active');
    bindTabEvents();
  }

  // ---------- 事件绑定 ----------
  function bindTabEvents() {
    // --- 设置页 ---
    $('#wsp-toggle').on('click', () => {
      settings.running = !settings.running;
      saveSettings();
      if (settings.running) { startMinuteTimer(); log('已启动'); }
      else { stopMinuteTimer(); log('已停止'); }
      $('#wsp-toggle').text(settings.running ? '⏸ 停止' : '▶ 开始');
    });
    $('#wsp-run-now').on('click', () => runWorldTick(true));
    $('#wsp-apiMode').on('change', function () {
      settings.apiMode = this.value;
      $('#wsp-custom-fields').toggle(this.value === 'custom');
      saveSettings();
    });
    $('#wsp-url').on('change', function () { settings.customUrl = this.value; saveSettings(); });
    $('#wsp-key').on('change', function () { settings.customKey = this.value; saveSettings(); });
    $('#wsp-model').on('change', function () { settings.customModel = this.value; saveSettings(); });
    $('#wsp-mode').on('change', function () {
      settings.triggerMode = this.value; saveSettings(); startMinuteTimer();
    });
    $('#wsp-n').on('change', function () {
      settings.triggerN = parseInt(this.value, 10) || 1; saveSettings(); startMinuteTimer();
    });
    $('#wsp-historyN').on('change', function () {
      settings.historyN = parseInt(this.value, 10) || 30; saveSettings();
    });
    $('#wsp-depth').on('change', async function () {
      settings.injectDepth = parseInt(this.value, 10) || 0;
      await saveSettings();
      updateInjection(cachedState);
    });
    $('#wsp-inject').on('change', async function () {
      settings.injectState = this.checked; await saveSettings(); updateInjection(cachedState);
    });
    $('#wsp-injectrel').on('change', async function () {
      settings.injectRelations = this.checked; await saveSettings(); updateInjection(cachedState);
    });
    $('#wsp-narration').on('change', function () { settings.autoNarration = this.checked; saveSettings(); });
    $('#wsp-usetime').on('change', function () { settings.useWorldTime = this.checked; saveSettings(); });
    $('#wsp-useworldbook').on('change', function () { settings.useWorldbookNames = this.checked; saveSettings(); });

    // --- NPC 页 ---
    $('.wsp-npc-head').on('click', function () {
      const name = $(this).closest('.wsp-npc').data('npc');
      expandedNpc = (expandedNpc === name) ? null : name;
      renderActiveTab();
    });
    $('#wsp-promote-btn').on('click', async () => {
      const name = String($('#wsp-promote-name').val() || '').trim();
      if (!name) return;
      const list = settings.whitelist.split(',').map(s => s.trim()).filter(Boolean);
      if (!list.includes(name)) list.push(name);
      settings.whitelist = list.join(',');
      await saveSettings();

      const state = await loadWorldState();
      if (!state.characters[name]) {
        state.characters[name] = {
          location: '未知', activity: '尚待模拟', with: null,
          lastEvent: '刚被标记为重要角色', relationships: [], updatedAt: Date.now(),
        };
      }
      await saveWorldState(state);
      renderActiveTab();
      log(`已将「${name}」加入追踪`);
    });
    $('.wsp-remove-npc').on('click', async function (e) {
      e.stopPropagation();
      const name = $(this).data('npc');
      const list = settings.whitelist.split(',').map(s => s.trim()).filter(x => x && x !== name);
      settings.whitelist = list.join(',');
      await saveSettings();

      const state = await loadWorldState();
      delete state.characters[name];
      await saveWorldState(state);
      if (expandedNpc === name) expandedNpc = null;
      renderActiveTab();
      log(`已将「${name}」移出追踪`);
    });

    // --- 高级页 ---
    if (activeTab === 'advanced') {
      $('#wsp-editor').val(JSON.stringify(cachedState, null, 2));
      $('#wsp-editor-save').on('click', async () => {
        try {
          const parsed = JSON.parse($('#wsp-editor').val());
          await saveWorldState(parsed);
          log('世界状态已手动保存');
        } catch (e) {
          log('JSON 格式错误：' + e.message);
        }
      });
      $('#wsp-editor-reload').on('click', async () => {
        await loadWorldState();
        $('#wsp-editor').val(JSON.stringify(cachedState, null, 2));
        log('已重新载入世界状态');
      });
    }
  }

  // ---------- 建立悬浮球 + 面板 ----------
  function buildUI() {
    $('#wsp-ball, #wsp-panel').remove();
    injectStyle();

    const startX = settings.ballX != null ? settings.ballX : (window.innerWidth - 80);
    const startY = settings.ballY != null ? settings.ballY : 120;

    const $ball = $(`<div id="wsp-ball" title="世界模拟器 v${SCRIPT_VERSION}">🌍</div>`)
      .css({ left: startX + 'px', top: startY + 'px' })
      .appendTo('body');

    const $panel = $(`
      <div id="wsp-panel">
        <div id="wsp-titlebar">
          <span>🌍 世界模拟器 v${SCRIPT_VERSION}</span>
          <span class="wsp-close">✕</span>
        </div>
        <div id="wsp-main">
          <div id="wsp-tabs">
            ${TABS.map(t => `<div class="wsp-tab" data-tab="${t.id}">${t.label}</div>`).join('')}
          </div>
          <div id="wsp-content"></div>
        </div>
      </div>
    `).appendTo('body');

    // --- 悬浮球拖拽（拖动不触发开关，只有真正的点击才开）---
    let dragging = false, moved = false, offsetX = 0, offsetY = 0;
    $ball.on('mousedown', e => {
      dragging = true; moved = false;
      const r = $ball[0].getBoundingClientRect();
      offsetX = e.clientX - r.left;
      offsetY = e.clientY - r.top;
      e.preventDefault();
    });
    $(document).on('mousemove.wsp', e => {
      if (!dragging) return;
      moved = true;
      const x = Math.max(0, Math.min(window.innerWidth - 52, e.clientX - offsetX));
      const y = Math.max(0, Math.min(window.innerHeight - 52, e.clientY - offsetY));
      $ball.css({ left: x + 'px', top: y + 'px' });
    });
    $(document).on('mouseup.wsp', () => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        const r = $ball[0].getBoundingClientRect();
        settings.ballX = r.left;
        settings.ballY = r.top;
        saveSettings();
      } else {
        togglePanel();
      }
    });

    // --- 面板拖拽 ---
    let pDrag = false, pOffX = 0, pOffY = 0;
    $('#wsp-titlebar').on('mousedown', e => {
      if ($(e.target).hasClass('wsp-close')) return;
      pDrag = true;
      const r = $panel[0].getBoundingClientRect();
      pOffX = e.clientX - r.left;
      pOffY = e.clientY - r.top;
      e.preventDefault();
    });
    $(document).on('mousemove.wsppanel', e => {
      if (!pDrag) return;
      $panel.css({ left: (e.clientX - pOffX) + 'px', top: (e.clientY - pOffY) + 'px' });
    });
    $(document).on('mouseup.wsppanel', () => { pDrag = false; });

    $('.wsp-close').on('click', () => $panel.removeClass('wsp-open'));
    $('.wsp-tab').on('click', function () {
      activeTab = $(this).data('tab');
      renderActiveTab();
    });

    renderActiveTab();
  }

  function togglePanel() {
    const $panel = $('#wsp-panel');
    if ($panel.hasClass('wsp-open')) {
      $panel.removeClass('wsp-open');
      return;
    }
    // 开启时定位到球旁边，并避免超出画面
    const r = $('#wsp-ball')[0].getBoundingClientRect();
    let left = r.left - 570;
    if (left < 10) left = r.right + 10;
    if (left + 560 > window.innerWidth) left = Math.max(10, window.innerWidth - 570);
    let top = Math.min(r.top, window.innerHeight - 470);
    if (top < 10) top = 10;
    $panel.css({ left: left + 'px', top: top + 'px' }).addClass('wsp-open');
    loadWorldState().then(renderActiveTab);
  }

  // ---------- 初始化 / 销毁 ----------
  async function init() {
    await loadSettings();
    await loadWorldState();
    buildUI();
    registerFloorTrigger();
    if (settings.running) startMinuteTimer();
    updateInjection(cachedState);
    // 脚本被停用/页面卸载时自我清理，不留悬浮球在画面上
    $(window).on('pagehide.worldsim', destroy);
    log(`世界模拟器 v${SCRIPT_VERSION} 已加载`);
  }

  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;

    stopMinuteTimer();
    if (msgListenerHandle) {
      try { API.eventRemoveListener(API.tavern_events.MESSAGE_RECEIVED, msgListenerHandle); } catch (e) { /* noop */ }
      msgListenerHandle = null;
    }
    // 清掉注入，避免脚本关了世界状态还留在RP提示词里
    try {
      const ctx = SillyTavern.getContext();
      ctx.setExtensionPrompt(INJECT_KEY, '', ctx.extension_prompt_types.IN_CHAT, settings.injectDepth, false, ctx.extension_prompt_roles.SYSTEM);
    } catch (e) { /* noop */ }

    $(window).off('pagehide.worldsim');
    $(document).off('.wsp').off('.wsppanel');
    $('#wsp-ball, #wsp-panel, #wsp-style').remove();
    if (window.__world_sim_instance__ && window.__world_sim_instance__.destroy === destroy) {
      delete window.__world_sim_instance__;
    }
    console.log('[世界模拟器] 已卸载');
  }

  window.__world_sim_instance__ = { destroy };

  // 启动失败时在画面上直接说明，而不是静悄悄什么都没有
  function showFatal(msg) {
    $('#wsp-fatal').remove();
    $(`<div id="wsp-fatal" style="position:fixed;top:20px;right:20px;z-index:10001;
         max-width:360px;background:#4a1f1f;color:#ffd7d7;border:1px solid #a05050;
         border-radius:8px;padding:12px;font-size:13px;font-family:system-ui,sans-serif;
         box-shadow:0 4px 14px rgba(0,0,0,.5);">
        <b>🌍 世界模拟器启动失败</b>
        <div style="margin-top:6px;white-space:pre-wrap;">${$('<div>').text(msg).html()}</div>
        <div style="margin-top:8px;font-size:11px;opacity:.8;">详细信息请看 F12 控制台</div>
        <div style="text-align:right;margin-top:6px;">
          <span style="cursor:pointer;text-decoration:underline;"
                onclick="this.closest('#wsp-fatal').remove()">关闭</span>
        </div>
      </div>`).appendTo('body');
  }

  try {
    init().catch(e => {
      console.error('[世界模拟器] 初始化失败', e);
      showFatal(e && e.message ? e.message : String(e));
    });
  } catch (e) {
    console.error('[世界模拟器] 初始化失败', e);
    showFatal(e && e.message ? e.message : String(e));
  }
})();
