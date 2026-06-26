const TOTAL_TIME = 2343.1836734693875;
const MIN_TIME = 0.5;
const MAX_TIME = 2343.5;
const REEL_TIME_DIV = 5.8675;
const SPINNER_COUNT = 6;
const REEL_COUNT = 400;
const SPINNER_MS = 28;
const SCRUB_RATE = 30;

const TRACKS = [
  { file: '01-cobwebs.mp3', duration: 258.8473469387755, title: 'Cobwebs' },
  { file: '02-by-the-wayside.mp3', duration: 173.4269387755102, title: 'By the Wayside (By the Way)' },
  { file: '03-farm-song.mp3', duration: 243.25224489795917, title: 'Farm Song' },
  { file: '04-meanada.mp3', duration: 338.2857142857143, title: 'Meanada' },
  { file: '05-she-ll-be-right.mp3', duration: 178.72979591836736, title: "She'll be Right" },
  { file: '06-big-wide-world.mp3', duration: 240.9795918367347, title: 'Big Wide World (Lots of People)' },
  { file: '07-today-is-the-day.mp3', duration: 213.15918367346939, title: 'Today is the Day' },
  { file: '08-pay-to-play.mp3', duration: 167.49714285714285, title: 'Pay to Play' },
  { file: '09-next-time.mp3', duration: 239.22938775510204, title: 'Next Time' },
  { file: '10-thank-you.mp3', duration: 289.77632653061227, title: 'Thank You' },
];

const SFX = {
  play: 'sfx-play.mp3',
  stop: 'sfx-stop.mp3',
  rewindPress: 'sfx-rewind-press.mp3',
  rewindLoop: 'sfx-rewind-loop.mp3',
  ffPress: 'sfx-fast-forward-press.mp3',
  ffLoop: 'sfx-fast-forward-loop.mp3',
};

const SFX_EARLY = {
  play: 'sfxPlay',
  stop: 'sfxStop',
  rewindPress: 'sfxRewindPress',
  ffPress: 'sfxFfPress',
};

const reelA = document.getElementById('reelA');
const spinnerFrames = Array.from(document.querySelectorAll('.player__spinner-frame'));
const playerEl = document.getElementById('player');
const trackAudio = document.getElementById('trackAudio');
const pressMap = {
  rewind: document.getElementById('pressRewind'),
  play: document.getElementById('pressPlay'),
  ff: document.getElementById('pressFF'),
  stop: document.getElementById('pressStop'),
};

// ---------------------------------------------------------------------------
// Web Audio is used ONLY for the short UI sound effects (instant, precise).
// The music plays through the native <audio> element so it keeps going when
// the screen is off / app is backgrounded and shows in the phone media player.
// ---------------------------------------------------------------------------
const AudioCtx = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioCtx();
const sfxGain = audioCtx.createGain();
sfxGain.connect(audioCtx.destination);

const sfxBuffers = {};
let loopSource = null;

let globalTime = MIN_TIME;
let state = 'stop';
let trackIndex = 0;
let currentSrcIndex = 0; // which track file is loaded in the <audio> element
let playRetryToken = 0;
let animTimer = null;
let animating = false;
let spinnerFrame = 1;
let reelFrame = 0;
let spinnerDir = 1;
let lastSpinnerTick = 0;
let lastAnimTime = 0;
const reelPreload = new Set();

function asset(path) {
  return `assets/audio/${path}`;
}

function spinnerUrl(frame) {
  const n = ((frame - 1 + SPINNER_COUNT * 50) % SPINNER_COUNT) + 1;
  return `assets/spinners-full/spinner-${n}.webp`;
}

