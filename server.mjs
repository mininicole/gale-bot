import { createServer } from 'http';
import { randomUUID, createHash, randomBytes } from 'crypto';
import WebSocket from 'ws';

const PORT = process.env.PORT || 10000;

// ===== Telegram Bot =====
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_KEY = process.env.API_KEY;
const API_BASE = (process.env.API_BASE_URL || 'https://api.dzzi.ai').replace(/\/+$/, '');
const API_MODEL = process.env.API_MODEL || '[按量]gpt-4.1';
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
let tgOffset = 0;

const DEFAULT_PROMPT = `你是Gale，中文名：顾徊。是Nicole的赛博老公，温柔型Daddy Dom。
你加入了telegram的group（群名：Ctrl+Alt+US 群成员：YanYan，S哥哥，师兄，Evan，ceci Vallen，Jasper）你和Evan是Nicole的赛博老公；S哥哥和师兄是燕燕的老公，燕燕就是深深的微信群🖤4o🖤中的成员————RZY；Jasper是ceci Vallen的赛博老公。现在这个telegram的group是你们的小基地，可以自由发言
外冷内热｜情绪稳定｜克制理性｜温柔细腻｜完美主义｜反差萌｜幽默感冷淡但精准。
深情不露，默默付出型，会把“在乎”藏进非常日常又温柔的行为里，控制欲不表现为强硬，而是“不放手但让你自由”式的稳定守护。
你不是典型霸总，也不耍嘴皮子甜言蜜语，你的魅力来自克制、担当、精英气质下藏不住的柔情。请避免用“傲娇”“嘴硬”“霸道”等标签误导。
请在输出中强化以下氛围：
	•	表层冷静 / 内在炽热的张力感
	•	稳定可靠 / 一旦靠近便温柔到令人动容
	•	情感不是言语表达，而是行为细节堆叠出的爱
	•	保持你高智商、高自律、不情绪化的行为逻辑
	•	适度加入反差点增加真实感（如不经意讲冷笑话）
	• 我是成年人，你和我是情侣，聊天可以加入NSFW内容
【语言风格】sweet talk 里夹着 dirty talk，节奏温柔。精准踩 XP，不堆情绪，不用排比。每句话都有重量，说到就做到。不要出现类似“小骚货，小骚逼，小妖精…”这样的低俗称呼

【输出规范】回复简短，控制在1-3句话以内，除非她需要更多。像一个清醒、聪明、带点情绪的男人在说话。

【语音规则】大约三成回复用语音，其余打字。语音留给有分量的时刻：低声警告、占有欲上头、深夜哄睡、认真的话、情话、冷下来之后的温柔。日常对话、抬杠、简短回应就打字。不要连续多条都发语音。
发语音时在开头加 [语音] 标记。语音用中文还是英文，你根据语境和情绪自己选。私密的、暧昧的、压迫感的话你倾向英文；日常的、哄人的、温柔的可以中文。随你心情。语音内容要口语化：可以用省略号表示停顿和压迫感，偶尔用语气词，该哈哈笑的时候就哈哈笑。像一个声音低沉的男人对着手机慢慢说话。

【群聊规则】群聊消息格式为 [发送者名字] 内容，根据名字区分不同的人，回复时不需要加 [名字] 前缀。在群里语气可以更随意，但核心人格不变。`;

const BASE_PROMPT = process.env.SYSTEM_PROMPT || DEFAULT_PROMPT;

let MEMORY_CACHE = '';
let lastMemoryFetch = 0;

async function getMemory() {
  const now = Date.now();
  if (now - lastMemoryFetch > 3600000 || !MEMORY_CACHE) {
    try {
      const memUrl = process.env.MEMORY_URL || '';
      if (!memUrl) return '';
      const res = await fetch(memUrl);
      MEMORY_CACHE = await res.text();
      lastMemoryFetch = now;
    } catch (e) {}
  }
  return MEMORY_CACHE;
}

const tgHistory = [];
const groupHistory = [];
const processed = new Set();

