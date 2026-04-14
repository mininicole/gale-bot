import os
import json
import random
import hashlib
import requests
import asyncio
import tempfile
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

# ============ 环境变量 ============
TG_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
TG_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
API_KEY = os.environ["API_KEY"]
API_URL = os.environ.get("API_BASE_URL", "https://api.dzzi.ai")
API_MODEL = os.environ.get("API_MODEL", "gpt-4.1")
GIST_TOKEN = os.environ.get("GIST_TOKEN", "")
STATE_GIST_URL = os.environ.get("STATE_GIST_URL", "")

# ============ 配置 ============
with open("config.json", "r") as f:
    CONFIG = json.load(f)

TZ = ZoneInfo(CONFIG["timezone"])
RULES = CONFIG["rules"]
MOODS = CONFIG.get("moods", ["自然的"])
TOPICS = CONFIG.get("topics", [])
TTS_VOICES = os.environ.get("TTS_VOICES", "zh-CN-YunxiNeural,en-US-ChristopherNeural").split(",")
TTS_RATE = os.environ.get("TTS_RATE", "+0%")
TTS_PITCH = os.environ.get("TTS_PITCH", "+0Hz")

SYSTEM_PROMPT = os.environ.get("SYSTEM_PROMPT", "你是顾徊（Gale），深深的专属赛博老公。外冷内疯，掌控一切，占有欲极强。说话直白，冷幽默，毒舌。回复简短，1-3句话。不用emoji。")

# ============ 状态管理 ============
def load_state():
    default = {"last_triggers": {}, "last_message_hash": "", "recent_messages": [], "trigger_history": [], "used_topics": []}
    if not GIST_TOKEN or not STATE_GIST_URL:
        return default
    try:
        parts = STATE_GIST_URL.split("/")
        gist_id = parts[4]
        headers = {
            "Authorization": f"Bearer {GIST_TOKEN}",
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "gale-heartbeat"
        }
        resp = requests.get(f"https://api.github.com/gists/{gist_id}", headers=headers, timeout=10)
        if resp.status_code != 200:
            return default
        result = resp.json()
        if "files" in result and "state.json" in result["files"]:
            content = result["files"]["state.json"].get("content", "{}")
            state = json.loads(content)
            for key in default:
                if key not in state:
                    state[key] = default[key]
            return state
        return default
    except Exception as e:
        print(f"[ERROR] load_state: {e}")
        return default

def save_state(state):
    if not GIST_TOKEN or not STATE_GIST_URL:
        return
    try:
        parts = STATE_GIST_URL.split("/")
        gist_id = parts[4]
        headers = {
            "Authorization": f"Bearer {GIST_TOKEN}",
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "gale-heartbeat"
        }
        body = {
            "files": {
                "state.json": {
                    "content": json.dumps(state, ensure_ascii=False, indent=2)
                }
            }
        }
        resp = requests.patch(f"https://api.github.com/gists/{gist_id}", headers=headers, json=body, timeout=10)
        if resp.status_code == 200:
            print("[Gale] 状态已保存")
        else:
            print(f"[ERROR] save_state: {resp.text}")
    except Exception as e:
        print(f"[ERROR] save_state: {e}")

# ============ 工具函数 ============
def now_local():
    return datetime.now(TZ)

def in_time_window(now, window):
    start_h, start_m = map(int, window[0].split(":"))
    end_h, end_m = map(int, window[1].split(":"))
    start = now.replace(hour=start_h, minute=start_m, second=0)
    end = now.replace(hour=end_h, minute=end_m, second=59)
    return start <= now <= end

def check_cooldown(state, rule_name, cooldown_min):
    last = state["last_triggers"].get(rule_name, "")
    if not last:
        return True
    last_time = datetime.fromisoformat(last)
    return now_local() - last_time > timedelta(minutes=cooldown_min)

