(() => {
'use strict';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = { uzVol: 1, origVol: 0.08, cc: true, voice: 'female', wantQ: 0 };
let cfg = {};
let me = { logged_in: false };

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  let data = null;
  try { data = await r.json(); } catch (e) { /* bo'sh javob */ }
  if (!r.ok) {
    const e = new Error((data && data.error) || ('Xato ' + r.status));
    e.status = r.status;
    throw e;
  }
  return data;
}

function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}

function showErr(msg) { const e = $('#err'); e.textContent = msg; e.hidden = false; }
function hideErr() { $('#err').hidden = true; }
function setProg(p, txt) { $('#pfill').style.width = Math.max(1, Math.min(100, p || 0)) + '%'; if (txt) $('#pstep').textContent = txt; }

/* ------------------------------------------------------------------ auth */
function renderAuth() {
  const logged = !!me.logged_in;
  $('#gbtn').hidden = logged;
  $('#userbox').hidden = !logged;
  if (logged) {
    $('#uname').textContent = me.name || me.email;
    const av = $('#avatar');
    if (me.picture) { av.src = me.picture; av.hidden = false; } else { av.hidden = true; }
    $('#adminBadge').hidden = !me.is_admin;
    $('#adminLink').hidden = !me.is_admin;
  }
  renderQuota();
}

function renderQuota() {
  const q = $('#quota');
  if (!cfg.google_client_id) { q.textContent = "Google orqali kirish hali sozlanmagan (admin: GOOGLE_CLIENT_ID ni qo'shishi kerak)."; return; }
  if (!me.logged_in) { q.textContent = 'Tarjima qilish uchun avval Google orqali kiring.'; return; }
  q.textContent = me.remaining === null ? 'Admin: cheklovsiz.' : `Bugun qolgan tarjimalar: ${me.remaining} / ${cfg.daily_limit}`;
}