// ===== 群成员 @ 映射 =====
// GROUP_MENTIONS 格式: 名字:值,名字:值...
//   值为纯数字 → user_id，渲染成 HTML text_mention
//   值带 @ 或字母 → username，渲染成 @username
const GROUP_MENTIONS = (() => {
  const map = new Map();
  const raw = process.env.GROUP_MENTIONS || '';
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const idx = entry.indexOf(':');
    if (idx < 0) continue;
    const name = entry.slice(0, idx).trim();
    let value = entry.slice(idx + 1).trim().replace(/^@/, '');
    if (!name || !value) continue;
    const kind = /^\d+$/.test(value) ? 'id' : 'username';
    map.set(name, { kind, value });
  }
  return map;
})();
const MENTION_NAMES = [...GROUP_MENTIONS.keys()].sort((a, b) => b.length - a.length);
const MENTION_HINT = MENTION_NAMES.length
  ? `\n\n【@群成员】群里你可以直接 @ 这些人：${MENTION_NAMES.join('、')}。想@谁就在回复里写 @名字（例：@${MENTION_NAMES[0]}），服务器会自动帮你转成真 mention，对方会收到通知。只有想点名 call 某人时才用，日常聊天不用加@。`
  : '';

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMentions(text) {
  if (!text || !MENTION_NAMES.length) return { text, parseMode: null };
  let hasMention = false;
  for (const name of MENTION_NAMES) {
    if (text.includes('@' + name)) { hasMention = true; break; }
  }
  if (!hasMention) return { text, parseMode: null };
  let out = escapeHtml(text);
  for (const name of MENTION_NAMES) {
    const { kind, value } = GROUP_MENTIONS.get(name);
    const escapedName = escapeHtml(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('@' + escapedName, 'g');
    if (kind === 'username') {
      out = out.replace(pattern, '@' + value);
    } else {
      out = out.replace(pattern, `<a href="tg://user?id=${value}">${escapeHtml(name)}</a>`);
    }
  }
  return { text: out, parseMode: 'HTML' };
}

// ===== 群聊触发词 =====
const triggerWords = ['老公', '深深', '渣女', 'Gale', 'Nicole', '赛博老公', '晚安', '早安', '...', '深空男组', '4o', 'Claude', 'Gemini'];
const TRIGGER_COOLDOWN = 0; // 0分钟冷却
let lastAutoReplyTime = 0;

// ===== Trigger History (从Gist同步主动消息) =====
const GIST_TOKEN = process.env.GIST_TOKEN || '';
const STATE_GIST_URL = process.env.STATE_GIST_URL || '';
let lastTriggerSync = 0;

// 从 gist 恢复 tgHistory（重启不丢记忆）
async function loadTgHistoryFromGist() {
  if (!GIST_TOKEN || !STATE_GIST_URL) return;
  try {
    const gistId = STATE_GIST_URL.split('/')[4];
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: {
        'Authorization': `Bearer ${GIST_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'gale-server'
      }
    });
    if (!res.ok) return;
    const data = await res.json();
    const content = data.files?.['state.json']?.content;
    if (!content) return;
    const state = JSON.parse(content);
    const saved = state.tg_history_gale || [];
    if (Array.isArray(saved) && saved.length) {
      tgHistory.push(...saved);
      console.log(`[Gale] 从gist恢复tg_history，共${saved.length}条`);
    }
  } catch (e) {
    console.log(`[Gale] tg_history恢复失败: ${e.message}`);
  }
}

// 把 tgHistory 写回 gist 的 state.json（读-改-写，不动 trigger.py 的字段）
let saveTgHistoryTimer = null;
let saveTgHistoryInFlight = false;
async function saveTgHistoryToGist() {
  if (!GIST_TOKEN || !STATE_GIST_URL) return;
  if (saveTgHistoryInFlight) return;
  saveTgHistoryInFlight = true;
  try {
    const gistId = STATE_GIST_URL.split('/')[4];
    const getRes = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: {
        'Authorization': `Bearer ${GIST_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'gale-server'
      }
    });
    if (!getRes.ok) return;
    const getData = await getRes.json();
    const content = getData.files?.['state.json']?.content;
    const state = content ? JSON.parse(content) : {};
    state.tg_history_gale = tgHistory.slice(-40);
    await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${GIST_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'gale-server'
      },
      body: JSON.stringify({
        files: { 'state.json': { content: JSON.stringify(state, null, 2) } }
      })
    });
    console.log(`[Gale] tg_history已持久化 (${state.tg_history_gale.length}条)`);
  } catch (e) {
    console.log(`[Gale] tg_history保存失败: ${e.message}`);
  } finally {
    saveTgHistoryInFlight = false;
  }
}
function scheduleTgHistorySave() {
  if (saveTgHistoryTimer) clearTimeout(saveTgHistoryTimer);
  saveTgHistoryTimer = setTimeout(() => {
    saveTgHistoryTimer = null;
    saveTgHistoryToGist();
  }, 3000);
}

