window.__ModuleLoader__.load({
  id: '@hystudio/dsh-quota-pill',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    // Sidecar address. Overridable so people can run it on another port
    // without editing this file (QUOTA_PILL_PORT / QUOTA_PILL_URL).
    const SIDECAR = (() => {
      const explicit = (typeof window !== 'undefined' && window.__QUOTA_PILL_URL__) || '';
      if (explicit) return String(explicit).replace(/\/$/, '');
      return 'http://127.0.0.1:' + (Number(
        (typeof window !== 'undefined' && window.__QUOTA_PILL_PORT__) || 8319,
      ) || 8319);
    })();
    const R = 5.5;
    const C = 2 * Math.PI * R;
    const STORE_KEY = 'quota-pill.samples.v1';

    function loadHistory() {
      try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        return raw && typeof raw === 'object' ? raw : {};
      } catch (e) {
        return {};
      }
    }
    const history = loadHistory();
    function saveHistory() {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(history)); } catch (e) { /* quota storage full */ }
    }

    // ---------------------------------------------------------- 读数缓存
    // 额度环挂在会话级的 composer dock 上，切会话就会重新挂载、state 丢失，
    // 于是每次都要重查一遍上游（期间环显示「—」，回来后突然出现）。
    // 这里按 provider|model 记下最近一次读数，挂载时先用它渲染，过期才后台校验。
    //
    // 注意：这只是「最近一次读数」，不等于「额度一定没变」——别的会话、别的应用
    // 也在消耗同一个账号。所以仍然靠 TTL 兜底，并且在真有活动（任务起止、一轮结束、
    // 手动刷新）时强制读最新。新值到达时由 useTween 平滑过渡，不会跳变。
    const READ_STORE_KEY = 'quota-pill.reads.v1';
    const READ_TTL_MS = 3 * 60 * 1000;

    function loadReads() {
      try {
        const raw = JSON.parse(localStorage.getItem(READ_STORE_KEY) || '{}');
        return raw && typeof raw === 'object' ? raw : {};
      } catch (e) {
        return {};
      }
    }
    const reads = loadReads();
    function saveReads() {
      try { localStorage.setItem(READ_STORE_KEY, JSON.stringify(reads)); } catch (e) { /* storage full */ }
    }
    function cacheRead(key, payload) {
      if (!key || !payload) return;
      reads[key] = { at: Date.now(), payload };
      saveReads();
    }
    /** 取缓存条目（含时间戳）；过不过期交给调用方判断。 */
    function peekRead(key) {
      const hit = key ? reads[key] : null;
      return hit && hit.payload ? hit : null;
    }
    function isFreshRead(hit) {
      return !!hit && Date.now() - hit.at < READ_TTL_MS;
    }

    // 「全部」页的结果也缓一份：它要并发问 6 个上游（~4s），切会话重新挂载时
    // 不必再等一次。
    let allRead = { at: 0, payload: null };

    function providerFor(model) {
      const m = (model || '').toLowerCase();
      const prefix = m.split('/')[0];
      // ★ 先按前缀精确匹配已登记的 provider。
      // 必须放在下面的模糊规则之前：`gemini` 既是 agy 的模型族关键词，
      // 又是免费渠道池里的一个独立渠道（Gemini Code Assist），
      // 若先跑 m.includes('gemini') 就会被 agy 抢走。
      if (ALL_PROVIDERS.some(([k]) => k === prefix)) return prefix;
      // 通用规则：模型 id 以 provider id 打头的，直接认这个 provider。
      // 这样新加的 provider（opendesign 等）不需要改这张表就能被「当前」页认出来。
      // 只在「全部」页已经见过它时生效，避免把未知前缀误当成 provider。
      if (ALL_PROVIDERS.length && ALL_PROVIDERS.some(([k]) => m.startsWith(k + '/'))) {
        return ALL_PROVIDERS.map(([k]) => k).find((k) => m.startsWith(k + '/')) || '';
      }
      if (prefix === 'command-code') return 'commandcode';
      if (prefix === 'opencode-go') return 'opencode';
      if (prefix === 'kimi-coding') return 'kimi';
      if (prefix === 'antigravity') return 'agy';
      if (prefix === 'kimi' || m.startsWith('kimi') || m.startsWith('k3')) return 'kimi';
      if (prefix === 'xai' || m.includes('grok')) return 'xai';
      if (prefix === 'agy' || m.includes('gemini')) return 'agy';
      if (prefix === 'codex' || m.includes('codex')) return 'codex';
      if (prefix === 'devin') return 'devin';
      return '';
    }

    /** 100% remaining = green, 0% = red, smooth through yellow. */
    function remainingColor(pct) {
      const t = Math.max(0, Math.min(100, pct)) / 100;
      const hue = 120 * t;
      return `hsl(${hue.toFixed(1)} 72% 42%)`;
    }

    // ---------------------------------------------------------------- 全部额度
    // 「全部」页签的数据来自 sidecar 的 /quota/all，键必须与它的 ADAPTERS 一致。

    /** 页签顺序，切换动画的方向也按它算。 */
    const TAB_ORDER = ['current', 'all'];

    // 「全部」页展示哪些 provider —— 由侧车根据 DSH 的 modelCatalog 决定。
    //
    // 原来是这里手写的一张表，于是有两个必然的毛病：
    //   · 删掉插件/渠道后条目还在 → 全部页出现一堆取不到数的空行（显示成 none）
    //   · 新加 provider（如 opendesign）表里没有 → 完全不显示
    // 现在表是空的，装到 DSH 上的 provider 会带着自己的 displayName 自动出现，
    // 卸掉的自然消失。空表时退回一份兜底清单，保证侧车还没应答也不至于全空。
    let ALL_PROVIDERS = [];

    /**
     * Shown before the sidecar answers, so the panel is never blank on first
     * paint. Not authoritative: once /quota/all responds, the real list (with
     * display names from the sidecar) replaces it.
     */
    const FALLBACK_PROVIDERS = [
      ['commandcode', 'Command Code'],
      ['opencode', 'OpenCode Go'],
      ['kimi', 'Kimi Coding'],
      ['codex', 'Codex'],
      ['xai', 'xAI (Grok)'],
      ['agy', 'Antigravity'],
    ];

    /**
     * 用一次 /quota/all 的结果刷新 provider 清单。
     * 侧车每个 payload 都带 displayName（来自 DSH 目录），这里直接采用。
     */
    function providersFromAll(all) {
      if (!all || typeof all !== 'object') return null;
      const rows = Object.entries(all)
        .filter(([, v]) => v && typeof v === 'object')
        .map(([k, v]) => [k, String(v.displayName || k)]);
      return rows.length ? rows : null;
    }

    /** provider key → 展示名（「全部」页用列表，「当前」页按当前 provider 反查）。 */
    // 只在「当前」页出现的 provider（没有额度、不进「全部」页）
    // Names for providers that appear only on the current page (no quota row).
    const EXTRA_PROVIDER_NAMES = {};

    function providerName(key) {
      const hit = ALL_PROVIDERS.find(([k]) => k === key);
      // 表还没被侧车刷新时，至少把 key 显示出来——返回空字符串会让
      // 「当前」页的分组标题整个消失。
      return hit ? hit[1] : (EXTRA_PROVIDER_NAMES[key] || String(key || ''));
    }

    // ------------------------------------------------- 语言（跟随 DSH 的语言设置）
    // DSH 的 @deepseek-ai/dsh-client-locale 会把活动语言写到 <html lang>。
    // 读它即可跟随系统设置，并用 MutationObserver 订阅——切语言时无需刷新。
    const TEXT = {
      tabCurrent: ['当前', 'Current'],
      tabAll: ['全部', 'All'],
      tabsHint: ['Shift+滚轮 或 触控板双指左右滑动可切换', 'Shift+scroll or two-finger swipe to switch'],
      refresh: ['刷新', 'Refresh'],
      refreshing: ['刷新中…', 'Refreshing…'],
      refreshTitle: ['强制刷新（绕过 60s 缓存）', 'Force refresh (bypass the 60s cache)'],
      remainingAll: ['剩余额度', 'Remaining quota'],
      limitWindow: ['限制窗口', 'Limit window'],
      subscription: ['订阅可用额度', 'Subscription allowance'],
      quotaWord: ['额度', 'quota'],
      account: ['账号', 'Account'],
      reset: ['重置', 'Resets'],
      usedThisPeriod: ['本期已用', 'Used this period'],
      usedRaw: ['（上游原始值）', ' (upstream raw)'],
      monthlyCap: ['月度上限', 'Monthly cap'],
      nextReset: ['下期重置', 'Next reset'],
      model: ['模型', 'Model'],
      basis: ['依据', 'Basis'],
      noQuotaApi: ['上游未提供查询接口', 'Upstream exposes no quota API'],
      verifiedUsable: ['实测可正常调用', 'Verified callable'],
      free: ['限时免费', 'Limited-time free'],
      payg: ['按量计费', 'Metered'],
      noCeiling: ['无额度上限', 'No quota ceiling'],
      lastSpend: ['上次消耗', 'Last spend'],
      avgPerTurn: ['平均每轮', 'Avg per turn'],
      estRemaining: ['预计还能跑', 'Est. turns left'],
      turns: (n) => [`≈ ${n} 轮`, `≈ ${n} turns`],
      noData: ['无数据', 'No data'],
      unknown: ['未知', 'Unknown'],
      queryFailed: ['查询失败', 'Query failed'],
      unavailable: ['不可用', 'Unavailable'],
      noQuotaApiShort: ['无额度接口', 'No quota API'],
      loadingAll: ['正在查询各 provider…', 'Querying providers…'],
      sidecarFailed: ['sidecar 连接失败', 'sidecar connection failed'],
      resetDone: ['已重置', 'Reset'],
      resetMin: (n) => [`${n} 分钟后重置`, `Resets in ${n}m`],
      resetHour: (n) => [`${n} 小时后重置`, `Resets in ${n}h`],
      resetHourMin: (h, m) => [`${h} 小时 ${m} 分后重置`, `Resets in ${h}h ${m}m`],
      resetDay: (n) => [`${n} 天后重置`, `Resets in ${n}d`],
      resetDayHour: (d, h) => [`${d} 天 ${h} 小时后重置`, `Resets in ${d}d ${h}h`],
      bodyProbeFailed: ['该模型当前不可用（可用性探测失败）。', 'This model is unavailable (availability probe failed).'],
      bodyNoApi: ['该模型暂无可查额度接口。', 'No queryable quota API for this model.'],
      querying: ['查询中…', 'Querying…'],
      underThreshold: ['不足 0.1%', '<0.1%'],
      turnsTotal: (n) => [`（${n} 轮合计）`, ` (${n} turns)`],
      leftSuffix: ['剩余可用', 'left'],
      triggerTitle: ['订阅剩余额度', 'Subscription remaining'],
      windowRemaining: (w) => [`${w}额度剩余`, `${w} limit remaining`],
      // 免费渠道池的两种汇总口径——它们不是「额度周期」，所以不加「额度剩余」后缀
      tightestWindow: ['最紧窗口', 'Tightest window'],
      // 兜底：汇总行没有 window 字段时的标题，绝不渲染成字面量 "undefined"
      quotaFallback: ['额度', 'Quota'],
      // 积分类的今日读数
      gainedToday: (n) => [`今日新增 +${n}`, `Today +${n}`],
      usedToday: ['今日消耗', "Today's usage"],
      remainingCredits: ['剩余积分', 'Credits left'],
      spendUnit: (req, tok) => [`${req} 次 · ${tok}`, `${req} reqs · ${tok}`],
      poolStatus: ['状态未知', 'Status unknown'],
      noSource: ['无数据源', 'No source'],
      balanceLeft: ['余额剩余', 'Balance left'],
      bonusBalance: ['赠金余额', 'Bonus balance'],
      offlineTitle: ['额度服务未启动', 'Quota service is not running'],
      offlineHint: ['在本机运行下面的命令即可（保持后台）', 'Start it locally in the background:'],
      creditsAll: ['全部积分', 'All credits'],
      creditsPermanent: ['永久积分', 'Permanent'],
      creditsTemporary: ['临时积分', 'Temporary'],
      expiresAt: (d) => [`${d} 到期`, `expires ${d}`],
    };

    /**
     * 取当前语言下的一条文案。
     * 条目形态有两种：`[zh, en]` 数组，或 `(...args) => [zh, en]` 函数（带插值）。
     * 必须先把函数求值成数组再按语言取，否则函数条目会取到 undefined。
     */
    function pick(lang, key, ...args) {
      const entry = TEXT[key];
      if (!entry) return key;
      const pair = typeof entry === 'function' ? entry(...args) : entry;
      return pair[lang === 'zh' ? 0 : 1];
    }

    function currentLang() {
      const raw = (document.documentElement.getAttribute('lang') || navigator.language || 'en');
      return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    /** 订阅 <html lang>，语言一变就重新渲染。 */
    function useLang() {
      const [lang, setLang] = React.useState(currentLang);
      React.useEffect(() => {
        const read = () => setLang(currentLang());
        read();
        const obs = new MutationObserver(read);
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
        return () => obs.disconnect();
      }, []);
      return lang;
    }

    /**
     * 数值从上一帧平滑过渡到最新值——额度刷新时不跳变。
     * target 非数值（null / undefined）时直接透传，不做动画。
     */
    /**
     * 「前段匀速推进，尾段明显减速」的缓动。
     *
     * 为什么不用 easeOutCubic：它在 25% 的时间里就走完 58%，视觉上等于
     * 「闪一下就停」，用户看到的「突然快速变」正是这个。
     * 这里前 65% 时间线性推进到 78%，剩下 35% 时间用二次曲线吃完最后 22%——
     * 总时长固定，但最后几个百分点走得很慢，收得干净。
     *
     * 选它而不是 quint / expo：那两条在起点更陡（t=0.25 就到 76%/82%），
     * 只会让「突跳」更明显。
     */
    function tweenEase(t) {
      const KNEE = 0.65;          // 拐点：之前匀速，之后减速
      const LEAD = 0.78;          // 拐点处已完成的进度
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      if (t <= KNEE) return (t / KNEE) * LEAD;
      const u = (t - KNEE) / (1 - KNEE);
      return LEAD + (1 - LEAD) * (1 - Math.pow(1 - u, 2));
    }

    function useTween(target, ms) {
      // 初值必须是 null 而不是 target。
      //
      // 之前写成 useState(target) 是「闪一下」的第一因：数据一到，首帧先
      // 直接画出终值，紧接着 effect 里又把 from 设成旧值重画，于是出现
      // 「跳到 94% → 弹回 0% → 再爬上去」。null 起步意味着第一帧不画读数，
      // 等 effect 拿到真正的 from 再开始，动画从第一次就有起点。
      const [shown, setShown] = React.useState(
        typeof target === 'number' && Number.isFinite(target) ? null : target,
      );
      const shownRef = React.useRef(null);
      const rafRef = React.useRef(null);
      const firstRef = React.useRef(true);

      React.useEffect(() => {
        if (typeof target !== 'number' || !Number.isFinite(target)) {
          shownRef.current = target;
          setShown(target);
          return undefined;
        }
        // 首次拿到数值：直接落到目标，不从 0 爬——否则每次打开面板都会
        // 看到「0% 涨到 94%」这种并不存在的历史。
        const isFirst = firstRef.current;
        const prev = shownRef.current;
        const from = (isFirst || typeof prev !== 'number') ? target : prev;
        firstRef.current = false;

        if (Math.abs(from - target) < 0.01) {
          shownRef.current = target;
          setShown(target);
          return undefined;
        }
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        const t0 = performance.now();
        const tick = (now) => {
          const t = Math.min(1, (now - t0) / ms);
          const v = from + (target - from) * tweenEase(t);
          shownRef.current = v;
          setShown(v);
          if (t < 1) rafRef.current = requestAnimationFrame(tick);
          else { shownRef.current = target; setShown(target); }
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => { if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
      }, [target, ms]);
      return shown;
    }

    // ---------------------------------------------------------------- 窗口名
    // 唯一来源。adapter 会给出多种写法，全部在这里归一。
    //
    // 两组合并是实测结论，不是猜的：
    //   • rolling ≡ 5h ≡ fiveHour —— opencode 把 5 小时窗口记作 rolling，
    //     实测它的 resetsAt 恰好是 5.0 小时后（另外两桶是 weekly / monthly）。
    //   • 7d ≡ weekly —— kimi 用 7d，codex / opencode / commandcode 用 weekly，
    //     是同一个 7 天窗口。
    // 不合并的话同一页里会同时出现「5 小时」和「滚动窗口」、「每周」和「7 天」。
    const WINDOW_LABEL = {
      '5h': ['5 小时', '5h'],
      fiveHour: ['5 小时', '5h'],
      rolling: ['5 小时', '5h'],
      weekly: ['每周', 'Weekly'],
      '7d': ['每周', 'Weekly'],
      monthly: ['每月', 'Monthly'],
      'model-pool': ['模型池', 'Model pool'],
      // 积分类的固定三行。放进这里是为了让 isKnownWindow 认得它们——
      // 否则 providerEntries 会再前置一条汇总行，变成四行。
      'credits-all': ['全部积分', 'All credits'],
      'credits-permanent': ['永久积分', 'Permanent'],
      'credits-temporary': ['临时积分', 'Temporary'],
    };

    function windowLabel(w, lang) {
      if (!w) return '';
      const key = String(w).replace(/^USAGE_PERIOD_TYPE_/i, '').toLowerCase();
      const entry = WINDOW_LABEL[key] || WINDOW_LABEL[w];
      return entry ? entry[lang === 'zh' ? 0 : 1] : String(w);
    }

    /** resetAt 见过三种形态：epoch 秒 / epoch 毫秒 / ISO 字符串。 */
    function fmtResetAt(v, lang) {
      if (v === null || v === undefined || v === '') return '';
      let d;
      if (typeof v === 'number' || /^\d+$/.test(String(v))) {
        let n = Number(v);
        if (n < 1e12) n *= 1000;
        d = new Date(n);
      } else {
        d = new Date(String(v));
      }
      if (!d || Number.isNaN(d.getTime())) return '';
      const diff = d.getTime() - Date.now();
      if (diff <= 0) return pick(lang, 'resetDone');
      // 按参考版式的精度给两级：6d 19h / 5h 20m / 10m
      const mins = Math.max(1, Math.round(diff / 60000));
      if (mins < 60) return pick(lang, 'resetMin', mins);
      const hrs = Math.floor(mins / 60);
      const remMin = mins % 60;
      if (hrs < 48) {
        return remMin ? pick(lang, 'resetHourMin', hrs, remMin) : pick(lang, 'resetHour', hrs);
      }
      const days = Math.floor(hrs / 24);
      const remHr = hrs % 24;
      return remHr ? pick(lang, 'resetDayHour', days, remHr) : pick(lang, 'resetDay', days);
    }

    /** 把任意 adapter 的返回值归一成一行展示数据。只表达剩余可用。 */
    function describeQuota(v, lang) {
      if (!v) return { text: pick(lang, 'noData'), tone: 'muted', pct: null };
      const kind = v.kind;
      if (kind === 'subscription-quota' && v.remainingPct !== null && v.remainingPct !== undefined) {
        const pct = Number(v.remainingPct);
        const bad = /exceeded|rate-limited|exhausted/i.test(String(v.status || ''));
        return {
          pct,
          text: `${pct.toFixed(pct < 10 ? 2 : 1)}%`,
          color: remainingColor(pct),
          tone: bad || pct < 10 ? 'danger' : pct < 30 ? 'warn' : 'ok',
          window: windowLabel(v.window, lang),
          reset: fmtResetAt(v.resetAt, lang),
        };
      }
      // v.label 来自 adapter，本身就是双语无关的短词，优先用它。
      if (kind === 'free-usable') return { text: v.label || pick(lang, 'free'), tone: 'ok', pct: null };
      if (kind === 'payg') {
        // Prepaid wallets (e.g. the official DeepSeek account) have a real
        // balance to show. Only fall back to the label when there is no amount.
        const c = v.credits;
        if (c && typeof c.remain === 'number') {
          return { text: money(c.remain, c.unit), tone: 'ok', pct: null };
        }
        return { text: v.label || pick(lang, 'payg'), tone: 'muted', pct: null };
      }
      // `none` = 这个 provider 当前取不到任何读数（渠道被删、插件被卸、没凭据）。
      // 之前没有这个分支，会掉到最后的 String(kind)，界面上直接显示字面量 "none"。
      if (kind === 'none') {
        return { text: v.error ? pick(lang, 'noSource') : pick(lang, 'noData'), tone: 'muted', pct: null };
      }
      if (kind === 'probe-failed') return { text: pick(lang, 'unavailable'), tone: 'danger', pct: null };
      // 免费池没有额度上限，所以没有百分比——只报可用状态
      if (kind === 'usage-only') {
        const bad = /不可用|失败/.test(String(v.label || ''));
        return { text: v.label || pick(lang, 'poolStatus'), tone: bad ? 'warn' : 'muted', pct: null };
      }
      if (kind === 'token-meter') return { text: pick(lang, 'noQuotaApiShort'), tone: 'muted', pct: null };
      if (kind === 'error') return { text: pick(lang, 'queryFailed'), tone: 'danger', pct: null };
      return { text: String(kind || pick(lang, 'unknown')), tone: 'muted', pct: null };
    }

    /**
     * adapter 的 products 里每个子窗口都是「已用百分比」，这里一律换算成剩余。
     * @returns {{label: string, remain: number}[]}
     */
    function subWindows(v, lang) {
      const p = v && v.products;
      if (!p || typeof p !== 'object' || Array.isArray(p)) return [];
      return Object.keys(p)
        .map((k) => {
          const used = Number(p[k]);
          if (!Number.isFinite(used)) return null;
          return { label: windowLabel(k, lang) || k, remain: Math.max(0, Math.min(100, 100 - used)) };
        })
        .filter(Boolean);
    }

    /** 这个键是不是一个真的"额度窗口"，还是 adapter 顺带报的模型/产品名。 */
    function isKnownWindow(key) {
      return !!WINDOW_LABEL[String(key).replace(/^USAGE_PERIOD_TYPE_/i, '').toLowerCase()];
    }

    /**
     * 免费渠道池的两种汇总口径。它们不是「额度周期」，所以不加「额度剩余」后缀，
     * 否则会读成「最紧窗口额度剩余」这种别扭的说法。
     */
    const AGGREGATE_LABELS = {
      'credits-total': 'creditsAll',
      'tightest-window': 'tightestWindow',
      // 固定三行：不加「额度剩余」后缀（它们不是额度周期）
      'credits-all': 'creditsAll',
      'credits-permanent': 'creditsPermanent',
      'credits-temporary': 'creditsTemporary',
    };

    /**
     * 一条窗口的展示标签。
     *
     * agy / xai 曾经有过「模型名 / 产品线」当窗口键的数据，这里会给它们加前缀；
     * 现在 adapter 不再产出那类行了（agy 的模型池全部同分，取「最紧」是并列里
     * 随机挑一个；xai 只有一个产品线，和汇总重复），所以不再需要按 provider 猜测。
     *
     * @param key      窗口键 / 汇总口径
     * @param lang     语言
     */
    function entryLabel(key, lang) {
      const raw = key === null || key === undefined ? '' : String(key);
      // 兜底：没有键时给一个中性标题，绝不返回字面量 "undefined"
      if (!raw) return pick(lang, 'quotaFallback');
      const norm = raw.replace(/^USAGE_PERIOD_TYPE_/i, '').toLowerCase();
      if (AGGREGATE_LABELS[norm]) return pick(lang, AGGREGATE_LABELS[norm]);
      if (!isKnownWindow(raw)) return raw;
      return pick(lang, 'windowRemaining', windowLabel(raw, lang));
    }

    /**
     * 把一个 provider 的读数摊平成「每个额度一条」。
     *
     * 数据里有两层：汇总（remainingPct + window + resetAt）与分窗口（windows 数组，
     * 带各自的剩余与重置）。多数 adapter 的分窗口就是全部窗口，直接列出来即可；
     * 当一个窗口键都不是已知窗口时（免费渠道池按积分包给），汇总本身才是主额度，
     * 要先把它补上，否则会丢掉真正的主额度。
     *
     * @returns {{key: string, label: string, pct: number|null, reset: string, credits: object|null}[]}
     */
    function providerEntries(v, lang) {
      if (!v) return [{ key: 'none', label: pick(lang, 'noData'), pct: null, reset: '', credits: null }];
      if (v.kind === 'usage-only') {
        // 行标题给状态，副行给原因（availability 的 detail，例如
        // 「OpenCode's free tier can only be used from within OpenCode」）——
        // 免费池最要紧的信息就是「这个模型到底能不能用、为什么不能」。
        return [{
          key: 'usage',
          label: v.label || pick(lang, 'poolStatus'),
          pct: null,
          reset: v.detail ? String(v.detail) : '',
          credits: null,
        }];
      }
      // Prepaid wallets (official DeepSeek): a balance, plus optional bonus
      // credit. Both are money, not percentages, so each needs its own row —
      // collapsing them into one label silently loses the bonus.
      if (v.kind === 'payg' && v.credits && typeof v.credits.remain === 'number') {
        const rows = [{
          key: 'balance',
          label: pick(lang, 'balanceLeft'),
          pct: null,
          reset: '',
          credits: { remain: v.credits.remain, unit: v.credits.unit },
          money: true,
        }];
        if (v.bonus && typeof v.bonus.amount === 'number') {
          rows.push({
            key: 'bonus',
            label: pick(lang, 'bonusBalance'),
            pct: null,
            reset: '',
            credits: { remain: v.bonus.amount, unit: v.bonus.unit },
            money: true,
          });
        }
        return rows;
      }
      if (v.kind !== 'subscription-quota' || v.remainingPct === null || v.remainingPct === undefined) {
        return [{ key: 'kind', label: describeQuota(v, lang).text, pct: null, reset: '', credits: null }];
      }
      const provider = v.provider;
      const wins = Array.isArray(v.windows) ? v.windows : [];
      const gain = v.today && typeof v.today.gained === 'number' ? v.today.gained : null;
      const out = [];
      if (!wins.some((w) => isKnownWindow(w.key))) {
        out.push({
          key: '__aggregate',
          label: entryLabel(v.window, lang, provider),
          pct: Number(v.remainingPct),
          // 有今日新增就先报它——积分渠道最想一眼看到的是「今天又进账多少」，
          // 重置时间对积分包通常为空。取不到新增就退回原来的重置倒计时。
          reset: gain !== null ? pick(lang, 'gainedToday', gain) : fmtResetAt(v.resetAt, lang),
          credits: v.credits || null,
        });
      }
      for (const w of wins) {
        const pct = Number(w.remainPct);
        out.push({
          key: String(w.key),
          label: entryLabel(w.key, lang, provider),
          pct: Number.isFinite(pct) ? pct : null,
          reset: (w.credits && w.resetAt) ? fmtExpiry(w.resetAt, lang) : fmtResetAt(w.resetAt, lang),
          credits: w.credits || null,
        });
      }
      // 积分类用的是固定三行，三个键都算「已知窗口」，所以不会再前置汇总行——
      // 今日新增原本挂在汇总行上，会因此丢掉。改挂到第一行（全部积分）的副行。
      if (gain !== null && out.length && out[0].key === 'credits-all') {
        out[0].reset = pick(lang, 'gainedToday', gain);
      }
      return out;
    }

    function QuotaPill(props) {
      const { useSession, useChat } = props;
      const directory = props.directory;
      const running = useSession ? useSession((s) => s.running) : false;
      const nodeCount = useChat ? useChat((s) => (s.order ? s.order.length : 0)) : 0;
      const sel = React.useSyncExternalStore(
        (fn) => (directory ? directory.subscribe(fn) : () => {}),
        () => (directory ? directory.getSnapshot() : null),
      );
      const current = sel && sel.current;
      const model = current ? `${current.provider}/${current.model}` : null;
      const provider = providerFor(model);
      // 读数的缓存键按 provider|model——换模型时额度来源确实不同，不能混用。
      const readKey = provider ? `${provider}|${current ? current.model : ''}` : '';
      const readKeyRef = React.useRef(readKey);
      readKeyRef.current = readKey;

      // data 记下自己是「哪个 key 的读数」。
      //
      // 只存 payload 是不够的：切会话时 QuotaPill 不会重新挂载（DSH 侧栏常驻），
      // data 里还留着上一个 provider 的对象，于是第一帧会先画出别人的额度，
      // effect 跑完才换成正确的——这就是切会话时「环跳一下」的真正原因。
      // 带上 key 之后，渲染前就能判断「这份数据属于当前 provider 吗」。
      const [data, setData] = React.useState(() => {
        const hit = peekRead(readKey);
        return hit ? { key: readKey, payload: hit.payload } : null;
      });
      // 当前渲染该用哪份数据：key 对得上才算数，否则视为「还没有数据」。
      const dataKey = data ? data.key : null;
      const dataPayload = data && data.key === readKey ? data.payload : null;
      const [open, setOpen] = React.useState(false);
      // 「现在显示的是历史读数，正在刷新」。
      //
      // 切会话时不去清空数据，而是先把该 provider 上一次的读数亮出来（同一份
      // 额度，只是不是最新的），同时后台刷新；新数据到达后过渡过去并撤掉标记。
      // 这样切换瞬间不会出现空环或别人 provider 的数字。
      const [stale, setStale] = React.useState(false);
      const [fetchErr, setFetchErr] = React.useState(null);
      // True once we have reached the sidecar at least once in this mount.
      // Lets us distinguish "service not running" (show the start command)
      // from "service up but this upstream failed" (show the upstream error).
      const [everOk, setEverOk] = React.useState(false);
      const anchorRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const prevRunning = React.useRef(running);

      // 面板位置：固定在视口内，而不是跟着触发器「贴」到哪算哪。
      //
      // 旧写法直接取触发器的 left，面板 340px 宽，窄窗口时右边就被切掉了；
      // bottom 固定向上展开，窗口矮时上面同样被切。这里改成：
      //   · 水平：优先对齐触发器左边，再夹到视口内
      //   · 垂直：上方放得下就向上，放不下就翻到触发器下面
      //   · 两侧都塞不满时给 maxHeight，让面板自己滚动而不是溢出
      const [panelStyle, setPanelStyle] = React.useState(null);
      const GAP = 8;      // 与触发器的间距
      const EDGE = 12;    // 距视口边缘的最小留白
      const PANEL_MAX_W = 340;

      /** 把面板夹进视口：水平贴触发器左边但不出界，垂直放不下就翻到下方。 */
      const placePanel = React.useCallback(() => {
        const el = anchorRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        setPanelStyle(computePanelPlacement(
          { left: r.left, top: r.top, bottom: r.bottom },
          {
            width: window.innerWidth || document.documentElement.clientWidth,
            height: window.innerHeight || document.documentElement.clientHeight,
          },
          panelRef.current ? panelRef.current.offsetHeight : 0,
          GAP, EDGE, PANEL_MAX_W,
        ));
      }, []);

      React.useEffect(() => {
        if (!open) { setPanelStyle(null); return undefined; }
        placePanel();
        // 挂载后量到真实高度再算一次，翻转判定才准
        const raf = requestAnimationFrame(placePanel);
        const onViewportChange = () => placePanel();
        window.addEventListener('resize', onViewportChange);
        // capture: 工具条自身可能滚动，滚动会改变触发器的位置
        window.addEventListener('scroll', onViewportChange, true);
        return () => {
          cancelAnimationFrame(raf);
          window.removeEventListener('resize', onViewportChange);
          window.removeEventListener('scroll', onViewportChange, true);
        };
      }, [open, placePanel]);

      // 面板页签：默认「当前」（本会话在用的 provider），可切到「全部」。
      const [tab, setTab] = React.useState('current');
      // 切换动画从哪一侧滑入：'right' = 新内容自右来（往前进），'left' = 自左来。
      const [dir, setDir] = React.useState('right');
      const [all, setAll] = React.useState(() => allRead.payload);
      // provider 清单是运行时数据（来自侧车 / DSH 目录），用 state 存一份，
      // 变了才能触发重渲染；ALL_PROVIDERS 只是它的可读镜像，供各处同步取用。
      const [, setProviders] = React.useState(() => ALL_PROVIDERS);
      const [allErr, setAllErr] = React.useState(null);
      const [allBusy, setAllBusy] = React.useState(false);

      // 手势 effect 只在 open 时挂一次，闭包里不能捕获旧的 tab，所以镜像到 ref。
      const tabRef = React.useRef(tab);
      tabRef.current = tab;

      /** 稳定引用的页签切换：step>0 往后，<0 往前，越界不动。 */
      const switchTab = React.useCallback((step) => {
        const i = TAB_ORDER.indexOf(tabRef.current);
        const j = Math.min(TAB_ORDER.length - 1, Math.max(0, i + step));
        if (j === i || i < 0) return;
        setDir(step > 0 ? 'right' : 'left');
        setTab(TAB_ORDER[j]);
      }, []);

      const loadAll = React.useCallback((fresh) => {
        setAllBusy(true);
        fetch(`${SIDECAR}/quota/all${fresh ? '?fresh=1' : ''}`)
          .then((r) => r.json())
          .then((d) => {
            setAllErr(null);
            setEverOk(true);
            allRead = { at: Date.now(), payload: d };
            // provider 清单跟着数据走：新装的 provider 立刻出现，卸掉的立刻消失。
            const rows = providersFromAll(d);
            if (rows && JSON.stringify(rows) !== JSON.stringify(ALL_PROVIDERS)) {
              ALL_PROVIDERS = rows;
              setProviders(rows);
            }
            setAll(d);
          })
          .catch((e) => setAllErr(String(e)))
          .finally(() => setAllBusy(false));
      }, []);

      // 挂载时先铺一份缓存（有就立即显示，没有就留空），让切页签时第一帧就有内容。
      React.useEffect(() => {
        if (!allRead.payload || Date.now() - allRead.at > READ_TTL_MS) loadAll(false);
      }, [loadAll]);

      // 切到「全部」页（含首次打开就落在这一页）时，强制读一次最新额度。
      //
      // 之前这里只在 all === null 时补刷，于是缓存一旦存在就再也不刷新——
      // 别的会话消耗了额度、或上游窗口滚动过，看板显示的还是旧的，和实际有出入。
      // 现在每次「真正切到这一页」都 fresh 一次；「全部」是主动查看的行为，
      // 看的就是当下，宁可多一次上游往返。
      //
      // 守卫记住的是「上次为哪次打开刷过」：同一次打开内反复重渲染不重复打，
      // 但关掉再开、或从「当前」切过来，都会重新刷。
      const allRefreshRef = React.useRef(null);
      React.useEffect(() => {
        if (!open || tab !== 'all') return;
        if (allRefreshRef.current === 'done') return;   // 本次打开已刷过
        allRefreshRef.current = 'done';
        loadAll(true);
      }, [open, tab, loadAll]);

      // 关面板或离开「全部」页时清掉标记，下次切回来再刷一次。
      React.useEffect(() => {
        if (!open || tab !== 'all') allRefreshRef.current = null;
      }, [open, tab]);

      /**
       * 读一次额度。
       * @param mode 'soft'  上下文变化时用——允许 sidecar 的 60s 缓存命中，没发生消耗就不必打上游
       *             'fresh' 真有活动（任务起止 / 一轮结束）或手动刷新时用——强制读上游
       */
      const query = React.useCallback((tag, mode) => {
        if (!provider) { setData(null); return; }
        const key = readKeyRef.current;
        const fresh = mode === 'fresh';
        fetch(`${SIDECAR}/quota?model=${encodeURIComponent(model)}${fresh ? '&fresh=1' : ''}`)
          .then((r) => r.json())
          .then((d) => {
            // 缓存照写：这份读数确实属于 key 那个 provider，无论用户现在在哪。
            cacheRead(key, d);
            // 但界面只在自己仍是当前上下文时才更新。
            //
            // fresh 要等 0.9–4.0 秒，这段时间用户完全可能又切走了。不判一下就会
            // 出现「A 的请求回来把 B 的界面覆盖成 A 的值」——比原来更糟，因为
            // 现在等得更久、撞上的概率更高。
            if (key !== readKeyRef.current) return;
            setFetchErr(null);
            setEverOk(true);   // reached the sidecar at least once
            setData({ key, payload: d });
            setStale(false);   // 准确数据到了，撤掉「非实时」标记
            if (d.kind === 'subscription-quota' && d.remainingPct != null) {
              const rec = (history[provider] = history[provider] || { turns: [], window: d.window || '' });
              // A new billing window starts the series over so old spend is not reused.
              if (d.resetAt && rec.resetAt && d.resetAt !== rec.resetAt) rec.turns = [];
              rec.resetAt = d.resetAt || rec.resetAt;
              const last = rec.turns[rec.turns.length - 1];
              if (!last || last.pct !== d.remainingPct) {
                rec.turns.push({ at: Date.now(), pct: d.remainingPct, tag });
                if (rec.turns.length > 80) rec.turns.shift();
                saveHistory();
              }
            }
          })
          .catch((e) => { if (key === readKeyRef.current) setFetchErr(String(e)); });
      }, [provider, model]);

      // 上下文变化（挂载 / 切会话 / 换模型）。
      //
      // 先亮出该 provider 上一次的读数（绝不显示别人 provider 的数字），
      // 标成「非实时」并转场；然后真去上游查一次当下值，到了再平滑过渡过去。
      //
      // 这里用 fresh 而不是 soft：切会话就是「我想看现在」的动作，而 soft 只打
      // 侧车、会命中它 60s 的缓存（实测 6–47ms 就返回），等于给你一个最多 60 秒
      // 前的答案——顺带也让这个转场短到看不见。fresh 实测 0.9–4.0s，
      // 正好是有意义的等待。
      React.useEffect(() => {
        const key = readKeyRef.current;
        const hit = peekRead(key);
        if (hit) {
          setData({ key, payload: hit.payload });
          setStale(true);
        } else {
          // 从没刷过：清空（显示「—」）并让刷新动效表示正在取。
          setData(null);
          setStale(true);
        }
        // 唯一例外：刚查过（10s 内）就来回切，没必要重复打上游——
        // 那种情况值几乎不可能变，而连续几次 2s 往返会让人以为界面卡住。
        if (isFreshRead(hit) && hit && Date.now() - hit.at < 10 * 1000) {
          setStale(false);
          return;
        }
        query('modelChange', 'fresh');
      }, [provider, model, query]);

      // 以下都是「确实发生了消耗」的信号，读最新值。
      // Task start, each settled turn, and the whole task ending. No interval.
      React.useEffect(() => {
        const was = prevRunning.current;
        prevRunning.current = running;
        if (!was && running) query('taskStart', 'fresh');
        else if (was && !running) query('taskEnd', 'fresh');
      }, [running, query]);

      const prevNodes = React.useRef(nodeCount);
      React.useEffect(() => {
        const grew = nodeCount > prevNodes.current;
        prevNodes.current = nodeCount;
        if (grew && !running) query('turnEnd', 'fresh');
      }, [nodeCount, running, query]);

      React.useEffect(() => {
        if (!open) return;
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        const onDown = (e) => {
          const a = anchorRef.current;
          const p = panelRef.current;
          if (a && a.contains(e.target)) return;
          if (p && p.contains(e.target)) return;
          setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('mousedown', onDown);
        };
      }, [open]);

      // 触控板双指左右滑 / Shift+滚轮 切换「当前 ↔ 全部」。
      // 只挂面板打开时，且只劫持横向意图——纵向滚动（内容超高的滚动区）照常。
      React.useEffect(() => {
        if (!open) return undefined;
        const el = panelRef.current;
        if (!el) return undefined;
        const THRESHOLD = 30;   // 滑动像素累积阈值，避免误触
        const COOLDOWN = 350;   // 一次切换后的静默期，避免连跳
        let acc = 0;
        let cooling = false;
        let unlock = null;
        const onWheel = (e) => {
          // 横向分量优先；没有横向分量时把 Shift+纵向当横向。
          // （Firefox 会自动换轴成 deltaX，Chrome 上 Shift+滚轮仍报 deltaY，两种都接。）
          const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY)
            ? e.deltaX
            : (e.shiftKey ? e.deltaY : 0);
          if (dx === 0) return;
          e.preventDefault();
          if (cooling) return;
          acc += dx;
          if (Math.abs(acc) < THRESHOLD) return;
          const step = acc > 0 ? 1 : -1;
          acc = 0;
          cooling = true;
          unlock = window.setTimeout(() => { cooling = false; unlock = null; }, COOLDOWN);
          switchTab(step);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => {
          el.removeEventListener('wheel', onWheel);
          if (unlock !== null) window.clearTimeout(unlock);
        };
      }, [open, switchTab]);

      // 语言跟随 DSH；数值过渡要在提前 return 之前挂（hooks 不能条件化）。
      const lang = useLang();
      const rawPct = dataPayload && dataPayload.kind === 'subscription-quota' ? dataPayload.remainingPct : null;
      const shownPct = useTween(typeof rawPct === 'number' ? rawPct : null, 450);

      if (!model) return null;
      const rec = history[provider] || { turns: [] };
      const isFree = !!(dataPayload && dataPayload.kind === 'free-usable');
      const isPayg = !!(dataPayload && dataPayload.kind === 'payg');
      const isText = isFree || isPayg;
      // 积分类渠道：剩余百分比恒为 100%，既没有信息量、也不能参与「每轮消耗 /
      // 还能跑几轮」的历史计算（分母没有意义），所以这类渠道一律不带 pct，
      // 改显示剩余积分本身。
      const cr = dataPayload && dataPayload.kind === 'subscription-quota' ? dataPayload.credits : null;
      const hasCr = !!(cr && typeof cr.remain === 'number');
      // 一律用百分比（与官网口径一致）；百分比不可得时才退回积分数值。
      const pct = dataPayload && dataPayload.kind === 'subscription-quota'
        && typeof rawPct === 'number' && Number.isFinite(rawPct) ? rawPct : null;
      // 展示用百分比走动画值；pct 仍用原始值参与「还能跑几轮」等计算。
      const shown = typeof shownPct === 'number' ? shownPct : pct;
      const label = isFree ? pick(lang, 'free')
        : isPayg ? ((dataPayload && dataPayload.label) || pick(lang, 'payg'))
        : (pct != null) ? `${Math.round(shown)}%`
        : hasCr ? (fmtCompact(cr.remain) + (unitLabel(cr.unit, lang) ? ' ' + unitLabel(cr.unit, lang) : ''))
        : (shown == null ? '—' : `${Math.round(shown)}%`);
      const color = shown == null ? 'var(--dsw-alias-label-tertiary, #888)' : remainingColor(shown);
      const dash = shown == null ? 0 : (C * Math.max(0, Math.min(100, shown))) / 100;

      // Upstream quota is integer percent, so one turn often moves nothing.
      // Accumulate from the last point where the reported percent actually dropped.
      const drops = [];
      let span = 0;
      for (let i = 1; i < rec.turns.length; i++) {
        const d = rec.turns[i - 1].pct - rec.turns[i].pct;
        span += 1;
        if (d > 0) {
          drops.push({ delta: d, span });
          span = 0;
        }
      }
      const lastDrop = drops.length ? drops[drops.length - 1] : null;
      const lastDelta = lastDrop ? lastDrop.delta : null;
      const lastSpan = lastDrop ? lastDrop.span : (span || null);
      const totalDrop = drops.reduce((a, b) => a + b.delta, 0);
      const totalSpan = drops.reduce((a, b) => a + b.span, 0) + span;
      const avgDelta = totalDrop > 0 && totalSpan > 0 ? totalDrop / totalSpan : null;
      const remainTasks = pct != null && avgDelta ? Math.max(1, Math.floor(pct / avgDelta)) : null;

      // 服务连不上：从未成功过 + 有错误 + 手上没有任何数据。
      // 这时要直接告诉用户「服务没启动、去跑这条命令」，否则面板只会停在「—」。
      const offline = !!fetchErr && !everOk && !dataPayload
        && !(all && Object.keys(all).length);

      const tabButton = (id, text) => h('button', {
        key: id,
        type: 'button',
        className: 'quota-pill-tab',
        'aria-pressed': tab === id,
        onClick: () => switchTab(TAB_ORDER.indexOf(id) - TAB_ORDER.indexOf(tab)),
      }, text);

      return h('span', {
        ref: anchorRef,
        className: 'quota-pill-root',
        style: { display: 'inline-flex', flex: 'none', order: 2 },
      },
        h('button', {
          type: 'button',
          className: 'quota-pill-trigger',
          // 面板收起时触发器是唯一可见的读数，必须跟着一起进「非实时」态，
          // 否则会出现「胶囊暗着、展开却是亮的」这种前后不一致。
          'data-stale': stale ? '1' : undefined,
          'aria-label': isFree ? 'limited-time free model' : isPayg ? 'metered billing, no quota ceiling' : hasCr ? `credits remaining ${label}` : (pct == null ? 'quota unavailable' : `remaining quota ${label}`),
          'aria-expanded': open,
          title: fetchErr ? `quota sidecar: ${fetchErr}` : (isText ? label : pick(lang, 'triggerTitle')),
          onClick: () => {
            query('manual', 'fresh');
            // 每次打开都回到「当前」，不记忆上次停留的页签。
            const next = !open;
            if (next) setTab('current');
            setOpen(next);
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '1px 8px',
            border: 'none',
            background: 'transparent',
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            color: 'var(--dsw-alias-label-tertiary, inherit)',
            fontFamily: 'inherit',
            fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
        },
          isText ? null : h('svg', { viewBox: '0 0 14 14', width: 14, height: 14, 'aria-hidden': true },
            h('circle', {
              cx: 7, cy: 7, r: R, fill: 'none',
              stroke: 'var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
              strokeWidth: 2,
            }),
            h('circle', {
              cx: 7, cy: 7, r: R, fill: 'none',
              stroke: color,
              strokeWidth: 2,
              strokeLinecap: 'round',
              strokeDasharray: `${dash} ${C}`,
              transform: 'rotate(-90 7 7)',
            }),
          ),
          h('span', isText ? { style: { color: 'var(--dsw-alias-label-primary, #2e7d32)' } } : null, label),
        ),
        open && ReactDOM.createPortal(
          h('div', {
            ref: panelRef,
            role: 'dialog',
            'aria-label': 'quota',
            className: 'quota-pill-panel',
            style: panelStyle
              ? { position: 'fixed', ...panelStyle }
              // 第一帧还没算好位置：先藏着，否则会先画在错误的地方再跳一下
              : { position: 'fixed', left: 0, top: 0, visibility: 'hidden' },
          },
            h('div', {
              className: 'quota-pill-tabs',
              title: pick(lang, 'tabsHint'),
            },
              tabButton('current', pick(lang, 'tabCurrent')),
              tabButton('all', pick(lang, 'tabAll')),
            ),
            // key=tab：切页签时 React 重挂载这一层，入场动画才会重放；
            // data-dir 决定从哪一侧滑入。
            h('div', { key: tab, className: 'quota-pill-pane', 'data-dir': dir },
              // Sidecar unreachable: say so, with the exact command to start it.
              // Without this the panel just sits on "—" and the user has no idea
              // whether the plugin is broken or the service is simply not running.
              offline
                ? h('div', { className: 'quota-pill-empty quota-pill-offline' },
                    h('div', { className: 'quota-pill-offline-title' },
                      pick(lang, 'offlineTitle')),
                    h('div', { className: 'quota-pill-offline-hint' },
                      pick(lang, 'offlineHint')),
                    h('code', { className: 'quota-pill-offline-cmd' }, 'npx @hystudio/dsh-quota-pill'),
                  )
                : tab === 'all'
                ? allBody(all, allErr, allBusy, () => loadAll(true), lang)
                : isFree
                ? freeBody(dataPayload, lang)
                : isPayg
                ? paygBody(dataPayload, lang)
                // 能渲染的三种情形都要放进来，否则会掉到下面的「查询中…」：
                //   ① 有百分比的订阅额度  ② 积分类（pct 为 null，但有 credits）
                //   ③ 免费池（usage-only，既无百分比也无积分）
                : canRenderBody(dataPayload)
                ? quotaBody(dataPayload, lastDelta, lastSpan, avgDelta, remainTasks, rec.turns.length, lang, providerName(provider), stale)
                : h('div', {
                    className: 'quota-pill-empty',
                    // 这个 provider 从没刷过：显示「—」并让刷新动效说明正在取。
                    // 不用「查询中…」是因为它和「切到没数据的 provider」是同一件事，
                    // 但用户看到「—」+ 动效更清楚：这个位置还没有数，正在补。
                    'data-loading': stale ? '1' : undefined,
                  },
                    dataPayload && dataPayload.kind === 'probe-failed' ? pick(lang, 'bodyProbeFailed')
                      : dataPayload && dataPayload.kind === 'token-meter' ? pick(lang, 'bodyNoApi')
                      : dataPayload && dataPayload.error ? String(dataPayload.error)
                        : stale ? '—' : pick(lang, 'querying')),
            ),
          ),
          document.body,
        ),
      );
    }

    function fmtDelta(delta, span, lang) {
      if (delta == null) return span ? pick(lang, 'underThreshold') : '—';
      const per = span && span > 1 ? pick(lang, 'turnsTotal', span) : '';
      return `${delta < 0.1 ? '<0.1' : delta.toFixed(1)}%${per}`;
    }

    function paygBody(data, lang) {
      const c = data && data.credits;
      const hasBalance = c && typeof c.remain === 'number';
      return h(React.Fragment, null,
        h('div', { className: 'quota-pill-header' },
          h('span', { className: 'quota-pill-headline' },
            hasBalance ? pick(lang, 'balanceLeft') : ((data && data.label) ? String(data.label) : pick(lang, 'payg'))),
          hasBalance
            ? h('span', { className: 'quota-pill-figures' }, money(c.remain, c.unit))
            : h('span', { className: 'quota-pill-figures' }, (data && data.note) ? String(data.note) : pick(lang, 'noCeiling')),
        ),
        h('dl', { className: 'quota-pill-rows' },
          // A prepaid wallet's bonus is worth showing separately: it is spendable
          // but not the same money, and mixing it into the balance would overstate.
          data.bonus && typeof data.bonus.amount === 'number'
            ? statRow(pick(lang, 'bonusBalance'), money(data.bonus.amount, data.bonus.unit))
            : null,
          !hasBalance && data.account && statRow(pick(lang, 'account'), String(data.account)),
          data.usedAmount != null && statRow(pick(lang, 'usedThisPeriod'), String(data.usedAmount) + pick(lang, 'usedRaw')),
          data.monthlyLimit != null && statRow(pick(lang, 'monthlyCap'), String(data.monthlyLimit)),
          data.resetAt && statRow(pick(lang, 'nextReset'), String(data.resetAt).slice(0, 10)),
        ),
      );
    }

    function freeBody(data, lang) {
      return h(React.Fragment, null,
        h('div', { className: 'quota-pill-header' },
          h('span', { className: 'quota-pill-headline' }, pick(lang, 'free')),
          h('span', { className: 'quota-pill-figures' }, data.note ? String(data.note) : pick(lang, 'noQuotaApiShort')),
        ),
        h('dl', { className: 'quota-pill-rows' },
          data.account && statRow(pick(lang, 'model'), String(data.account)),
          statRow(pick(lang, 'quotaWord'), pick(lang, 'noQuotaApi')),
          statRow(pick(lang, 'basis'), pick(lang, 'verifiedUsable')),
        ),
      );
    }

    /** 一个「剩余百分比」圆环：0% 只剩底圈，100% 是整圈。 */
    function quotaRing(pct, size) {
      const r = size / 2 - 1.5;
      const c = 2 * Math.PI * r;
      const clamped = Math.max(0, Math.min(100, pct));
      const dash = (c * clamped) / 100;
      return h('svg', {
        viewBox: `0 0 ${size} ${size}`,
        width: size,
        height: size,
        'aria-hidden': true,
        style: { flex: 'none', display: 'block' },
      },
        h('circle', {
          cx: size / 2, cy: size / 2, r, fill: 'none',
          stroke: 'var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
          strokeWidth: 2,
        }),
        h('circle', {
          cx: size / 2, cy: size / 2, r, fill: 'none',
          stroke: remainingColor(clamped),
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeDasharray: `${dash} ${c}`,
          transform: `rotate(-90 ${size / 2} ${size / 2})`,
        }),
      );
    }

    /**
     * 一个额度窗口，两行（参考 Antigravity 的额度面板）：
     *   第一行：标签 ······ 大号百分比 · 圆环
     *   第二行：重置倒计时（没有就不占行）
     *
     * 组件化是为了每条额度各自持有过渡动画。
     */
     /** 千分位，例 8500 → 8,500。不依赖 toLocaleString（不同运行时表现不一致）。 */
    function fmtAmount(n) {
      const v = Math.round(Number(n) * 100) / 100;
      const neg = v < 0;
      const [i, f] = Math.abs(v).toFixed(v % 1 === 0 ? 0 : 2).split('.');
      const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return (neg ? '-' : '') + grouped + (f ? '.' + f.replace(/0+$/, '') : '');
    }

    /** 大数据量摘要：3042900 → 304.3 万；1234 → 1,234。 */
    function fmtTokens(n, lang) {
      const v = Number(n) || 0;
      if (v >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
      if (v >= 1e4) return `${(v / 1e4).toFixed(1)} 万`;
      return fmtAmount(v);
    }

    /**
     * 这个读数能不能铺成窗口行？不能就退到「查询中…」——所以判定必须覆盖全部可渲染情形，
     * 否则功能正常却一直显示在查询中（积分类曾经因为 pct 为 null 卡在这里）。
     *   ① 有百分比的订阅额度
     *   ② 积分类：没有百分比，但有 credits
     *   ③ 免费池 usage-only：既无百分比也无积分，只有状态
     */
    function canRenderBody(data) {
      if (!data) return false;
      if (data.kind === 'usage-only') return true;
      if (data.kind !== 'subscription-quota') return false;
      const c = data.credits;
      return (c && typeof c.remain === 'number') || data.remainingPct != null;
    }

    /**
     * 单位展示名。上游的单位写法不统一，先归一：
     *   credit / credits / 积分 → 积分（en: credits）
     *   USD / token 等 → 原样（它们确实是另一种东西，不能混为一谈）
     * 渠道之间的单位本来就不同（cline 是 USD、zcode 是 token），所以必须跟着数据走。
     */
    function unitLabel(u, lang) {
      const raw = String(u == null ? '' : u).trim();
      if (!raw) return '';
      const k = raw.toLowerCase();
      if (k === 'credit' || k === 'credits' || raw === '积分') {
        return lang === 'zh' ? '积分' : 'credits';
      }
      return raw;
    }

    /** 到期时间：积分包给的是「哪天到期」，用绝对日期比「X 天后重置」贴切。 */
    /**
     * Currency amount. Uses a symbol for the few currencies we may see and a
     * bare code otherwise, so we never imply a currency we did not get.
     */
    function money(amount, unit) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
      const sym = { CNY: '\u00a5', USD: '$', EUR: '\u20ac' }[String(unit || '').toUpperCase()];
      const n = Math.abs(amount) >= 100 ? amount.toFixed(1) : amount.toFixed(2);
      return sym ? sym + n : n + (unit ? ' ' + unit : '');
    }

    function fmtExpiry(iso, lang) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const ms = d.getTime() - Date.now();
      // 一天以内用相对时间：5 小时窗口写成「10-21 到期」会误导——
      // 它其实是今天晚些时候就重置。超过一天才值得看绝对日期。
      if (ms <= 24 * 3600 * 1000) return fmtResetAt(iso, lang);
      const p2 = (n) => String(n).padStart(2, '0');
      const txt = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      return pick(lang, 'expiresAt', txt);
    }

    /**
     * 环中心/读数用的紧凑数值：最多三位数，超过写成 X.Yk。
     *   500 → 500    999 → 999    1758 → 1.7k    8500 → 8.5k    10000 → 10k
     * 目的是让这一列宽度稳定——积分可能是 8500、10 万、甚至 6 位数，
     * 原样铺开会把行撑开、和百分比行对不齐。
     */
    function fmtCompact(n) {
      const v = Number(n) || 0;
      if (Math.abs(v) < 1000) return fmtAmount(Math.round(v * 10) / 10);
      // 截断而不是四舍五入：1758 → 1.7k（不是 1.8k）。展示的是「还剩多少」，
      // 向上取整会多报余量，宁可少报。
      const cut = (x, div) => (Math.floor(Math.abs(x) / (div / 10)) / 10).toFixed(1).replace(/\.0$/, '');
      const sign = v < 0 ? '-' : '';
      // cut(v, 单位) = floor(|v| / (单位/10)) / 10 → 保留一位小数并截断
      if (Math.abs(v) >= 1e6) return sign + cut(v, 1e6) + 'M';
      return sign + cut(v, 1000) + 'k';
    }

    /**
     * 百分比有没有信息量？
     *
     * 判据是「剩余/上限」这个比值是否可能变化：
     *   · 没有上限（total 缺失或 0）→ 算不出比例，百分比无意义
     *   · 剩余 == 上限（恒等）→ 比例永远是 100%，显示它等于什么都没说
     *   · 其它（如 opendesign 94%/98%）→ 比例是真实读数，比积分更有信息量
     *
     * 这条规则取代了原来「有 credits 就一律显示 credits」的死规则——
     * 那条规则是为恒 100% 的包月渠道写的，把 94% 这种真实比例也一起吞掉了。
     */
    function pctIsInformative(pct, credits) {
      if (typeof pct !== 'number' || !Number.isFinite(pct)) return false;
      if (!credits || typeof credits.total !== 'number' || credits.total <= 0) {
        // 没有上限：只有百分比本身不是「满格」时才算有信息
        return Math.abs(pct - 100) > 0.01;
      }
      if (typeof credits.remain !== 'number') return true;
      // 剩余 == 上限 ⇒ 比例恒 100%，没有信息量
      return Math.abs(credits.total - credits.remain) > 1e-9 || Math.abs(pct - 100) > 0.01;
    }

    /**
     * 计算面板该放在哪，纯函数（不碰 DOM，便于测试）。
     *
     * 面板固定在视口里，不跟着触发器「贴」到哪算哪：
     *   · 水平：优先对齐触发器左边，再夹进视口，宁可左移也不切边
     *   · 垂直：上方放得下就向上展开，放不下就翻到触发器下方
     *   · 都不够高时返回 maxHeight，让面板内部滚动，绝不溢出视口
     *
     * @param anchor  触发器的 getBoundingClientRect 形状 {left, top, bottom}
     * @param viewport {width, height}
     * @param panelHeight 面板实测高度，0 表示还没量到
     */
    function computePanelPlacement(anchor, viewport, panelHeight, gap, edge, maxWidth) {
      const vw = viewport.width;
      const vh = viewport.height;
      const width = Math.min(maxWidth, vw - edge * 2);
      const left = Math.max(edge, Math.min(anchor.left, vw - width - edge));

      const spaceAbove = anchor.top - gap - edge;
      const spaceBelow = vh - anchor.bottom - gap - edge;
      const up = panelHeight === 0
        ? spaceAbove >= spaceBelow
        : (spaceAbove >= panelHeight || spaceAbove >= spaceBelow);

      const base = { left, width, overflowY: 'auto' };
      return up
        ? { ...base, bottom: Math.max(edge, vh - anchor.top + gap), maxHeight: Math.max(140, spaceAbove), placement: 'up' }
        : { ...base, top: Math.max(edge, anchor.bottom + gap), maxHeight: Math.max(140, spaceBelow), placement: 'down' };
    }

    function WindowRow(props) {
      const { label, pct, reset, credits, lang, stale, money: isMoney } = props;
      const isNum = typeof pct === 'number' && Number.isFinite(pct);
      const tweened = useTween(isNum ? pct : null, 450);
      // 首帧 tween 还没拿到起点时 shown 是 null；这时按目标值渲染静态读数，
      // 避免出现一帧空白，也避免 null.toFixed 崩掉。
      const shown = typeof tweened === 'number' ? tweened : pct;
      // 每行只显示一种读数，二选一，不并排：
      //   · 百分比有信息量  → 显示百分比（open-design 官网就是「剩余 94%」）
      //   · 百分比恒 100%   → 显示积分（这种渠道百分比什么都说明不了）
      // 判据见 pctIsInformative；两种方式都保留，只是不同渠道各取其一。
      const hasCredits = credits && typeof credits.remain === 'number';
      const showPct = isNum && pctIsInformative(pct, credits);
      const showCredits = hasCredits && !showPct;
      // data-stale：这份读数是「该 provider 上次的值」，正在后台刷新。
      // 视觉上降饱和 + 缓慢呼吸，数据到了再撤掉（见 CSS）。
      return h('div', { className: 'quota-pill-win', 'data-stale': stale ? '1' : undefined },
        // 左块 = 额度名 + 重置日期（两行）作为一个整体；右块 = 数值 + 环。
        // align-items:center 让右块相对这个两行整体垂直居中，而不是只跟额度名那一行对齐。
        h('div', { className: 'quota-pill-win-main' },
          h('div', { className: 'quota-pill-win-text' },
            h('span', { className: 'quota-pill-win-label', title: label }, label),
            reset ? h('span', { className: 'quota-pill-win-reset', title: reset }, reset) : null,
          ),
          h('div', { className: 'quota-pill-win-gauge' },
            showCredits
              ? h('span', {
                  className: 'quota-pill-win-credits',
                  title: credits.total !== undefined
                    ? `${fmtAmount(credits.remain)} / ${fmtAmount(credits.total)}`
                      + (credits.unit ? ' ' + String(credits.unit) : '')
                    : undefined,
                }, isMoney ? money(credits.remain, credits.unit) : fmtCompact(credits.remain))
              : isNum
                ? h('span', {
                    className: 'quota-pill-win-pct',
                    // 百分比模式下，把「剩余/上限 单位」放进 title，鼠标悬停仍能看到具体积分
                    title: showPct && hasCredits && credits.total !== undefined
                      ? `${fmtAmount(credits.remain)} / ${fmtAmount(credits.total)}`
                        + (credits.unit ? ' ' + String(credits.unit) : '')
                      : undefined,
                    style: { color: remainingColor(shown) },
                  }, typeof shown === 'number' ? `${shown.toFixed(shown < 10 ? 1 : 0)}%` : '')
                : null,
            showCredits && !isMoney && unitLabel(credits.unit, lang)
              ? h('span', { className: 'quota-pill-win-unit' }, unitLabel(credits.unit, lang))
              : null,

            h('span', { className: 'quota-pill-win-ring' },
              (typeof shown === 'number' && Number.isFinite(shown))
                ? quotaRing(shown, 14)
                : h('span', { className: 'quota-pill-allnoring' })),
          ),
        ),
      );
    }

    /** 一个 provider 分组：分组标题 + 它的各条额度。 */
    function ProviderGroup(props) {
      const { name, entries, lang, stale } = props;
      return h('section', { className: 'quota-pill-group' },
        h('div', { className: 'quota-pill-group-head' }, name),
        // 组内行 key 带组名，避免不同 provider 的同名窗口（都是 5h/weekly）
        // 被 React 当成同一个组件实例，导致 tween 跨 provider 插值。
        entries.map((e) => h(WindowRow, { key: `${name}|${e.key}`, label: e.label, pct: e.pct, reset: e.reset, credits: e.credits, lang, stale, money: e.money })),
      );
    }

    /**
     * 「全部」页签：每个 provider 一个分组，组内每条额度两行。
     *
     * 已有数据时刷新不空白——只把按钮变成「刷新中…」，内容继续显示，
     * 否则每次刷新都会闪一下空态。
     */
    function allBody(all, err, busy, onRefresh, lang) {
      // 清单以数据为准：侧车回了谁就展示谁（含 displayName）。
      // 侧车还没回来时用兜底清单占位，避免首帧整块空白。
      const list = (all && providersFromAll(all)) || FALLBACK_PROVIDERS;
      const groups = list.map(([key, name]) => ({
        key,
        name,
        entries: providerEntries(all ? all[key] : null, lang),
      }));
      const loaded = !!all;
      return h(React.Fragment, null,
        h('div', { className: 'quota-pill-header' },
          h('span', { className: 'quota-pill-headline' }, pick(lang, 'remainingAll')),
          // 刷新按钮：忙时把图标换成旋转圈 + 文案「刷新中…」。
          // 切到本页会自动 fresh 一次，用户需要看到「正在刷」而不是干等 4s。
          h('button', {
            type: 'button',
            className: 'quota-pill-refresh',
            'data-busy': busy ? '1' : undefined,
            onClick: onRefresh,
            disabled: busy,
            title: pick(lang, 'refreshTitle'),
          },
            h('span', { className: 'quota-pill-refresh-icon', 'aria-hidden': true },
              busy ? RefreshSpin() : RefreshGlyph()),
            h('span', null, busy ? pick(lang, 'refreshing') : pick(lang, 'refresh')),
          ),
        ),
        loaded
          ? h('div', { className: 'quota-pill-rows' },
              groups.map((g) => h(ProviderGroup, { key: g.key, name: g.name, entries: g.entries, lang })))
          : h('div', { className: 'quota-pill-empty' }, pick(lang, 'loadingAll')),
        err ? h('div', { className: 'quota-pill-empty' }, `${pick(lang, 'sidecarFailed')}: ${err}`) : null,
      );
    }

    /**
     * 「当前」页签。
     *
     * 版式与「全部」页同源：分组标题 + 逐条窗口行（标签 / 大号百分比 / 环 + 重置倒计时），
     * 都用同一个 WindowRow 组件、同一套配色层级。原先这里另起了一套（头部大号百分比 +
     * 通栏进度条 + 把各窗口塞成一堆 statRow），两页看起来像两个插件。
     *
     * 通用信息（账号 / 上次消耗 / 平均每轮 / 预计还能跑）保留在下方独立一块。
     * 「重置」不再单列——每条窗口行下面已经各自带了。
     */
    function quotaBody(data, lastDelta, lastSpan, avgDelta, remainTasks, samples, lang, providerName, stale) {
      const entries = providerEntries(data, lang);
      // 百分比类的统计量在积分类渠道上算不出来（没有可比的剩余百分比），
      // 这时整行不显示，而不是显示「—」占位（老板要求：算不出来的就不显示）。
      const avg = avgDelta == null
        ? (samples > 1 ? pick(lang, 'underThreshold') : null)
        : `${avgDelta < 0.1 ? '<0.1' : avgDelta.toFixed(1)}%`;
      const cr = data && data.credits;
      const today = (data && data.today) || null;
      const used = today && today.used;
      return h(React.Fragment, null,
        // 这里原本有个「剩余」标题单独占一行。去掉的原因：下方的窗口行本身就写着
        // 「XX额度剩余」，标题是重复信息；而且「全部」页也没有这个标题，两页因此不对齐。
        h('div', { className: 'quota-pill-rows' },
          h('section', { className: 'quota-pill-group' },
            providerName ? h('div', { className: 'quota-pill-group-head' }, providerName) : null,
            // key 带 provider：换 provider 时强制重挂载，让 tween 从「空」开始，
            // 而不是把 A 的 5h 平滑滑到 B 的 5h——那是两个不同账户的额度，
            // 中间的数字不代表任何真实状态。
            entries.map((e) => h(WindowRow, { key: `${providerName}|${e.key}`, label: e.label, pct: e.pct, reset: e.reset, credits: e.credits, lang, stale, money: e.money })),
          ),
          h('dl', { className: 'quota-pill-stats' },
            data.account ? statRow(pick(lang, 'account'), String(data.account)) : null,
            // 这里原本还有一行「剩余积分」。去掉的原因：积分类现在有固定的
            // 「全部积分」行，数值相同，留着就是重复。
            // 今日消耗：只有 channel-pack 渠道有这份台账，取不到就不显示
            used ? statRow(pick(lang, 'usedToday'),
              pick(lang, 'spendUnit', used.requests, fmtTokens(used.tokens))) : null,
            lastDelta == null ? null : statRow(pick(lang, 'lastSpend'), fmtDelta(lastDelta, lastSpan, lang)),
            avg == null ? null : statRow(pick(lang, 'avgPerTurn'), avg),
            remainTasks == null ? null : statRow(pick(lang, 'estRemaining'), pick(lang, 'turns', remainTasks)),
          ),
        ),
      );
    }

    /** 刷新图标：一个顺时针的圆弧箭头。 */
    function RefreshGlyph() {
      return h('svg', {
        width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
      },
        h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9' }),
        h('path', { d: 'M13.6 1.9v3.2h-3.2' }),
      );
    }

    /** 忙时的旋转圈：一圈淡环 + 一段高亮弧，靠 CSS 转。 */
    function RefreshSpin() {
      return h('svg', {
        width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none',
        strokeWidth: 1.8, strokeLinecap: 'round',
      },
        h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', opacity: 0.25 }),
        h('path', { d: 'M8 2a6 6 0 0 1 6 6', stroke: 'currentColor' }),
      );
    }

    function statRow(k, v) {
      return h('div', { key: k, className: 'quota-pill-row' },
        h('dt', null, k),
        h('dd', null, v),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.inject(['slots', 'modelDirectories'], (scope) => {
          const styleId = '@hystudio/dsh-quota-pill/order';
          if (!document.querySelector(`style[data-plugin-css="${styleId}"]`)) {
            const tag = document.createElement('style');
            tag.dataset.plugin = '@hystudio/dsh-quota-pill';
            tag.dataset.pluginCss = styleId;
            // Context meter is the last sibling; push the quota ring immediately after it.
            tag.textContent = [
              '.quota-pill-root{order:2}',
              '.quota-pill-trigger:hover,.quota-pill-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
              // 触发器上的「非实时」：和窗口行同一套语言（降饱和 + 慢呼吸）
              '.quota-pill-trigger[data-stale]{animation:quota-stale-breathe 2.4s ease-in-out infinite}',
              '@media (prefers-reduced-motion:reduce){.quota-pill-trigger[data-stale]{animation:none;opacity:.6}}',
              // 对齐 DSH 官方弹出菜单（-Fl-UW_panel）：padding:16px / font-size:12px /
              // line-height:18px / label-secondary / elevation-prominent。
              '.quota-pill-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:min(340px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);border:0;padding:16px;font-size:12px;line-height:18px}',
              '.quota-pill-header{align-items:center;gap:6px;display:flex}',
              '.quota-pill-headline{color:var(--dsw-alias-label-tertiary)}',
              '.quota-pill-figures{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;font-weight:500}',
              // 「全部」页现在是 6 组 × 每组若干条额度、每条两行，必然超高——列表自己滚动，
              // 头部（标题 + 刷新）留在外面不动。
              // padding-right：DSH 的滚动条是经典式（全局 ::-webkit-scrollbar 按
              // --dsh-scrollbar-width 定宽），会占掉内容宽度；不留通道的话最右列的额度环
              // 会贴在滚动条上。DSH 自己的滚动容器（pageScroll / detailScroll）都留了。
              '.quota-pill-rows{margin:6px 0 0;max-height:min(64vh,520px);overflow-y:auto;overscroll-behavior:contain;padding-right:calc(var(--dsh-scrollbar-width,6px) + 2px)}',
              // 「当前」页的通用信息块：与窗口分组之间用同一条分隔线，视觉上是一段而不是两块
              '.quota-pill-stats{margin:0;padding:8px 0 0;border-top:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}',
              '.quota-pill-row{justify-content:space-between;align-items:center;gap:12px;padding:2px 0;display:flex}',
              '.quota-pill-row dt{color:var(--dsw-alias-label-secondary)}',
              '.quota-pill-row dd{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin:0}',
              '.quota-pill-empty{color:var(--dsw-alias-label-secondary)}',
              // 页签：当前 / 全部
              '.quota-pill-tabs{display:flex;gap:2px;margin:-4px 0 10px;padding:2px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-interactive-bg-hover)}',
              '.quota-pill-tab{flex:1;cursor:pointer;border:0;background:transparent;font:inherit;padding:3px 0;border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-secondary)}',
              '.quota-pill-tab[aria-pressed=true]{background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);font-weight:500}',
              '.quota-pill-tab:hover{color:var(--dsw-alias-label-primary)}',
              '.quota-pill-tab{transition:background-color .15s ease,color .15s ease}',
              // 切页签的入场动画：新内容从手势/点击来的那一侧滑入并淡入
              '.quota-pill-pane{animation:quota-pane-in-right .18s cubic-bezier(.32,.72,0,1) both}',
              '.quota-pill-pane[data-dir=left]{animation-name:quota-pane-in-left}',
              '@keyframes quota-pane-in-right{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}',
              '@keyframes quota-pane-in-left{from{opacity:0;transform:translateX(-16px)}to{opacity:1;transform:none}}',
              // 尊重系统的「减弱动态效果」
              '@media (prefers-reduced-motion:reduce){.quota-pill-pane{animation:none}}',
              // 「全部」页签：provider 当分组，组内每条额度是「左块(两行) + 右块(百分比+环)」
              '.quota-pill-group{padding:8px 0}',
              '.quota-pill-group+.quota-pill-group{border-top:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}',
              // 分组标题是「节」这一级：比内容暗、比元信息亮，靠字重站住
              '.quota-pill-group-head{color:var(--dsw-alias-label-secondary);font-weight:500;margin-bottom:4px}',
              '.quota-pill-win{padding:3px 0}',
              // align-items:center 是这里的关键——让右侧的百分比与环相对左侧
              // 「额度名 + 重置日期」这个两行整体垂直居中，而不是只跟额度名那一行对齐。
              '.quota-pill-win-main{align-items:center;gap:8px;display:flex;min-width:0}',
              '.quota-pill-win-text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}',
              // 主：额度名（primary）。min-width:0 + 省略号，长模型名不撑破行。
              '.quota-pill-win-label{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
              // 次：重置日期（tertiary）。不再另设字号，靠颜色分主次（官方在面板里只用一个字号）。
              '.quota-pill-win-reset{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
              '.quota-pill-win-gauge{align-items:center;gap:8px;display:flex;flex:none}',
              // 等宽数字 + 固定右对齐宽度，使各行的环与数字成列
              '.quota-pill-win-pct{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:500;flex:none;min-width:40px;text-align:right}',
              // 积分数值：位数比百分比多得多，min-width 给宽一点，仍右对齐成列
              '.quota-pill-win-credits{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:500;flex:none;min-width:52px;text-align:right}',
              // 单位：同字号（保持 12px 版式统一），靠次级色拉开层级
              '.quota-pill-win-unit{flex:none;margin-left:3px;color:var(--dsw-alias-label-tertiary)}',

              '.quota-pill-win-ring{flex:none;display:inline-flex}',
              // Sidecar not running: show the fix instead of a bare dash.
              '.quota-pill-offline{display:flex;flex-direction:column;gap:6px;padding:10px 2px}',
              '.quota-pill-offline-title{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
              '.quota-pill-offline-hint{color:var(--dsw-alias-label-tertiary,inherit)}',
              '.quota-pill-offline-cmd{display:block;margin-top:2px;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);'
              + 'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));'
              + 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;'
              + 'color:var(--dsw-alias-label-secondary,inherit);user-select:all;overflow-x:auto;white-space:nowrap}',
              // 无历史读数时的「—」：同样用慢呼吸表示正在取数，和窗口行的
              // data-stale 是同一套语言，只是这里没有数值可淡。
              '.quota-pill-empty[data-loading]{animation:quota-stale-breathe 2.4s ease-in-out infinite}',
              '@media (prefers-reduced-motion:reduce){'
              + '.quota-pill-empty[data-loading]{animation:none;opacity:.6}}',
              // 「非实时读数」：切会话时先把该 provider 上次的值亮出来，后台正在刷新。
              // 用降饱和 + 缓慢呼吸表达「这是旧值、正在更新」——
              // 不用转圈 loading，那会盖掉额度环本身要传达的信息。
              '.quota-pill-win[data-stale] .quota-pill-win-gauge{opacity:.6;'
              + 'animation:quota-stale-breathe 2.4s ease-in-out infinite}',
              '@keyframes quota-stale-breathe{0%,100%{opacity:.45}50%{opacity:.72}}',
              // 减弱动态效果下只保留降饱和，不做呼吸（避免眩晕）
              '@media (prefers-reduced-motion:reduce){'
              + '.quota-pill-win[data-stale] .quota-pill-win-gauge{animation:none;opacity:.55}}',
              '.quota-pill-allnoring{width:14px;height:14px;flex:none;display:block}',
              '.quota-pill-refresh{align-items:center;gap:4px;display:inline-flex;margin-left:auto;cursor:pointer;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;padding:1px 6px;border-radius:var(--dsw-radius-sm,6px)}',
              '.quota-pill-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
              '.quota-pill-refresh:disabled{cursor:default;opacity:.75}',
              '.quota-pill-refresh-icon{align-items:center;display:inline-flex;flex:none}',
              // 忙时高亮成主色，并让那段圆弧转起来——切到本页会自动刷新，
              // 用户需要看到「正在刷」，否则 4s 的等待像是卡住了。
              '.quota-pill-refresh[data-busy] .quota-pill-refresh-icon{color:var(--dsw-alias-label-primary)}',
              '.quota-pill-refresh[data-busy] .quota-pill-refresh-icon svg{animation:quota-pill-spin .8s linear infinite}',
              '@keyframes quota-pill-spin{to{transform:rotate(360deg)}}',
              '@media (prefers-reduced-motion:reduce){.quota-pill-refresh[data-busy] .quota-pill-refresh-icon svg{animation:none}}',
            ].join('');
            document.head.appendChild(tag);
          }
          scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
            name: 'conversation.composer.dock',
            id: 'quota-pill',
            order: 10,
            inject: (sessionId) => {
              let directory = null;
              try {
                directory = scope.modelDirectories.directoryFor(sessionId).store;
              } catch (e) { /* no model directory */ }
              return { directory };
            },
          }, QuotaPill));
        });
      },
    };
  },
});
