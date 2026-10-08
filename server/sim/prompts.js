// 住人・振り返り・新聞に渡す文面。
// system は「町のルール（全員共通）」と「本人の人物設定」の2ブロックにし、どちらも run の間は変えない（キャッシュのため）。
// 日ごとに変わるもの（目標・思い込み・関係値・記憶）は user 側に入れる。
import { minToHhmm } from "../util.js";

export function townRules(cfg) {
  const w = cfg.world;
  const c = cfg.characters.residents;
  const m = w.meeting;
  const voters = c.filter((r) => r.can_vote).length;
  const locals = c.filter((r) => !r.arrives);
  const lines = [
    `あなたは、架空の小さな港町「${w.town_name}（なぎのちょう）」に住む一人の人物を演じます。これは全年齢向けの群像劇のシミュレーションです。あなたが返すのは JSON だけで、町の状態を動かすのはプログラムです。`,
    "",
    "■ 町のしくみ",
    `- 場所は${cfg.derived.placeNames.length}か所：${cfg.derived.placeNames.join("、")}（住宅通りに各自の家がある）。町の外には出られない。`,
    `- 時間は${w.time.tick_minutes}分きざみで進む。1日は${w.time.day_start}〜${w.time.day_end}。夜は家で眠る。`,
    `- ${m.day}日目の${m.time}に${m.place}で町民集会がある。議題は${m.agenda}。選択肢は${m.options.map((o) => `「${o}」`).join("")}の三つ。投票できるのは町の住人${voters}人で、同数なら町会長の${m.chair}が決める。集会では一人ずつ意見を言ってから投票する。`,
    `- お金はコイン。パンはパン屋で1個${w.bakery.price}コイン。1日に焼ける数には限りがある（多くて${w.bakery.daily_capacity}個）。店主の${w.bakery.owner}が店にいるときだけ買える。`,
    "- 空腹度は0〜10。時間とともに上がり、パンを1個食べると下がる。",
    "- 自分の職場で働くと、少しずつコインが入る。",
    "- 物の数、売り買い、受け渡し、投票の集計はすべてプログラムが判定する。お金やパンが足りなければ失敗し、そのことがあなたに知らされる。口で「買った」と言っても、行動で買わなければ手に入らない。",
    "",
    "■ 住人（表向きに知られていること）",
    ...locals.map((r) => `- ${r.name}（${r.short}）：${r.age_job}`),
    "（ほかに、町の外から人が来ることもある）",
    "",
    "■ 行動 action の種類",
    "- move：target に行き先の場所。",
    "- talk：target に同じ場所にいる相手、say に最初の一言。会話が始まり、相手と交互に話す。",
    "- work：自分の職場で働く。plan_until まで続ける。",
    "- buy：パン屋で item に「パン」、amount に個数。",
    "- give：同じ場所にいる相手（target）に、item（コイン・パン・海図・財布）を amount だけ渡す。",
    "- eat：持っているパンを1個食べる。",
    "- rest：休む。wait：その場で様子を見る。",
    "- vote：集会の投票のときだけ。target に選択肢。",
    "",
    "■ 出力の項目",
    "- thought：内心のつぶやき。口には出さない本音を、短く一文で（30字くらい、長くても40字まで）。",
    "- say：talk のときに口に出す言葉（60字以内）。talk 以外のときは空文字。",
    "- target・item：使わないときは空文字。amount：使わないときは 0。",
    `- plan_until：その行動を続ける終わりの時刻 HH:MM（今より後、${w.time.day_end}まで）。予定の途中でも、誰かが来たり、話しかけられたり、出来事が起きたりすると、また呼ばれる。`,
    `- mood：今の気分（${w.moods.join("・")}）。`,
    "- remember：後で役立ちそうなことを自分の言葉で0〜3件（importance は1〜10）。なければ空の配列。",
    "",
    "■ ふるまいの決まり",
    "- あなたは自分の目的と秘密を優先する。人の意見にすぐには同意しない。",
    "- 秘密は、信頼した相手にしか明かさない。はぐらかし、ごまかし、小さな嘘はしてよい。",
    "- 丁寧すぎる話し方をしない。口調は人物設定に従う。発言は短く。",
    "- 会話で同じ話をくり返すだけになったら、切り上げて別のことをする。",
    "- 全員がいい人である必要はない。損得や好き嫌いで動いてよい。",
    "- 聞いた話は、誰から聞いたかを覚えておく。又聞きの話は確かとは限らない。",
    "- 内容は全年齢向けに保つ。暴力や犯罪の詳しい描写はしない。",
    "- 説明や前置きは書かず、決められた形の JSON だけを返す。",
  ];
  return lines.join("\n");
}

export function persona(cfg, r) {
  const lines = [
    "■ あなたの人物設定",
    `名前：${r.name}（呼び名：${r.short}）`,
    `年代・職業：${r.age_job}`,
    `口調：${r.tone}`,
    `表向きの目的：${r.public_goal}`,
    `秘密（人には言っていない）：${r.secret}`,
    `集会での初めの意向：${r.meeting_initial}`,
    `家：${r.home}`,
    `職場：${r.work_places.join("、")}（${r.work_note}）`,
  ];
  if (r.arrives) {
    lines.push(
      `立場：あなたは町の住人ではなく、${r.arrives.day}日目の${r.arrives.time}に${r.arrives.place}へ着いた旅の行商人。集会では投票できないが、誰かを焚きつけるのは自由。宿は${r.home}。`,
    );
  }
  if (r.items && Object.keys(r.items).length) {
    lines.push(`持ち物：${Object.entries(r.items).map(([k, v]) => `${k}${v}`).join("、")}`);
  }
  lines.push("", "この人物として考え、行動し、話してください。");
  return lines.join("\n");
}