function initGoogle() {
  const box = $('#gbtn');
  if (!cfg.google_client_id) {
    box.innerHTML = '<button class="btn" disabled><i class="fa-brands fa-google"></i> Google orqali kirish</button>';
    return;
  }
  const t = setInterval(() => {
    if (!(window.google && google.accounts && google.accounts.id)) return;
    clearInterval(t);
    google.accounts.id.initialize({ client_id: cfg.google_client_id, callback: onCredential, ux_mode: 'popup' });
    google.accounts.id.renderButton(box, { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill', locale: 'uz' });
  }, 200);
}

async function onCredential(resp) {
  try {
    me = await api('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential: resp.credential }) });
    hideErr();
    renderAuth();
  } catch (e) { showErr(e.message); }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch (e) { /* e'tiborsiz */ }
  try { google.accounts.id.disableAutoSelect(); } catch (e) { /* e'tiborsiz */ }
  me = { logged_in: false };
  teardownPlayer();
  $('#playerSection').hidden = true;
  renderAuth();
}

/* ------------------------------------------------------------------ audio (bitta <audio> — iPhone uchun ham ishonchli) */
const audio = $('#dubAudio');
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
function unlockAudio() {
  try { audio.src = SILENT; const p = audio.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* e'tiborsiz */ }
}

/* ------------------------------------------------------------------ o'zbekcha ovoz dvigateli (videoga sinxron) */
const Dub = {
  segs: [], jobId: null, voice: 'female', playing: false, cur: -1, token: 0, lastT: 0,
  seeked: false, shown: -2, blobs: new Map(), pending: new Map(), queue: [], active: 0,
  timer: null, getTime: () => 0,

  load(jobId, segs, voice) {
    this.stopAll();
    this.jobId = jobId; this.segs = segs; this.voice = voice;
    this.cur = -1; this.lastT = 0; this.seeked = false; this.shown = -2;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 150);
    this.prefetch(0, 6);
  },
  key(i) { return this.voice + ':' + i; },
  clip(i) {
    const k = this.key(i);
    if (this.blobs.has(k)) return Promise.resolve(this.blobs.get(k));
    if (this.pending.has(k)) return this.pending.get(k);
    const voice = this.voice, jobId = this.jobId;
    const p = fetch(`/api/tts/${jobId}/${i}?v=${voice}`, { credentials: 'same-origin' })
      .then((r) => { if (!r.ok) throw new Error('tts ' + r.status); return r.blob(); })
      .then((b) => { const u = URL.createObjectURL(b); if (jobId === this.jobId) this.blobs.set(voice + ':' + i, u); return u; })
      .finally(() => this.pending.delete(k));
    this.pending.set(k, p);
    return p;
  },
  prefetch(from, n) {
    for (let i = Math.max(0, from); i < Math.min(this.segs.length, from + n); i++) {
      const k = this.key(i);
      if (!this.blobs.has(k) && !this.pending.has(k) && !this.queue.includes(i)) this.queue.push(i);
    }
    this.pump();
  },
  pump() {
    while (this.active < 3 && this.queue.length) {
      const i = this.queue.shift();
      const k = this.key(i);
      if (this.blobs.has(k) || this.pending.has(k)) continue;
      this.active++;
      this.clip(i).catch(() => {}).finally(() => { this.active--; this.pump(); });
    }
  },
  evict() {
    for (const [k, u] of this.blobs) {
      const idx = parseInt(k.split(':')[1], 10);
      if (idx < this.cur - 12) { URL.revokeObjectURL(u); this.blobs.delete(k); }
    }
  },
  indexAt(t) {
    const a = this.segs;
    let lo = 0, hi = a.length - 1, r = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (a[m].s <= t + 0.12) { r = m; lo = m + 1; } else { hi = m - 1; }
    }
    return r;
  },
  tick() {
    if (!this.segs.length) return;
    const t = this.getTime();
    if (typeof t !== 'number' || isNaN(t)) return;
    const jumped = Math.abs(t - this.lastT) > 2.2; // 150ms ichida >2.2s o'zgarsa — bu seek
    this.lastT = t;
    if (jumped) { this.token++; this.stopClip(); this.cur = -1; this.seeked = true; }
    const i = this.indexAt(t);
    this.showSub(i, t);
    if (!this.playing) return;
    this.prefetch(Math.max(0, i), 6);
    if (i >= 0 && i !== this.cur) {
      const off = t - this.segs[i].s;
      this.cur = i;
      if (off < 1.2 || this.seeked) this.playClip(i, Math.max(0, off));
      this.seeked = false;
      this.evict();
    }
  },
  async playClip(i, off) {
    const my = ++this.token;
    let url;
    try { url = await this.clip(i); } catch (e) { return; }
    if (my !== this.token || !this.playing) { if (this.cur === i && !this.playing) this.cur = -1; return; }
    const s = this.segs[i], next = this.segs[i + 1];
    if (next && this.getTime() >= next.s + 0.25) return; // kechikdi — keyingi bo'lakka o'tamiz
    audio.src = url;
    audio.volume = state.uzVol;
    audio.defaultPlaybackRate = 1;
    const slotEnd = next ? next.s : s.e + 2.5;
    audio.onloadedmetadata = () => {
      const d = isFinite(audio.duration) ? audio.duration : 0;
      const slot = Math.max(0.6, slotEnd - this.getTime());
      audio.playbackRate = d > 0 ? Math.min(1.7, Math.max(1, d / slot)) : 1; // sig'masa tezlashtiramiz
      const o = Math.max(0, this.getTime() - s.s);
      if (o > 1.0 && d > 0) audio.currentTime = Math.min(d - 0.1, (o / Math.max(0.1, slotEnd - s.s)) * d);
      audio.play().catch(() => {});
    };
  },
  stopClip() { audio.onloadedmetadata = null; try { audio.pause(); } catch (e) { /* e'tiborsiz */ } },
  pause() { this.playing = false; this.token++; try { audio.pause(); } catch (e) { /* e'tiborsiz */ } },
  resume() {
    this.playing = true;
    if (audio.src && audio.src !== SILENT && !audio.ended && audio.currentTime > 0 && audio.currentTime < (audio.duration || 0)) {
      audio.play().catch(() => {});
    }
  },
  setVoice(v) {
    this.voice = v; this.queue = []; this.token++; this.stopClip(); this.cur = -1; this.shown = -2;
    this.prefetch(Math.max(0, this.indexAt(this.getTime())), 6);
  },
  stopAll() {
    this.playing = false; this.token++; this.stopClip();
    this.blobs.forEach((u) => URL.revokeObjectURL(u));
    this.blobs.clear(); this.pending.clear(); this.queue = []; this.segs = [];
    clearInterval(this.timer);
    $('#sub').textContent = '';
  },
  showSub(i, t) {
    let key = -1;
    if (state.cc && i >= 0) {
      const s = this.segs[i];
      const speaking = this.cur === i && !audio.paused && !audio.ended;
      if (t <= s.e + 0.6 || speaking) key = i;
    }
    if (key === this.shown) return;
    this.shown = key;
    const el = $('#sub');
    el.textContent = '';
    if (key >= 0) { const sp = document.createElement('span'); sp.textContent = this.segs[key].t; el.appendChild(sp); }
  },
};

/* ------------------------------------------------------------------ pleer adapterlari */
const Player = {
  mode: null, yt: null, video: null, formats: [], qDone: false,
  time() {
    if (this.mode === 'yt') return this.yt && this.yt.getCurrentTime ? this.yt.getCurrentTime() : 0;
    if (this.mode === 'direct' && this.video) return this.video.currentTime;
    return 0;
  },
  setOrig(v) {
    if (this.mode === 'yt' && this.yt && this.yt.setVolume) this.yt.setVolume(Math.round(v * 100));
    if (this.mode === 'direct' && this.video) this.video.volume = v;
  },
};

const YTQ = {
  tiny: ['144p', 144], small: ['240p', 240], medium: ['360p', 360], large: ['480p', 480],
  hd720: ['720p (HD)', 720], hd1080: ['1080p (Full HD)', 1080], hd1440: ['1440p (2K)', 1440],
  hd2160: ['2160p (4K)', 2160], hd2880: ['2880p (5K)', 2880], highres: ['Yuqori (4K+)', 4320],
};

function loadYT() {
  return new Promise((res, rej) => {
    if (window.YT && window.YT.Player) return res();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(); };
    if (!document.getElementById('ytapi')) {
      const s = document.createElement('script');
      s.id = 'ytapi'; s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => rej(new Error("YouTube pleyeri yuklanmadi (internet yoki bloklangan)."));
      document.head.appendChild(s);
    }
  });
}

function onYtState(e) {
  const S = window.YT.PlayerState;
  if (e.data === S.PLAYING) { Dub.resume(); populateYtQuality(); }
  else if (e.data === S.PAUSED || e.data === S.BUFFERING || e.data === S.ENDED) { Dub.pause(); }
}

function populateYtQuality() {
  if (Player.qDone || !Player.yt || !Player.yt.getAvailableQualityLevels) return;
  let lv = [];
  try { lv = (Player.yt.getAvailableQualityLevels() || []).filter((x) => YTQ[x]); } catch (e) { /* e'tiborsiz */ }
  if (!lv.length) return;
  Player.qDone = true;
  const sel = $('#qual');
  sel.innerHTML = '<option value="auto">Avto</option>';
  lv.forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = YTQ[c][0]; sel.appendChild(o); });
  $('#qualGrp').hidden = false;
  if (state.wantQ > 0) { // xohlangan sifatga eng yaqin (undan oshmagan) darajani tanlaymiz
    const ok = lv.filter((c) => YTQ[c][1] <= state.wantQ).sort((a, b) => YTQ[b][1] - YTQ[a][1]);
    const code = ok[0] || lv[lv.length - 1];
    sel.value = code;
    try { Player.yt.setPlaybackQuality(code); } catch (e) { /* e'tiborsiz */ }
  }
}

