// deepseek-fallback: プロバイダエラー時にフォールバック候補へ自動切替する
// - 候補(優先順): zen/deepseek-v4-flash → zen/big-pickle(無料) → deepseek/deepseek-chat
// - 対象エラー: 429 / 5xx / 残高不足(CreditsError) / rate limit 系メッセージ
// - 検出: agent_end の失敗メッセージ(stopReason==="error")
//   ※ pi は 429 等のHTTPエラーで after_provider_response を発火させないため
// - リトライ:
//   · 429/5xx は pi 内蔵リトライが新モデルで再実行する(setModel だけすればよい)
//   · 残高不足など fail-fast エラーは内蔵リトライが動かないので、
//     非対話モード(-p 等)では sendUserMessage でプロンプトを自動再送する
// - 戻すときは /model または Ctrl+P で手動選択する
import { appendFileSync } from "node:fs";

const CANDIDATES: Array<[string, string]> = [
    ["zen", "deepseek-v4-flash"],
    ["zen", "big-pickle"], // 無料モデル(残高ゼロでも可)
    ["zen", "x-preview-f-free"],
    ["zen", "mimo-v2.5-free"],
    ["zen", "hy3-free"],
    ["zen", "nemotron-3.5-lightning-free"],
    ["zen", "nemotron-3-ultra-free"],
    ["deepseek", "deepseek-chat"],
];
const LOG = `${process.env.HOME ?? "~"}/.pi/agent/extensions/deepseek-fallback.log`;

function log(msg: string) {
    try {
        appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
    } catch {
        // ログ書けなくても本体動作は妨げない
    }
}

function statusOf(msg: string): number | undefined {
    const m = msg.match(/\b(4\d\d|5\d\d)\b/);
    return m ? Number(m[1]) : undefined;
}

function isTransient(msg: string, status: number | undefined): boolean {
    if (status !== undefined && [401, 402, 429].includes(status)) return true;
    if (status !== undefined && status >= 500 && status <= 599) return true;
    return /rate limit|quota|overloaded|insufficient|credits?\s*error|too many requests/i.test(msg);
}

// pi 内蔵リトライが対象としない(fail-fastする)エラーか
// ※ pi 側の NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN 相当
function isFailFast(msg: string): boolean {
    return /billing|insufficient_quota|out of budget|quota exceeded|available balance|insufficient balance|gousagelimit|freeusagelimit|usage limit/i.test(msg);
}

export default function (pi) {
    let lastKey = "";
    let stashedPrompt = "";
    let fallbackAttempts = 0;
    let tried = new Set<string>(); // このプロンプトで失敗したモデル
    const MAX_FALLBACK_ATTEMPTS = CANDIDATES.length;

    async function fallback(ctx, fromLabel, errMsg, status): Promise<boolean> {
        let available = [];
        try {
            available = ctx.modelRegistry.getAvailable();
        } catch (e) {
            log(`getAvailable failed: ${e}`);
            return false;
        }
        tried.add(fromLabel); // 失敗済みとして記録
        const current = `${ctx.model?.provider}/${ctx.model?.id}`;
        let target;
        for (const [prov, id] of CANDIDATES) {
            if (tried.has(`${prov}/${id}`)) continue;
            target = available.find((m) => m.provider === prov && m.id === id);
            if (target) break;
        }
        if (!target) {
            log(`no fallback candidates available (tried=[${[...tried].join(", ")}])`);
            return false;
        }

        const key = `${fromLabel}:${errMsg.slice(0, 60)}:${target.provider}/${target.id}`;
        if (key === lastKey) return true; // 同一失敗は処理済み(通知抑制のみ)
        lastKey = key;

        const ok = await pi.setModel(target);
        if (!ok) {
            log(`setModel(${target.provider}/${target.id})=false (APIキー未設定?)`);
            ctx.ui.notify(
                `エラー ${errMsg.slice(0, 60)}: フォールバック先 ${target.provider}/${target.id} の API キーが未設定です`,
                "error",
            );
            return false;
        }
        log(`fallback #${fallbackAttempts} ${fromLabel} -> ${target.provider}/${target.id} (${errMsg.slice(0, 80)})`);
        ctx.ui.notify(`${fromLabel} 失敗 → ${target.provider}/${target.id} にフォールバック`, "warning");
        return true;
    }

    // 元プロンプトの退避とカウンタ初期化
    // ※ tried はここでリセットしない。プロンプトをまたいで失敗モデルを記憶し、
    //   対話モードでの手動再送時に死んだモデルへ戻る往復を防ぐ(成功時にクリア)
    pi.on("before_agent_start", async (event) => {
        if (typeof event?.prompt === "string") stashedPrompt = event.prompt;
        fallbackAttempts = 0;
        lastKey = "";
    });

    // 成功レスポンス経由の検出(輻輳時の一部プロバイダで発火)
    pi.on("after_provider_response", async (event, ctx) => {
        const status: number = event?.status ?? 0;
        if (!isTransient("", status)) return;
        if (!ctx.model) return;
        await fallback(ctx, `${ctx.model.provider}/${ctx.model.id}`, "", status);
    });

    // メイン検出: 失敗ランは stopReason="error" + errorMessage 付きで agent_end に来る
    pi.on("agent_end", async (event, ctx) => {
        const failure = (event?.messages ?? []).find(
            (m) => m?.stopReason === "error" && m?.errorMessage,
        );
        if (!failure) {
            lastKey = "";
            tried.clear(); // 正常終了したので失敗記憶をクリア
            return; // 正常終了
        }
        if (!ctx.model) return;

        const msg = String(failure.errorMessage);
        const fromLabel = `${failure.provider}/${failure.model}`;
        log(`agent_end error: ${fromLabel} msg=${msg.slice(0, 140)}`);

        if (!isTransient(msg, statusOf(msg))) {
            log("not transient -> skip");
            return;
        }

        if (fallbackAttempts >= MAX_FALLBACK_ATTEMPTS) {
            log(`max fallback attempts (${MAX_FALLBACK_ATTEMPTS}) reached -> give up`);
            return;
        }

        const switched = await fallback(ctx, fromLabel, msg, statusOf(msg));
        if (!switched) return;
        fallbackAttempts++;

        // fail-fast 系(残高不足等)は内蔵リトライが動かないため自動再送。
        // 対話UIでは二重送信になるので、ユーザーの再送に任せる。
        if (isFailFast(msg) && !ctx.hasUI && stashedPrompt) {
            log(`auto-resend prompt (${stashedPrompt.slice(0, 60)})`);
            pi.sendUserMessage(stashedPrompt, { deliverAs: "followUp" });
        }
    });
}
