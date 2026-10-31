/**
 * Ten-second skippable rebirth intro: old-world death → The Source → rebirth in Bellgrave.
 * Native DOM + CSS + Web Animations over the existing generated art; no engine, no network calls
 * beyond those images (and an MP4 only when `options.videoUrl` is supplied by the caller).
 *
 * Contract: call only after an explicit Play click. `onDone` fires exactly once (auto at 10 s, video
 * end, Skip button or Escape). The returned cleanup cancels everything WITHOUT calling `onDone`.
 * This module never joins, opens the mic, or starts the game itself.
 */
const DURATION_MS = 10_000;
const P = 'rbx-intro'; // scoped class prefix; nothing global is styled

interface Beat { art: string; kicker: string; title: string; line: string; tint: string; filter: string }

const BEATS: Beat[] = [
  {
    art: '/generated/screens/02-crimson-chapel-showdown.png',
    kicker: 'The old world',
    title: 'You died.',
    line: 'A bell tolled once, and the dark took you.',
    tint: 'rgba(120, 8, 12, 0.55)',
    filter: 'grayscale(0.55) brightness(0.55) contrast(1.1)',
  },
  {
    art: '/generated/project-cover.png',
    kicker: 'Between worlds',
    title: 'The Source',
    line: 'Four lights answered. Their power will find you when you need it.',
    tint: 'rgba(30, 60, 140, 0.35)',
    filter: 'brightness(0.8) saturate(1.1)',
  },
  {
    art: '/generated/screens/03-pumpkin-festival-clash.png',
    kicker: 'Reborn',
    title: 'Bellgrave',
    line: 'The dead here remember. Hunt them, and be remembered.',
    tint: 'rgba(160, 90, 10, 0.25)',
    filter: 'brightness(0.85) saturate(1.05)',
  },
];

const CSS = `
.${P}{position:fixed;inset:0;z-index:10000;background:#050409;overflow:hidden;font-family:Georgia,'Times New Roman',serif;color:#f6e6c2;}
.${P} .${P}-art{position:absolute;inset:-4%;background-size:cover;background-position:center;opacity:0;will-change:transform,opacity;}
.${P} .${P}-tint{position:absolute;inset:0;opacity:0;pointer-events:none;}
.${P} .${P}-vig{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 40%,rgba(0,0,0,0.78) 100%);}
.${P} .${P}-text{position:absolute;left:0;right:0;bottom:16%;text-align:center;opacity:0;padding:0 6vw;text-shadow:0 2px 18px rgba(0,0,0,0.9);}
.${P} .${P}-kicker{font-size:clamp(12px,1.4vw,18px);letter-spacing:0.42em;text-transform:uppercase;color:#9fc4ff;}
.${P} .${P}-title{font-size:clamp(40px,7vw,96px);letter-spacing:0.08em;margin:0.15em 0;color:#f2c76b;}
.${P} .${P}-line{font-size:clamp(15px,1.8vw,24px);font-style:italic;color:#f1dcc0;}
.${P} video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;}
.${P} .${P}-skip{position:absolute;right:24px;bottom:24px;z-index:2;padding:10px 18px;font:600 14px/1 system-ui,sans-serif;letter-spacing:0.08em;color:#f6e6c2;background:rgba(10,8,16,0.72);border:1px solid rgba(242,199,107,0.7);border-radius:6px;cursor:pointer;}
.${P} .${P}-skip:hover,.${P} .${P}-skip:focus-visible{background:rgba(120,20,20,0.75);outline:2px solid #f2c76b;outline-offset:2px;}
.${P} .${P}-bar{position:absolute;left:0;bottom:0;height:3px;width:100%;background:linear-gradient(90deg,#8c1010,#f2c76b,#67c7ff);transform-origin:left;transform:scaleX(0);}
`;