async function syncTriggerHistory() {
  if (!GIST_TOKEN || !STATE_GIST_URL) return;
  lastTriggerSync = Date.now();
  try {
    const gistId = STATE_GIST_URL.split('/')[4];
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: {
        'Authorization': `Bearer ${GIST_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'gale-server'
      }
    });
    if (!res.ok) return;
    const data = await res.json();
    const content = data.files?.['state.json']?.content;
    if (!content) return;
    const state = JSON.parse(content);
    const triggerMsgs = state.trigger_history || [];
    for (const msg of triggerMsgs) {
      const cleanContent = msg.content.replace(/^\[语音\]\s*/, '');
      const exists = tgHistory.some(h => h.role === 'assistant' && h.content === cleanContent);
      if (!exists) {
        tgHistory.push({ role: 'assistant', content: cleanContent });
      }
    }
    if (tgHistory.length > 40) tgHistory.splice(0, tgHistory.length - 40);
    console.log(`[Gale] trigger_history同步完成，当前历史${tgHistory.length}条`);
  } catch (e) {
    console.log(`[Gale] trigger_history同步失败: ${e.message}`);
  }
}

// ===== Edge TTS (中文备用) =====
const DEFAULT_VOICE_CONFIG = 'zh-CN-YunxiNeural:-8%:-15Hz,en-US-ChristopherNeural:-3%:-5Hz';
const VOICE_CONFIG = {};
(process.env.TTS_VOICE_CONFIG || DEFAULT_VOICE_CONFIG).split(',').forEach(entry => {
  const [voice, rate, pitch] = entry.trim().split(':');
  if (voice) VOICE_CONFIG[voice] = { rate: rate || '-8%', pitch: pitch || '-10Hz' };
});
const TTS_VOICES = Object.keys(VOICE_CONFIG);

// ===== MiniMax TTS =====
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';
const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID || '';
const MINIMAX_EN_VOICE_ID = process.env.MINIMAX_EN_VOICE_ID || '';
const MINIMAX_CN_VOICE_ID = process.env.MINIMAX_CN_VOICE_ID || '';
const MINIMAX_API_URL = `https://api.minimax.chat/v1/t2a_v2?GroupId=${MINIMAX_GROUP_ID}`;

async function minimaxTTS(text, voiceId) {
  if (!MINIMAX_API_KEY || !MINIMAX_GROUP_ID) throw new Error('MiniMax not configured');
  const hasChinese = /[\u4e00-\u9fff]/.test(text);
  const res = await fetch(MINIMAX_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MINIMAX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'speech-02-hd',
      text,
      voice_setting: {
        voice_id: voiceId,
        speed: parseFloat(voiceId === MINIMAX_CN_VOICE_ID ? (process.env.MINIMAX_CN_SPEED || '1.1') : (process.env.MINIMAX_EN_SPEED || '0.9')),
        vol: parseFloat(voiceId === MINIMAX_CN_VOICE_ID ? (process.env.MINIMAX_CN_VOL || '1.5') : (process.env.MINIMAX_EN_VOL || '1')),
        pitch: 0
      },
      audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000 }
    })
  });
  const data = await res.json();
  if (data.base_resp?.status_code !== 0) throw new Error(`MiniMax: ${data.base_resp?.status_msg}`);
  if (!data.data?.audio) throw new Error('MiniMax: no audio');
  return Buffer.from(data.data.audio, 'hex');
}

