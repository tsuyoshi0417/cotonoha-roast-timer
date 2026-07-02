/* ============================================================
   言ノ葉 焙煎タイマー ― 測定・計算の純関数（外出し・v2.0 魔改造 2026-07-02）
   - ブラウザ：window.RoastMetrics として読み込む（焙煎タイマー.html から <script src>）
   - node   ：module.exports（roast-test.js が直接テストする）
   - DOM・localStorage・Firebase に一切触らない＝計算だけ。
   守る一線：正直な測定ラベルは LABELS がアプリで唯一の真実。
   UIはここから文言を読み、roast-test.js が内容を機械強制する
   （BRIX＝糖度の近似・ROR＝経験則・n少は「記録」＝統計断定しない）。
   ============================================================ */
(function (global) {
  "use strict";

  /* ---- n（焼いた回数）がこれ未満のうちは「傾向」でなく「記録」---- */
  var N_TREND_MIN = 10;

  /* ---- 正直な測定ラベル（唯一の真実・UIはここから読む）---- */
  var LABELS = {
    tds: "TDS％＝抽出液の総溶解固形分。VST/SCAのbrewing control chartで使われる確立した指標（◎）。",
    ey: "抽出収率EY％＝豆から液に出た成分の割合＝TDS％×液量g÷粉g。SCAの18〜22％はあくまで目安・最終判断は味。",
    brix: "Brix＝屈折計の読み＝珈琲では糖度の近似（珈琲の溶質はショ糖だけではない）。甘さそのものではない＝甘さの断定には使わない。TDSの参考値。",
    ror: "ROR（℃/分）＝温度上昇率。焙煎業界の経験則の指標で、科学的証明ではない（学術裏付けは弱い）。再現の目印として使う。",
    n: "nが少ないうちは「記録」＝傾向・相関の断定はしない。nが増えると傾向が見えてくる。"
  };

  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  /* ---- 重量減％＝(生豆−焙煎後)÷生豆×100 ---- */
  function calcLoss(greenG, roastedG) {
    var g = num(greenG), r = num(roastedG);
    if (g === null || r === null || g <= 0 || r < 0 || r > g) return null;
    return (g - r) / g * 100;
  }

  /* ---- DTR％（発達率）＝(煎り止め−1ハゼ開始)÷煎り止め×100（秒） ---- */
  function calcDTR(fcSec, dropSec) {
    var fc = num(fcSec), drop = num(dropSec);
    if (fc === null || drop === null || drop <= 0 || fc < 0 || fc > drop) return null;
    return (drop - fc) / drop * 100;
  }

  /* ---- 抽出収率EY％＝TDS％×液量g÷粉g
         透過（エスプレッソ等）＝液量＝抽出量g／浸漬（カッピング等）＝液量＝湯量g（簡易・近似） ---- */
  function calcEY(tdsPct, liquidG, doseG) {
    var t = num(tdsPct), l = num(liquidG), d = num(doseG);
    if (t === null || l === null || d === null || d <= 0 || t < 0 || l <= 0) return null;
    return t * l / d;
  }

  /* ---- 温度カーブの補間：時刻tSec時点の温度（線形）。範囲外はnull ---- */
  function tempAt(series, tSec) {
    if (!series || !series.length) return null;
    var t = num(tSec);
    if (t === null) return null;
    var i, a = null, b = null;
    for (i = 0; i < series.length; i++) {
      var p = series[i];
      if (p == null || num(p.t) === null || num(p.temp) === null) continue;
      if (p.t <= t && (a === null || p.t > a.t)) a = p;
      if (p.t >= t && (b === null || p.t < b.t)) b = p;
    }
    if (a === null || b === null) return null;
    if (a.t === b.t) return num(a.temp);
    return num(a.temp) + (num(b.temp) - num(a.temp)) * (t - a.t) / (b.t - a.t);
  }

  /* ---- ROR点列（℃/分）＝隣り合う記録点の差分。間隔が近すぎる点（<5秒）はノイズなのでスキップ ---- */
  function rorPoints(series) {
    var out = [];
    if (!series || series.length < 2) return out;
    var prev = null, i;
    for (i = 0; i < series.length; i++) {
      var p = series[i];
      if (p == null || num(p.t) === null || num(p.temp) === null) continue;
      if (prev !== null) {
        var dt = p.t - prev.t;
        if (dt >= 5) {
          out.push({ t: p.t, ror: (num(p.temp) - num(prev.temp)) / (dt / 60) });
          prev = p;
        }
        /* dt<5秒＝直前点を保持して次と比較（連打補正のノイズを平す） */
      } else {
        prev = p;
      }
    }
    return out;
  }

  /* ---- 区間平均ROR（℃/分）＝(温度b−温度a)÷(分)。境界温度は線形補間 ---- */
  function rorBetween(series, aSec, bSec) {
    var a = num(aSec), b = num(bSec);
    if (a === null || b === null || b <= a) return null;
    var ta = tempAt(series, a), tb = tempAt(series, b);
    if (ta === null || tb === null) return null;
    return (tb - ta) / ((b - a) / 60);
  }

  /* ---- 節目ごとの区間平均ROR。marks={bottom,fc,drop}（秒）。取れない区間はnull ---- */
  function rorPhases(series, marks) {
    marks = marks || {};
    return {
      bottomToFc: rorBetween(series, marks.bottom, marks.fc),   // 中点→1ハゼ
      fcToDrop: rorBetween(series, marks.fc, marks.drop),       // 1ハゼ→煎り止め（発達）
      bottomToDrop: rorBetween(series, marks.bottom, marks.drop) // 中点→煎り止め（全体）
    };
  }

  /* ---- n の正直ラベル：n<N_TREND_MIN＝「記録」モード（傾向・相関の断定を出さない）---- */
  function nLabel(n) {
    var v = num(n); if (v === null || v < 0) v = 0;
    if (v < N_TREND_MIN) {
      return { mode: "record",
        text: "n=" + v + "＝まだ「記録」の段階。傾向・相関の断定はしない（n≥" + N_TREND_MIN + "で傾向が見えてくる）。" };
    }
    return { mode: "trend",
      text: "n=" + v + "＝傾向を眺めてよい量。それでも「断定」でなく「目安」（最終判断は味）。" };
  }

  var api = {
    N_TREND_MIN: N_TREND_MIN,
    LABELS: LABELS,
    calcLoss: calcLoss,
    calcDTR: calcDTR,
    calcEY: calcEY,
    tempAt: tempAt,
    rorPoints: rorPoints,
    rorBetween: rorBetween,
    rorPhases: rorPhases,
    nLabel: nLabel
  };

  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  else { global.RoastMetrics = api; }
})(typeof window !== "undefined" ? window : this);