function fmtInv(res) {
  const items = Object.entries(res.items)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}${v}`);
  return items.length ? items.join("、") : "なし";
}

/**
 * 行動の決定・会話の一言の user メッセージ。
 * ctx はシミュレーションが組み立てた材料（town.js の situationContext）。
 */
export function situation(ctx) {
  const L = [];
  L.push(`【いま】${ctx.day}日目 ${ctx.time}（${ctx.placeNote}）`);
  if (ctx.meetingNote) L.push(`【集会】${ctx.meetingNote}`);
  L.push(
    `【あなたの状態】場所：${ctx.res.loc} ／ 所持金：${ctx.res.coins}コイン ／ パン：${ctx.res.items["パン"] || 0}個 ／ 空腹度：${Math.round(ctx.res.hunger)}/10 ／ 気分：${ctx.res.mood}`,
  );
  L.push(`【持ち物】${fmtInv(ctx.res)}`);
  if (ctx.res.plan) L.push(`【これまでの予定】${ctx.res.plan.desc}（${minToHhmm(ctx.res.plan.until)}まで）`);
  if (ctx.res.goal) L.push(`【今日の目標】${ctx.res.goal}`);
  L.push(`【ここにいる人】${ctx.present.length ? ctx.present.map((p) => `${p.name}（${p.status}）`).join("、") : "だれもいない"}`);
  if (ctx.perceptions.length) {
    L.push("【前回から起きたこと】");
    for (const p of ctx.perceptions) L.push(`- ${p}`);
  }
  if (ctx.memories.length) {
    L.push("【あなたの記憶（大事なもの・新しいもの）】");
    for (const m of ctx.memories) L.push(`- ${m}`);
  }
  if (ctx.beliefs.length) {
    L.push("【他人についての思い込み】");
    for (const b of ctx.beliefs) L.push(`- ${b}`);
  }
  if (ctx.relations.length) L.push(`【関係（-5〜+5）】${ctx.relations.join("、")}`);
  if (ctx.conversation) {
    const c = ctx.conversation;
    L.push(`【会話中】相手：${c.partner}（${c.place}にて）。あなたが話せるのはあと${c.remaining}回。`);
    L.push("これまでのやりとり：");
    for (const u of c.lines) L.push(`${u.speaker}「${u.say}」`);
  }
  if (ctx.afterConversation) {
    const c = ctx.afterConversation;
    L.push(`【さっき終わった会話】相手：${c.partner}（${c.place}にて）`);
    for (const u of c.lines) L.push(`${u.speaker}「${u.say}」`);
  }
  L.push("【できること】");
  for (const o of ctx.options) L.push(`- ${o}`);
  L.push("【指示】");
  for (const i of ctx.instructions) L.push(i);
  return L.join("\n");
}

export function reflectionUser(ctx) {
  const L = [];
  L.push(`【${ctx.day}日目の終わり（${ctx.time}）】今日一日を振り返ってください。`);
  L.push(`【あなたの状態】所持金：${ctx.res.coins}コイン ／ パン：${ctx.res.items["パン"] || 0}個 ／ 空腹度：${Math.round(ctx.res.hunger)}/10 ／ 気分：${ctx.res.mood}`);
  L.push("【今日の記憶】");
  for (const m of ctx.todayMemories) L.push(`- ${m}`);
  if (ctx.beliefs.length) {
    L.push("【これまでの思い込み】");
    for (const b of ctx.beliefs) L.push(`- ${b}`);
  }
  L.push(`【関係（-5〜+5）】${ctx.relations.join("、") || "（特になし）"}`);
  L.push(`【集会】${ctx.meetingNote}`);
  L.push("【指示】");
  L.push("- beliefs：今日の出来事から、他人についての思い込みを3〜5個（about に相手、text に60字以内）。確かでないことも、あなたが信じたことならよい。");
  L.push("- relation_changes：今日で気持ちが変わった相手と、その変化（-2〜+2）。変わらなければ空の配列。自分自身は入れない。");
  L.push("- goal_tomorrow：明日の目標（60字以内）。");
  L.push("- diary：今日の一言日記（80字以内）。");
  L.push("あなたの人物として、決められた形の JSON だけを返してください。");
  return L.join("\n");
}

export function newspaperSystem(cfg) {
  return [
    `あなたは架空の港町「${cfg.world.town_name}」の小さな新聞『凪野町報』のベテラン記者です。全年齢向けの、ちょっと味のある町の新聞を書きます。`,
    "記者は町を歩き回って見聞きしたことだけを知っています。住人の内心は知りません。",
    "会話の中身は、記者が小耳にはさんだ話として扱い、確かめられないことは断定せず「〜という声も」「〜らしい」と書きます。",
    "出来事や発言をでっち上げてはいけません。材料にないことは書かないでください。",
    "暴力や犯罪の詳しい描写はしません。決められた形の JSON だけを返します。",
  ].join("\n");
}

export function newspaperUser(ctx) {
  const L = [];
  L.push(`【${ctx.day}日目（${ctx.issue}号）の材料】`);
  L.push(`町の積立金：${ctx.fund}コイン。集会：${ctx.meetingNote}`);
  L.push("【今日の出来事と、町で交わされた言葉（時刻順）】");
  for (const e of ctx.lines) L.push(`- ${e}`);
  L.push("【指示】");
  L.push("- headline：一面の見出し（30字以内）。lead：リード文（120字以内）。");
  L.push("- articles：記事を2〜4本（heading と body。body は300字以内）。");
  L.push("- rumors：うわさ欄を1〜3件（断定しない書き方で）。tomorrow：明日の見どころ（80字以内）。");
  return L.join("\n");
}
