// 住人・振り返り・新聞の呼び出しをすべてここに通す。
// mock と real の切り替え、送る前の費用チェック、検証と1回だけの再試行、記録を受け持つ。
import crypto from "node:crypto";
import { roleConfigFor } from "../config.js";
import { costFromUsage, worstCaseCost } from "./pricing.js";
import { validateAgainstSchema } from "./schemas.js";
import { makeClient, callClaude, FatalLlmError, scrub } from "./real.js";
import { estimateTokens, round6 } from "../util.js";
import { getApiKeyForClient } from "../env.js";

export class BudgetStop extends Error {}
export { FatalLlmError };

class Semaphore {
  constructor(n) {
    this.n = n;
    this.q = [];
  }
  async run(fn) {
    if (this.n <= 0) await new Promise((r) => this.q.push(r));
    this.n--;
    try {
      return await fn();
    } finally {
      this.n++;
      const next = this.q.shift();
      if (next) next();
    }
  }
}

function emptyStats() {
  return {
    calls: 0, // API（または mock）への送信回数
    requests: 0, // 論理的な呼び出し数（再試行をまとめて1）
    validFirst: 0,
    validRetry: 0,
    failed: 0, // 2回とも検証に落ちて wait 扱いになった数
    refusals: 0,
    apiErrors: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    byRole: {},
  };
}

export class LlmGateway {
  constructor({ cfg, mode, recorder, ledger, onCost, mockLatency = [20, 120] }) {
    this.cfg = cfg;
    this.mode = mode;
    this.recorder = recorder;
    this.ledger = ledger;
    this.onCost = onCost || (() => {});
    this.mockLatency = mockLatency;
    this.runCost = 0;
    this.mockShadowCost = 0; // mock のときの「real だったらいくらか」の粗い推定
    this.stats = emptyStats();
    this.stopReason = null;
    this.sem = new Semaphore(cfg.models.client.concurrency || 4);
    this.seenPrefixes = new Set();
    this.client = mode === "real" ? makeClient(getApiKeyForClient(), cfg.models.client) : null;
    this.seq = 0;
  }

  budgetState() {
    const b = this.cfg.budget;
    return {
      mode: this.mode,
      run_usd: round6(this.runCost),
      run_cap_usd: b.run_cap_usd,
      ledger_usd: this.ledger.total,
      ledger_cap_usd: b.ledger_cap_usd,
      mock_shadow_usd: round6(this.mockShadowCost),
      stop_reason: this.stopReason,
      stats: this.stats,
    };
  }

  /** 送る前のトークン数の見積もりが上限内か */
  fits(systemTexts, userText, schema) {
    const est = estimateTokens(systemTexts.join("\n") + userText + JSON.stringify(schema)) + 300;
    return { ok: est <= this.cfg.budget.max_input_tokens, est };
  }

  checkBudgetBefore(model, estIn, maxTokens) {
    if (this.stopReason) throw new BudgetStop(this.stopReason);
    if (this.mode !== "real") return;
    const b = this.cfg.budget;
    const worst = worstCaseCost(this.cfg.pricing, model, estIn, maxTokens);
    if (this.runCost + worst > b.run_cap_usd) {
      this.stopReason = `この run の上限 $${b.run_cap_usd} に届くため止めました（現在 $${round6(this.runCost)}）`;
      throw new BudgetStop(this.stopReason);
    }
    if (this.ledger.total + worst > b.ledger_cap_usd) {
      this.stopReason = `台帳の上限 $${b.ledger_cap_usd} に届くため止めました（累計 $${this.ledger.total}）`;
      throw new BudgetStop(this.stopReason);
    }
  }

