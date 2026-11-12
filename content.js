/*
 * Serotonin for Twitter - content script
 *
 * 方針:
 *  - Xの本物のDOMをそのまま使う（クローンせえへんから、いいね・RP・リプ・画像クリックも普通に効く）
 *  - 今のカード以外の cellInnerDiv を透明化して、ページスクロールはこっちが1枚ずつ制御する
 *  - Xのタイムラインは仮想リストやから、スクロールで読み込み・描画させつつカードを切り替えるで
 */
(() => {
  'use strict';
  if (window.__tcsLoaded) return;
  window.__tcsLoaded = true;

  const DEFAULTS = { enabled: true, animation: 'slide-x' };
  const SEL = {
    column: '[data-testid="primaryColumn"]',
    cell: '[data-testid="cellInnerDiv"]',
    tweet: 'article[data-testid="tweet"]',
    bottomBar: '[data-testid="BottomBar"]',
  };
  const ATTR_CUR = 'data-tcs-current';
  const ATTR_ANIM = 'data-tcs-anim';
  const ATTR_HIDE = 'data-tcs-hide';
  const ATTR_FLOAT = 'data-tcs-float';
  const ATTR_PATH = 'data-tcs-path';
  const ATTR_INNER = 'data-tcs-inner';
  const GAP = 12; // ヘッダーとカードの隙間
  const HUD_SPACE = 72; // 画面下の操作バー分の余白
  const MIN_CARD_HEIGHT = 16; // これ未満の高さのセルはカードとして扱わない
  const root = document.documentElement;
  const store = globalThis.chrome?.storage;

  let settings = { ...DEFAULTS };
  const st = {
    active: false,
    current: null,
    lastCard: null,
    href: location.href,
    loading: false,
    programmaticUntil: 0,
    lastStepAt: 0,
    lastAlignAt: 0,
    header: { value: 0, at: -1e9 },
    scrollTimer: 0,
    roRaf: 0,
    wheel: { busy: null, dir: 0, accum: 0, lastAbs: 0, timer: 0 },
    touch: null,
    themeKey: '',
    topPad: 0, // タイムライン上端に足した余白(px)
  };
  const now = () => performance.now();

  /* ------------------------------------------------------------------ */
  /* 設定                                                               */
  /* ------------------------------------------------------------------ */
  function loadSettings() {
    return new Promise((resolve) => {
      if (!store?.sync) return resolve();
      try {
        store.sync.get(DEFAULTS, (v) => {
          settings = { ...DEFAULTS, ...(v || {}) };
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }
  function saveSettings(patch) {
    settings = { ...settings, ...patch };
    try { store?.sync?.set(patch); } catch { /* 拡張がリロードされた後とかは無視や */ }
    applySettings();
  }
  function applySettings() {
    root.setAttribute('data-tcs-style', settings.animation);
    hud.setAxis(settings.animation === 'slide-x' ? 'x' : 'y');
    evaluate();
  }
  try {
    store?.onChanged?.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const [k, { newValue }] of Object.entries(changes)) {
        if (k in DEFAULTS) settings[k] = newValue ?? DEFAULTS[k];
      }
      applySettings();
    });
  } catch { /* noop */ }

  /* ------------------------------------------------------------------ */
  /* DOM ヘルパー                                                        */
  /* ------------------------------------------------------------------ */
  const column = () => document.querySelector(SEL.column);
  const hasCards = () => !!column()?.querySelector(`${SEL.cell} ${SEL.tweet}`);
  const modalOpen = () => !!document.querySelector('[aria-modal="true"]');
  const isTyping = (el) =>
    !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]');

  function eligiblePath() {
    const p = location.pathname;
    if (/\/status\/\d+/.test(p)) return false; // 個別ポスト画面は普通に読ませる
    if (/^\/(messages|settings|compose|notifications|i\/flow|i\/chat|i\/grok|login|logout|jobs)(\/|$)/.test(p)) return false;
    return true;
  }

  /** タイムライン上のポストを含むセルを、ドキュメント座標の上から順に返す */
  function getCards() {
    const col = column();
    if (!col) return [];
    const sy = window.scrollY;
    const out = [];
    for (const el of col.querySelectorAll(SEL.cell)) {
      if (!el.querySelector(SEL.tweet)) continue;
      const r = el.getBoundingClientRect();
      // 広告セルは article を持ったまま高さ 1px に潰れる。表示できないため対象から除く
      if (r.height < MIN_CARD_HEIGHT) continue;
      out.push({ el, top: r.top + sy, bottom: r.bottom + sy });
    }
    return out.sort((a, b) => a.top - b.top);
  }

  const docTop = (el) => el.getBoundingClientRect().top + window.scrollY;

  function findNeighbor(fromTop, dir) {
    const cards = getCards();
    if (dir > 0) return cards.find((c) => c.top > fromTop + 2)?.el || null;
    let t = null;
    for (const c of cards) {
      if (c.top < fromTop - 2) t = c.el;
      else break;
    }
    return t;
  }

  /** カラム上部の sticky ヘッダー（「おすすめ / フォロー中」タブとか）の下端を測る */
  function measureHeader() {
    const col = column();
    if (!col) return 0;
    let best = 0;
    let count = 0;
    const queue = [[col, 0]];
    while (queue.length && count < 400) {
      const [node, depth] = queue.shift();
      for (const child of node.children) {
        count++;
        if (child.tagName === 'SECTION' || child.matches(SEL.cell)) continue;
        const pos = getComputedStyle(child).position;
        if (pos === 'sticky' || pos === 'fixed') {
          const r = child.getBoundingClientRect();
          if (r.top <= 2 && r.bottom > 0 && r.height < window.innerHeight / 2) best = Math.max(best, r.bottom);
          continue;
        }
        if (depth < 8) queue.push([child, depth + 1]);
      }
    }
    return best;
  }

  /**
   * 画面下端に固定された BottomBar の高さを返す。
   * display:none の要素は矩形が全て 0 になり top=0 が画面全体の高さとして計算されるため、高さ 0 は不在として扱う
   */
  function footerHeight() {
    const r = document.querySelector(SEL.bottomBar)?.getBoundingClientRect();
    return r?.height ? Math.max(0, window.innerHeight - r.top) : 0;
  }

  /** カードを置ける縦の範囲（ビューポート座標） */
  function bounds() {
    const t = now();
    if (t - st.header.at > 1500) st.header = { value: measureHeader(), at: t };
    const footer = footerHeight();
    const top = st.header.value + GAP;
    const bottom = window.innerHeight - footer - HUD_SPACE;
    return { top, bottom, avail: Math.max(120, bottom - top), footer };
  }

  /* ------------------------------------------------------------------ */
  /* ポスト以外の要素の非表示                                              */
  /* ------------------------------------------------------------------ */
  // Xの要素は React が管理しており DOM から取り除くと再描画が破綻するため、属性を付けて CSS の display:none で非表示にする
  let hiddenEls = new Set();
  let pathEls = new Set();
  let innerEls = new Set();

  /** #layers はモーダル・メニュー・トーストの描画先のため、それを含む要素は非表示にしない */
  function mustKeep(el, layers) {
    return el.id === 'tcs-hud' || el.matches('script, style, link') || (!!layers && el.contains(layers));
  }

  function syncAttr(prev, next, attr) {
    for (const el of prev) if (!next.has(el)) el.removeAttribute(attr);
    for (const el of next) if (!prev.has(el)) el.setAttribute(attr, '');
    return next;
  }

  /* 右下フローティング（DM/Grok等）を隠す。Xは本体の外にfixed枠を残すため、
     既知testidから外側へ登って最小の枠ごと data-tcs-float + inline非表示にする。
     CSSだけではinline !importantに負けるためJSで直接display:noneを当てる。
     React再描画で消えるため evaluate/tick のたびに付け直す */
  function hideEl(el) {
    try {
      el.setAttribute(ATTR_FLOAT, '');
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('opacity', '0', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
    } catch { /* noop */ }
  }
  function clearFloaters() {
    for (const el of document.querySelectorAll(`[${ATTR_FLOAT}]`)) {
      el.removeAttribute(ATTR_FLOAT);
      try {
        el.style.removeProperty('display');
        el.style.removeProperty('visibility');
        el.style.removeProperty('opacity');
        el.style.removeProperty('pointer-events');
      } catch { /* noop */ }
    }
  }
  function tagFloaters() {
    if (!st.active) return;
    const main = document.querySelector('main');
    const col = column();
    // ユーザー報告の実DOM位置を直接隠す（testidなしの素div対策）。位置がずれても外側のfixed枠ごと消す。
    try {
      const xp = "/html/body/div[1]/div/div/div[1]/div/div[2]/div";
      const node = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (node instanceof Element) {
        const r0 = node.getBoundingClientRect();
        const atCorner = r0.right >= window.innerWidth - 300 && r0.bottom > window.innerHeight - 500;
        const small = r0.width <= 460 && r0.height <= 560;
        const txt = (node.textContent || '').slice(0, 200);
        const looksDM = /\u30e1\u30c3\u30bb\u30fc\u30b8|Messages|\u65b0\u3057\u3044\u30e1\u30c3\u30bb\u30fc\u30b8/i.test(txt) ||
          !!node.querySelector?.('[data-testid*="DM" i], [data-testid*="Message" i], a[href^="/messages"]');
        if ((atCorner && small) || looksDM) {
          hideEl(node);
          let cur = node;
          for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
            try { if (getComputedStyle(cur).position === 'fixed') { hideEl(cur); break; } } catch { /* noop */ }
            const r = cur.getBoundingClientRect();
            if (r.width && r.height && r.width <= 420 && r.height <= 520) hideEl(cur);
            cur = cur.parentElement;
            if (cur?.id === 'react-root') break;
          }
        }
      }
    } catch { /* noop */ }
    const skipSel = '#tcs-hud, [data-testid="primaryColumn"], [data-testid="sidebarColumn"], header[role="banner"], [role="dialog"], [aria-modal="true"]';
    let known;
    try {
      known = document.querySelectorAll(
        '[data-testid="DMDrawer"], [data-testid="DMDrawerHeader"], [data-testid="GrokDrawer"],' +
        'a[href="/messages"], a[href^="/messages/"],' +
        '[aria-label="Messages"], [aria-label="\u30e1\u30c3\u30bb\u30fc\u30b8"],' +
        '[data-testid*="DMDrawer" i], [data-testid*="GrokDrawer" i], [data-testid*="MessagesDock" i]'
      );
    } catch { known = []; }
    for (const el of known) {
      try { if (el.closest(skipSel)) continue; } catch { /* noop */ }
      hideEl(el);
      let target = el;
      let cur = el.parentElement;
      for (let i = 0; i < 8 && cur && cur !== document.body && cur !== document.documentElement; i++) {
        try {
          if (cur.id === 'react-root' || (main && cur.contains(main))) break;
          if (cur.closest?.('[data-testid="primaryColumn"]')) break;
        } catch { break; }
        const r = cur.getBoundingClientRect();
        if (r.width > 420 || r.height > 500) break;
        target = cur;
        try { if (getComputedStyle(cur).position === 'fixed') break; } catch { /* noop */ }
        cur = cur.parentElement;
      }
      hideEl(target);
    }
    // 位置ベースの保険: 右下にfixedで居座る小さな箱を隠す
    try {
      if (!main) return;
      for (const el of document.body.querySelectorAll('button, a, [role="button"], [data-testid]')) {
        try { if (el.closest('#tcs-hud, [data-testid="primaryColumn"], [data-testid="sidebarColumn"], header[role="banner"], [role="dialog"], [aria-modal="true"], [data-tcs-float]')) continue; } catch { continue; }
        let fixed = null;
        let n = el;
        for (let i = 0; i < 6 && n && n !== document.body; i++) {
          try { if (getComputedStyle(n).position === 'fixed') { fixed = n; break; } } catch { /* noop */ }
          n = n.parentElement;
        }
        if (!fixed) continue;
        try { if (fixed.contains(main)) continue; } catch { /* noop */ }
        try { if (col && fixed.contains(col)) continue; } catch { /* noop */ }
        const r = fixed.getBoundingClientRect();
        if (!r.width || !r.height || r.width > 380 || r.height > 450) continue;
        if (r.right < window.innerWidth - 160) continue;
        if (!(r.bottom > window.innerHeight - 420)) continue;
        hideEl(fixed);
      }
    } catch { /* noop */ }
  }
  // DevTools用: コンソールで __tcsFloatDebug() を呼ぶと右下候補の一覧が出る
  try {
    window.__tcsFloatDebug = () => {
      const out = [];
      for (const el of document.querySelectorAll('[data-testid], a[href^="/messages"], button, [role="button"]')) {
        try {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          if (r.right < window.innerWidth - 300) continue;
          if (!(r.bottom > window.innerHeight - 500)) continue;
          out.push({
            tag: el.tagName,
            testid: el.getAttribute('data-testid'),
            aria: el.getAttribute('aria-label'),
            href: el.getAttribute?.('href'),
            text: (el.textContent || '').slice(0, 40),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            fixed: (() => { let n = el; for (let i = 0; i < 6 && n; i++) { try { if (getComputedStyle(n).position === 'fixed') return n.tagName + '.' + (n.className || '').toString().slice(0, 40); } catch { /* noop */ } n = n.parentElement; } return ''; })(),
          });
        } catch { /* noop */ }
      }
      console.table(out);
      return out;
    };
  } catch { /* noop */ }

  /**
   * タイムラインのセル群から #react-root までの祖先経路を求め、経路上にない兄弟要素を全て非表示にする。
   * 経路上の祖先には ATTR_PATH を付け、左右のカラムが消えた分の幅をタイムラインの中央寄せに使う。
   * セル群から primaryColumn までの間の要素には ATTR_INNER を付け、横幅の上限を外す。
   * 非アクティブ時は空集合と同期し、付けた属性を全て外す
   */
  function isolateTimeline() {
    const hide = new Set();
    const path = new Set();
    const inner = new Set();
    const col = column();
    const cell = st.active ? col?.querySelector(SEL.cell) : null;
    const stop = document.getElementById('react-root') || document.body;
    if (cell && stop.contains(cell)) {
      const layers = document.getElementById('layers');
      for (let n = cell.parentElement; n !== stop; n = n.parentElement) {
        for (const sib of n.parentElement.children) {
          if (sib !== n && !mustKeep(sib, layers)) hide.add(sib);
        }
      }
      for (let n = col.parentElement; n && n !== stop; n = n.parentElement) path.add(n);
      for (let n = cell.parentElement; n && n !== col; n = n.parentElement) inner.add(n);
    }
    const changed = hide.size !== hiddenEls.size || [...hide].some((el) => !hiddenEls.has(el));
    hiddenEls = syncAttr(hiddenEls, hide, ATTR_HIDE);
    pathEls = syncAttr(pathEls, path, ATTR_PATH);
    innerEls = syncAttr(innerEls, inner, ATTR_INNER);
    if (changed) {
      // 非表示にした要素の分だけカードの位置とヘッダー高さが変わるため、計測値を破棄して再配置させる
      st.header.at = -1e9;
      st.lastAlignAt = 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /* スクロール & 配置                                                    */
  /* ------------------------------------------------------------------ */
  function scrollByY(dy) {
    if (Math.abs(dy) < 0.5) return;
    st.programmaticUntil = Math.max(st.programmaticUntil, now() + 250);
    window.scrollTo({ top: window.scrollY + dy, behavior: 'instant' });
  }

  /** タイムライン上端の余白を設定する（最上段のポストを中央に置くため） */
  function setTopPad(px) {
    st.topPad = Math.max(0, Math.round(px));
    if (st.topPad) root.style.setProperty('--tcs-top-pad', `${st.topPad}px`);
    else root.style.removeProperty('--tcs-top-pad');
  }

  /**
   * dy だけスクロールする。scrollY が 0 を下回る分（最上段のポストを中央へ置くのに足りない分）は、
   * タイムライン上端に余白を足して賄う
   */
  function scrollWithRoom(dy) {
    const missing = -(window.scrollY + dy);
    if (missing > 0.5) {
      setTopPad(st.topPad + missing);
      dy += missing; // 余白の分だけカードが下がるので、必要なスクロール量も同じだけ減る
    }
    scrollByY(dy);
  }

  /** 収まるカードは中央寄せ、デカいカードは上端（戻るときは下端）合わせ */
  function align(el, mode = 'top') {
    const r = el.getBoundingClientRect();
    const b = bounds();
    let dy;
    if (r.height <= b.avail) dy = r.top - (b.top + (b.avail - r.height) / 2);
    else if (mode === 'bottom') dy = r.bottom - b.bottom;
    else dy = r.top - b.top;
    scrollWithRoom(dy);
    st.lastAlignAt = now();
  }

  /** 画像の読み込みとかでズレたら静かに直す（ユーザーの縦長カード内スクロールは邪魔せん） */
  function keepAligned() {
    if (!st.active || st.loading || st.wheel.busy) return;
    const t = now();
    if (t - st.lastAlignAt < 250 || t - st.lastStepAt < 250) return;
    const el = st.current;
    if (!el?.isConnected) return pickInitial();
    const r = el.getBoundingClientRect();
    const b = bounds();
    if (r.bottom < 0 || r.top > window.innerHeight) return pickInitial();
    if (r.height <= b.avail) {
      const want = b.top + (b.avail - r.height) / 2;
      if (Math.abs(r.top - want) > 3) scrollWithRoom(r.top - want);
    } else if (r.top > b.top + 2) {
      scrollByY(r.top - b.top);
    } else if (r.bottom < b.bottom - 2) {
      scrollByY(r.bottom - b.bottom);
    }
  }

  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(st.roRaf);
    st.roRaf = requestAnimationFrame(() => {
      st.lastAlignAt = 0;
      keepAligned();
    });
  });

  /* ------------------------------------------------------------------ */
  /* カード切り替え                                                       */
  /* ------------------------------------------------------------------ */
  function clearCurrent() {
    if (st.current) st.lastCard = st.current;
    st.current?.removeAttribute(ATTR_CUR);
    st.current = null;
    ro.disconnect();
  }

  function setCurrent(el, dir = 0) {
    if (st.current && st.current !== el) st.current.removeAttribute(ATTR_CUR);
    st.current = el;
    el.setAttribute(ATTR_CUR, '');
    ro.disconnect();
    ro.observe(el);
    align(el, dir < 0 ? 'bottom' : 'top');
    playAnim(el, dir);
    focusCard(el);
    hud.update();
  }

  function playAnim(el, dir) {
    const t = el.firstElementChild;
    if (!t) return;
    t.removeAttribute(ATTR_ANIM);
    void t.offsetWidth; // アニメ再生し直しのためのリフローや
    t.setAttribute(ATTR_ANIM, dir > 0 ? 'next' : dir < 0 ? 'prev' : 'enter');
    t.addEventListener('animationend', () => t.removeAttribute(ATTR_ANIM), { once: true });
  }

  /** article にフォーカスを渡すと、Xの L(いいね) / R(リプ) / T(RP) / Enter がこのカードに効く */
  function focusCard(el) {
    const a = el.querySelector(SEL.tweet);
    const active = document.activeElement;
    if (!a || a.contains(active) || isTyping(active)) return;
    const y = window.scrollY;
    a.focus({ preventScroll: true });
    if (Math.abs(window.scrollY - y) > 1) scrollByY(y - window.scrollY);
  }

  /** 今いちばん見えとるカードを選ぶ */
  function pickInitial() {
    const cards = getCards();
    if (!cards.length) return clearCurrent();
    const b = bounds();
    const sy = window.scrollY;
    const vt = sy + b.top;
    const vb = sy + b.bottom;
    const center = (vt + vb) / 2;
    let best = cards[0];
    let bestScore = -Infinity;
    for (const c of cards) {
      const vis = Math.min(c.bottom, vb) - Math.max(c.top, vt);
      // 見えとる割合が主、同点なら画面中央に近い方。前に選んどったカードはちょい優遇
      const frac = vis / Math.min(c.bottom - c.top, b.avail);
      const dist = Math.abs((c.top + c.bottom) / 2 - center) / window.innerHeight;
      const score = Math.round(frac * 20) / 20 - dist * 0.1 + (c.el === st.lastCard ? 0.06 : 0);
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    setCurrent(best.el, 0);
  }

  function go(dir) {
    if (st.loading) return;
    const cur = st.current;
    if (!cur?.isConnected) return pickInitial();
    const from = docTop(cur);
    const target = findNeighbor(from, dir);
    if (target) return setCurrent(target, dir);
    fetchBeyond(dir, from);
  }

  /** 隣のカードがまだDOMに無い → 一旦スクロールしてXに読み込ませる */
  async function fetchBeyond(dir, from) {
    if (dir < 0 && window.scrollY <= 0) return hud.flash('先頭のポストです');
    const cur = st.current;
    st.loading = true;
    hud.update();
    st.programmaticUntil = now() + 6000;
    scrollByY(dir * window.innerHeight);
    const target = await waitFor(() => findNeighbor(from, dir), dir > 0 ? 5000 : 900);
    st.loading = false;
    st.programmaticUntil = now() + 250;
    if (!st.active) return;
    if (target) {
      setCurrent(target, dir);
    } else {
      if (cur?.isConnected) align(cur, dir > 0 ? 'bottom' : 'top');
      else pickInitial();
      hud.flash(dir > 0 ? '続きを読み込めませんでした' : '先頭のポストです');
    }
    hud.update();
  }

  function waitFor(fn, timeout) {
    return new Promise((resolve) => {
      const started = now();
      const check = () => {
        const v = fn();
        if (v || now() - started > timeout) {
          clearInterval(iv);
          resolve(v || null);
        }
      };
      const iv = setInterval(check, 100);
    });
  }

  /** 縦長カードは、はみ出しとる分だけカード内をスクロールする */
  function innerScroll(dir, amount) {
    const cur = st.current;
    if (!cur?.isConnected) return false;
    const r = cur.getBoundingClientRect();
    const b = bounds();
    if (dir > 0 && r.bottom > b.bottom + 1) {
      scrollByY(Math.min(amount, r.bottom - b.bottom));
      return true;
    }
    if (dir < 0 && r.top < b.top - 1) {
      scrollByY(-Math.min(amount, b.top - r.top));
      return true;
    }
    return false;
  }

  function step(dir) {
    if (!st.active) return;
    const t = now();
    if (t - st.lastStepAt < 70) return; // キー押しっぱなしの暴走防止
    st.lastStepAt = t;
    if (!st.current?.isConnected) return pickInitial();
    if (!innerScroll(dir, bounds().avail * 0.85)) go(dir);
  }

  /* ------------------------------------------------------------------ */
  /* 入力                                                               */
  /* ------------------------------------------------------------------ */
  function hasScrollableAncestor(el) {
    for (let n = el instanceof Element ? el : el?.parentElement; n && n !== document.body && n !== root; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 1) {
        const oy = getComputedStyle(n).overflowY;
        if (oy === 'auto' || oy === 'scroll') return true;
      }
    }
    return false;
  }
  function shouldIgnore(t) {
    if (modalOpen()) return true;
    if (t?.closest?.('#layers, [data-testid="DMDrawer"], [data-testid="GrokDrawer"], [data-tcs-float]')) return true;
    return hasScrollableAncestor(t);
  }

  function onWheel(e) {
    if (!st.active || e.ctrlKey || e.defaultPrevented) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // 横スワイプ（戻る）はブラウザに任せる
    if (shouldIgnore(e.target)) return;
    e.preventDefault();

    const dy = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? window.innerHeight : 1);
    if (!dy) return;
    const w = st.wheel;
    const abs = Math.abs(dy);
    const dir = Math.sign(dy);

    // 160ms 何も来んかったら1ジェスチャー終わり
    clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      w.busy = null;
      w.accum = 0;
      w.lastAbs = 0;
    }, 160);

    // 慣性スクロール中に逆向き or 急な強まり → 新しいスワイプとみなす
    if (w.busy && (dir !== w.dir || (abs > Math.max(25, w.lastAbs * 2.5) && now() - st.lastStepAt > 250))) {
      w.busy = null;
      w.accum = 0;
    }
    w.lastAbs = abs;

    if (w.busy === 'nav') return; // 1スワイプ1枚
    if (innerScroll(dir, abs)) {
      w.busy = 'inner';
      w.dir = dir;
      return;
    }
    if (w.busy === 'inner') return; // カード内スクロールの勢いで次に飛ばんように
    w.accum += dy;
    if (Math.abs(w.accum) >= 30) {
      w.busy = 'nav';
      w.dir = dir;
      w.accum = 0;
      st.lastStepAt = now();
      if (!st.current?.isConnected) pickInitial();
      else go(dir);
    }
  }

  const NEXT_KEYS = new Set(['ArrowDown', 'ArrowRight', 'j', 'J', 'PageDown']);
  const PREV_KEYS = new Set(['ArrowUp', 'ArrowLeft', 'k', 'K', 'PageUp']);

  function onKey(e) {
    if (e.isComposing) return;
    // Alt+S でON/OFF
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS') {
      if (isTyping(e.target) || !isEligible()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleEnabled();
      return;
    }
    if (!st.active || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTyping(e.target) || modalOpen()) return;
    if (e.target?.closest?.('[data-testid="videoPlayer"], [role="slider"], [role="menu"], #tcs-hud')) return;

    let dir = 0;
    if (e.key === ' ') {
      if (e.target?.closest?.('button, a, [role="button"], [role="link"]')) return;
      dir = e.shiftKey ? -1 : 1;
    } else if (NEXT_KEYS.has(e.key)) dir = 1;
    else if (PREV_KEYS.has(e.key)) dir = -1;
    if (!dir) return;

    // Xの j/k より先に横取りする（window の capture で登録しとる）
    e.preventDefault();
    e.stopImmediatePropagation();
    step(dir);
  }

  function onTouchStart(e) {
    if (!st.active || e.touches.length !== 1 || shouldIgnore(e.target)) return (st.touch = null);
    st.touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  function onTouchMove(e) {
    if (st.active && st.touch && e.cancelable) e.preventDefault();
  }
  function onTouchEnd(e) {
    const s = st.touch;
    st.touch = null;
    if (!st.active || !s) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const d = horizontal ? dx : dy;
    if (Math.abs(d) < 40) return;
    if (horizontal && settings.animation !== 'slide-x') return;
    step(d < 0 ? 1 : -1);
  }

  /** スクロールバーをドラッグされた・Xが勝手にスクロールした → 止まったとこで一番見えとるカードに吸着 */
  function onScroll() {
    if (!st.active || now() < st.programmaticUntil) return;
    clearTimeout(st.scrollTimer);
    st.scrollTimer = setTimeout(() => {
      if (!st.active || st.loading || now() < st.programmaticUntil) return;
      pickInitial();
    }, 180);
  }

  /* ------------------------------------------------------------------ */
  /* ON/OFF                                                             */
  /* ------------------------------------------------------------------ */
  const isEligible = () => eligiblePath() && hasCards();

  function toggleEnabled() {
    saveSettings({ enabled: !settings.enabled });
    hud.flash(settings.enabled ? 'カード表示: ON' : 'カード表示: OFF');
  }

  function activate() {
    st.active = true;
    root.setAttribute('data-tcs', 'on');
    isolateTimeline();
    tagFloaters();
    st.header.at = -1e9;
    pickInitial();
  }
  function deactivate() {
    st.active = false;
    st.loading = false;
    root.removeAttribute('data-tcs');
    isolateTimeline();
    clearFloaters();
    setTopPad(0);
    clearCurrent();
  }

  function evaluate() {
    if (location.href !== st.href) {
      st.href = location.href;
      setTopPad(0);
      clearCurrent();
      st.header.at = -1e9;
    }
    const eligible = isEligible();
    const want = eligible && settings.enabled;
    if (want && !st.active) activate();
    else if (!want && st.active) deactivate();
    else if (want) {
      // X はルート遷移や追加読み込みで要素を差し替えるため、毎回非表示対象を求め直す
      isolateTimeline();
      tagFloaters();
      if (!st.loading && !st.current?.isConnected) pickInitial();
    }
    hud.setVisible(eligible);
    hud.update();
  }

  /* ------------------------------------------------------------------ */
  /* テーマ（ライト / ダークブルー / ブラック）                              */
  /* ------------------------------------------------------------------ */
  const dyn = document.createElement('style');
  dyn.id = 'tcs-dyn';
  (document.head || root).appendChild(dyn);

  function updateTheme() {
    const bg = getComputedStyle(document.body).backgroundColor;
    if (bg === st.themeKey) return;
    st.themeKey = bg;
    const [r, g, b, a = 1] = (bg.match(/[\d.]+/g) || []).map(Number);
    const transparent = r === undefined || a === 0;
    const dark = !transparent && 0.299 * r + 0.587 * g + 0.114 * b < 128;
    dyn.textContent = `:root{--tcs-card-bg:${transparent ? '#fff' : bg};--tcs-line:${dark ? 'rgba(255,255,255,.16)' : 'rgba(15,20,25,.10)'
      };--tcs-shadow:${dark ? 'rgba(0,0,0,.65)' : 'rgba(15,20,25,.16)'};}`;
    hud.setDark(dark);
  }

  /* ------------------------------------------------------------------ */
  /* 操作バー（Shadow DOM でXのCSSと干渉させへん）                         */
  /* ------------------------------------------------------------------ */
  const hud = (() => {
    const host = document.createElement('div');
    host.id = 'tcs-hud';
    host.hidden = true;
    const sh = host.attachShadow({ mode: 'open' });
    const chevron = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    sh.innerHTML = `
      <style>
        :host { all: initial; }
        :host([hidden]) { display: none !important; }
        .wrap {
          position: fixed; z-index: 2147483000; bottom: 16px; left: 50%;
          transform: translateX(-50%);
          display: flex; flex-direction: column; align-items: center; gap: 8px;
          font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
          --fg: #0f1419; --bg: rgba(255,255,255,.88); --line: rgba(15,20,25,.12); --hover: rgba(15,20,25,.08);
          --accent: #1d9bf0;
        }
        .wrap.dark { --fg: #e7e9ea; --bg: rgba(22,24,28,.88); --line: rgba(255,255,255,.16); --hover: rgba(255,255,255,.1); }
        .pill {
          display: flex; align-items: center; gap: 2px; padding: 4px;
          background: var(--bg); color: var(--fg);
          border: 1px solid var(--line); border-radius: 999px;
          box-shadow: 0 6px 20px rgba(0,0,0,.18);
          backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
        }
        button {
          all: unset; box-sizing: border-box; cursor: pointer;
          width: 38px; height: 38px; border-radius: 999px;
          display: grid; place-items: center; color: inherit;
        }
        button:hover { background: var(--hover); }
        button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
        .prev svg { transform: rotate(180deg); }
        .axis-x .prev svg { transform: rotate(90deg); }
        .axis-x .next svg { transform: rotate(-90deg); }
        .sep { width: 1px; height: 22px; background: var(--line); margin: 0 4px; }
        .toggle[aria-pressed="true"] { color: var(--accent); }
        .off .nav, .off .sep { display: none; }
        .off .pill { opacity: .55; transition: opacity .15s; }
        .off .pill:hover { opacity: 1; }
        .loading .next { animation: pulse .9s ease-in-out infinite; color: var(--accent); }
        @keyframes pulse { 50% { opacity: .3; } }
        .toast {
          padding: 6px 12px; border-radius: 999px; white-space: nowrap;
          background: var(--fg); color: var(--bg);
          opacity: 0; transform: translateY(6px); transition: opacity .18s, transform .18s; pointer-events: none;
        }
        .toast.show { opacity: 1; transform: none; }
      </style>
      <div class="wrap">
        <div class="toast" role="status" aria-live="polite"></div>
        <div class="pill">
          <button class="nav prev" title="前のポスト（↑ / K）" aria-label="前のポスト">${chevron}</button>
          <button class="nav next" title="次のポスト（↓ / J）" aria-label="次のポスト">${chevron}</button>
          <span class="sep"></span>
          <button class="toggle" title="カード表示を切り替え（Alt+S）" aria-label="カード表示を切り替え">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3.5" width="14" height="17" rx="3"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/></svg>
          </button>
        </div>
      </div>`;
    const wrap = sh.querySelector('.wrap');
    const toast = sh.querySelector('.toast');
    const toggleBtn = sh.querySelector('.toggle');
    let toastTimer = 0;

    // ボタン押してもカードのフォーカスを奪わんように
    sh.addEventListener('mousedown', (e) => e.preventDefault());
    sh.querySelector('.prev').addEventListener('click', () => step(-1));
    sh.querySelector('.next').addEventListener('click', () => step(1));
    toggleBtn.addEventListener('click', toggleEnabled);
    (document.body || root).appendChild(host);

    return {
      setVisible(v) {
        host.hidden = !v;
        if (v) this.place();
      },
      place() {
        const col = column();
        const r = col?.getBoundingClientRect();
        if (r && r.width) wrap.style.left = `${r.left + r.width / 2}px`;
        wrap.style.bottom = `${footerHeight() + 16}px`;
      },
      setDark(d) { wrap.classList.toggle('dark', d); },
      setAxis(a) { wrap.classList.toggle('axis-x', a === 'x'); },
      update() {
        wrap.classList.toggle('off', !st.active);
        wrap.classList.toggle('loading', st.loading);
        toggleBtn.setAttribute('aria-pressed', String(st.active));
      },
      flash(msg) {
        toast.textContent = msg;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
      },
    };
  })();

  /* ------------------------------------------------------------------ */
  /* 起動                                                               */
  /* ------------------------------------------------------------------ */
  function tick() {
    if (document.hidden) return;
    updateTheme();
    evaluate();
    tagFloaters();
    hud.place();
    keepAligned();
  }

  window.addEventListener('wheel', onWheel, { passive: false, capture: true });
  window.addEventListener('keydown', onKey, { capture: true });
  window.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
  window.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
  window.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    st.header.at = -1e9;
    st.lastAlignAt = 0;
    hud.place();
    keepAligned();
  });
  window.addEventListener('popstate', () => setTimeout(evaluate, 50));

  loadSettings().then(() => {
    updateTheme();
    applySettings();
    setInterval(tick, 300);
  });
})();
