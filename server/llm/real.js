// Anthropic API を呼ぶ部分。住人に与えるのは「JSON を返すこと」だけで、
// tool use・コード実行・Web 検索・ファイル操作の類は一切渡さない。
import Anthropic from "@anthropic-ai/sdk";

export class FatalLlmError extends Error {}

export function makeClient(apiKey, clientCfg) {
  return new Anthropic({
    apiKey, // TOWN_ANTHROPIC_API_KEY を明示的に渡す
    authToken: null, // 環境変数 ANTHROPIC_AUTH_TOKEN を読ませない
    baseURL: "https://api.anthropic.com", // 環境変数 ANTHROPIC_BASE_URL を読ませない
    logLevel: "warn",
    maxRetries: clientCfg.max_retries ?? 2,
    timeout: clientCfg.timeout_ms ?? 120000,
  });
}

/** エラー文にキーらしきものが混ざっていたら伏せる（念のため） */
export function scrub(s) {
  return String(s ?? "").replace(/sk-ant-[A-Za-z0-9_\-]+/g, "[REDACTED]").slice(0, 2000);
}

/**
 * 1回呼ぶ。返り値 { text, usage, stopReason, model, id }。
 * 認証エラーなど続けても無駄なものは FatalLlmError にする。
 */
export async function callClaude(client, { model, maxTokens, effort, thinking, systemTexts, userText, schema, timeoutMs }) {
  const params = {
    model,
    max_tokens: maxTokens,
    system: systemTexts.map((text) => ({ type: "text", text, cache_control: { type: "ephemeral" } })),
    messages: [{ role: "user", content: userText }],
    output_config: { effort, format: { type: "json_schema", schema } },
  };
  if (thinking) params.thinking = thinking;
  try {
    const res = await client.messages.create(params, timeoutMs ? { timeout: timeoutMs } : undefined);
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, usage: res.usage, stopReason: res.stop_reason, model: res.model, id: res.id };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new FatalLlmError(`API の認証に失敗しました（${e.status}）。キーかワークスペースの設定を確かめてください`);
    }
    if (e instanceof Anthropic.NotFoundError) {
      throw new FatalLlmError(`モデルが見つかりません（${model}）`);
    }
    if (e instanceof Anthropic.APIError && e.status === 402) {
      throw new FatalLlmError("API の支払い・クレジットの問題で止まりました（402）");
    }
    const status = e instanceof Anthropic.APIError ? e.status : "network";
    const err = new Error(`API エラー（${status}）: ${scrub(e.message)}`);
    err.apiStatus = status;
    throw err;
  }
}