export function startRebirthIntro(onDone: () => void, options?: { videoUrl?: string }): () => void {
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const doc = document;
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.appendChild(style);

  const root = doc.createElement('div');
  root.className = P;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Rebirth intro');
  const animations: Animation[] = [];
  let video: HTMLVideoElement | null = null;
  let finished = false;
  let timer = 0;

  const teardown = () => {
    window.clearTimeout(timer);
    doc.removeEventListener('keydown', onKey, true);
    for (const a of animations) a.cancel();
    animations.length = 0;
    if (video) {
      video.onended = null;
      video.onerror = null;
      video.pause();
      video.removeAttribute('src');
      video.load(); // detaches the media resource
      video = null;
    }
    root.remove();
    style.remove();
  };
  /** Ends the intro and reports completion (once). */
  const complete = () => {
    if (finished) return;
    finished = true;
    teardown();
    onDone();
  };
  /** Cancels without onDone (caller left / unmounted). */
  const cancel = () => {
    if (finished) return;
    finished = true;
    teardown();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      complete();
    }
  };

  const animate = (el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) => {
    if (typeof el.animate !== 'function') return; // very old browsers: static layout, timer still finishes
    animations.push(el.animate(frames, { fill: 'forwards', ...opts }));
  };

  const playArt = () => {
    const slot = DURATION_MS / BEATS.length;
    BEATS.forEach((beat, i) => {
      const start = i * slot;
      const last = i === BEATS.length - 1;
      const art = doc.createElement('div');
      art.className = `${P}-art`;
      art.style.backgroundImage = `url("${beat.art}")`;
      art.style.filter = beat.filter;
      const tint = doc.createElement('div');
      tint.className = `${P}-tint`;
      tint.style.background = beat.tint;
      const text = doc.createElement('div');
      text.className = `${P}-text`;
      const kicker = doc.createElement('div');
      kicker.className = `${P}-kicker`;
      kicker.textContent = beat.kicker;
      const title = doc.createElement('div');
      title.className = `${P}-title`;
      title.textContent = beat.title;
      const line = doc.createElement('div');
      line.className = `${P}-line`;
      line.textContent = beat.line;
      text.append(kicker, title, line);
      root.append(art, tint, text);

      const fadeIn = 700;
      const fadeOut = last ? 500 : 700;
      const show: Keyframe[] = [
        { opacity: 0, offset: 0 },
        { opacity: 1, offset: fadeIn / (slot + 400) },
        { opacity: 1, offset: 1 - fadeOut / (slot + 400) },
        { opacity: 0, offset: 1 },
      ];
      const dur = slot + 400; // slight overlap = crossfade between beats
      const delay = Math.max(0, start - 200);
      animate(art, show, { duration: dur, delay, easing: 'ease-in-out' });
      animate(tint, show.map((k) => ({ ...k, opacity: (k.opacity as number) * 0.9 })), { duration: dur, delay });
      if (!reduced) {
        // Slow push-in / drift; reduced motion keeps only the soft fades.
        const drift = i === 0 ? ['scale(1.12) translateY(-1%)', 'scale(1.02) translateY(1%)'] : i === 1 ? ['scale(1.0)', 'scale(1.1)'] : ['scale(1.1) translateX(1%)', 'scale(1.0) translateX(-1%)'];
        animate(art, [{ transform: drift[0] }, { transform: drift[1] }], { duration: dur, delay, easing: 'linear' });
        animate(text, [
          { opacity: 0, transform: 'translateY(14px)' },
          { opacity: 1, transform: 'translateY(0)', offset: 0.3 },
          { opacity: 1, transform: 'translateY(0)', offset: 0.8 },
          { opacity: 0, transform: 'translateY(-6px)' },
        ], { duration: slot - 150, delay: start + 250, easing: 'ease-out' });
      } else {
        animate(text, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: slot - 150, delay: start + 250 });
      }
    });
  };

  if (options?.videoUrl) {
    const v = doc.createElement('video');
    video = v;
    v.src = options.videoUrl;
    v.playsInline = true;
    v.preload = 'auto';
    v.onended = () => complete();
    /** Detach the MP4 and switch to the art sequence; the 10 s timer is already running. */
    const fallBack = () => {
      if (video !== v || finished) return;
      v.onended = null;
      v.onerror = null;
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.remove();
      video = null;
      playArt();
    };
    v.onerror = fallBack;
    root.appendChild(v);
    const tryPlay = (): Promise<void> => {
      try {
        return Promise.resolve(v.play());
      } catch (err) {
        return Promise.reject(err);
      }
    };
    // Called right after the Play click, so audio usually works; if autoplay policy still
    // rejects, retry once muted, then fall back to the animated art.
    tryPlay().catch(() => {
      if (video !== v || finished) return;
      v.muted = true;
      return tryPlay().catch(fallBack);
    });
  } else {
    playArt();
  }

  const vig = doc.createElement('div');
  vig.className = `${P}-vig`;
  const bar = doc.createElement('div');
  bar.className = `${P}-bar`;
  const skip = doc.createElement('button');
  skip.type = 'button';
  skip.className = `${P}-skip`;
  skip.textContent = 'Skip ⏵ Esc';
  skip.setAttribute('aria-label', 'Skip intro');
  skip.addEventListener('click', (e) => {
    e.stopPropagation();
    complete();
  });
  root.append(vig, bar, skip);
  doc.body.appendChild(root);
  animate(bar, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: DURATION_MS, easing: 'linear' });

  doc.addEventListener('keydown', onKey, true);
  timer = window.setTimeout(complete, DURATION_MS); // hard cap, including the MP4 path
  try {
    skip.focus({ preventScroll: true });
  } catch {
    /* focus is best-effort */
  }
  return cancel;
}
