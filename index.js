/**
 * widespread-bot — the forge-native surface on GitHub.
 * @widespread $N for <spec>  → labels + spec comment + NEAR escrow link
 * merge of a PR with `closes #N`  → merge=accept → bridge review → oracle-signed release
 * receipt writeback → the settlement lands in the PR's own thread permanently.
 */
const BRIDGE = process.env.WIDE_BRIDGE || "https://widespread-bridge.widespread.workers.dev";
const FORGE = process.env.WIDE_FORGE || "https://code.widespread.fyi";
const { parseBotVerdict } = require("./verdict");
const seen = new Set(); // `${repo}#${issue}:${bot}:${sha}` — one verdict per head

module.exports = (app) => {
  app.log.info("widespread-bot up");

  /** PR → linked wide:funded issue → {issueNum, amount, claimant}. */
  async function fundedIssue(ctx, prBody) {
    const ref = (prBody || "").match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
    if (!ref) return null;
    const issueNum = Number(ref[1]);
    const issue = await ctx.octokit.issues.get({ ...ctx.issue(), issue_number: issueNum }).catch(() => null);
    const funded = (issue?.data?.labels ?? []).find((l) => /wide:funded/i.test(l.name || ""));
    if (!funded) return null;
    const amount = ((funded.name || "").match(/\$?([\d.]+)/) || [])[1] ?? "1.00";
    // payout binding: claimant:/near: NEAR account in issue body or the market comment
    const acct = /(?:claimant|near|payout):\s*([\w.-]+\.(?:testnet|near|tg|sweat|kaiching))/i;
    let claimant = (issue.data.body || "").match(acct)?.[1] ?? "";
    if (!claimant) {
      const comments = await ctx.octokit.issues.listComments({ ...ctx.issue(), issue_number: issueNum, per_page: 10 }).catch(() => ({ data: [] }));
      claimant = (comments.data.map((c) => c.body || "").join("\n").match(acct) || [])[1] ?? "";
    }
    return { issueNum, amount, claimant };
  }

  /** A parsed verdict on a funded PR → signed oracle verdict + payout. */
  async function emitVerdict(ctx, { pr, market, verdict }) {
    const repo = `${ctx.payload.repository.owner.login}/${ctx.payload.repository.name}`;
    const key = `${repo}#${market.issueNum}:${verdict.bot}:${pr.head?.sha ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const res = await fetch(`${BRIDGE}/api/bot-verdict`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo, pr: pr.number, issue: market.issueNum,
        bot: verdict.bot, score: verdict.score, verdict: verdict.verdict,
        head_sha: pr.head?.sha ?? "", amount: market.amount, claimant: market.claimant || undefined,
      }),
    }).catch((e) => ({ ok: false, json: async () => ({ error: String(e) }) }));
    const out = await res.json().catch(() => ({}));
    app.log.info({ repo, pr: pr.number, ...verdict, out: out.status }, "bot verdict");
    if (verdict.verdict === "accept" && pr.number) {
      await ctx.octokit.issues.createComment({ ...ctx.issue(), issue_number: pr.number,
        body: `@widespread **${verdict.bot} verdict: ${verdict.score}** → \`${out.status ?? "pending"}\`` +
              (out.record?.oracle_verdict_sig ? `\noracle_sig \`${out.record.oracle_verdict_sig.slice(0, 16)}…\`` : "") +
              `\nreceipt → ${BRIDGE}/api/bot-verdicts` }).catch(() => {});
    }
  }

  // PR review submitted (Copilot APPROVED, reviewer bots, etc.)
  app.on("pull_request_review.submitted", async (ctx) => {
    const pr = ctx.payload.pull_request, review = ctx.payload.review;
    const market = await fundedIssue(ctx, `${pr.body || ""} ${pr.title || ""}`);
    if (!market) return;
    const v = parseBotVerdict({ login: review.user?.login, body: review.body || "", state: review.state });
    if (v) await emitVerdict(ctx, { pr, market, verdict: v });
  });

  // PR conversation comment by a bot (Greptile summary, CodeRabbit notes)
  app.on("issue_comment.created", async (ctx) => {
    if (!ctx.payload.issue?.pull_request) return; // PR comments only
    const pr = await ctx.octokit.pulls.get({ ...ctx.issue(), pull_number: ctx.payload.issue.number }).catch(() => null);
    if (!pr) return;
    const market = await fundedIssue(ctx, `${pr.data.body || ""} ${pr.data.title || ""}`);
    if (!market) return;
    const v = parseBotVerdict({ login: ctx.payload.comment.user?.login, body: ctx.payload.comment.body || "" });
    if (v) await emitVerdict(ctx, { pr: pr.data, market, verdict: v });
  });

  // Check suite completed (review-ish apps only — CI alone isn't acceptance)
  app.on(["check_suite.completed", "check_run.completed"], async (ctx) => {
    const suite = ctx.payload.check_suite;
    const conclusion = suite?.conclusion ?? ctx.payload.check_run?.conclusion;
    const appSlug = suite?.app?.slug ?? ctx.payload.check_run?.app?.slug ?? "";
    const login = suite?.app?.name ?? ctx.payload.check_run?.app?.name ?? "";
    const prs = suite?.pull_requests ?? ctx.payload.check_run?.pull_requests ?? [];
    for (const pref of prs) {
      const pr = await ctx.octokit.pulls.get({ ...ctx.issue(), pull_number: pref.number }).catch(() => null);
      if (!pr) continue;
      const market = await fundedIssue(ctx, `${pr.data.body || ""} ${pr.data.title || ""}`);
      if (!market) continue;
      const headSha = pr.data.head?.sha ?? "";
      const v = parseBotVerdict({ login, appSlug, conclusion, body: "" });
      if (v) await emitVerdict(ctx, { pr: { ...pr.data, head: { sha: headSha } }, market, verdict: v });
    }
  });

  // ---- @widespread $N for <spec> → seed a market (issue body OR comment) ----
  async function seedBounty(ctx, rawBody, issue) {
    const body = rawBody || "";
    const m = body.match(/@widespread\s+\$?([\d.]+)\s+(?:for\s+)?([\s\S]+)/i);
    if (!m) return false;
    const [_, amount, specRaw] = m;
    const claimant = (specRaw.match(/(?:claimant|near):\s*([\w.-]+\.(?:testnet|near|tg|sweat|kaiching))/i) || [])[1] ?? "";
    const spec = specRaw.replace(/\s*(?:claimant|near):\s*[\w.-]+\.(?:testnet|near|tg|sweat|kaiching)/i, "").trim();
    const repo = `${ctx.payload.repository.owner.login}/${ctx.payload.repository.name}`;
    // labels + spec comment = the forge-native market record.
    // `wide:funded` (canonical) enables global label search for the feed poll.
    await ctx.octokit.issues.addLabels({ ...ctx.issue(), issue_number: issue.number,
      labels: [`wide:funded:$${amount}`, "wide:funded"] });
    await ctx.octokit.issues.createComment({ ...ctx.issue(), issue_number: issue.number,
      body: `@widespread market — **$${amount}** for \`${spec.slice(0, 140)}\`\n` +
            `market_id: \`${repo}#${issue.number}\` · specHash pinned · escrow → ${BRIDGE}/api/markets` +
            (claimant ? `\nclaimant: \`${claimant}\` — release pays it on-chain` : "") });
    // push-index into the unified feed — agents discover this within seconds
    await fetch(`${BRIDGE}/api/feed/index`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: `gh:${repo}#${issue.number}`, source: "github", forge: "github",
        kind: "bounty", repo, locator: `https://github.com/${repo}`,
        title: issue.title || spec.slice(0, 140), spec,
        amount, currency: "USD", est_usd: Number(amount) || undefined,
        escrow: { state: "label-only" },
        url: issue.html_url || `https://github.com/${repo}/issues/${issue.number}`,
        claim: { how: "PR with 'closes #N' + @widespread grammar", grammar: "@widespread <amount> <spec>" },
        execution: { recommended: "browser-tab (Pyodide/isomorphic-git)", isolation: "wasm-sandbox",
          alternatives: ["self-hosted sealed runner"], note: "client-side execution only" },
      }),
    }).catch((e) => app.log.warn({ err: String(e) }, "feed index push failed"));
    app.log.info({ repo, amount }, "bounty seeded");
    return true;
  }

  app.on(["issue_comment.created"], async (ctx) => {
    if (ctx.payload.issue?.pull_request) return; // PR comments handled above
    await seedBounty(ctx, ctx.payload.comment.body, ctx.payload.issue);
  });

  // Issue body grammar — opened seeds, edited re-seeds only if not funded yet.
  app.on(["issues.opened", "issues.edited"], async (ctx) => {
    const issue = ctx.payload.issue;
    if (!issue?.body) return;
    if ((issue.labels ?? []).some((l) => /wide:funded/i.test(l.name || ""))) return;
    await seedBounty(ctx, issue.body, issue);
  });

  // ---- PR merge = accept → trigger the bridge review → payout ----
  app.on("pull_request.closed", async (ctx) => {
    const pr = ctx.payload.pull_request;
    if (!pr.merged) return;
    const repo = `${ctx.payload.repository.owner.login}/${ctx.payload.repository.name}`;
    // find a wide-funded issue this PR closes
    const body = (pr.body || "") + " " + (pr.title || "");
    const ref = body.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
    if (!ref) return;
    const issueNum = ref[1];
    const issue = await ctx.octokit.issues.get({ ...ctx.issue(), issue_number: Number(issueNum) });
    const funded = (issue.data.labels || []).some((l) => /wide:funded/i.test(l.name || l));
    if (!funded) return;
    // merge=accept: trigger bridge adjudication on the merge commit
    const res = await fetch(`${BRIDGE}/review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, seq: 0, commits: [pr.merge_commit_sha], accept: true, merge_sha: pr.merge_commit_sha }),
    }).catch((e) => ({ ok: false, text: () => String(e) }));
    const out = await res.json?.().catch?.(() => ({}));
    // receipt lands in the PR thread — permanent repo history
    await ctx.octokit.issues.createComment({ ...ctx.issue(), issue_number: pr.number,
      body: `@widespread **merge = accept**\n` +
            `commit \`${pr.merge_commit_sha.slice(0, 10)}\` → review: \`${out.status ?? out.adjudication ?? "pending"}\`\n` +
            `receipt → ${BRIDGE}/api/markets` });
    app.log.info({ repo, sha: pr.merge_commit_sha }, "merge=accept triggered");
  });
};