  /**
   * 1回の論理的な呼び出し。検証に落ちたら理由を添えて1回だけ再試行する。
   * spec: { role, resident, systemTexts, userText, schema, schemaName, check(obj) => string[], mock(attempt) => obj }
   * 返り値: { ok, value, attempts, errors }
   */
  async call(spec) {
    const rc = roleConfigFor(this.cfg, spec.role, spec.resident);
    const roleStats = (this.stats.byRole[spec.role] ||= { requests: 0, failed: 0, cost: 0 });
    this.stats.requests++;
    roleStats.requests++;
    let errors = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const userText =
        attempt === 1
          ? spec.userText
          : `${spec.userText}\n\n【やり直し】さきほどの出力は次の理由で受け付けられませんでした。\n- ${errors.join("\n- ")}\n規則に合う JSON をもう一度出してください。`;
      const fit = this.fits(spec.systemTexts, userText, spec.schema);
      this.checkBudgetBefore(rc.model, fit.est, rc.max_tokens);
      const started = Date.now();
      const callId = ++this.seq;
      let text = "";
      let usage = null;
      let stopReason = null;
      let costUsd = 0;
      let apiError = null;

      try {
        if (this.mode === "real") {
          const r = await this.sem.run(() =>
            callClaude(this.client, {
              model: rc.model,
              maxTokens: rc.max_tokens,
              effort: rc.effort,
              thinking: rc.thinking,
              systemTexts: spec.systemTexts,
              userText,
              schema: spec.schema,
            }),
          );
          text = r.text;
          usage = r.usage;
          stopReason = r.stopReason;
        } else {
          const obj = await this.sem.run(async () => {
            const [lo, hi] = this.mockLatency;
            if (hi > 0) await new Promise((res) => setTimeout(res, lo + Math.random() * (hi - lo)));
            return spec.mock(attempt);
          });
          text = JSON.stringify(obj);
          stopReason = "end_turn";
        }
      } catch (e) {
        if (e instanceof FatalLlmError) {
          this.stopReason = e.message;
          this.log({ callId, attempt, spec, rc, userText, text: "", usage: null, stopReason: "error", costUsd: 0, started, valid: false, errors: [e.message] });
          throw e;
        }
        apiError = scrub(e.message);
        this.stats.apiErrors++;
      }
      this.stats.calls++;

      // 費用の記録（real のみ）
      if (usage) {
        const c = costFromUsage(this.cfg.pricing, rc.model, usage);
        costUsd = c.usd;
        this.runCost = round6(this.runCost + costUsd);
        roleStats.cost = round6(roleStats.cost + costUsd);
        this.stats.input += usage.input_tokens || 0;
        this.stats.output += usage.output_tokens || 0;
        this.stats.cacheRead += usage.cache_read_input_tokens || 0;
        this.stats.cacheWrite += usage.cache_creation_input_tokens || 0;
        this.ledger.add({
          at: new Date().toISOString(),
          run: this.recorder.id,
          role: spec.role,
          model: rc.model,
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          cache_read_input_tokens: usage.cache_read_input_tokens || 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
          cost_usd: costUsd,
        });
        this.recorder.cost({ at: new Date().toISOString(), role: spec.role, call_usd: costUsd, run_usd: this.runCost, ledger_usd: this.ledger.total });
        const b = this.cfg.budget;
        if (this.runCost >= b.run_cap_usd) this.stopReason = `この run の上限 $${b.run_cap_usd} に達しました`;
        else if (this.ledger.total >= b.ledger_cap_usd) this.stopReason = `台帳の上限 $${b.ledger_cap_usd} に達しました`;
      } else if (this.mode === "mock" && !apiError) {
        this.addShadowCost(rc, spec, fit.est, text);
      }

      // 検証
      errors = [];
      let value = null;
      if (apiError) {
        errors.push(apiError);
      } else if (stopReason === "refusal") {
        this.stats.refusals++;
        errors.push("安全上の理由で応答が拒否された（物語の範囲で、全年齢向けの内容にしてください）");
      } else if (stopReason === "max_tokens") {
        errors.push("出力が長すぎて途中で切れた。短く答えること");
      } else {
        try {
          value = JSON.parse(text);
        } catch {
          errors.push("JSON として読めない");
        }
        if (value !== null) {
          errors.push(...validateAgainstSchema(spec.schema, value));
          if (errors.length === 0 && spec.check) errors.push(...spec.check(value));
        }
      }
      const valid = errors.length === 0;
      this.log({ callId, attempt, spec, rc, userText, text, usage, stopReason, costUsd, started, valid, errors });
      this.onCost(this.budgetState());

      if (valid) {
        if (attempt === 1) this.stats.validFirst++;
        else this.stats.validRetry++;
        return { ok: true, value, attempts: attempt, errors: [] };
      }
      if (this.stopReason) break; // 上限に達したら再試行しない
    }
    this.stats.failed++;
    roleStats.failed++;
    return { ok: false, value: null, attempts: 2, errors };
  }

  addShadowCost(rc, spec, estIn, text) {
    // 町のルールの部分は2回目以降キャッシュ読み込みになると仮定した、ごく粗い推定
    const sysTokens = estimateTokens(spec.systemTexts.join("\n"));
    const key = rc.model + ":" + crypto.createHash("sha1").update(spec.systemTexts.join("\n")).digest("hex");
    const first = !this.seenPrefixes.has(key);
    this.seenPrefixes.add(key);
    const usage = {
      input_tokens: Math.max(0, estIn - sysTokens),
      output_tokens: estimateTokens(text) + 20,
      cache_read_input_tokens: first ? 0 : sysTokens,
      cache_creation_input_tokens: first ? sysTokens : 0,
    };
    this.mockShadowCost = round6(this.mockShadowCost + costFromUsage(this.cfg.pricing, rc.model, usage).usd);
  }

  log({ callId, attempt, spec, rc, userText, text, usage, stopReason, costUsd, started, valid, errors }) {
    this.recorder.llmCall({
      at: new Date().toISOString(),
      call: callId,
      attempt,
      mode: this.mode,
      role: spec.role,
      role_label: rc.label,
      resident: spec.resident || null,
      model: rc.model,
      effort: rc.effort,
      thinking: rc.thinking ? rc.thinking.type : "default",
      max_tokens: rc.max_tokens,
      schema: spec.schemaName,
      usage: usage
        ? {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            cache_read_input_tokens: usage.cache_read_input_tokens || 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
          }
        : null,
      est_input_tokens: this.fits(spec.systemTexts, userText, spec.schema).est,
      cost_usd: costUsd,
      duration_ms: Date.now() - started,
      stop_reason: stopReason,
      valid,
      errors,
      prompt: { system: spec.systemTexts, user: userText },
      response: text,
    });
  }
}