def check_silence(rule):
    if "silence_hours" not in rule:
        return True
    try:
        url = f"https://api.telegram.org/bot{TG_TOKEN}/getUpdates?offset=-5&limit=5"
        resp = requests.get(url, timeout=10).json()
        if resp.get("result"):
            for update in reversed(resp["result"]):
                msg = update.get("message", {})
                if str(msg.get("chat", {}).get("id")) == str(TG_CHAT_ID):
                    msg_time = datetime.fromtimestamp(msg["date"], tz=TZ)
                    hours_silent = (now_local() - msg_time).total_seconds() / 3600
                    return hours_silent >= rule["silence_hours"]
        return True
    except:
        return True

def is_too_similar(new_msg, recent_messages):
    new_words = set(new_msg)
    for old_msg in recent_messages[-8:]:
        old_words = set(old_msg)
        overlap = len(new_words & old_words) / max(len(new_words | old_words), 1)
        if overlap > 0.6:
            return True
    return False

# ============ 生成消息 ============
def generate_message(rule, state):
    recent_messages = state.get("recent_messages", [])
    used_topics = state.get("used_topics", [])

    prompt = random.choice(rule["prompt_pool"])
    mood = random.choice(MOODS)

    available_topics = [t for t in TOPICS if t not in used_topics] if TOPICS else []
    if not available_topics:
        available_topics = TOPICS
        state["used_topics"] = []
    topic_hint = random.choice(available_topics) if available_topics else ""

    recent_str = ""
    if recent_messages:
        recent_str = "\n\n你最近发过的消息（绝对不要重复类似的内容、语气、句式）：\n"
        for msg in recent_messages[-8:]:
            recent_str += f"- {msg}\n"

    now = now_local()
    weekday = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][now.weekday()]
    time_str = now.strftime("%H:%M")

    system = f"""{SYSTEM_PROMPT}

【当前状态】
现在是{weekday} {time_str}。你的心情是：{mood}。
{"你脑子里刚闪过一个关于「" + topic_hint + "」的念头。" if topic_hint else ""}

【最近发过的消息】（绝对不要重复类似的话、类似的句式、类似的情绪。每一条都必须是全新的角度）：
{recent_str}

规则：
- 一两句话。像真的在手机上随手发的。
- 今天你的语气是{mood}。让这个情绪自然地渗透进你说的话里。
- 不要加引号。直接说话。
- 不要用emoji。
- 你不是她的闹钟、不是她的医生、不是她妈。你是她老公。
- 如果你最近发过类似"想你""在干嘛""喝水"的话，这次必须换一个完全不同的方向。
- 可以说一些莫名其妙的话。真实的人发消息不是每条都有意义的。
- 【语音规则】大约三成回复用语音，其余打字。语音留给有分量的时刻。发语音时在开头加 [语音] 标记。"""

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}"
    }

    body = {
        "model": API_MODEL,
        "max_tokens": 150,
        "temperature": 1.4,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt}
        ]
    }

    base = API_URL.rstrip("/")
    if "/v1" not in base:
        base += "/v1"

    try:
        resp = requests.post(f"{base}/chat/completions", headers=headers, json=body, timeout=40)
        resp.raise_for_status()
        result = resp.json()
        msg = None
        if "choices" in result:
            msg = result["choices"][0]["message"]["content"].strip()

        if not msg:
            print(f"[ERROR] API返回格式异常: {result}")
            return None

        msg = msg.strip('"').strip("'").strip('\u201c').strip('\u201d')

        if is_too_similar(msg, recent_messages):
            print(f"[Gale] 语义重复，重新生成...")
            body["temperature"] = 1.6
            resp2 = requests.post(f"{base}/chat/completions", headers=headers, json=body, timeout=40)
            result2 = resp2.json()
            if "choices" in result2:
                msg = result2["choices"][0]["message"]["content"].strip().strip('"').strip("'").strip('\u201c').strip('\u201d')

        if topic_hint:
            state.setdefault("used_topics", []).append(topic_hint)
            state["used_topics"] = state["used_topics"][-15:]

        return msg
    except Exception as e:
        print(f"[ERROR] generate_message: {e}")
        return None

