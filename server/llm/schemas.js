// structured outputs に渡す JSON Schema と、サーバー側でのスキーマ検証。
// 制限（optional 24 個まで・union 16 個まで）から離すため、すべて required・union なしにしている。

export function actionSchema(derived, moods) {
  return {
    type: "object",
    properties: {
      thought: { type: "string", description: "内心のつぶやき（40字以内）。口には出さない本音" },
      action: { type: "string", enum: derived.actions },
      target: { type: "string", enum: derived.targets, description: "行き先・相手・投票先。なければ空文字" },
      item: { type: "string", enum: derived.items, description: "buy と give で使う品物。なければ空文字" },
      amount: { type: "integer", description: "buy と give の数。なければ 0" },
      say: { type: "string", description: "talk のときの発言（60字以内）。talk 以外は空文字" },
      plan_until: { type: "string", pattern: "^[0-2][0-9]:[0-5][0-9]$", description: "この行動を続ける終わりの時刻 HH:MM" },
      mood: { type: "string", enum: moods },
      remember: {
        type: "array",
        description: "覚えておくこと（0〜3件）",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "自分の言葉で。80字以内" },
            importance: { type: "integer", description: "1〜10" },
          },
          required: ["text", "importance"],
          additionalProperties: false,
        },
      },
    },
    required: ["thought", "action", "target", "item", "amount", "say", "plan_until", "mood", "remember"],
    additionalProperties: false,
  };
}

export function reflectionSchema(derived) {
  return {
    type: "object",
    properties: {
      beliefs: {
        type: "array",
        description: "他人についての思い込み（3〜5個）",
        items: {
          type: "object",
          properties: {
            about: { type: "string", enum: derived.names },
            text: { type: "string", description: "60字以内" },
          },
          required: ["about", "text"],
          additionalProperties: false,
        },
      },
      relation_changes: {
        type: "array",
        description: "今日の出来事で変わった関係（-2〜+2 の変化量）",
        items: {
          type: "object",
          properties: {
            to: { type: "string", enum: derived.names },
            delta: { type: "integer" },
          },
          required: ["to", "delta"],
          additionalProperties: false,
        },
      },
      goal_tomorrow: { type: "string", description: "明日の目標（60字以内）" },
      diary: { type: "string", description: "今日の一言日記（80字以内）" },
    },
    required: ["beliefs", "relation_changes", "goal_tomorrow", "diary"],
    additionalProperties: false,
  };
}

export function newspaperSchema() {
  return {
    type: "object",
    properties: {
      headline: { type: "string", description: "一面の見出し（30字以内）" },
      lead: { type: "string", description: "リード文（120字以内）" },
      articles: {
        type: "array",
        description: "記事（2〜4本）",
        items: {
          type: "object",
          properties: {
            heading: { type: "string" },
            body: { type: "string", description: "300字以内" },
          },
          required: ["heading", "body"],
          additionalProperties: false,
        },
      },
      rumors: { type: "array", description: "うわさ欄（1〜3件、断定しない書き方で）", items: { type: "string" } },
      tomorrow: { type: "string", description: "明日の見どころ（80字以内）" },
    },
    required: ["headline", "lead", "articles", "rumors", "tomorrow"],
    additionalProperties: false,
  };
}

// --- サーバー側のスキーマ検証（使っている機能だけを実装した小さな検証器） ---

export function validateAgainstSchema(schema, value, where = "$") {
  const errors = [];
  walk(schema, value, where, errors);
  return errors;
}

function walk(s, v, where, errors) {
  switch (s.type) {
    case "object": {
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        errors.push(`${where} はオブジェクトでなければならない`);
        return;
      }
      for (const k of s.required || []) if (!(k in v)) errors.push(`${where}.${k} がない`);
      if (s.additionalProperties === false) {
        for (const k of Object.keys(v)) if (!(k in s.properties)) errors.push(`${where}.${k} は余分な項目`);
      }
      for (const [k, sub] of Object.entries(s.properties || {})) if (k in v) walk(sub, v[k], `${where}.${k}`, errors);
      return;
    }
    case "array": {
      if (!Array.isArray(v)) {
        errors.push(`${where} は配列でなければならない`);
        return;
      }
      v.forEach((item, i) => walk(s.items, item, `${where}[${i}]`, errors));
      return;
    }
    case "string": {
      if (typeof v !== "string") {
        errors.push(`${where} は文字列でなければならない`);
        return;
      }
      if (s.enum && !s.enum.includes(v)) errors.push(`${where}「${v}」は選択肢にない`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${where}「${v}」は形式が違う`);
      return;
    }
    case "integer": {
      if (!Number.isInteger(v)) errors.push(`${where} は整数でなければならない`);
      return;
    }
    case "boolean": {
      if (typeof v !== "boolean") errors.push(`${where} は真偽値でなければならない`);
      return;
    }
    default:
      errors.push(`${where}: 検証器が知らない型 ${s.type}`);
  }
}
