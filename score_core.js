/* score_core.js — 515450 v6 评分计算核心（node / 浏览器共用）
 *
 * 口径与权威脚本 strategy_v6_test.py 逐项对齐：
 *   评分 = 50% × 40日收益差(分位) + 25% × 250日乖离(分位) + 25% × RSI14(分位)
 *   op   = round(3日均, 1)   —— 注意 Python 是银行家取整，用 r1() 复刻
 *   sp_  = op 自身的历史扩展分位（因果，<=）
 *   档位 P0-10=25% / P10-20=35% / P20-30=45% / P30-70 死区 / P70-80=80% / P80-90=90% / P90-100=100%
 *
 * 一个重要性质：所有因子都是因果的（只依赖当日及之前的数据），
 * 因此「改最后一天的价格」只会改变最后一天的 raw/op/sp，历史完全不变。
 * 触发价二分正是利用这一点做到 O(n) 每次。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScoreCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 银行家取整：复刻 Python round(x, 1) ----------
   * Python 的 round 基于 double 的精确十进制值做 half-to-even；
   * JS 的 Math.round / toFixed 是 half-up，会在 op 上产生 0.1 的偏差，
   * 进而污染 sp_ 与档位。只有 x 恰好等于 (f+0.5)/10（可二进制精确表示）
   * 时才需要走 half-even 分支，其余情况 Math.round 与 Python 一致。 */
  function r1(x) {
    var s = x < 0 ? -1 : 1, a = Math.abs(x), t = a * 10, f = Math.floor(t);
    var q = (a === (f + 0.5) / 10) ? ((f % 2 === 0) ? f : f + 1) : Math.round(t);
    return s * q / 10;
  }

  /* 百分位：非 null 值中 <= v 的占比；空集返回 50 */
  function pct(arr, upto, v) {
    var cnt = 0, tot = 0;
    for (var i = 0; i <= upto; i++) {
      var x = arr[i];
      if (x === null || x === undefined) continue;
      tot++;
      if (x <= v) cnt++;
    }
    return tot ? 100.0 * cnt / tot : 50.0;
  }

  /* 扩展分位（对已去重的累积直方图做 <= 计数，语义同上） */
  function pctPush(hist, v) {
    var cnt = 0, tot = hist.length;
    for (var i = 0; i < tot; i++) if (hist[i] <= v) cnt++;
    return tot ? 100.0 * cnt / tot : 50.0;
  }

  /* ---------- 档位 ---------- */
  function band(p) {
    if (p === null || p === undefined) return null;
    if (p >= 30 && p < 70) return -1;   // 死区
    if (p < 10) return 0;
    if (p < 20) return 1;
    if (p < 30) return 2;
    if (p < 80) return 3;
    if (p < 90) return 4;
    return 5;
  }
  var BAND_NAMES = ['P0-10', 'P10-20', 'P20-30', 'P70-80', 'P80-90', 'P90-100'];

  /* 档位序号（按仓位从低到高排）。注意 band 编号本身不单调：
   * P20-30 是 2，死区是 -1，P70-80 是 3 —— 死区在数值上夹在中间，
   * 所以判断"升档/降档"必须用这个序号而不是 band 编号。 */
  function ord(b) {
    if (b === null || b === undefined) return null;
    if (b === -1) return 3;
    return b <= 2 ? b : b + 1;
  }

  function targetOf(p, meta) {
    var b = band(p);
    if (b === -1 || b === null) return 0.50;
    return meta.targets[b];
  }

  /* ---------- 状态 ---------- */
  function makeState(n) {
    return {
      done: 0,
      ag: 0, al: 0,          // RSI Wilder 递推状态（处理完 i-1 后的值）
      winSum: 0,             // 250 日滑窗和（处理完 i-1 后为 c[i-250..i-1]）
      rdHist: [],            // 40日收益差全量历史
      opHist: [],            // op 的非空历史
      rsi: new Array(n), bias: new Array(n), pd: new Array(n),
      raw: new Array(n), op: new Array(n), sp: new Array(n)
    };
  }

  function snap(st) {
    return { ag: st.ag, al: st.al, winSum: st.winSum, r0: st.rdHist.length, o0: st.opHist.length, done: st.done };
  }
  function restore(st, s) {
    st.ag = s.ag; st.al = s.al; st.winSum = s.winSum;
    st.rdHist.length = s.r0; st.opHist.length = s.o0; st.done = s.done;
  }

  /* ---------- 单日推进：算出索引 i 的全部因子 ----------
   * 前置条件：0..i-1 已推进完毕（i===0 时无需前置）。
   * 复杂度 O(i)（两次 pct 扫描）。 */
  function step(st, i, c, a) {
    var n = c.length;

    // --- RSI14（Wilder）：i<=14 累加，i==14 取均值，之后递推 ---
    if (i >= 1) {
      var ch = c[i] - c[i - 1], g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      if (i <= 14) {
        st.ag += g; st.al += l;
        if (i === 14) { st.ag = st.ag / 14; st.al = st.al / 14; }
      } else {
        st.ag = (st.ag * 13 + g) / 14; st.al = (st.al * 13 + l) / 14;
      }
    }
    st.rsi[i] = (i >= 14) ? ((st.ag + st.al) > 0 ? 100 * st.ag / (st.ag + st.al) : 100.0) : null;

    // --- bias250 ---
    if (i === 249) {
      var s0 = 0;
      for (var k = 0; k <= 249; k++) s0 += c[k];
      st.winSum = s0;
    } else if (i > 249) {
      st.winSum += c[i] - c[i - 250];
    }
    st.bias[i] = (i >= 249) ? (c[i] / (st.winSum / 250) - 1) * 100 : null;

    // --- 40日收益差（相对国证A指 399317）的扩展分位 ---
    var aNow = (a[i] === null || a[i] === undefined) ? null : a[i];
    var a40 = (i >= 40 && a[i - 40] !== null && a[i - 40] !== undefined) ? a[i - 40] : null;
    if (aNow && a40 && c[i] && c[i - 40]) {
      var d = (c[i] / c[i - 40] - 1) - (aNow / a40 - 1);
      st.rdHist.push(d);
      st.pd[i] = (st.rdHist.length >= 60) ? pctPush(st.rdHist, d) : null;
    } else {
      st.pd[i] = null;
    }

    // --- 原始评分 ---
    if (st.bias[i] === null || st.pd[i] === null) {
      st.raw[i] = null;
    } else {
      st.raw[i] = 0.50 * (100 - st.pd[i])
                + 0.25 * (100 - pct(st.bias, i, st.bias[i]))
                + 0.25 * (100 - pct(st.rsi, i, st.rsi[i]));
    }

    // --- 操作评分（3日均，银行家取整到 1 位） ---
    if (i >= 2 && st.raw[i] !== null && st.raw[i - 1] !== null && st.raw[i - 2] !== null) {
      st.op[i] = r1((st.raw[i] + st.raw[i - 1] + st.raw[i - 2]) / 3);
    } else {
      st.op[i] = null;
    }

    // --- 评分自身的扩展分位 ---
    if (st.op[i] === null) {
      st.sp[i] = null;
    } else {
      st.opHist.push(st.op[i]);
      st.sp[i] = pctPush(st.opHist, st.op[i]);
    }
    st.done = i + 1;
  }

  /* 全量构建：从 0 推进到 closes.length-1，O(n^2)，1588 天约数十毫秒 */
  function build(closes, aCloses, meta) {
    var n = closes.length;
    var st = makeState(n);
    for (var i = 0; i < n; i++) step(st, i, closes, aCloses);
    return st;
  }

  /* 单步求值：在 st（已推进到 i，即 0..i-1 就绪）上用当前 closes/aCloses 算出第 i 天。
   * 结果写回 st 的数组中，但标量状态回滚 —— 因此可反复调用做二分，零拷贝。 */
  function tail(st, i, closes, aCloses) {
    var s = snap(st);
    step(st, i, closes, aCloses);
    var out = {
      rsi: st.rsi[i], bias: st.bias[i], pd: st.pd[i],
      raw: st.raw[i], op: st.op[i], sp: st.sp[i]
    };
    restore(st, s);
    return out;
  }

  /* ---------- 回测模拟 ----------
   * 与 Python simulate(gap, confirm, i_start) 一致；sp 用 st.sp 数组。 */
  function simulate(st, closes, dates, meta, i1, iStart) {
    var i0 = (iStart === undefined || iStart === null) ? meta.i0 : iStart;
    var COST = meta.cost, CAP = meta.capital, gap = meta.gap, confirm = meta.confirm;

    var t0 = band(st.sp[i0]);
    var pos = (t0 === -1 || t0 === null) ? 0.50 : meta.targets[t0];
    var eq = CAP, lastTrade = -99, trades = [];
    var peak = eq, mdd = 0.0, trough = '';
    var curBand = t0, pendBand = null, pendDays = 0;

    for (var i = i0 + 1; i <= i1; i++) {
      eq *= 1 + pos * (closes[i] / closes[i - 1] - 1);
      if (eq > peak) peak = eq;
      if (1 - eq / peak > mdd) { mdd = 1 - eq / peak; trough = dates[i]; }

      var b = band(st.sp[i]);
      if (b === null) continue;
      if (b === pendBand) pendDays++;
      else { pendBand = b; pendDays = 1; }

      if (b !== curBand && pendDays >= confirm && i - lastTrade >= gap) {
        if (b === -1) {
          curBand = b;
        } else {
          var tgt = meta.targets[b];
          var d = tgt - pos;
          if (Math.abs(d) > 1e-9) {
            eq *= 1 - COST * Math.abs(d);
            trades.push({ date: dates[i], op: st.op[i], sp: st.sp[i], from: pos, to: tgt, px: closes[i] });
            pos = tgt; lastTrade = i;
          }
          curBand = b;
        }
      }
    }
    var last = trades.length ? trades[trades.length - 1] : null;
    var todayBand = band(st.sp[i1]);
    return {
      eq: eq, eqPct: (eq / CAP - 1) * 100, mdd: mdd, mddPct: mdd * 100, trough: trough,
      trades: trades, nt: trades.length, pos: pos,
      todayBand: todayBand,   // 今日评分所处的档位
      curBand: curBand,       // 策略当前认定的档位（触发后会被更新为今日档位）
      bandChanged: curBand !== todayBand,   // 档位已变但未触发（通常是间隔不足）
      lastTradeIdx: lastTrade,
      lastTradeDate: last ? last.date : null,
      lastTradeFrom: last ? last.from : null,
      lastTradeTo: last ? last.to : null,
      gapDays: lastTrade >= 0 ? (i1 - lastTrade) : null,
      todayTraded: !!last && last.date === dates[i1]
    };
  }

  /* ---------- 触发价：网格扫描 ----------
   * 固定其它条件，把"今日价"作为唯一变量，找跳出当前档位的最近临界价。
   *
   * 为什么不用二分：50% 权重的 40日收益差是**反向**因子（价越高 -> 收益差分位越高
   * -> 100-分位 越低 -> 评分越低），而乖离/RSI 是正向因子，两者叠加后
   * 评分对价格并非单调，二分会给出错误答案。网格扫描每次 O(n)，
   * 300 个采样点实测仅几毫秒，比正确性重要得多。 */
  function findTrigger(stBase, closes, aCloses, dates, meta, i1, lo, hi, steps) {
    steps = steps || 150;
    var orig = closes[i1];
    var cur = tail(stBase, i1, closes, aCloses);
    var curOrd = ord(band(cur.sp));
    var out = { curBand: band(cur.sp), curOrd: curOrd, up: null, down: null, lo: lo, hi: hi };

    function probe(p) {
      closes[i1] = p;
      var r = tail(stBase, i1, closes, aCloses);
      return { px: p, band: band(r.sp), ord: ord(band(r.sp)), op: r.op, sp: r.sp, target: targetOf(r.sp, meta) };
    }

    // 向上扫描：从当前价到 hi。只判断"档位变了"，不预设变高还是变低
    // （实测评分对价格是单调递减的：50% 权重的收益差是反向因子，压过了
    //  乖离与 RSI 的正向贡献，所以涨价反而会掉到更低的档位）
    var span = (hi - orig) / steps;
    for (var k = 1; k <= steps; k++) {
      var r1 = probe(orig + span * k);
      if (r1.ord !== null && curOrd !== null && r1.ord !== curOrd) {
        r1.dir = r1.ord > curOrd ? 'up' : 'down';
        out.up = r1; break;
      }
    }
    // 向下扫描：从当前价到 lo
    var span2 = (orig - lo) / steps;
    for (var k2 = 1; k2 <= steps; k2++) {
      var r2 = probe(orig - span2 * k2);
      if (r2.ord !== null && curOrd !== null && r2.ord !== curOrd) {
        r2.dir = r2.ord > curOrd ? 'up' : 'down';
        out.down = r2; break;
      }
    }

    closes[i1] = orig;                 // 复位
    tail(stBase, i1, closes, aCloses); // 恢复 st.sp[i1] 为真实值
    return out;
  }

  return {
    r1: r1, pct: pct, band: band, ord: ord, targetOf: targetOf, BAND_NAMES: BAND_NAMES,
    makeState: makeState, step: step, build: build, tail: tail,
    simulate: simulate, findTrigger: findTrigger, snap: snap, restore: restore
  };
});