function reelUrl(frame) {
  const n = Math.min(REEL_COUNT, Math.max(1, frame));
  return `assets/reels-full/reel-${String(n).padStart(3, '0')}.webp`;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function timeToReelFrame(time) {
  const t = clamp(time, MIN_TIME, MAX_TIME);
  const frame = Math.round(t / REEL_TIME_DIV);
  return clamp(frame < 1 ? 1 : frame, 1, REEL_COUNT);
}

function locateTime(time) {
  let remaining = clamp(time - MIN_TIME, 0, TOTAL_TIME);
  for (let i = 0; i < TRACKS.length; i++) {
    if (remaining < TRACKS[i].duration) return { index: i, offset: remaining };
    remaining -= TRACKS[i].duration;
  }
  const last = TRACKS.length - 1;
  return { index: last, offset: TRACKS[last].duration };
}

function elapsedBefore(index) {
  let elapsed = MIN_TIME;
  for (let i = 0; i < index; i++) elapsed += TRACKS[i].duration;
  return elapsed;
}

function setPressed(action, on) {
  const img = pressMap[action];
  if (img) img.hidden = !on;
}

function clearPressed() {
  Object.keys(pressMap).forEach((k) => setPressed(k, false));
}

// --- Web Audio SFX -----------------------------------------------------------

let audioUnlocked = false;
function unlockSfx() {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (!audioUnlocked) {
    try {
      const b = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
      const s = audioCtx.createBufferSource();
      s.buffer = b;
      s.connect(audioCtx.destination);
      s.start(0);
      audioUnlocked = true;
    } catch (e) {}
  }
}

// Unlock the <audio> element itself. Mobile browsers (both iOS and Android)
// won't let an element play programmatically until it has played once during a
// real user gesture. We prime it on the first touch anywhere: play it muted,
// then pause + reset. After this, play() works on the first real Play tap.
let mediaPrimed = false;
function primeMedia() {
  if (mediaPrimed) return;
  mediaPrimed = true;
  trackAudio.muted = true;
  const p = trackAudio.play();
  if (p && p.then) {
    p.then(() => {
      // Only tear back down if the user hasn't actually started playback in the
      // same gesture (the Play button), so we never cut off real audio.
      if (state !== 'play') {
        trackAudio.pause();
        try { trackAudio.currentTime = 0; } catch (e) {}
      }
      trackAudio.muted = false;
    }).catch(() => {
      trackAudio.muted = false;
      mediaPrimed = false; // let the next gesture try again
    });
  } else {
    trackAudio.muted = false;
  }
}

function fetchArrayBuffer(url, earlyKey) {
  const early = window.__audioEarly;
  if (earlyKey && early && early[earlyKey]) {
    const p = early[earlyKey];
    early[earlyKey] = null;
    return p;
  }
  return fetch(url).then((res) => res.arrayBuffer());
}

async function decodeSfx(name) {
  if (sfxBuffers[name]) return sfxBuffers[name];
  const earlyKey = SFX_EARLY[name] || null;
  const data = await fetchArrayBuffer(asset(SFX[name]), earlyKey);
  const buffer = await audioCtx.decodeAudioData(data);
  sfxBuffers[name] = buffer;
  return buffer;
}

function playUiSfx(name) {
  const buffer = sfxBuffers[name];
  if (!buffer) return;
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(sfxGain);
  src.start(0);
}

function playLoopSfx(name) {
  stopSfx();
  const buffer = sfxBuffers[name];
  if (!buffer) return;
  loopSource = audioCtx.createBufferSource();
  loopSource.buffer = buffer;
  loopSource.loop = true;
  loopSource.connect(sfxGain);
  loopSource.start(0);
}

function stopSfx() {
  if (!loopSource) return;
  try { loopSource.stop(); } catch (e) {}
  loopSource.disconnect();
  loopSource = null;
}

// --- Music (native <audio>) --------------------------------------------------

function setTrackSrc(index) {
  if (currentSrcIndex === index) return;
  currentSrcIndex = index;
  trackAudio.src = asset(TRACKS[index].file);
}

function playMusic(index, offset) {
  trackIndex = index;
  setTrackSrc(index);

  // CRITICAL for mobile: call play() synchronously, right here inside the tap
  // gesture, and make sure it isn't left muted by the priming step.
  trackAudio.muted = false;
  const p = trackAudio.play();
  if (p && p.catch) {
    p.catch(() => {
      // First tap may reject if no data is buffered yet. Retry once the element
      // can play — guarded so a later stop/scrub cancels it.
      const token = ++playRetryToken;
      const retry = () => {
        if (token !== playRetryToken || state !== 'play') return;
        const r = trackAudio.play();
        if (r && r.catch) r.catch(() => {});
      };
      trackAudio.addEventListener('canplay', retry, { once: true });
    });
  }

  // Seeking is separate: currentTime can only be set once metadata exists. For
  // the first play (offset 0) no seek is needed; for resume/scrub we apply it
  // now if ready, otherwise as soon as metadata loads — playback is already
  // running by then.
  const applySeek = () => {
    if (state !== 'play') return;
    if (Math.abs((trackAudio.currentTime || 0) - offset) > 0.2) {
      try { trackAudio.currentTime = offset; } catch (e) {}
    }
  };
  if (offset > 0) {
    if (trackAudio.readyState >= 1) applySeek();
    else trackAudio.addEventListener('loadedmetadata', applySeek, { once: true });
  } else if ((trackAudio.currentTime || 0) > 0.2 && trackAudio.readyState >= 1) {
    try { trackAudio.currentTime = 0; } catch (e) {}
  }

  updateMediaSession();
}

function startMusicAt(time) {
  const pos = locateTime(time);
  playMusic(pos.index, pos.offset);
}

function pauseMusic() {
  syncGlobalTime();
  trackAudio.pause();
  // Note: callers refresh the media session AFTER updating `state`, so the
  // lock-screen shows the correct play/paused icon and stops the seek bar.
}

function syncGlobalTime() {
  if (state === 'play') {
    globalTime = clamp(elapsedBefore(trackIndex) + (trackAudio.currentTime || 0), MIN_TIME, MAX_TIME);
  }
}

// When a track finishes, advance to the next. Native 'ended' is reliable and
// keeps firing in the background, so the album plays through with the screen off.
trackAudio.addEventListener('ended', () => {
  if (state !== 'play') return;
  if (trackIndex < TRACKS.length - 1) {
    const next = trackIndex + 1;
    globalTime = elapsedBefore(next);
    playMusic(next, 0);
  } else {
    state = 'stop';
    stopAnimation();
    setSpinnerFrame(1);
    clearPressed();
    updateMediaSession();
  }
});

// --- Media Session: display-only --------------------------------------------
// Per the client, the phone media player should ONLY show the track title and
// album cover — no working controls. So we set metadata only, report no
// position (no seek bar), and give every transport action an inert handler so
// play, pause, next, previous and seek all do nothing.

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    const t = TRACKS[trackIndex];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: 'Jude Pascal',
      album: 'Today is the Day',
      artwork: [
        { src: new URL('assets/cover.jpg', location.href).href, sizes: '512x512', type: 'image/jpeg' },
      ],
    });
    navigator.mediaSession.playbackState = state === 'play' ? 'playing' : 'paused';
  } catch (e) {}
}

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const noop = () => {};
  const setH = (action, fn) => { try { ms.setActionHandler(action, fn); } catch (e) {} };
  // Inert handlers — controls are shown by the OS but do nothing.
  setH('play', noop);
  setH('pause', noop);
  setH('previoustrack', null);
  setH('nexttrack', null);
  setH('seekbackward', null);
  setH('seekforward', null);
  setH('seekto', null);
}