async function mountYouTube(id) {
  await loadYT();
  $('#media').innerHTML = '<div id="ytp"></div>';
  await new Promise((resolve) => {
    Player.yt = new window.YT.Player('ytp', {
      videoId: id, width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0, fs: 0, modestbranding: 1, iv_load_policy: 3, origin: location.origin, hl: 'uz' },
      events: { onReady: () => { Player.mode = 'yt'; Player.setOrig(state.origVol); resolve(); }, onStateChange: onYtState },
    });
  });
}

function mountDirect(formats) {
  const media = $('#media');
  media.innerHTML = '';
  const v = document.createElement('video');
  v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto'; v.controls = false;
  media.appendChild(v);
  Player.video = v; Player.mode = 'direct'; Player.formats = formats;

  const sel = $('#qual');
  sel.innerHTML = '';
  formats.forEach((f) => {
    const o = document.createElement('option');
    o.value = f.height;
    o.textContent = f.height + 'p' + (f.height >= 2160 ? ' (4K)' : f.height >= 1440 ? ' (2K)' : f.height >= 1080 ? ' (Full HD)' : f.height >= 720 ? ' (HD)' : '');
    sel.appendChild(o);
  });
  $('#qualGrp').hidden = false;
  let pick = formats[formats.length - 1];
  if (state.wantQ > 0) { const le = formats.filter((f) => f.height <= state.wantQ); pick = le.length ? le[le.length - 1] : formats[0]; }
  sel.value = pick.height;
  v.src = pick.url;
  v.volume = state.origVol;

  const playIcon = $('#playBtn i');
  v.addEventListener('play', () => { playIcon.className = 'fa-solid fa-pause'; });
  v.addEventListener('playing', () => Dub.resume());
  v.addEventListener('pause', () => { playIcon.className = 'fa-solid fa-play'; Dub.pause(); });
  v.addEventListener('waiting', () => Dub.pause());
  v.addEventListener('ended', () => { playIcon.className = 'fa-solid fa-play'; Dub.pause(); });
  v.addEventListener('error', () => showErr("Videoni ochib bo'lmadi (manba ruxsat bermadi yoki havola eskirgan). Qayta urinib ko'ring."));
  v.addEventListener('timeupdate', updateTransport);
  v.addEventListener('loadedmetadata', updateTransport);
  v.addEventListener('click', togglePlay);
  $('#transport').hidden = false;
}