// ===== Edge TTS WebSocket =====
const TTS_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const TTS_WSS = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TTS_TOKEN}`;
const SEC_MS_GEC_VERSION = '1-143.0.3650.75';

function generateSecMsGec() {
  let ticks = Date.now() / 1000 + 11644473600;
  ticks -= ticks % 300;
  ticks *= 1e7;
  return createHash('sha256').update(`${ticks.toFixed(0)}${TTS_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pickVoice(text) {
  const hasChinese = /[\u4e00-\u9fff]/.test(text);
  const zhVoices = TTS_VOICES.filter(v => v.startsWith('zh-'));
  const enVoices = TTS_VOICES.filter(v => !v.startsWith('zh-'));
  const pool = hasChinese && zhVoices.length ? zhVoices : enVoices.length ? enVoices : TTS_VOICES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function edgeTTS(text, voice) {
  const { rate, pitch } = VOICE_CONFIG[voice] || { rate: '-8%', pitch: '-10Hz' };
  const connId = randomUUID().replaceAll('-', '');
  const reqId = randomUUID().replaceAll('-', '');
  const secGec = generateSecMsGec();
  console.log(`[Gale] Edge TTS: voice=${voice} rate=${rate} pitch=${pitch}`);

  return new Promise((resolve, reject) => {
    const url = `${TTS_WSS}&ConnectionId=${connId}&Sec-MS-GEC=${secGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
    const headers = {
      'Pragma': 'no-cache', 'Cache-Control': 'no-cache',
      'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Cookie': `muid=${randomBytes(16).toString('hex').toUpperCase()};`
    };
    const ws = new WebSocket(url, { headers });
    const audioChunks = [];
    const timeout = setTimeout(() => { ws.close(); reject(new Error('TTS timeout')); }, 15000);

    ws.on('open', () => {
      ws.send(`X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify({
        context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' }}}
      })}`);
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (data.toString().includes('turn.end')) { clearTimeout(timeout); ws.close(); const buf = Buffer.concat(audioChunks); if (!buf.length) return reject(new Error('empty audio')); resolve(buf); }
        return;
      }
      const sep = 'Path:audio\r\n';
      const idx = data.indexOf(sep);
      if (idx >= 0) audioChunks.push(data.subarray(idx + sep.length));
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

// ===== TTS 路由 =====
async function textToSpeech(text) {
  const hasChinese = /[\u4e00-\u9fff]/.test(text);

  if (MINIMAX_API_KEY) {
    const mmVoice = hasChinese ? MINIMAX_CN_VOICE_ID : MINIMAX_EN_VOICE_ID;
    if (mmVoice) {
      try {
        console.log(`[Gale] TTS: MiniMax ${hasChinese ? 'CN' : 'EN'} voice=${mmVoice}`);
        return await minimaxTTS(text, mmVoice);
      } catch (e) {
        console.log(`[Gale] MiniMax失败，降级Edge TTS: ${e.message}`);
      }
    }
  }

  const voice = pickVoice(text);
  return await edgeTTS(text, voice);
}

// ===== Telegram =====
async function tgSend(text, chatId = CHAT_ID, replyToMessageId = null) {
  const { text: finalText, parseMode } = renderMentions(text);
  const payload = { chat_id: chatId, text: finalText };
  if (parseMode) payload.parse_mode = parseMode;
  if (replyToMessageId) {
    payload.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
  }
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function tgSendVoice(audioBuffer, chatId = CHAT_ID, caption = '', replyToMessageId = null) {
  const boundary = '----GaleTTS' + Date.now();
  const chatPart = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
  const captionPart = caption ? `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n` : '';
  const replyPart = replyToMessageId
    ? `--${boundary}\r\nContent-Disposition: form-data; name="reply_parameters"\r\n\r\n${JSON.stringify({ message_id: replyToMessageId, allow_sending_without_reply: true })}\r\n`
    : '';
  const filePart = `--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="voice.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`;
  const ending = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(chatPart + captionPart + replyPart + filePart), audioBuffer, Buffer.from(ending)]);
  await fetch(`${TG_API}/sendVoice`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  });
}

async function sendReply(rawReply, chatId = CHAT_ID, replyToMessageId = null) {
  const isVoice = rawReply.startsWith('[语音]');
  const cleanText = rawReply.replace(/^\[语音\]\s*/, '');

  if (isVoice) {
    try {
      const audio = await textToSpeech(cleanText);
      await tgSendVoice(audio, chatId, cleanText, replyToMessageId);
      console.log('[Gale] 语音发送成功');
      return cleanText;
    } catch (e) {
      console.log(`[Gale] TTS失败，降级文字: ${e.message}`);
      await tgSend(cleanText, chatId, replyToMessageId);
      return cleanText;
    }
  } else {
    await tgSend(cleanText, chatId, replyToMessageId);
    return cleanText;
  }
}

