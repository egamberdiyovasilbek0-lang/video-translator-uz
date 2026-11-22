# -*- coding: utf-8 -*-
"""AI Video Tarjimon (O'zbekcha) - Flask backend.

YouTube / VK havolasi -> subtitr (yoki STT) -> o'zbekcha tarjima -> odam ovozli TTS.
Video qayta kodlanmaydi: pleerda asl video o'ynaydi, o'zbekcha ovoz uning ustidan sinxron chaladi.
"""
import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import requests
from flask import Flask, jsonify, request, send_file, send_from_directory, session
from werkzeug.middleware.proxy_fix import ProxyFix

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("vt")

# --------------------------------------------------------------------------- config
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR") or os.path.join(tempfile.gettempdir(), "vt-data")
TTS_DIR = os.path.join(DATA_DIR, "tts")
os.makedirs(TTS_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "app.db")

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
# Admin Google email(lari), vergul bilan ajratilgan. Render > Environment orqali beriladi.
ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}
ADMIN_PHONE = os.environ.get("ADMIN_PHONE", "+998881170611").strip()
DAILY_LIMIT = int(os.environ.get("DAILY_LIMIT", "10"))
MAX_MINUTES = int(os.environ.get("MAX_VIDEO_MINUTES", "90"))
MAX_JOBS = int(os.environ.get("MAX_JOBS", "2"))
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
YTDLP_COOKIES = os.environ.get("YTDLP_COOKIES", "")  # cookies.txt (Netscape) matni

LANGS = {"zh": "Xitoy", "ja": "Yapon", "ru": "Rus", "en": "Ingliz",
         "de": "Nemis", "fr": "Fransuz", "ar": "Arab", "tr": "Turk"}
GT_CODE = {"zh": "zh-CN", "ja": "ja", "ru": "ru", "en": "en",
           "de": "de", "fr": "fr", "ar": "ar", "tr": "tr"}
GROQ_LANG_NAMES = {"chinese": "zh", "japanese": "ja", "russian": "ru", "english": "en",
                   "german": "de", "french": "fr", "arabic": "ar", "turkish": "tr"}
VOICES = {"female": "uz-UZ-MadinaNeural", "male": "uz-UZ-SardorNeural"}
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def _secret_key():
    s = os.environ.get("SECRET_KEY", "").strip()
    if s:
        return s
    path = os.path.join(DATA_DIR, "secret.key")
    try:
        if os.path.exists(path):
            with open(path) as fh:
                return fh.read().strip()
        s = secrets.token_hex(32)
        with open(path, "w") as fh:
            fh.write(s)
        return s
    except OSError:
        return secrets.token_hex(32)


app = Flask(__name__, static_folder=os.path.join(BASE_DIR, "static"), static_url_path="/static")
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.config.update(
    SECRET_KEY=_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("RENDER")),
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    MAX_CONTENT_LENGTH=1024 * 1024,
    SEND_FILE_MAX_AGE_DEFAULT=300,
)

# --------------------------------------------------------------------------- database
_db_lock = threading.Lock()
SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  email TEXT PRIMARY KEY, name TEXT, picture TEXT,
  created_at TEXT, last_login TEXT, blocked INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS translations(
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, email TEXT, url TEXT,
  platform TEXT, title TEXT, src_lang TEXT, method TEXT, segments INTEGER,
  status INTEGER DEFAULT 0, error TEXT, day TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, data TEXT, created_at TEXT);