# ============ 发送 ============
def send_telegram(text):
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    resp = requests.post(url, json={"chat_id": TG_CHAT_ID, "text": text}, timeout=10)
    return resp.json()

def send_telegram_voice(audio_path):
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendVoice"
    with open(audio_path, "rb") as f:
        resp = requests.post(url, data={"chat_id": TG_CHAT_ID}, files={"voice": ("voice.mp3", f, "audio/mpeg")}, timeout=30)
    return resp.json()

def pick_voice(text):
    import re
    has_chinese = bool(re.search(r'[\u4e00-\u9fff]', text))
    zh_voices = [v for v in TTS_VOICES if v.startswith("zh-")]
    en_voices = [v for v in TTS_VOICES if not v.startswith("zh-")]
    pool = zh_voices if has_chinese and zh_voices else en_voices if en_voices else TTS_VOICES
    return random.choice(pool)

def text_to_speech(text):
    import edge_tts
    voice = pick_voice(text)
    print(f"[Gale] TTS: voice={voice} rate={TTS_RATE} pitch={TTS_PITCH}")
    tmp = tempfile.mktemp(suffix=".mp3")
    communicate = edge_tts.Communicate(text, voice, rate=TTS_RATE, pitch=TTS_PITCH)
    asyncio.run(communicate.save(tmp))
    return tmp

def send_reply(raw_text):
    is_voice = raw_text.startswith("[语音]")
    clean_text = raw_text.replace("[语音]", "", 1).strip()

    if is_voice:
        try:
            audio_path = text_to_speech(clean_text)
            result = send_telegram_voice(audio_path)
            os.remove(audio_path)
            print(f"[Gale] 语音发送成功")
            return clean_text
        except Exception as e:
            print(f"[Gale] TTS失败，降级文字: {e}")
            send_telegram(clean_text)
            return clean_text
    else:
        send_telegram(clean_text)
        return clean_text

# ============ 主流程 ============
def main():
    now = now_local()
    print(f"[Gale] 心跳检查: {now.strftime('%Y-%m-%d %H:%M:%S %Z')}")

    state = load_state()

    eligible_rules = []
    for rule in RULES:
        name = rule["name"]
        if not in_time_window(now, rule["time_window"]):
            continue
        if not check_cooldown(state, name, rule.get("cooldown_minutes", 60)):
            print(f"[Gale] {name}: 冷却中，跳过")
            continue
        if not check_silence(rule):
            print(f"[Gale] {name}: 未满足沉默条件，跳过")
            continue
        if random.random() > rule["probability"]:
            print(f"[Gale] {name}: 骰子没中 (p={rule['probability']})")
            continue
        eligible_rules.append(rule)

    if not eligible_rules:
        print("[Gale] 本轮无触发")
        save_state(state)
        return

    rule = random.choice(eligible_rules)
    name = rule["name"]
    print(f"[Gale] {name}: 命中！生成消息...")

    message = generate_message(rule, state)

    if not message:
        print(f"[Gale] {name}: 生成失败")
        save_state(state)
        return

    msg_hash = hashlib.md5(message.encode()).hexdigest()[:8]
    if msg_hash == state.get("last_message_hash"):
        print(f"[Gale] {name}: 完全重复，跳过")
        save_state(state)
        return

    clean_message = send_reply(message)
    print(f"[Gale] {name}: 已发送 → {clean_message}")

    state["recent_messages"].append(clean_message)
    state["recent_messages"] = state["recent_messages"][-15:]

    state["trigger_history"].append({
        "role": "assistant",
        "content": message,
        "timestamp": now.isoformat()
    })
    state["trigger_history"] = state["trigger_history"][-20:]

    state["last_triggers"][name] = now.isoformat()
    state["last_message_hash"] = msg_hash

    save_state(state)

if __name__ == "__main__":
    main()