function togglePlay() {
  const v = Player.video;
  if (!v) return;
  if (v.paused) { unlockAudio(); v.play().catch(() => {}); } else { v.pause(); }
}

function updateTransport() {
  const v = Player.video;
  if (!v) return;
  const d = v.duration || 0;
  $('#timeTxt').textContent = fmt(v.currentTime) + ' / ' + fmt(d);
  if (!$('#seek').matches(':active') && d) $('#seek').value = Math.round((v.currentTime / d) * 1000);
}

function teardownPlayer() {
  Dub.stopAll();
  try { if (Player.yt && Player.yt.destroy) Player.yt.destroy(); } catch (e) { /* e'tiborsiz */ }
  if (Player.video) { try { Player.video.pause(); Player.video.removeAttribute('src'); Player.video.load(); } catch (e) { /* e'tiborsiz */ } }
  Player.yt = null; Player.video = null; Player.mode = null; Player.qDone = false;
  $('#media').innerHTML = '';
  $('#transport').hidden = true;
  $('#qualGrp').hidden = true;
  exitFs();
}

/* ------------------------------------------------------------------ to'liq ekran + yonbosh (landscape) */
const stage = $('#stage');
const isNativeFs = () => document.fullscreenElement === stage || document.webkitFullscreenElement === stage;
const isPseudo = () => stage.classList.contains('pseudo');

function updateFsIcon() {
  $('#fsBtn i').className = (isNativeFs() || isPseudo()) ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
}

async function enterFs() {
  let native = false;
  try {
    if (stage.requestFullscreen) { await stage.requestFullscreen({ navigationUI: 'hide' }); native = true; }
    else if (stage.webkitRequestFullscreen) { stage.webkitRequestFullscreen(); native = true; }
  } catch (e) { native = false; }

  let locked = false;
  if (native && window.screen && screen.orientation && screen.orientation.lock) {
    try { await screen.orientation.lock('landscape'); locked = true; } catch (e) { locked = false; }
  }
  const portrait = window.innerHeight > window.innerWidth;
  if (native && portrait && !locked) {
    // Yonbosh qilib qulflab bo'lmadi va telefon tik turibdi: "soxta" yonbosh rejimga o'tamiz
    try { if (document.exitFullscreen) await document.exitFullscreen(); } catch (e) { /* e'tiborsiz */ }
    stage.classList.add('pseudo', 'rot');
  } else if (!native) {
    stage.classList.add('pseudo');
    if (portrait) stage.classList.add('rot');
  }
  document.body.classList.add('fs-open');
  stage.classList.add('tools-collapsed');
  updateFsIcon();
}