"""


def _conn():
    c = sqlite3.connect(DB_PATH, timeout=15)
    c.row_factory = sqlite3.Row
    return c


def db_init():
    with _db_lock:
        c = _conn()
        try:
            c.executescript(SCHEMA)
            c.commit()
        finally:
            c.close()


def db_exec(sql, params=()):
    with _db_lock:
        c = _conn()
        try:
            cur = c.execute(sql, params)
            c.commit()
            return cur.lastrowid
        finally:
            c.close()


def db_all(sql, params=()):
    c = _conn()
    try:
        return [dict(r) for r in c.execute(sql, params).fetchall()]
    finally:
        c.close()


def db_one(sql, params=()):
    rows = db_all(sql, params)
    return rows[0] if rows else None


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def today():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


db_init()


# --------------------------------------------------------------------------- helpers: auth
def is_admin_email(email):
    return (email or "").lower() in ADMIN_EMAILS


def current_user():
    email = session.get("email")
    if not email:
        return None
    u = db_one("SELECT * FROM users WHERE email=?", (email,))
    if not u or u["blocked"]:
        return None
    return u


def used_today(email):
    r = db_one("SELECT COUNT(*) AS n FROM translations WHERE email=? AND day=? AND status>=0",
               (email, today()))
    return r["n"] if r else 0


def remaining_for(user):
    if is_admin_email(user["email"]):
        return None  # cheksiz
    return max(0, DAILY_LIMIT - used_today(user["email"]))


def err(msg, code=400, **extra):
    return jsonify({"error": msg, **extra}), code


@app.after_request
def _headers(resp):
    if request.path.startswith("/api/") and not request.path.startswith("/api/tts/"):
        resp.headers["Cache-Control"] = "no-store"
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    return resp


# --------------------------------------------------------------------------- helpers: url
ALLOWED_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
    "vk.com", "www.vk.com", "m.vk.com", "vk.ru", "m.vk.ru",
    "vkvideo.ru", "www.vkvideo.ru", "m.vkvideo.ru",
}


def parse_video_url(raw):
    """-> {platform, vid, url} yoki None. Faqat YouTube/VK ruxsat (SSRF himoyasi)."""
    raw = (raw or "").strip()
    if not raw or len(raw) > 500:
        return None
    if not re.match(r"^https?://", raw, re.I):
        raw = "https://" + raw
    try:
        u = urlparse(raw)
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    if host not in ALLOWED_HOSTS:
        return None
    if "youtu" in host:
        vid = None
        if host == "youtu.be":
            vid = u.path.strip("/").split("/")[0]
        elif u.path == "/watch":
            vid = (parse_qs(u.query).get("v") or [None])[0]
        else:
            m = re.match(r"^/(?:shorts|embed|live|v)/([\w-]{11})", u.path)
            vid = m.group(1) if m else None
        if not vid or not re.fullmatch(r"[\w-]{11}", vid):
            return None
        return {"platform": "youtube", "vid": vid, "url": f"https://www.youtube.com/watch?v={vid}"}
    # VK
    q = parse_qs(u.query)
    oid = vid = None
    if q.get("oid") and q.get("id"):
        oid, vid = q["oid"][0], q["id"][0]
    else:
        m = re.search(r"video(-?\d+)_(\d+)", raw)
        if m:
            oid, vid = m.group(1), m.group(2)
    if not (oid and vid and re.fullmatch(r"-?\d+", oid) and re.fullmatch(r"\d+", vid)):
        return None
    url = f"https://vk.com/video{oid}_{vid}"
    if q.get("hash") and re.fullmatch(r"\w+", q["hash"][0]):
        url = f"https://vk.com/video_ext.php?oid={oid}&id={vid}&hash={q['hash'][0]}"
    return {"platform": "vk", "vid": f"{oid}_{vid}", "url": url}


# --------------------------------------------------------------------------- helpers: captions
SENT_END = re.compile(r"[.!?\u3002\uff01\uff1f\u2026]['\")\]]*$")
CJK = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]")


def _norm_lang(code):
    return (code or "").split("-")[0].lower()


def pick_caption(info, hint):
    """Eng yaxshi subtitrni tanlaydi: qo'lda yozilgan > asl tildagi avto (-orig) > boshqalar."""
    subs = {k: v for k, v in (info.get("subtitles") or {}).items() if k != "live_chat" and v}
    auto = {k: v for k, v in (info.get("automatic_captions") or {}).items() if v}
    order = []
    if hint in LANGS:
        order.append(hint)
    il = _norm_lang(info.get("language"))
    if il and il not in order:
        order.append(il)
    order += [c for c in LANGS if c not in order]

    def find(pool, lang):
        for k, v in pool.items():
            if _norm_lang(k) == lang:
                return {"lang": lang, "formats": v, "key": k}
        return None

    for lang in order[:2]:
        r = find(subs, lang)
        if r:
            return r
    for k, v in auto.items():  # asl ovoz tilidagi avtomatik subtitr
        if k.endswith("-orig"):
            return {"lang": _norm_lang(k), "formats": v, "key": k}
    for lang in order:
        r = find(subs, lang)
        if r:
            return r
    for lang in order[:2]:
        r = find(auto, lang)
        if r:
            return r
    return None


