// mock：API を呼ばず、決まった型の行動をランダムに返す偽物。
// 返すのは本物と同じ形の JSON で、同じ検証にかける。ときどきわざと不正な値を混ぜ、再試行の道筋も通す。
import { minToHhmm } from "../util.js";

const FLAVOR = {
  鳴海トキ: { greet: "おお、{s}かい", talk: ["昔はのう、この港も賑やかでな", "灯台の灯は、わしが守らねばのう", "嵐の晩のことを思い出すわい"], think: ["あの手紙のことは、まだ言えん", "灯台がなくなったら、わしは…"] },
  小春ミナミ: { greet: "まいど、{s}！", talk: ["ね、ね、今日のパンは自信作なの", "かまど？ぜんぜん平気平気！", "新しいかまどがあればなあ"], think: ["かまど、今日はもつかな", "お客さん増やさなきゃ"] },
  澄川ハルオ: { greet: "やあ{s}さん", talk: ["町のためを思えばこそ、桟橋です", "まあまあ、集会で決めましょう", "港が栄えれば皆が潤いますよ"], think: ["ゲンへの借りを早く返さねば", "桟橋の案、通さねばならん"] },
  潮田ゲン: { greet: "おうよ、{s}！", talk: ["てえへんだ、聞いたか？", "桟橋ができりゃ町は大繁盛よ", "澄川のやつ、最近目をそらしやがる"], think: ["貸した金、いつ返ってくるんだ", "ちょいと話を盛っとくか"] },
  文月ユウ: { greet: "{s}さん、こんにちは", talk: ["それ、誰から聞きました？", "町史の資料を集めているんです", "事実を確かめてから決めたいです"], think: ["灯台の件、トキさんは知ってるのかな", "噂の出どころを確かめなきゃ"] },
  波多カイ: { greet: "…{s}か", talk: ["…別に", "今日も不漁だ", "…パン、うまいな"], think: ["金がない", "ミナミ、元気そうだな"] },
  遠野サキ: { greet: "ねえねえ、{s}さん！", talk: ["ここだけの話ね…いや、やっぱやめとく", "配達って町じゅう回るから色々見えるんだ", "いつか町を出たいんだよね"], think: ["あの封筒のこと、言っちゃだめ", "お金貯めなきゃ"] },
  ロッテ: { greet: "おやおや、{s}様。これはこれは", talk: ["この海図、お目が高い方にだけお見せしております", "沖に眠る船の宝、ご興味は？", "旅の者の戯言とお思いですか"], think: ["この町なら海図が売れそうだ", "本物かどうか…まあいい"] },
};

function fl(name) {
  return FLAVOR[name] || { greet: "{s}", talk: ["そうだね"], think: ["さて"] };
}

function planUntil(rng, nowMin, dayEndMin, minM, maxM) {
  const span = minM + Math.floor(rng.next() * ((maxM - minM) / 15 + 1)) * 15;
  return minToHhmm(Math.min(dayEndMin, nowMin + Math.max(15, span)));
}

function base(h, rng) {
  return {
    thought: rng.pick(fl(h.name).think),
    action: "wait",
    target: "",
    item: "",
    amount: 0,
    say: "",
    plan_until: planUntil(rng, h.nowMin, h.dayEndMin, 15, 45),
    mood: rng.pick(h.moods),
    remember: [],
  };
}