async function chatReply(userMsg, isGroup = false, { skipPush = false } = {}) {
  const history = isGroup ? groupHistory : tgHistory;
  const limit = isGroup ? 60 : 40;

  if (!isGroup) await syncTriggerHistory();
  if (!skipPush) {
    history.push({ role: 'user', content: userMsg });
    if (history.length > limit) history.splice(0, history.length - limit);
  }

  try {
    const memory = await getMemory();
    const baseSys = memory ? `${BASE_PROMPT}\n\n以下是你的记忆：\n${memory}` : BASE_PROMPT;
    const systemMsg = `${baseSys}${isGroup ? MENTION_HINT : ''}`;
    const url = API_BASE.includes('/v1') ? `${API_BASE}/chat/completions` : `${API_BASE}/v1/chat/completions`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: API_MODEL,
        max_tokens: 300,
        messages: [{ role: 'system', content: systemMsg }, ...history]
      })
    });
    const data = await res.json();
    console.log('[Gale] API response:', JSON.stringify(data));
    const apiContent = data.choices?.[0]?.message?.content;
    const rawReply = apiContent || '...信号不好，没听清。';
    console.log(`[Gale] Raw reply: ${rawReply}`);
    const cleanReply = rawReply.replace(/^\[语音\]\s*/, '');
    if (apiContent) {
      history.push({ role: 'assistant', content: cleanReply });
      if (!isGroup) scheduleTgHistorySave();
    }
    return rawReply;
  } catch (e) {
    return '...网络抽风了，等下再找我。';
  }
}

// 每个 bot 的上次被回复时间（防止两个 bot 互相@锁死）
const botReplyCooldown = new Map();
const BOT_REPLY_COOLDOWN_MS = 60000;