def _ts(h, m, s, ms):
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


VTT_TS = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})")


def parse_vtt(text):
    out, lines, i = [], text.splitlines(), 0
    while i < len(lines):
        m = VTT_TS.search(lines[i])
        if not m:
            i += 1
            continue
        g = m.groups()
        s, e = _ts(*g[0:4]), _ts(*g[4:8])
        i += 1
        buf = []
        while i < len(lines) and lines[i].strip():
            buf.append(re.sub(r"<[^>]+>", "", lines[i]).strip())
            i += 1
        t = " ".join(x for x in buf if x)
        if t:
            out.append((s, e, t))
    ded = []  # avtomatik subtitrdagi "dumalab" takrorlarni olib tashlash
    for s, e, t in out:
        if ded and (t == ded[-1][2] or ded[-1][2].endswith(t)):
            ded[-1] = (ded[-1][0], max(ded[-1][1], e), ded[-1][2])
        elif ded and t.startswith(ded[-1][2]):
            ded[-1] = (ded[-1][0], e, t)
        else:
            ded.append((s, e, t))
    return ded


def parse_json3(data):
    out = []
    for ev in data.get("events", []):
        segs = ev.get("segs")
        if not segs:
            continue
        t = "".join(s.get("utf8", "") for s in segs).replace("\n", " ").strip()
        if not t:
            continue
        s = ev.get("tStartMs", 0) / 1000.0
        e = s + ev.get("dDurationMs", 0) / 1000.0
        out.append((s, e, t))
    return out


def fetch_caption(formats):
    by_ext = {f.get("ext"): f for f in formats if f.get("url")}
    for ext in ("json3", "vtt", "srt"):
        f = by_ext.get(ext)
        if not f:
            continue
        r = requests.get(f["url"], headers={"User-Agent": UA}, timeout=30)
        r.raise_for_status()
        if ext == "json3":
            return parse_json3(r.json())
        return parse_vtt(r.text)
    raise ValueError("Mos subtitr formati topilmadi")


def merge_segments(raw, lang=None):
    """Qisqa bo'laklarni gap-gapga birlashtiradi (tarjima va ovoz tabiiy chiqishi uchun)."""
    items = sorted(raw, key=lambda x: x[0])
    out, cur = [], None

    def flush():
        nonlocal cur
        if cur:
            out.append(cur)
            cur = None

    for s, e, t in items:
        t = re.sub(r"\s+", " ", t).strip()
        if not t:
            continue
        if e <= s:
            e = s + max(1.0, len(t) / 14.0)
        if cur:
            gap = s - cur["e"]
            dur = cur["e"] - cur["s"]
            if gap >= 1.0 or dur >= 6.0 or (SENT_END.search(cur["o"]) and dur >= 1.5):
                flush()
        if cur:
            joiner = "" if CJK.search(t[:1]) and CJK.search(cur["o"][-1:]) else " "
            cur["o"] += joiner + t
            cur["e"] = max(cur["e"], e)
        else:
            cur = {"s": round(s, 2), "e": round(e, 2), "o": t}
    flush()
    for i in range(len(out) - 1):  # ustma-ust tushmasin
        if out[i]["e"] > out[i + 1]["s"]:
            out[i]["e"] = out[i + 1]["s"]
    return [x for x in out if x["e"] > x["s"]][:3000]