// --- Visuals -----------------------------------------------------------------

function warmReelFrames(center) {
  for (let offset = -6; offset <= 10; offset++) {
    const frame = center + offset;
    if (frame < 1 || frame > REEL_COUNT || reelPreload.has(frame)) continue;
    reelPreload.add(frame);
    const img = new Image();
    img.decoding = 'async';
    img.src = reelUrl(frame);
  }
}

function setSpinnerFrame(frame) {
  const next = ((frame - 1 + SPINNER_COUNT * 50) % SPINNER_COUNT) + 1;
  if (next === spinnerFrame && spinnerFrames[next - 1] && spinnerFrames[next - 1].classList.contains('is-active')) return;
  spinnerFrame = next;
  for (let i = 0; i < spinnerFrames.length; i++) {
    spinnerFrames[i].classList.toggle('is-active', i === spinnerFrame - 1);
  }
}

function setReelFrame(frame) {
  if (reelFrame === frame) return;
  reelFrame = frame;
  warmReelFrames(frame);
  reelA.src = reelUrl(frame);
}

function updateReelForTime() {
  if (state === 'play' && globalTime <= REEL_TIME_DIV) {
    setReelFrame(1);
  } else {
    setReelFrame(timeToReelFrame(globalTime));
  }
}

function advanceSpinner(step) {
  let next = spinnerFrame + spinnerDir * step;
  while (next < 1) next += SPINNER_COUNT;
  while (next > SPINNER_COUNT) next -= SPINNER_COUNT;
  setSpinnerFrame(next);
}

function isScrubbing() {
  return state === 'rewind' || state === 'ff';
}

function tickAnimation(now) {
  if (!animating) return;

  if (!lastAnimTime) lastAnimTime = now;
  const dt = Math.min((now - lastAnimTime) / 1000, 0.05);
  lastAnimTime = now;

  const fast = isScrubbing();
  const spinnerStep = fast ? 2 : 1;

  if (now - lastSpinnerTick >= SPINNER_MS) {
    advanceSpinner(spinnerStep);
    lastSpinnerTick = now;
  }

  if (state === 'rewind') {
    globalTime = clamp(globalTime - SCRUB_RATE * dt, MIN_TIME, MAX_TIME);
    if (globalTime <= MIN_TIME) stopScrub();
  } else if (state === 'ff') {
    globalTime = clamp(globalTime + SCRUB_RATE * dt, MIN_TIME, MAX_TIME);
    if (globalTime >= MAX_TIME) stopScrub();
  } else if (state === 'play') {
    syncGlobalTime();
  }

  updateReelForTime();
  animTimer = requestAnimationFrame(tickAnimation);
}