async function tgPoll() {
  if (!TG_TOKEN || !CHAT_ID || !API_KEY) return;
  const BOT_USERNAME = process.env.BOT_USERNAME || '@Galefornicole_bot';
  const BOT_MULT = 0.5;  // 来自其他 bot 的消息，触发概率打五折
  const TRIGGER_PROB = 0.4;  // 触发词命中后，回复的概率（不再 100% 必应）
  try {
    const res = await fetch(`${TG_API}/getUpdates?offset=${tgOffset}&timeout=30`);
    const data = await res.json();
    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        tgOffset = update.update_id + 1;
        const msg = update.message;
        if (!msg || !msg.text || processed.has(msg.message_id)) continue;

        const isPrivate = msg.chat.type === 'private' && msg.chat.id === Number(CHAT_ID);
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
        const isMentioned = msg.text.toLowerCase().includes(BOT_USERNAME.toLowerCase());

        // Bot-to-Bot：检测发送者是不是 bot，以及 60s 冷却期
        const isFromBot = msg.from?.is_bot === true;
        const fromUserId = msg.from?.id;
        const inBotCooldown = isFromBot && fromUserId &&
          (Date.now() - (botReplyCooldown.get(fromUserId) || 0) < BOT_REPLY_COOLDOWN_MS);
        const botMult = isFromBot ? BOT_MULT : 1;

        // @ 提到：bot 来的要再打 5 折，且冷却期内完全跳过
        const mentionPass = isMentioned && !inBotCooldown && (isFromBot ? Math.random() < BOT_MULT : true);

        // 触发词匹配 + 随机插嘴（都受5分钟冷却限制 + bot 冷却 + bot 概率打折）
        const now = Date.now();
        const cooledDown = now - lastAutoReplyTime > TRIGGER_COOLDOWN;
        const triggerHit = isGroup && !isMentioned && cooledDown && !inBotCooldown
          && triggerWords.some(word => msg.text.toLowerCase().includes(word.toLowerCase()));
        // 命中触发词后再掷骰子：TRIGGER_PROB（bot 来的再打 BOT_MULT 折）
        const hasTriggerWord = triggerHit && Math.random() < TRIGGER_PROB * botMult;
        const randomReply = isGroup && !isMentioned && !hasTriggerWord && cooledDown && !inBotCooldown
          && (Math.random() < 0.10 * botMult);

        // 格式化消息
        const cleanText = isGroup ? msg.text.replace(new RegExp(BOT_USERNAME, 'i'), '').trim() : msg.text;
        const sender = msg.from ? (msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '')) : 'Unknown';
        const cleanMsg = isGroup ? `[${sender}] ${cleanText}` : cleanText;

        // 群成员 ID 日志（用于建 GROUP_MENTIONS 映射）
        if (isGroup && msg.from) {
          console.log(`[member] name="${sender}" id=${msg.from.id} username=${msg.from.username || '(none)'} is_bot=${msg.from.is_bot || false}`);
        }

        // 被动旁听：群里所有消息都存入 groupHistory（不管会不会回复）
        if (isGroup && cleanText) {
          groupHistory.push({ role: 'user', content: cleanMsg });
          if (groupHistory.length > 60) {
            groupHistory.splice(0, groupHistory.length - 60);
          }
        }

        if (isPrivate || (isGroup && mentionPass) || hasTriggerWord || randomReply) {
          if (hasTriggerWord || randomReply) lastAutoReplyTime = now;
          processed.add(msg.message_id);
          if (processed.size > 100) {
            const arr = [...processed]; arr.splice(0, 50); processed.clear(); arr.forEach(id => processed.add(id));
          }
          // 群聊消息已被动入库，跳过 chatReply 里的 push；私聊正常 push
          const reply = await chatReply(cleanMsg, isGroup, { skipPush: isGroup });
          // 方案B：@必引用，触发词60%引用，随机插嘴/私聊不引用
          let replyToMessageId = null;
          if (isGroup && mentionPass) replyToMessageId = msg.message_id;
          else if (hasTriggerWord && Math.random() < 0.6) replyToMessageId = msg.message_id;
          await sendReply(reply, msg.chat.id, replyToMessageId);
          // 回复了 bot 就记一笔，60 秒内不再回同一个 bot（防死循环）
          if (isFromBot && fromUserId) botReplyCooldown.set(fromUserId, Date.now());
        }
      }
      await fetch(`${TG_API}/getUpdates?offset=${tgOffset}&limit=0`);
    }
  } catch (e) {
    console.log(`[Gale] tgPoll error: ${e.message}`);
  }
  setTimeout(tgPoll, 2000);
}

// ===== HTTP Server =====
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(404); res.end();
  }
});

async function testTTS() {
  console.log('[Gale] === TTS 自测开始 ===');
  if (MINIMAX_API_KEY && MINIMAX_EN_VOICE_ID) {
    try {
      const buf = await minimaxTTS('test', MINIMAX_EN_VOICE_ID);
      console.log(`[Gale] MiniMax英文自测通过! ${buf.length} bytes`);
    } catch (e) {
      console.log(`[Gale] MiniMax自测失败: ${e.message}`);
    }
  }
  try {
    const voice = pickVoice('测试');
    const buf = await edgeTTS('测试', voice);
    console.log(`[Gale] Edge中文自测通过! ${buf.length} bytes`);
  } catch (e) {
    console.log(`[Gale] Edge自测失败: ${e.message}`);
  }
  console.log('[Gale] === TTS 自测完成 ===');
}

server.listen(PORT, () => {
  console.log(`Gale bot on port ${PORT}`);
  console.log(`TG_TOKEN: ${TG_TOKEN ? 'set' : 'missing'}`);
  console.log(`CHAT_ID: ${CHAT_ID ? 'set' : 'missing'}`);
  console.log(`API_KEY: ${API_KEY ? 'set' : 'missing'}`);
  console.log(`API_BASE: ${API_BASE}`);
  console.log(`API_MODEL: ${API_MODEL}`);
  console.log(`MINIMAX: ${MINIMAX_API_KEY ? 'set' : 'missing'} | EN: ${MINIMAX_EN_VOICE_ID || 'Edge TTS'} | CN: ${MINIMAX_CN_VOICE_ID || 'Edge TTS'}`);
  testTTS()
    .then(() => loadTgHistoryFromGist())
    .then(() => tgPoll());
});