# --------------------------------------------------------------------------- helpers: translate
def translate_texts(texts, src_lang, progress=None):
    from deep_translator import GoogleTranslator

    tr = GoogleTranslator(source=GT_CODE.get(src_lang, "auto"), target="uz")
    out, i = [], 0
    while i < len(texts):
        chunk, size, j = [], 0, i
        while j < len(texts) and size + len(texts[j]) + 1 < 3800:
            chunk.append(texts[j].replace("\n", " "))
            size += len(texts[j]) + 1
            j += 1
        if not chunk:
            chunk, j = [texts[i][:3800]], i + 1
        lines = None
        try:
            res = tr.translate("\n".join(chunk))
            cand = (res or "").split("\n")
            if len(cand) == len(chunk):
                lines = cand
        except Exception as ex:  # noqa: BLE001
            log.warning("batch translate failed: %s", ex)
        if lines is None:
            lines = []
            for c in chunk:
                try:
                    lines.append(tr.translate(c) or c)
                except Exception:  # noqa: BLE001
                    lines.append(c)
        out.extend(x.strip() for x in lines)
        i = j
        if progress:
            progress(i / max(1, len(texts)))
    return out


# --------------------------------------------------------------------------- helpers: yt-dlp / STT
class UserError(Exception):
    """Foydalanuvchiga ko'rsatiladigan xato."""


def _cookie_copy():
    if not YTDLP_COOKIES.strip():
        return None
    fd, path = tempfile.mkstemp(suffix=".txt", dir=DATA_DIR)
    with os.fdopen(fd, "w") as fh:
        fh.write(YTDLP_COOKIES)
    return path


def ydl_opts(extra=None):
    opts = {
        "quiet": True, "no_warnings": True, "noplaylist": True, "socket_timeout": 25,
        "retries": 2, "cachedir": False, "ignore_no_formats_error": True,
        # YouTube uchun JS runtime (Dockerfile'da nodejs o'rnatilgan); eski versiyada e'tiborsiz qoladi
        "js_runtimes": {"node": {}}, "remote_components": ["ejs:github"],
    }
    if extra:
        opts.update(extra)
    return opts


def _rm(path):
    if path:
        try:
            os.remove(path)
        except OSError:
            pass


def extract_info(url):
    import yt_dlp

    cookie = _cookie_copy()
    try:
        opts = ydl_opts({"skip_download": True})
        if cookie:
            opts["cookiefile"] = cookie
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False)
    finally:
        _rm(cookie)


def direct_formats(info):
    best = {}
    for f in info.get("formats") or []:
        if f.get("vcodec") in (None, "none") or f.get("acodec") in (None, "none"):
            continue
        if f.get("protocol") not in ("https", "http"):
            continue
        h, u = f.get("height"), f.get("url")
        if not h or not u:
            continue
        if h not in best or (f.get("tbr") or 0) > (best[h].get("tbr") or 0):
            best[h] = f
    return [{"height": h, "url": best[h]["url"], "ext": best[h].get("ext")} for h in sorted(best)]


