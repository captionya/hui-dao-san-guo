/* =========================================================
   三国模拟人生 — 判定引擎（纯函数，无依赖）
   结算权在这里，不在模型手里。
   浏览器里挂到 window.SGEngine；Node 里可以 require 用于测试。
   ========================================================= */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SGEngine = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ---------------- 难度 ---------------- */

  const DIFFICULTIES = {
    storybook: {
      id: "storybook",
      label: "沙盒",
      deathScale: 0.5,
      heal: 4,
      fatalRequiresRisk: 3,
      rewind: true,
      budget: 0,
      note: "默认不会死，只有明确致命的行动才会死"
    },
    history: {
      id: "history",
      label: "史实",
      deathScale: 1,
      heal: 2,
      fatalRequiresRisk: 2,
      rewind: true,
      budget: 12,
      note: "乱世会死人，但不会轻易死"
    },
    ironman: {
      id: "ironman",
      label: "铁人",
      deathScale: 1.35,
      heal: 1,
      fatalRequiresRisk: 2,
      rewind: false,
      budget: 0,
      note: "死亡即锁档，不可回读"
    }
  };

  const DEFAULT_DIFFICULTY = "history";
  const TIERS = ["success", "cost", "light", "serious", "dying", "dead"];

  /* ---------------- 结算分布 ---------------- */

  // 每个风险等级的基准分布（未受状态影响）
  const TABLE = {
    0: { success: 0.97, cost: 0.03, light: 0, serious: 0, dying: 0, dead: 0 },
    1: { success: 0.68, cost: 0.20, light: 0.10, serious: 0.02, dying: 0, dead: 0 },
    2: { success: 0.30, cost: 0.22, light: 0.22, serious: 0.18, dying: 0.06, dead: 0.02 },
    3: { success: 0.02, cost: 0.05, light: 0.08, serious: 0.35, dying: 0.30, dead: 0.20 }
  };

  const HP_LOSS = { success: 0, cost: 0, light: 8, serious: 20, dying: 34, dead: 100 };
  const INJURY_ADD = { success: 0, cost: 0, light: 1, serious: 2, dying: 3, dead: 3 };

  const WOUND_TEXT = {
    success: "",
    cost: "",
    light: "皮肉之伤，出血不多，但动起来疼",
    serious: "断骨或深创，持续失血，行动严重受限",
    dying: "重伤失能，意识时有时无",
    dead: "当场毙命"
  };

  /* ---------------- 工具 ---------------- */

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function random(rng) {
    return typeof rng === "function" ? rng() : Math.random();
  }

  function difficultyOf(id) {
    return DIFFICULTIES[id] || DIFFICULTIES[DEFAULT_DIFFICULTY];
  }

  /* ---------------- 状态 ---------------- */

  function createState(opts) {
    const o = opts || {};
    return {
      version: 2,
      name: o.name || "",
      age: typeof o.age === "number" ? o.age : 0,
      identity: o.identity || "",
      hp: 100,
      injury: 0,           // 0 无伤 1 轻伤 2 重伤 3 濒死
      alive: true,
      turn: 0,
      difficulty: o.difficulty || DEFAULT_DIFFICULTY,
      causeOfDeath: "",
      epitaph: "",
      wounds: [],
      lastLethalTurn: -999,
      legacy: o.legacy || null,
      createdAt: o.createdAt || new Date().toISOString()
    };
  }

  function injuryLabel(injury) {
    return ["无伤", "轻伤", "重伤", "濒死"][clamp(injury, 0, 3)] || "无伤";
  }

  function isDead(state) {
    return !state || state.alive === false || state.hp <= 0 || state.injury >= 4;
  }

  /* ---------------- 判定 ---------------- */

  /**
   * 掷骰并给出结算档位。纯函数：同样的 state + risk + rng 序列得到同样结果。
   */
  function resolve(input) {
    const state = input.state;
    const risk = clamp(Math.round(input.risk == null ? 1 : input.risk), 0, 3);
    const diff = difficultyOf(input.difficulty || state.difficulty);
    const rng = input.rng || Math.random;

    const base = TABLE[risk] || TABLE[1];

    // 状态惩罚：伤势越重、体力越低，越容易出事
    const injuryPenalty = state.injury * 0.07;
    const hpPenalty = state.hp < 60 ? ((60 - state.hp) / 60) * 0.30 : 0;
    const penalty = clamp(injuryPenalty + hpPenalty, 0, 0.75);

    // 成功概率被惩罚压缩，减少的部分按权重摊到失败档位
    const pSuccess = base.success * (1 - penalty);
    const rest = 1 - pSuccess;

    const weights = {
      cost: base.cost,
      light: base.light,
      serious: base.serious * diff.deathScale,
      dying: base.dying * diff.deathScale,
      dead: base.dead * diff.deathScale
    };
    const weightSum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;

    const probs = { success: pSuccess };
    TIERS.slice(1).forEach(function (t) {
      probs[t] = (weights[t] / weightSum) * rest;
    });

    // 掷骰
    let r = random(rng);
    let tier = "success";
    let acc = 0;
    for (let i = 0; i < TIERS.length; i++) {
      const t = TIERS[i];
      acc += probs[t] || 0;
      if (r < acc) { tier = t; break; }
      tier = t;
    }

    let downgraded = "";

    // 致命行为的下限：判定为"致命"的行动，结果至少是重伤。
    // 避免出现"从城头跳下去只擦破一块皮"这种叙事事故。
    if (risk === 3 && (tier === "success" || tier === "cost" || tier === "light")) {
      tier = "serious";
      downgraded = "lethal_floor";
    }

    // 致命门槛：沙盒里只有明确致命的行为才会死
    if (tier === "dead" && risk < diff.fatalRequiresRisk) {
      tier = "dying";
      downgraded = "risk_below_fatal_threshold";
    }

    // 死亡预算：史实档里，刚经历过生死关头的角色不会立刻再被判死
    if (tier === "dead" && diff.budget > 0 && state.turn - state.lastLethalTurn < diff.budget) {
      tier = "dying";
      downgraded = "death_budget";
    }

    // 濒死状态下再挨一击 = 死
    if (state.injury >= 3 && (tier === "serious" || tier === "dying")) {
      tier = "dead";
      downgraded = downgraded || "already_dying";
    }

    return {
      risk: risk,
      tier: tier,
      tierIndex: TIERS.indexOf(tier),
      probSuccess: Number(pSuccess.toFixed(4)),
      roll: Number(r.toFixed(4)),
      downgraded: downgraded,
      difficulty: diff.id,
      lethal: tier === "dead"
    };
  }

  /**
   * 把结算写回状态。返回新状态（不修改入参）。
   */
  function applyOutcome(state, outcome, difficultyId) {
    const diff = difficultyOf(difficultyId || state.difficulty);
    const next = JSON.parse(JSON.stringify(state));

    next.turn = (next.turn || 0) + 1;
    next.difficulty = diff.id;

    const loss = HP_LOSS[outcome.tier] || 0;
    next.hp = clamp(next.hp - loss, 0, 100);

    const add = INJURY_ADD[outcome.tier] || 0;
    if (add > 0) {
      next.injury = clamp(next.injury + add, 0, 4);
      const text = WOUND_TEXT[outcome.tier];
      if (text) {
        next.wounds = (next.wounds || []).slice(-4);
        next.wounds.push(text);
      }
    }

    if (outcome.tier === "dying" || outcome.tier === "dead") {
      next.lastLethalTurn = next.turn;
    }

    // 自然恢复：每回合回血；伤得重恢复慢
    if (outcome.tier === "success" || outcome.tier === "cost") {
      const heal = diff.heal;
      next.hp = clamp(next.hp + heal, 0, 100);
      if (next.injury > 0 && next.hp > 85 && next.turn % 4 === 0) {
        next.injury = clamp(next.injury - 1, 0, 4);
      }
    }

    // 年龄：每 36 回合长一岁（一回合按一旬粗算）
    if (next.age && next.turn % 36 === 0) {
      next.age += 1;
    }

    if (next.hp <= 0 || next.injury >= 4 || outcome.tier === "dead") {
      next.alive = false;
      next.hp = 0;
      next.injury = 4;
    }

    return next;
  }

  /* ---------------- 给模型看的摘要 ---------------- */

  function stateSummary(state) {
    const parts = [];
    if (state.name) parts.push("姓名：" + state.name);
    if (state.age) parts.push("年龄：" + state.age);
    if (state.identity) parts.push("身份：" + state.identity);
    parts.push("第 " + (state.turn || 0) + " 回合");
    parts.push("体力：" + clamp(state.hp, 0, 100) + "/100");
    parts.push("伤势：" + (state.alive ? injuryLabel(state.injury) : "已死"));
    if (state.wounds && state.wounds.length) {
      parts.push("具体伤：" + state.wounds[state.wounds.length - 1]);
    }
    return parts.join("｜");
  }

  /* ---------------- 墓志铭解析 ---------------- */

  function extractEpitaph(text) {
    if (!text) return "";
    const m = String(text).match(/墓志铭[:：]\s*(.+)/);
    if (!m) return "";
    const raw = m[1].trim().slice(0, 80);
    // 去掉书名号/括号包裹
    const inner = raw.replace(/^[〈《（(【\[]+/, "").replace(/[〉》）)】\]]+$/, "").trim();
    if (!inner) return "";
    // 叙述者偷懒写的占位符
    if (/^(无|无字|没有|略|空|待补|不详|—+|－+|-+)$/.test(inner)) return "";
    return inner;
  }

  function extractIdentity(text) {
    const out = { name: "", age: 0 };
    if (!text) return out;
    const n = String(text).match(/姓名[:：]\s*([^\n，,；;]{1,12})/);
    if (n) out.name = n[1].trim();
    const a = String(text).match(/年龄[:：]\s*([0-9]{1,2})/);
    if (a) out.age = parseInt(a[1], 10);
    return out;
  }

  /* ---------------- 导出 ---------------- */

  return {
    DIFFICULTIES: DIFFICULTIES,
    DEFAULT_DIFFICULTY: DEFAULT_DIFFICULTY,
    TIERS: TIERS,
    TABLE: TABLE,
    createState: createState,
    resolve: resolve,
    applyOutcome: applyOutcome,
    isDead: isDead,
    injuryLabel: injuryLabel,
    difficultyOf: difficultyOf,
    stateSummary: stateSummary,
    extractEpitaph: extractEpitaph,
    extractIdentity: extractIdentity,
    clamp: clamp
  };
});