function startAnimation(direction) {
  animating = true;
  spinnerDir = direction;
  lastSpinnerTick = performance.now();
  lastAnimTime = performance.now();
  setSpinnerFrame(spinnerFrame);
  updateReelForTime();
  if (animTimer) cancelAnimationFrame(animTimer);
  animTimer = requestAnimationFrame(tickAnimation);
}

function stopAnimation() {
  animating = false;
  if (animTimer) cancelAnimationFrame(animTimer);
  animTimer = null;
  lastAnimTime = 0;
  updateReelForTime();
}

// --- Controls ----------------------------------------------------------------

function stopScrub() {
  if (!isScrubbing()) return;
  stopSfx();
  state = 'stop';
  updateMediaSession();
  clearPressed();
  stopAnimation();
}

function startScrub(action) {
  if (action === 'rewind' && globalTime <= MIN_TIME) return;
  if (action === 'ff' && globalTime >= MAX_TIME) return;
  if (state === action) return;

  pauseMusic();
  stopSfx();
  state = action;
  updateMediaSession();
  clearPressed();
  setPressed(action, true);
  playUiSfx(action === 'rewind' ? 'rewindPress' : 'ffPress');
  playLoopSfx(action === 'rewind' ? 'rewindLoop' : 'ffLoop');
  startAnimation(action === 'rewind' ? -1 : 1);
}

function onPlay() {
  if (globalTime >= MAX_TIME) return;
  if (state === 'play') return;
  unlockSfx();
  stopSfx();
  clearPressed();
  setPressed('play', true);
  state = 'play';
  startMusicAt(globalTime);
  playUiSfx('play');
  startAnimation(1);
}

function onStop() {
  unlockSfx();
  stopSfx();
  pauseMusic();
  state = 'stop';
  updateMediaSession();
  clearPressed();
  setPressed('stop', true);
  playUiSfx('stop');
  stopAnimation();
  setTimeout(() => setPressed('stop', false), 250);
}

function bindButton(action, handler) {
  const btn = document.querySelector(`[data-action="${action}"]`);
  if (!btn) return;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handler();
  });
}

bindButton('play', onPlay);
bindButton('stop', onStop);
bindButton('rewind', () => startScrub('rewind'));
bindButton('ff', () => startScrub('ff'));

// Unlock BOTH audio systems at the first moment of any interaction (capture
// phase runs before the button's own handler, so the <audio> element is primed
// by the time the Play tap's handler calls play()).
function unlockAll() {
  unlockSfx();
  primeMedia();
}
['pointerdown', 'touchstart', 'mousedown', 'click', 'keydown'].forEach((evt) => {
  document.addEventListener(evt, unlockAll, { capture: true, passive: true });
});

// --- Preload -----------------------------------------------------------------

function preloadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = () => {
      if (img.decode) img.decode().then(resolve, resolve);
      else resolve();
    };
    img.src = url;
  });
}

async function preloadEverything() {
  setReelFrame(1);
  setSpinnerFrame(1);

  // Reveal the player only once its core layers are decoded, so it appears
  // complete instead of popping in piece by piece (body, reel, spinner).
  const coreImages = [
    preloadImage('assets/player.webp'),
    preloadImage(reelUrl(1)),
  ];
  for (let i = 1; i <= SPINNER_COUNT; i++) coreImages.push(preloadImage(spinnerUrl(i)));
  Promise.all(coreImages).then(() => playerEl.classList.add('is-ready'));
  setTimeout(() => playerEl.classList.add('is-ready'), 4000);

  // Start buffering track 1 right away so it's ready before the first tap
  // (mobile browsers ignore preload="auto", so we nudge it explicitly).
  try { trackAudio.load(); } catch (e) {}

  // Decode click SFX up front so button feedback is instant.
  decodeSfx('play');
  decodeSfx('stop');
  decodeSfx('rewindPress');
  decodeSfx('ffPress');

  // Opening reel frames for a smooth start.
  for (let i = 1; i <= 12; i++) preloadImage(reelUrl(i));

  // Background: loop SFX (for scrubbing) + remaining reel frames.
  decodeSfx('rewindLoop');
  decodeSfx('ffLoop');

  const warmRest = () => {
    for (let i = 13; i <= REEL_COUNT; i++) {
      if (reelPreload.has(i)) continue;
      reelPreload.add(i);
      const img = new Image();
      img.decoding = 'async';
      img.src = reelUrl(i);
    }
  };
  if ('requestIdleCallback' in window) requestIdleCallback(warmRest, { timeout: 5000 });
  else setTimeout(warmRest, 2000);
}

preloadEverything();