async function exitFs() {
  try {
    if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
  } catch (e) { /* e'tiborsiz */ }
  stage.classList.remove('pseudo', 'rot', 'tools-collapsed');
  document.body.classList.remove('fs-open');
  try { if (window.screen && screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* e'tiborsiz */ }
  updateFsIcon();
}

function toggleFs() { return (isNativeFs() || isPseudo()) ? exitFs() : enterFs(); }

['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.addEventListener(ev, () => {
  if (!isNativeFs() && !isPseudo()) {
    stage.classList.remove('tools-collapsed');
    document.body.classList.remove('fs-open');
    try { if (window.screen && screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* e'tiborsiz */ }
  }
  updateFsIcon();
}));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isPseudo()) exitFs(); });
window.addEventListener('resize', () => {
  if (isPseudo()) stage.classList.toggle('rot', window.innerHeight > window.innerWidth);
});

/* ------------------------------------------------------------------ tarjima jarayoni */
async function poll(id) {
  let fails = 0;
  for (;;) {
    let j;
    try { j = await api('/api/job/' + id); fails = 0; }
    catch (e) {
      if (e.status === 401 || e.status === 404 || ++fails > 4) throw e;
      await sleep(2000); continue;
    }
    setProg(j.progress, j.step);
    if (j.status === 'done') return j.result;
    if (j.status === 'error') throw new Error(j.error || 'Xatolik yuz berdi.');
    await sleep(1500);
  }
}

async function start() {
  hideErr();
  if (!me.logged_in) { showErr('Avval yuqoridagi tugma orqali Google bilan kiring.'); return; }
  const url = $('#url').value.trim();
  if (!url) { showErr('YouTube yoki VK video havolasini kiriting.'); return; }
  unlockAudio(); // iPhone/Chrome: ovoz brauzerda faqat foydalanuvchi bosganda ochiladi
  state.wantQ = parseInt($('#quality').value, 10) || 0;
  state.voice = $('#voice').value;
  $('#voice2').value = state.voice;
  $('#go').disabled = true;
  $('#progress').hidden = false;
  setProg(1, 'Yuborilmoqda…');
  $('#playerSection').hidden = true;
  teardownPlayer();
  try {
    const { job_id } = await api('/api/translate', { method: 'POST', body: JSON.stringify({ url, lang: $('#lang').value }) });
    const res = await poll(job_id);
    await showPlayer(res, job_id);
    try { me = await api('/api/me'); renderQuota(); } catch (e) { /* e'tiborsiz */ }
  } catch (e) {
    showErr(e.message);
  } finally {
    $('#go').disabled = false;
    $('#progress').hidden = true;
  }
}

async function showPlayer(res, jobId) {
  setProg(96, "Ovoz tayyorlanmoqda…");
  $('#playerSection').hidden = false;
  $('#vtitle').textContent = res.title || 'Video';
  const method = { subtitr: 'subtitr', stt: 'ovozdan matn (STT)' }[String(res.method).split('+')[0]] || res.method;
  $('#meta').innerHTML = '';
  [['Asl til', res.src_lang_name], ['Manba', method + (String(res.method).includes('kesh') ? ' (keshdan)' : '')], ["Bo'laklar", res.segments.length]].forEach(([k, v]) => {
    const s = document.createElement('span'); s.append(k + ': '); const b = document.createElement('b'); b.textContent = v; s.appendChild(b);
    $('#meta').appendChild(s);
  });

  Dub.getTime = () => Player.time();
  Dub.load(jobId, res.segments, state.voice);
  const firstClips = [0, 1].filter((i) => i < res.segments.length).map((i) => Dub.clip(i));
  try { await Promise.race([Promise.all(firstClips), sleep(25000)]); } catch (e) { /* kechroq qayta uriniladi */ }

  if (res.platform === 'youtube') {
    await mountYouTube(res.video_id);
    $('#modeHint').textContent = "Video YouTube'ning rasmiy pleyerida ijro etiladi