/** 行動の決定 */
export function mockAction(h, rng, attempt) {
  const o = base(h, rng);
  const fla = fl(h.name);

  // 1回目だけ、まれに不正な値を混ぜる（再試行の確認用）
  if (attempt === 1 && rng.chance(h.invalidRate)) {
    o.action = "talk";
    o.target = h.absentPerson || "";
    o.say = "おーい";
    return o;
  }

  if (h.afterConversation) {
    o.remember.push({ text: `${h.afterConversation.partner}と話した。${rng.pick(["何か隠している気がする", "集会の話になった", "機嫌がよさそうだった", "うまくはぐらかされた"])}`, importance: rng.int(3, 7) });
  }

  if (h.hunger >= 7 && h.bread > 0) {
    o.action = "eat";
    return o;
  }
  if (h.hunger >= 6 && h.bread === 0) {
    if (h.atBakery && h.bakeryOpen && h.coins >= h.breadPrice) {
      o.action = "buy";
      o.item = "パン";
      o.amount = Math.min(2, Math.floor(h.coins / h.breadPrice));
      return o;
    }
    if (!h.atBakery && h.openPlaces.includes("パン屋")) {
      o.action = "move";
      o.target = "パン屋";
      o.plan_until = planUntil(rng, h.nowMin, h.dayEndMin, 15, 30);
      return o;
    }
  }
  const r = rng.next();
  if (h.present.length && r < 0.3) {
    const t = rng.pick(h.present);
    o.action = "talk";
    o.target = t;
    o.say = fla.greet.replace("{s}", h.shortOf[t] || t) + "。" + rng.pick(fla.talk);
    return o;
  }
  if (h.isWorkHours && r < 0.65) {
    if (h.canWorkHere) {
      o.action = "work";
      o.plan_until = planUntil(rng, h.nowMin, h.dayEndMin, 45, 120);
      return o;
    }
    if (h.workPlace && h.openPlaces.includes(h.workPlace)) {
      o.action = "move";
      o.target = h.workPlace;
      return o;
    }
  }
  if (h.wallet && h.present.length && rng.chance(0.5)) {
    o.action = "give";
    o.target = rng.pick(h.present);
    o.item = "財布";
    o.amount = 1;
    return o;
  }
  if (r < 0.85) {
    const dests = h.openPlaces.filter((p) => p !== h.loc);
    if (dests.length) {
      o.action = "move";
      o.target = rng.pick(dests);
      o.plan_until = planUntil(rng, h.nowMin, h.dayEndMin, 30, 90);
      return o;
    }
  }
  o.action = h.loc === h.home ? "rest" : "wait";
  if (rng.chance(0.2)) o.remember.push({ text: rng.pick(fla.think), importance: rng.int(2, 6) });
  return o;
}

/** 会話の一言（続けるなら talk、終えるなら別の行動） */
export function mockTalk(h, rng, attempt) {
  const o = base(h, rng);
  const c = h.conversation;
  if (attempt === 1 && rng.chance(h.invalidRate)) {
    o.action = "talk";
    o.target = c.partner;
    o.say = "";
    return o;
  }
  const keepGoing = c.remaining > 0 && rng.chance(c.lines.length < 3 ? 0.9 : 0.6);
  if (keepGoing) {
    o.action = "talk";
    o.target = c.partner;
    o.say = rng.pick(fl(h.name).talk);
    return o;
  }
  o.action = rng.chance(0.5) ? "wait" : "move";
  if (o.action === "move") {
    const dests = h.openPlaces.filter((p) => p !== h.loc);
    o.target = dests.length ? rng.pick(dests) : "";
    if (!o.target) o.action = "wait";
  }
  return o;
}

/** 集会での一言 */
export function mockSpeech(h, rng) {
  const o = base(h, rng);
  o.action = "talk";
  const pick = h.preferredOption || rng.pick(h.options);
  o.say = `わたしは「${pick}」がいいと思う。${rng.pick(["町のためだ", "理由はみんな分かってるはず", "よく考えてほしい"])}`;
  return o;
}

/** 集会での投票 */
export function mockVote(h, rng) {
  const o = base(h, rng);
  o.action = "vote";
  o.target = h.preferredOption && rng.chance(0.75) ? h.preferredOption : rng.pick(h.options);
  return o;
}

export function mockReflection(h, rng) {
  const others = rng.shuffle(h.others).slice(0, 3);
  return {
    beliefs: others.map((n) => ({ about: n, text: `${h.shortOf[n]}は${rng.pick(["何か隠している", "集会で桟橋を推しそうだ", "信用できそうだ", "噂話が好きだ", "お金に困っているらしい"])}` })),
    relation_changes: others.slice(0, 2).map((n) => ({ to: n, delta: rng.pick([-1, 1]) })),
    goal_tomorrow: rng.pick(["集会の前に味方を増やす", "噂の出どころを確かめる", "しっかり働いて稼ぐ", "パンを確保しておく"]),
    diary: rng.pick(["いろいろあった一日だった", "疲れたけど悪くない日", "気になることが増えた"]),
  };
}

export function mockNewspaper(h, rng) {
  const sample = rng.shuffle(h.lines).slice(0, 4);
  return {
    headline: `${h.day}日目、凪野町は${rng.pick(["にぎやか", "ざわざわ", "のんびり", "うわさで持ちきり"])}`,
    lead: `（mock の新聞）今日の町では${h.lines.length}件の出来事や会話があった。`,
    articles: [
      { heading: "町の一日", body: sample.join(" ／ ").slice(0, 280) || "大きな出来事はなかった。" },
      { heading: "集会まであと少し", body: `積立金${h.fund}コインの使い道をめぐり、町の声はまだ割れている。` },
    ],
    rumors: ["誰かが何かを隠しているらしい"],
    tomorrow: "集会に向けた動きに注目。",
  };
}
