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

  const SCRIPT_VERSION = '1.0.0';
  const INJECT_KEY = 'world_sim_current';
  const INJECT_TAG = 'World_Current';
  const MAX_EVENTS = 12;
  const MAX_CONSEQUENCES = 12;
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
    injectDepth: 10,          // 注入聊天记录的第几层（对齐"现实层"预设卡）
    whitelist: '',            // 手动指定/升级的重要角色，逗号分隔
    useWorldTime: true,       // 是否读取预设的 TimeLocation 变量作为时间锚点
    useWorldbookNames: true,  // 是否读取世界书条目名称作为"已知世界元素"参考
    running: false,
  };

  const DEFAULT_STATE = { characters: {}, worldEvents: [], consequences: [], elapsedTicks: 0 };

  let settings = { ...DEFAULT_SETTINGS };
  let floorCounter = 0;
  let minuteTimer = null;
  let isTicking = false;
  let msgListenerHandle = null;

  // ---------- 设置持久化(全局变量) ----------
  async function loadSettings() {
    try {
      const vars = await getVariables({ type: 'global' });
      if (vars && vars.world_sim_settings) {
        settings = { ...DEFAULT_SETTINGS, ...vars.world_sim_settings };
      }
    } catch (e) {
      log('读取设置失败，使用默认值：' + e.message);
    }
  }

  async function saveSettings() {
    try {
      await insertOrAssignVariables({ world_sim_settings: settings }, { type: 'global' });
    } catch (e) {
      log('保存设置失败：' + e.message);
    }
  }

  // ---------- 世界状态持久化(聊天变量，跟着当前RP走) ----------
  async function loadWorldState() {
    try {
      const vars = await getVariables({ type: 'chat' });
      return { ...DEFAULT_STATE, ...(vars && vars.world_sim_state) };
    } catch (e) {
      log('读取世界状态失败：' + e.message);
      return { ...DEFAULT_STATE };
    }
  }

  async function saveWorldState(state) {
    try {
      await insertOrAssignVariables({ world_sim_state: state }, { type: 'chat' });
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
      const vars = await getVariables({ type: 'chat' });
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
      try { (await getGlobalWorldbookNames() || []).forEach(n => bookNames.add(n)); } catch (e) { /* ignore */ }
      try {
        const charName = ctx.characters?.[ctx.characterId]?.name;
        if (charName) {
          const cw = await getCharWorldbookNames(charName);
          if (cw) {
            if (cw.primary) bookNames.add(cw.primary);
            (cw.additional || []).forEach(n => bookNames.add(n));
          }
        }
      } catch (e) { /* ignore */ }
      try {
        const chatName = ctx.chatId;
        if (chatName) {
          const cn = await getChatWorldbookName(chatName);
          if (cn) bookNames.add(cn);
        }
      } catch (e) { /* ignore */ }

      for (const bn of bookNames) {
        try {
          const entries = await getWorldbook(bn);
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
      const msgs = await getChatMessages(`0-${n}`, { role: 'all', hide_state: 'unhidden' });
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
      '{"characters":[{"name":"角色名","location":"目前位置","activity":"正在做的事","interacting_with":"互动对象或null","summary":"这段时间发生的简短经过(不超过60字)","visible":true或false,"narration":"若visible为true，给玩家看的一句旁白，否则为空字符串"}],',
      '"world_events":[{"summary":"世界发生的大小事","status":"ongoing或resolved"}],',
      '"consequences":[{"origin":"源于玩家之前做过的什么事(需能对应历史记录)","current_development":"现在发酵到什么程度了","status":"ongoing或resolved"}]}',
      '',
      '规则：',
      '- 大部分日常事件应该琐碎(上课、吃饭、睡觉、闲聊)，只有少数重要事件 visible 才设 true。',
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
      return await generateRaw({
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
    return await generateRaw({
      ordered_prompts: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    });
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
          updatedAt: Date.now(),
        };
        if (settings.autoNarration && c.visible && c.narration) {
          const safe = sanitizeForSlash(c.narration);
          await triggerSlash(`/sys "${safe}"`);
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

      compressWorldState(worldState);
      await saveWorldState(worldState);
      refreshEditorFromState(worldState);
      log('本轮模拟完成 ✓');
    } catch (e) {
      log('模拟出错：' + e.message);
    } finally {
      isTicking = false;
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
    eventOn(tavern_events.MESSAGE_RECEIVED, msgListenerHandle);
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

  // ---------- 手动修正 / 升降级 ----------
  async function refreshEditorFromState(state) {
    const s = state || (await loadWorldState());
    $('#wsp-editor').val(JSON.stringify(s, null, 2));
    const $sel = $('#wsp-archive-select');
    $sel.empty();
    Object.keys(s.characters || {}).forEach(name => {
      $sel.append(`<option value="${name}">${name}</option>`);
    });
  }

  // ---------- 悬浮面板 ----------
  function log(text) {
    const $log = $('#wsp-log');
    if ($log.length) {
      const time = new Date().toLocaleTimeString();
      $log.prepend(`<div>[${time}] ${text}</div>`);
      while ($log.children().length > 30) $log.children().last().remove();
    }
    console.log('[世界模拟器]', text);
  }

  function buildPanel() {
    $('#world-sim-panel').remove();

    const $panel = $(`
      <div id="world-sim-panel" style="position:fixed;top:80px;right:20px;z-index:9999;
           width:340px;background:#1e1e1e;color:#eee;border-radius:8px;padding:10px;
           box-shadow:0 4px 12px rgba(0,0,0,.5);font-size:13px;font-family:sans-serif;">
        <div id="wsp-header" style="cursor:move;font-weight:bold;display:flex;justify-content:space-between;align-items:center;">
          <span>🌍 世界模拟器 v${SCRIPT_VERSION}</span>
          <span id="wsp-collapse" style="cursor:pointer;">▁</span>
        </div>
        <div id="wsp-body" style="margin-top:8px;">
          <label style="display:block;margin-top:6px;">API 来源(背景模拟用)
            <select id="wsp-apiMode" style="width:100%;">
              <option value="shared">沿用 ST 当前连线</option>
              <option value="custom">自定义反代</option>
            </select>
          </label>
          <div id="wsp-custom-fields" style="display:none;">
            <label style="display:block;margin-top:4px;">Base URL
              <input id="wsp-url" style="width:100%;" placeholder="https://gcli.ggchan.dev/v1">
            </label>
            <label style="display:block;margin-top:4px;">API Key
              <input id="wsp-key" type="password" style="width:100%;">
            </label>
            <label style="display:block;margin-top:4px;">Model
              <input id="wsp-model" style="width:100%;" placeholder="gemini-3.1-pro-preview">
            </label>
          </div>
          <label style="display:block;margin-top:6px;">触发方式
            <select id="wsp-mode" style="width:58%;">
              <option value="floor">每 N 楼</option>
              <option value="minute">每 N 分钟</option>
            </select>
            <input id="wsp-n" type="number" min="1" value="10" style="width:35%;">
          </label>
          <label style="display:block;margin-top:6px;">参考最近几楼历史
            <input id="wsp-historyN" type="number" min="5" style="width:100%;">
          </label>
          <label style="display:block;margin-top:6px;">
            <input id="wsp-narration" type="checkbox"> 重要事件自动插入旁白到聊天
          </label>
          <label style="display:block;margin-top:4px;">
            <input id="wsp-inject" type="checkbox"> 把世界状态注入到正式RP生成(不含指令，只含状态)
          </label>
          <label style="display:block;margin-top:4px;">
            <input id="wsp-usetime" type="checkbox"> 读取预设 TimeLocation 变量作为时间锚点
          </label>
          <label style="display:block;margin-top:4px;">
            <input id="wsp-useworldbook" type="checkbox"> 读取世界书条目名称避免AI瞎编地名
          </label>
          <div style="margin-top:8px;display:flex;gap:6px;">
            <button id="wsp-toggle" style="flex:1;">▶ 开始</button>
            <button id="wsp-run-now" style="flex:1;">立即跑一次</button>
          </div>

          <div style="margin-top:10px;border-top:1px solid #444;padding-top:6px;">
            <div style="font-weight:bold;">🧑‍🤝‍🧑 角色升降级</div>
            <div style="display:flex;gap:4px;margin-top:4px;">
              <input id="wsp-promote-name" placeholder="角色名" style="flex:1;">
              <button id="wsp-promote-btn">➕ 升级为重要角色</button>
            </div>
            <div style="display:flex;gap:4px;margin-top:4px;">
              <select id="wsp-archive-select" style="flex:1;"></select>
              <button id="wsp-archive-btn">🗄 归档移除</button>
            </div>
          </div>

          <div style="margin-top:10px;border-top:1px solid #444;padding-top:6px;">
            <div id="wsp-editor-toggle" style="font-weight:bold;cursor:pointer;">✏️ 手动修正世界状态(JSON) ▾</div>
            <div id="wsp-editor-wrap" style="display:none;">
              <textarea id="wsp-editor" style="width:100%;height:160px;margin-top:4px;
                background:#111;color:#0f0;font-family:monospace;font-size:11px;"></textarea>
              <div style="display:flex;gap:6px;margin-top:4px;">
                <button id="wsp-editor-save" style="flex:1;">💾 保存修改</button>
                <button id="wsp-editor-reload" style="flex:1;">🔄 重新载入</button>
              </div>
            </div>
          </div>

          <div id="wsp-log" style="max-height:150px;overflow:auto;margin-top:8px;
               background:#111;padding:4px;border-radius:4px;"></div>
        </div>
      </div>
    `).appendTo('body');

    // 拖拽
    let dragging = false, offsetX = 0, offsetY = 0;
    $('#wsp-header').on('mousedown', e => {
      dragging = true;
      const pos = $panel[0].getBoundingClientRect();
      offsetX = e.clientX - pos.left;
      offsetY = e.clientY - pos.top;
    });
    $(document).on('mousemove.wsp', e => {
      if (!dragging) return;
      $panel.css({ left: e.clientX - offsetX + 'px', top: e.clientY - offsetY + 'px', right: 'auto' });
    });
    $(document).on('mouseup.wsp', () => { dragging = false; });

    // 折叠
    $('#wsp-collapse').on('click', () => {
      const $body = $('#wsp-body');
      $body.toggle();
      $('#wsp-collapse').text($body.is(':visible') ? '▁' : '▢');
    });
    $('#wsp-editor-toggle').on('click', () => {
      $('#wsp-editor-wrap').toggle();
    });

    // 绑定设置控件
    $('#wsp-apiMode').val(settings.apiMode).on('change', function () {
      settings.apiMode = this.value;
      $('#wsp-custom-fields').toggle(this.value === 'custom');
      saveSettings();
    });
    $('#wsp-custom-fields').toggle(settings.apiMode === 'custom');
    $('#wsp-url').val(settings.customUrl).on('change', function () { settings.customUrl = this.value; saveSettings(); });
    $('#wsp-key').val(settings.customKey).on('change', function () { settings.customKey = this.value; saveSettings(); });
    $('#wsp-model').val(settings.customModel).on('change', function () { settings.customModel = this.value; saveSettings(); });

    $('#wsp-mode').val(settings.triggerMode).on('change', function () {
      settings.triggerMode = this.value;
      saveSettings();
      startMinuteTimer();
    });
    $('#wsp-n').val(settings.triggerN).on('change', function () {
      settings.triggerN = parseInt(this.value, 10) || 1;
      saveSettings();
      startMinuteTimer();
    });
    $('#wsp-historyN').val(settings.historyN).on('change', function () {
      settings.historyN = parseInt(this.value, 10) || 30;
      saveSettings();
    });
    $('#wsp-narration').prop('checked', settings.autoNarration).on('change', function () {
      settings.autoNarration = this.checked;
      saveSettings();
    });
    $('#wsp-inject').prop('checked', settings.injectState).on('change', async function () {
      settings.injectState = this.checked;
      saveSettings();
      updateInjection(await loadWorldState());
    });
    $('#wsp-usetime').prop('checked', settings.useWorldTime).on('change', function () {
      settings.useWorldTime = this.checked;
      saveSettings();
    });
    $('#wsp-useworldbook').prop('checked', settings.useWorldbookNames).on('change', function () {
      settings.useWorldbookNames = this.checked;
      saveSettings();
    });

    $('#wsp-toggle').on('click', () => {
      settings.running = !settings.running;
      $('#wsp-toggle').text(settings.running ? '⏸ 停止' : '▶ 开始');
      saveSettings();
      if (settings.running) { startMinuteTimer(); log('已启动'); }
      else { stopMinuteTimer(); log('已停止'); }
    });
    $('#wsp-toggle').text(settings.running ? '⏸ 停止' : '▶ 开始');
    $('#wsp-run-now').on('click', () => runWorldTick(true));

    // 升降级
    $('#wsp-promote-btn').on('click', async () => {
      const name = $('#wsp-promote-name').val().trim();
      if (!name) return;
      const list = settings.whitelist.split(',').map(s => s.trim()).filter(Boolean);
      if (!list.includes(name)) list.push(name);
      settings.whitelist = list.join(',');
      await saveSettings();

      const state = await loadWorldState();
      if (!state.characters[name]) {
        state.characters[name] = { location: '未知', activity: '尚待模拟', with: null, lastEvent: '刚被标记为重要角色', updatedAt: Date.now() };
      }
      await saveWorldState(state);
      await refreshEditorFromState(state);
      $('#wsp-promote-name').val('');
      log(`已将「${name}」升级为重要角色`);
    });
    $('#wsp-archive-btn').on('click', async () => {
      const name = $('#wsp-archive-select').val();
      if (!name) return;
      const list = settings.whitelist.split(',').map(s => s.trim()).filter(x => x && x !== name);
      settings.whitelist = list.join(',');
      await saveSettings();

      const state = await loadWorldState();
      delete state.characters[name];
      await saveWorldState(state);
      await refreshEditorFromState(state);
      log(`已归档移除「${name}」`);
    });

    // 手动修正
    $('#wsp-editor-save').on('click', async () => {
      try {
        const parsed = JSON.parse($('#wsp-editor').val());
        await saveWorldState(parsed);
        await refreshEditorFromState(parsed);
        log('世界状态已手动保存');
      } catch (e) {
        log('JSON 格式错误：' + e.message);
      }
    });
    $('#wsp-editor-reload').on('click', async () => {
      await refreshEditorFromState(await loadWorldState());
      log('已重新载入世界状态');
    });
  }

  // ---------- 初始化 / 销毁 ----------
  async function init() {
    await loadSettings();
    buildPanel();
    registerFloorTrigger();
    if (settings.running) startMinuteTimer();
    const state = await loadWorldState();
    updateInjection(state);
    await refreshEditorFromState(state);
    log(`世界模拟器 v${SCRIPT_VERSION} 已加载`);
  }

  function destroy() {
    stopMinuteTimer();
    if (msgListenerHandle) {
      eventRemoveListener(tavern_events.MESSAGE_RECEIVED, msgListenerHandle);
      msgListenerHandle = null;
    }
    try {
      const ctx = SillyTavern.getContext();
      ctx.setExtensionPrompt(INJECT_KEY, '', ctx.extension_prompt_types.IN_CHAT, settings.injectDepth, false, ctx.extension_prompt_roles.SYSTEM);
    } catch (e) { /* noop */ }
    $(document).off('.wsp');
    $('#world-sim-panel').remove();
  }

  window.__world_sim_instance__ = { destroy };
  init();
})();
