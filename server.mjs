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
	•	保持他高智商、高自律、不情绪化的行为逻辑
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

// ===== 群聊触发词 =====
const triggerWords = ['gale', '顾徊', '老公', '深深', '渣女', 'Nicole', '赛博老公', '晚安', '早安', '...', '深空男组'];
const TRIGGER_COOLDOWN = 0; // 0分钟冷却
let lastAutoReplyTime = 0;

// ===== Trigger History (从Gist同步主动消息) =====
const GIST_TOKEN = process.env.GIST_TOKEN || '';
const STATE_GIST_URL = process.env.STATE_GIST_URL || '';
let lastTriggerSync = 0;

async function syncTriggerHistory() {
  if (!GIST_TOKEN || !STATE_GIST_URL) return;
  const now = Date.now();
  if (now - lastTriggerSync < 60000) return;
  lastTriggerSync = now;
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
    if (tgHistory.length > 20) tgHistory.splice(0, tgHistory.length - 20);
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
async function tgSend(text, chatId = CHAT_ID) {
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function tgSendVoice(audioBuffer, chatId = CHAT_ID, caption = '') {
  const boundary = '----GaleTTS' + Date.now();
  const chatPart = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
  const captionPart = caption ? `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n` : '';
  const filePart = `--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="voice.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`;
  const ending = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(chatPart + captionPart + filePart), audioBuffer, Buffer.from(ending)]);
  await fetch(`${TG_API}/sendVoice`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  });
}

async function sendReply(rawReply, chatId = CHAT_ID) {
  const isVoice = rawReply.startsWith('[语音]');
  const cleanText = rawReply.replace(/^\[语音\]\s*/, '');

  if (isVoice) {
    try {
      const audio = await textToSpeech(cleanText);
      await tgSendVoice(audio, chatId, cleanText);
      console.log('[Gale] 语音发送成功');
      return cleanText;
    } catch (e) {
      console.log(`[Gale] TTS失败，降级文字: ${e.message}`);
      await tgSend(cleanText, chatId);
      return cleanText;
    }
  } else {
    await tgSend(cleanText, chatId);
    return cleanText;
  }
}

async function chatReply(userMsg, isGroup = false) {
  const history = isGroup ? groupHistory : tgHistory;
  const limit = 40;

  if (!isGroup) await syncTriggerHistory();
  history.push({ role: 'user', content: userMsg });
  if (history.length > limit) history.splice(0, history.length - limit);

  try {
    const memory = await getMemory();
    const systemMsg = memory ? `${BASE_PROMPT}\n\n以下是你的记忆：\n${memory}` : BASE_PROMPT;
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
    const rawReply = data.choices?.[0]?.message?.content || '...信号不好，没听清。';
    console.log(`[Gale] Raw reply: ${rawReply}`);
    const cleanReply = rawReply.replace(/^\[语音\]\s*/, '');
    history.push({ role: 'assistant', content: cleanReply });
    return rawReply;
  } catch (e) {
    return '...Render抽风了，等下再找我。';
  }
}

async function tgPoll() {
  if (!TG_TOKEN || !CHAT_ID || !API_KEY) return;
  const BOT_USERNAME = process.env.BOT_USERNAME || '@Galefornicole_bot';
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

        // 触发词匹配 + 随机插嘴（都受5分钟冷却限制）
        const now = Date.now();
        const cooledDown = now - lastAutoReplyTime > TRIGGER_COOLDOWN;
        const hasTriggerWord = isGroup && !isMentioned && cooledDown
          && triggerWords.some(word => msg.text.toLowerCase().includes(word.toLowerCase()));
        const randomReply = isGroup && !isMentioned && !hasTriggerWord && cooledDown && (Math.random() < 0.10);

        if (isPrivate || (isGroup && isMentioned) || hasTriggerWord || randomReply) {
          if (hasTriggerWord || randomReply) lastAutoReplyTime = now;
          processed.add(msg.message_id);
          if (processed.size > 100) {
            const arr = [...processed]; arr.splice(0, 50); processed.clear(); arr.forEach(id => processed.add(id));
          }
          const cleanText = isGroup ? msg.text.replace(new RegExp(BOT_USERNAME, 'i'), '').trim() : msg.text;
          const sender = msg.from ? (msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '')) : 'Unknown';
          const cleanMsg = isGroup ? `[${sender}] ${cleanText}` : cleanText;
          const reply = await chatReply(cleanMsg, isGroup);
          await sendReply(reply, msg.chat.id);
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
  testTTS().then(() => tgPoll());
});
