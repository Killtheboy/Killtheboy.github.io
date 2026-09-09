/* app.js — 515450 手机端评分页
 *
 * 数据流：内嵌前复权序列 -> 抓实时价(qt.gtimg.cn, script 标签自动解 GBK)
 *        -> 补齐缺失交易日(web.ifzq.gtimg.cn, CORS *) -> 重算评分 -> 渲染
 *
 * 关键性质：所有因子都是因果的，改最后一天的价格只影响最后一天，
 * 因此先 build 前 n-1 天，再用 tail() 单步求值今日，改价时无需重建。
 */
(function () {
  'use strict';

  // ---- 全局错误兜底：任何脚本异常都在页面顶部红条显示，避免"白屏无提示" ----
  window.onerror = function (msg, src, ln, col) {
    var b = document.getElementById('banner');
    if (!b) return;
    b.className = 'banner err show';
    b.innerHTML = '<b>页面脚本出错</b><br>' + (msg || '') +
      '<br><span style="opacity:.7">行 ' + ln + '</span>';
  };

  var SC = window.ScoreCore, E = window.EMBED;
  if (!SC || !E) { window.onerror('数据或计算核心未加载'); return; }

  var BAND_COLOR = ['#15803d', '#22c57c', '#4ade80', '#4b5563', '#fb923c', '#f87171', '#dc2626'];
  var BAND_SEG = [
    { w: 10, name: 'P0-10', tgt: 0.25 }, { w: 10, name: 'P10-20', tgt: 0.35 },
    { w: 10, name: 'P20-30', tgt: 0.45 }, { w: 40, name: 'P30-70 死区', tgt: null },
    { w: 10, name: 'P70-80', tgt: 0.80 }, { w: 10, name: 'P80-90', tgt: 0.90 },
    { w: 10, name: 'P90-100', tgt: 1.00 }
  ];

  var S = {
    dates: E.d.slice(), c: E.c.map(function (v) { return v / 1000; }),
    a: E.a.map(function (v) { return v === null ? null : v / 1000; }),
    meta: E.meta, gen: E.gen,
    st: null, res: null, sim: null, trig: null,
    px: null, pxPrev: null, pxChgPct: null, pxTime: '', pxSrc: 'none',
    rt: null, histOK: false, rtOK: false, rebaseK: 1, appended: 0
  };

  function $(id) { return document.getElementById(id); }
  function pctf(v) { return (v * 100).toFixed(0) + '%'; }
  function bandName(b) { return (b === -1 || b === null || b === undefined) ? '死区 P30-70' : SC.BAND_NAMES[b]; }
  function tss(ts) {
    if (!ts || ts.length < 14) return '';
    return ts.slice(0, 4) + '-' + ts.slice(4, 6) + '-' + ts.slice(6, 8) + ' ' +
      ts.slice(8, 10) + ':' + ts.slice(10, 12) + ':' + ts.slice(12, 14);
  }
  function tsDate(ts) { return (ts && ts.length >= 8) ? ts.slice(0, 4) + '-' + ts.slice(4, 6) + '-' + ts.slice(6, 8) : ''; }

  /* ================= 抓取 ================= */

  // 实时价：qt.gtimg.cn 返回 GBK 的 JS 变量赋值，用 script 标签加载由浏览器自动解码
  function loadRealtime(cb) {
    var s = document.createElement('script');
    var done = false;
    function fin(ok) { if (!done) { done = true; cb(ok); } }
    s.charset = 'GBK';
    s.src = 'https://qt.gtimg.cn/q=sh515450,sz399317';
    s.onload = function () { fin(!!(window.v_sh515450 && window.v_sz399317)); };
    s.onerror = function () { fin(false); };
    document.head.appendChild(s);
    setTimeout(function () { fin(false); }, 6000);
  }

  function parseRealtime() {
    var a = window.v_sh515450, b = window.v_sz399317;
    if (!a || !b) return null;
    var fa = String(a).split('~'), fb = String(b).split('~');
    var px = parseFloat(fa[3]), ip = parseFloat(fb[3]);
    if (!isFinite(px) || px <= 0) return null;
    return {
      px: px, prev: parseFloat(fa[4]), chg: parseFloat(fa[31]), chgPct: parseFloat(fa[32]),
      time: fa[30] || '', date: tsDate(fa[30] || ''),
      idxPx: isFinite(ip) && ip > 0 ? ip : null, idxTime: fb[30] || ''
    };
  }

  // 历史补齐：腾讯前复权日K，响应头带 Access-Control-Allow-Origin: *，可直接 fetch
  function fetchHist(cb) {
    var u1 = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh515450,day,,,800,qfq';
    var u2 = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sz399317,day,,,800,qfq';
    var t = setTimeout(function () { cb(null, null); }, 8000);
    function grab(u, key) {
      return fetch(u, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        var d = j && j.data && j.data[key];
        var arr = d && (d.qfqday || d.day);
        if (!arr || !arr.length) throw new Error('空数据');
        var m = {};
        for (var i = 0; i < arr.length; i++) {
          var v = parseFloat(arr[i][2]);   // [日期, 开, 收, 高, 低, 量]
          if (isFinite(v) && v > 0) m[arr[i][0]] = v;
        }
        return m;
      });
    }
    Promise.all([grab(u1, 'sh515450'), grab(u2, 'sz399317')])
      .then(function (r) { clearTimeout(t); cb(r[0], r[1]); })
      .catch(function () { clearTimeout(t); cb(null, null); });
  }

  /* ================= 合并 ================= */
  /* 远端是"以今天为基准"的前复权序列；本地是"以 gen 日为基准"的旧序列。
   * 若期间发生除息，两者在除息日之前相差一个常数因子。
   * 做法：取远端与本地的**最早重叠日**算比例 k，用它缩放重叠日之前的本地数据，
   * 重叠日及之后一律用远端值（覆盖 + 追加）。这样不需要维护分红表。 */
  function mergeHist(etfMap, idxMap) {
    if (!etfMap) return false;
    var pos = {};
    for (var i = 0; i < S.dates.length; i++) pos[S.dates[i]] = i;
    var rd = Object.keys(etfMap).sort();
    if (!rd.length) return false;

    var iFirst = -1, jFirst = -1;
    for (var j = 0; j < rd.length; j++) {
      if (pos[rd[j]] !== undefined) { iFirst = pos[rd[j]]; jFirst = j; break; }
    }
    if (iFirst < 0) return false;   // 无重叠 —— 宁可不合，也不要基准不一致

    var k = S.c[iFirst] / etfMap[rd[jFirst]];
    S.rebaseK = k;
    if (!isFinite(k) || k <= 0) return false;

    var nd = [], nc = [], na = [];
    for (var i2 = 0; i2 < iFirst; i2++) {
      nd.push(S.dates[i2]); nc.push(S.c[i2] * k); na.push(S.a[i2]);
    }
    var appended = 0;
    for (var j2 = jFirst; j2 < rd.length; j2++) {
      var d = rd[j2];
      nd.push(d); nc.push(etfMap[d]);
      var ia = (idxMap && idxMap[d] !== undefined) ? idxMap[d]
        : (pos[d] !== undefined ? S.a[pos[d]] : null);
      na.push(ia);
      if (pos[d] === undefined) appended++;
    }
    S.appended = appended;
    S.dates = nd; S.c = nc; S.a = na;
    return true;
  }

  // 用实时价更新最后一根（或追加一根）
  function applyRealtime(rt) {
    var i1 = S.dates.length - 1, last = S.dates[i1];
    if (rt.date > last) {
      S.dates.push(rt.date); S.c.push(rt.px); S.a.push(rt.idxPx);
      return 'append';
    } else if (rt.date === last) {
      S.c[i1] = rt.px;
      if (rt.idxPx) S.a[i1] = rt.idxPx;
      return 'replace';
    }
    return 'stale';
  }

  // 疑似除息检测：单日 ETF 跌幅比指数多跌 2.5% 以上
  function suspectExDiv() {
    var n = S.c.length;
    if (n < 41) return null;
    for (var i = n - 5; i < n; i++) {
      if (i < 1) continue;
      if (!S.c[i] || !S.c[i - 1] || !S.a[i] || !S.a[i - 1]) continue;
      var de = S.c[i] / S.c[i - 1] - 1, da = S.a[i] / S.a[i - 1] - 1;
      if (de - da < -0.025) return { date: S.dates[i], de: de * 100, da: da * 100 };
    }
    return null;
  }

  /* ================= 计算 ================= */
  function compute() {
    var n = S.dates.length, i1 = n - 1;
    // 只 build 前 n-1 天；今日用 tail() 单步求值，改价时无需重建
    S.st = SC.build(S.c.slice(0, i1), S.a.slice(0, i1), S.meta);
    S.res = SC.tail(S.st, i1, S.c, S.a);
    S.sim = SC.simulate(S.st, S.c, S.dates, S.meta, i1);
    var px0 = S.c[i1];
    S.trig = SC.findTrigger(S.st, S.c, S.a, S.dates, S.meta, i1, px0 * 0.75, px0 * 1.25, 200);
    S.i1 = i1;
  }

  /* ================= 渲染 ================= */
  function render() {
    var i1 = S.i1, r = S.res, sim = S.sim, meta = S.meta;
    var b = SC.band(r.sp), px = S.c[i1];

    // --- 顶部 ---
    $('hdNm').textContent = meta.name + '（' + S.dates[i1] + '）';
    $('hdPx').textContent = px.toFixed(3);
    if (S.rtOK && isFinite(S.pxChgPct)) {
      var cls = S.pxChgPct > 0 ? 'up' : (S.pxChgPct < 0 ? 'down' : 'flat');
      $('hdPx').className = 'px ' + cls;
      $('hdCh').className = 'ch ' + cls;
      $('hdCh').textContent = (S.pxChgPct > 0 ? '+' : '') + S.pxChgPct.toFixed(2) + '%  (昨收 ' +
        (S.pxPrev ? S.pxPrev.toFixed(3) : '—') + ')';
    } else {
      var i0 = i1 - 1, ch = (i0 >= 0 && S.c[i0]) ? (px / S.c[i0] - 1) * 100 : null;
      $('hdCh').className = 'ch ' + (ch === null ? 'flat' : (ch > 0 ? 'up' : (ch < 0 ? 'down' : 'flat')));
      $('hdCh').textContent = ch === null ? '—' :
        ((ch > 0 ? '+' : '') + ch.toFixed(2) + '% (较前一交易日)');
      $('hdPx').className = 'px';
    }
    var dot = S.rtOK ? 'ok' : (S.pxSrc === 'manual' ? 'warn' : 'err');
    var srcTxt = S.rtOK ? ('实时 ' + S.pxTime) : (S.pxSrc === 'manual' ? '手动输入' : '未取到实时价');
    $('hdSrc').innerHTML = '<span class="dot ' + dot + '"></span>' + srcTxt;
    $('hdCd').textContent = '评分基准日 ' + S.gen + ' · 序列 ' + S.dates.length + ' 天' + (S.appended ? ('（补齐 +' + S.appended + '）') : '');
    $('vGen').textContent = S.gen;

    // --- 提示条 ---
    var msgs = [];
    if (!S.rtOK && S.pxSrc !== 'manual') {
      msgs.push(['warn', '未取到实时价，当前显示的是 <b>' + S.dates[i1] + '</b> 的收盘价。可在下方手动输入现价。']);
    }
    if (!S.histOK) {
      msgs.push(['warn', '未能从网络补齐历史行情，缺失的交易日会让 40日/250日窗口错位。请联网后刷新。']);
    }
    var ex = suspectExDiv();
    if (ex) {
      msgs.push(['err', '检测到 <b>' + ex.date + '</b> 单日跌幅（' + ex.de.toFixed(2) +
        '%）比指数（' + ex.da.toFixed(2) + '%）低 2.5% 以上，疑似除息未复权。请刷新重试。']);
    }
    var age = (Date.now() - new Date(S.gen + 'T00:00:00').getTime()) / 86400000;
    if (age > 30) {
      msgs.push(['warn', '数据基准日距今已 <b>' + age.toFixed(0) + '</b> 天，建议重新生成页面。']);
    }
    var bn = $('banner');
    if (msgs.length) {
      bn.className = 'banner ' + (msgs.some(function (m) { return m[0] === 'err'; }) ? 'err' : 'warn') + ' show';
      bn.innerHTML = msgs.map(function (m) { return m[1]; }).join('<br><br>');
      if (!S.rtOK && S.pxSrc !== 'manual') {
        bn.innerHTML += '<div style="margin-top:9px;display:flex;gap:8px">' +
          '<input id="manualPx" type="number" step="0.001" inputmode="decimal" placeholder="现价，如 1.416" ' +
          'style="flex:1;background:#0b0f16;border:1px solid #2a3140;color:#e6edf3;border-radius:8px;padding:10px;font-size:16px">' +
          '<button id="manualBtn" class="primary">用此价重算</button></div>';
      }
    } else {
      bn.className = 'banner'; bn.innerHTML = '';
    }

    // --- 核心评分 ---
    $('coreTail').textContent = '评分越高=越该减仓';
    $('vOp').textContent = r.op === null ? '—' : r.op.toFixed(1);
    $('vOpSub').textContent = '原始 ' + (r.raw === null ? '—' : r.raw.toFixed(2)) + ' 的 3 日均';
    $('vSp').textContent = r.sp === null ? '—' : r.sp.toFixed(1);
    $('vSpSub').textContent = bandName(b);

    // 色带
    var barHtml = BAND_SEG.map(function (s, i) {
      return '<div class="seg" style="width:' + s.w + '%;background:' + BAND_COLOR[i] + '"></div>';
    }).join('');
    if (r.sp !== null) {
      barHtml += '<div class="mk" style="left:' + Math.max(0, Math.min(100, r.sp)) + '%"></div>';
    }
    $('vBar').innerHTML = barHtml;
    $('vTicks').innerHTML = [[0, 'P0'], [10, 'P10'], [20, 'P20'], [30, 'P30'], [70, 'P70'], [90, 'P90'], [100, 'P100']]
      .map(function (t) { return '<span style="left:' + t[0] + '%">' + t[1] + '</span>'; }).join('');

    $('vCurPos').textContent = pctf(sim.pos);
    $('vCurPosSub').textContent = sim.lastTradeDate ? ('末笔 ' + sim.lastTradeDate + ' 后维持') : '起始仓位';
    if (b === -1) {
      $('vTgt').textContent = '维持';
      $('vTgtSub').textContent = '死区不设新目标';
    } else {
      $('vTgt').textContent = pctf(SC.targetOf(r.sp, meta));
      $('vTgtSub').textContent = bandName(b) + ' 档位目标';
    }

    // 建议
    var adv = $('vAdv'), advCls = 'adv', txt;
    if (sim.todayTraded) {
      var lt = sim.trades[sim.trades.length - 1];
      advCls += ' act';
      txt = '今日已触发调仓：' + pctf(lt.from) + ' → ' + pctf(lt.to) +
        '<small>进入 ' + bandName(b) + '，成本 0.1% 已计入</small>';
    } else if (b === -1) {
      txt = '死区（P30-70）不操作，维持 ' + pctf(sim.pos);
      if (sim.bandChanged) {
        txt += '<small>档位已变化，但受间隔约束暂不调仓</small>';
      } else {
        txt += '<small>评分处于历史中段，不作方向性判断</small>';
      }
    } else if (sim.bandChanged) {
      advCls += ' act';
      txt = '已进入 ' + bandName(b) + '，目标 ' + pctf(SC.targetOf(r.sp, meta)) +
        '<small>但距上笔仅 ' + sim.gapDays + ' 个交易日（需 ≥' + meta.gap + '），暂不触发</small>';
    } else {
      txt = '维持 ' + pctf(sim.pos) + '<small>档位 ' + bandName(b) + '，与当前仓位一致</small>';
    }
    adv.className = advCls; adv.innerHTML = txt;

    renderMine(px, sim);
    renderTrig(px);
    renderRules(sim, meta, b);
    renderFactors(r, i1);
    bindManual();
  }

  function renderMine(px, sim) {
    var el = $('vMine');
    var mp = parseFloat($('myPos').value), mv = parseFloat($('myVal').value);
    if (!isFinite(mp) || !isFinite(mv)) {
      el.className = 'adv';
      el.innerHTML = '填入你的实际仓位与组合市值，自动算出需要买卖的金额与份额' +
        '<small>数据只保存在本机浏览器，不会上传</small>';
      return;
    }
    var diff = sim.pos - mp / 100;
    if (Math.abs(diff) < 0.005) {
      el.className = 'adv';
      el.innerHTML = '与目标一致，无需操作<small>实际 ' + mp.toFixed(0) + '% vs 策略 ' + pctf(sim.pos) + '</small>';
      return;
    }
    var amt = diff * mv;
    var shares = Math.floor(Math.abs(amt) / px / 100) * 100;
    var buy = amt > 0;
    el.className = 'adv act';
    el.innerHTML = (buy ? '需买入 ' : '需卖出 ') + Math.abs(amt).toFixed(0) + ' 元 ≈ ' + shares + ' 份' +
      '<small>实际 ' + mp.toFixed(1) + '% → 策略 ' + pctf(sim.pos) + '，按现价 ' + px.toFixed(3) + ' 折算（整手 100 份）</small>';
  }

  // 在不动状态的前提下探测某个假设价下的档位
  function probeAt(px) {
    var old = S.c[S.i1];
    S.c[S.i1] = px;
    var r = SC.tail(S.st, S.i1, S.c, S.a);
    S.c[S.i1] = old;
    SC.tail(S.st, S.i1, S.c, S.a);   // 复位 st 的标量状态
    return { band: SC.band(r.sp), op: r.op, sp: r.sp, target: SC.targetOf(r.sp, S.meta) };
  }

  function renderTrig(px) {
    var t = S.trig, el = $('vTrig'), curPos = S.sim.pos;
    var rows = [];

    // 某方向在 ±25% 内没解时，放宽到 ±50% 再找一次，至少给个量级
    var wide = null;
    if (!t.up || !t.down) {
      wide = SC.findTrigger(S.st, S.c, S.a, S.dates, S.meta, S.i1, px * 0.5, px * 1.5, 300);
    }

    function line(lab, r, isWide) {
      var chg = (r.px / px - 1) * 100;
      var s = lab + ' 到 <b>' + r.px.toFixed(3) + '</b>（' + (chg > 0 ? '+' : '') + chg.toFixed(1) + '%）' +
        ' → ' + bandName(r.band) + '，目标 ' + pctf(r.target) +
        '　<span style="color:var(--tx3)">评分 ' + r.op.toFixed(1) + ' / 分位 ' + r.sp.toFixed(1) + '</span>';
      if (Math.abs(r.target - curPos) < 1e-9) {
        s += '<br><span style="color:var(--tx3);font-size:12px">目标与当前应持仓位相同，实际不会产生交易</span>';
      }
      if (isWide) {
        s += '<br><span style="color:var(--tx3);font-size:12px">超出 ±25% 常规区间，仅作量级参考</span>';
      }
      return s;
    }

    [['价格<span class="up">上涨</span>', 'up'], ['价格<span class="down">下跌</span>', 'down']].forEach(function (p) {
      var lab = p[0], key = p[1];
      if (t[key]) { rows.push(line(lab, t[key], false)); return; }
      if (wide && wide[key]) { rows.push(line(lab, wide[key], true)); return; }
      var endPx = key === 'up' ? px * 1.25 : px * 0.75;
      var e = probeAt(endPx);
      rows.push(lab + '：±25% 内未跨档，到 ' + endPx.toFixed(3) + '（' +
        (key === 'up' ? '+25' : '-25') + '%）时仍在 ' + bandName(e.band) +
        '　<span style="color:var(--tx3)">分位 ' + e.sp.toFixed(1) + '</span>');
    });

    el.innerHTML = rows.map(function (s) {
      return '<div style="padding:7px 0;border-bottom:1px solid var(--line);font-size:14px">' + s + '</div>';
    }).join('');
    $('vTrigNote').innerHTML =
      '常规扫描区间 ±25%（' + (px * 0.75).toFixed(3) + ' ~ ' + (px * 1.25).toFixed(3) + '）。' +
      '仅变动"今日价"这一个变量，其它条件冻结；实际分位会随整个序列变化而漂移，仅供量级参考。<br>' +
      '注意：40日收益差是<b>反向</b>因子（占 50% 权重）——价格越涨、相对指数跑赢越多，评分反而越低。' +
      '所以本策略本质是均值回归，"涨价→降档/减仓"是正常现象，不要按趋势策略的直觉理解。';
  }

  function renderRules(sim, meta, b) {
    var gapOK = sim.gapDays === null || sim.gapDays >= meta.gap;
    var rows = [
      ['间隔 ≥ ' + meta.gap + ' 个交易日',
        (sim.gapDays === null ? '—' : ('距上笔 ' + sim.gapDays + ' 日')) +
        '<span class="tag ' + (gapOK ? 'ok' : 'no') + '">' + (gapOK ? '满足' : '不足') + '</span>'],
      ['确认 ' + meta.confirm + ' 个交易日', '进入新档位当日确认<span class="tag ok">已配置</span>'],
      ['末笔交易', sim.lastTradeDate
        ? (sim.lastTradeDate + '　' + pctf(sim.lastTradeFrom) + ' → ' + pctf(sim.lastTradeTo))
        : '无'],
      ['今日档位 / 策略档位', bandName(sim.todayBand) + ' / ' + bandName(sim.curBand) +
        (sim.bandChanged ? '<span class="tag no">已变未触发</span>' : '')],
      ['单次调仓成本 / 本金', (meta.cost * 100).toFixed(1) + '% / ' + meta.capital.toFixed(0) + ' 元'],
      ['仓位上下限', pctf(meta.targets[0]) + ' ~ ' + pctf(meta.targets[5])]
    ];
    $('vRules').innerHTML = rows.map(function (r) {
      return '<div class="kv"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + '</span></div>';
    }).join('');
    $('vBt').innerHTML = '<b style="color:var(--up)">' + (sim.eqPct >= 0 ? '+' : '') + sim.eqPct.toFixed(2) + '%</b>' +
      '　回撤 ' + sim.mddPct.toFixed(1) + '%　' + sim.nt + ' 笔';
  }

  function renderFactors(r, i1) {
    var pB = SC.pct(S.st.bias, i1, r.bias), pR = SC.pct(S.st.rsi, i1, r.rsi);
    var rd = (i1 >= 40 && S.c[i1 - 40] && S.a[i1] && S.a[i1 - 40])
      ? ((S.c[i1] / S.c[i1 - 40] - 1) - (S.a[i1] / S.a[i1 - 40] - 1)) * 100 : null;
    var c1 = 0.50 * (100 - r.pd), c2 = 0.25 * (100 - pB), c3 = 0.25 * (100 - pR);
    var rows = [
      ['40日收益差(对399317)', rd === null ? '—' : (rd >= 0 ? '+' : '') + rd.toFixed(2) + '%', r.pd, '50%', c1],
      ['250日乖离', (r.bias >= 0 ? '+' : '') + r.bias.toFixed(2) + '%', pB, '25%', c2],
      ['RSI14', r.rsi.toFixed(2), pR, '25%', c3]
    ];
    var html = '<tr><th>因子</th><th>数值</th><th>分位</th><th>权重</th><th>贡献</th></tr>';
    rows.forEach(function (x) {
      html += '<tr><td>' + x[0] + '</td><td>' + x[1] + '</td><td>' + x[2].toFixed(1) +
        '</td><td>' + x[3] + '</td><td>' + x[4].toFixed(2) + '</td></tr>';
    });
    html += '<tr><td><b>原始评分</b></td><td colspan="3" style="text-align:right;color:var(--tx3)">三项相加</td><td><b>' +
      r.raw.toFixed(2) + '</b></td></tr>';
    $('vFactors').innerHTML = html;

    $('vLegend').innerHTML = BAND_SEG.map(function (s, i) {
      return '<span><i style="background:' + BAND_COLOR[i] + '"></i>' + s.name +
        (s.tgt === null ? ' 不操作' : ' ' + pctf(s.tgt)) + '</span>';
    }).join('');
  }

  /* ================= 交互 ================= */
  function bindManual() {
    var btn = $('manualBtn');
    if (btn && !btn.__bound) {
      btn.__bound = true;
      btn.onclick = function () {
        var v = parseFloat($('manualPx').value);
        if (!isFinite(v) || v <= 0) return;
        S.pxSrc = 'manual';
        S.c[S.i1] = v;
        recomputeTail();
      };
    }
    ['myPos', 'myVal'].forEach(function (id) {
      var el = $(id);
      if (el.__bound) return;
      el.__bound = true;
      el.addEventListener('input', function () {
        try { localStorage.setItem('515450_' + id, el.value); } catch (e) { }
        if (S.sim) renderMine(S.c[S.i1], S.sim);
      });
    });
  }

  // 只改最后一天的价格：tail + simulate 重算，不重建历史（约 0.01ms）
  function recomputeTail() {
    S.res = SC.tail(S.st, S.i1, S.c, S.a);
    S.sim = SC.simulate(S.st, S.c, S.dates, S.meta, S.i1);
    var px0 = S.c[S.i1];
    S.trig = SC.findTrigger(S.st, S.c, S.a, S.dates, S.meta, S.i1, px0 * 0.75, px0 * 1.25, 200);
    render();
  }

  function restoreInputs() {
    try {
      var p = localStorage.getItem('515450_myPos'), v = localStorage.getItem('515450_myVal');
      if (p) $('myPos').value = p;
      if (v) $('myVal').value = v;
    } catch (e) { }
  }

  /* ================= 启动 ================= */
  function boot() {
    restoreInputs();
    loadRealtime(function (ok) {
      S.rtOK = ok;
      if (ok) {
        var rt = parseRealtime();
        if (rt) { S.rt = rt; S.px = rt.px; S.pxPrev = rt.prev; S.pxChgPct = rt.chgPct; S.pxTime = tss(rt.time); S.pxSrc = 'rt'; }
        else { S.rtOK = false; }
      }
      fetchHist(function (em, im) {
        S.histOK = mergeHist(em, im);
        if (S.rtOK && S.rt) applyRealtime(S.rt);
        compute();
        render();
      });
    });
  }

  // 调试钩子：供自动化诊断脚本改价、读取内部状态
  window.__APP = {
    S: S, render: render,
    setPx: function (px) { S.pxSrc = 'manual'; S.c[S.i1] = px; recomputeTail(); },
    snap: function () {
      return {
        date: S.dates[S.i1], px: S.c[S.i1], op: S.res.op, sp: S.res.sp,
        band: SC.band(S.res.sp), pos: S.sim.pos, nt: S.sim.nt,
        eqPct: S.sim.eqPct, gapDays: S.sim.gapDays,
        lastTrade: S.sim.lastTradeDate, todayTraded: S.sim.todayTraded,
        rtOK: S.rtOK, histOK: S.histOK, appended: S.appended, rebaseK: S.rebaseK
      };
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