def transcribe(url, hint, job):
    """Groq Whisper orqali ovozni matnga aylantirish (subtitr bo'lmasa)."""
    import yt_dlp

    tmp = tempfile.mkdtemp(dir=DATA_DIR)
    cookie = _cookie_copy()
    try:
        job_update(job, step="Audio yuklab olinmoqda…", progress=20)
        opts = ydl_opts({"format": "worstaudio/worst", "outtmpl": os.path.join(tmp, "a.%(ext)s"),
                         "max_filesize": 500 * 1024 * 1024})
        if cookie:
            opts["cookiefile"] = cookie
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
        files = [os.path.join(tmp, f) for f in os.listdir(tmp)]
        if not files:
            raise UserError("Audio yuklab olinmadi.")
        path = files[0]
        if shutil.which("ffmpeg"):
            job_update(job, step="Audio siqilmoqda…", progress=32)
            small = os.path.join(tmp, "small.mp3")
            subprocess.run(["ffmpeg", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000",
                            "-b:a", "32k", "-t", str(MAX_MINUTES * 60), small],
                           check=True, capture_output=True, timeout=900)
            path = small
        if os.path.getsize(path) > 24 * 1024 * 1024:
            raise UserError("Video juda uzun: ovozni matnga aylantirish uchun fayl 25 MB dan oshib ketdi.")
        job_update(job, step="Ovoz matnga aylantirilmoqda (STT)…", progress=40)
        data = {"model": "whisper-large-v3-turbo", "response_format": "verbose_json",
                "timestamp_granularities[]": "segment"}
        if hint in LANGS:
            data["language"] = hint
        with open(path, "rb") as fh:
            r = requests.post("https://api.groq.com/openai/v1/audio/transcriptions",
                              headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
                              files={"file": (os.path.basename(path), fh)}, data=data, timeout=900)
        if r.status_code != 200:
            raise UserError(f"STT xizmati xato qaytardi ({r.status_code}).")
        j = r.json()
        raw = [(s["start"], s["end"], s["text"]) for s in j.get("segments", [])
               if (s.get("no_speech_prob") or 0) < 0.6 and s.get("text", "").strip()]
        lang = GROQ_LANG_NAMES.get(str(j.get("language", "")).lower()) or (hint if hint in LANGS else None)
        return raw, lang
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        _rm(cookie)


# --------------------------------------------------------------------------- cache
def cache_get(key):
    r = db_one("SELECT data FROM cache WHERE key=?", (key,))
    return json.loads(r["data"]) if r else None


def cache_put(key, obj):
    db_exec("INSERT OR REPLACE INTO cache(key,data,created_at) VALUES(?,?,?)",
            (key, json.dumps(obj, ensure_ascii=False), now_iso()))


# --------------------------------------------------------------------------- jobs
JOBS = {}
JOBS_LOCK = threading.Lock()
JOB_SEM = threading.Semaphore(MAX_JOBS)


def job_update(job, **kw):
    with JOBS_LOCK:
        job.update(kw)


def job_public(job):
    with JOBS_LOCK:
        d = {k: job.get(k) for k in ("id", "status", "step", "progress", "error")}
        if job["status"] == "done":
            d["result"] = job["result"]
        return d


def purge_jobs():
    cutoff = time.time() - 12 * 3600
    with JOBS_LOCK:
        old = [k for k, v in JOBS.items() if v["created"] < cutoff]
        for k in old:
            JOBS.pop(k, None)
    for k in old:
        shutil.rmtree(os.path.join(TTS_DIR, k), ignore_errors=True)


def friendly_error(ex):
    s = str(ex)
    if "Sign in to confirm" in s or "not a bot" in s:
        return ("YouTube server IP manzilini bot deb blokladi. Admin: YTDLP_COOKIES o'zgaruvchisiga "
                "brauzer cookie'larini (cookies.txt) qo'shsin.")
    if "Private video" in s or "members-only" in s.lower():
        return "Bu video yopiq yoki faqat a'zolar uchun."
    if "Video unavailable" in s or "not available" in s:
        return "Video mavjud emas yoki mintaqada bloklangan."
    return "Xatolik: " + s.replace("\n", " ")[:220]


def pipeline(job):
    url, platform, hint = job["url"], job["platform"], job["hint"]
    job_update(job, step="Video ma'lumotlari olinmoqda…", progress=8)
    info = extract_info(url) or {}
    dur = info.get("duration") or 0
    if dur and dur > MAX_MINUTES * 60:
        raise UserError(f"Video juda uzun (maksimum {MAX_MINUTES} daqiqa).")
    vid = str(info.get("id") or job["vid"])
    title = info.get("title")