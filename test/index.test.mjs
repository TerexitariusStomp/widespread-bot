// index.test.mjs — webhook handler tests with a fake Probot app/context.
// Covers: @widespread bounty seeding, funded-issue detection, merge=accept,
// and review-bot verdict emission — all against stubbed octokit + fetch.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const handlers = new Map();
const logs = [];
const fakeApp = {
  on: (names, fn) => { for (const n of [].concat(names)) handlers.set(n, fn); },
  log: { info: (...a) => logs.push(a), warn: () => {} },
};

const { default: _ } = await import("node:assert"); // noop keep import style
await import("../index.js").then((m) => m.default(fakeApp));

// --- fakes -----------------------------------------------------------------

const calls = { labels: [], comments: [], issuesGet: 0, pullsGet: 0,
                fetch: [] };
let fetchQueue = [];

const realFetch = globalThis.fetch;
beforeEach(() => {
  calls.labels = []; calls.comments = []; calls.issuesGet = 0;
  calls.pullsGet = 0; calls.fetch = []; fetchQueue = []; logs.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.fetch.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const next = fetchQueue.shift();
    if (next instanceof Error) throw next;
    if (next) return new Response(JSON.stringify(next), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
});
process.on("exit", () => { globalThis.fetch = realFetch; });

function makeOctokit({ issueLabels = [], issueBody = "", prBody = "", prTitle = "" } = {}) {
  return {
    issues: {
      get: async () => {
        calls.issuesGet++;
        return { data: { labels: issueLabels, body: issueBody } };
      },
      listComments: async () => ({ data: [] }),
      addLabels: async (a) => { calls.labels.push(a.labels); return {}; },
      createComment: async (a) => { calls.comments.push(a.body); return {}; },
    },
    pulls: {
      get: async () => {
        calls.pullsGet++;
        return { data: { body: prBody, title: prTitle, head: { sha: "abc123" }, number: 7 } };
      },
    },
  };
}

function issueCtx({ body = "", labels = [], number = 5, title = "task" } = {}) {
  return {
    octokit: makeOctokit({ issueLabels: labels, issueBody: body }),
    issue: () => ({ owner: "o", repo: "r" }),
    payload: {
      repository: { owner: { login: "o" }, name: "r" },
      issue: { number, title, body, labels, html_url: "https://github.com/o/r/issues/5" },
      comment: { body, user: { login: "someone" } },
    },
  };
}

const FUNDED = [{ name: "wide:funded:$25" }, { name: "wide:funded" }];

// --- tests -----------------------------------------------------------------

test("issue_comment '@widespread $25 for spec' seeds labels, comment, feed", async () => {
  const ctx = issueCtx({ body: "@widespread $25 for fix the flaky test claimant: worker.testnet" });
  await handlers.get("issue_comment.created")(ctx);
  assert.deepEqual(calls.labels[0], ["wide:funded:$25", "wide:funded"]);
  assert.match(calls.comments[0], /\$25.*flaky test/);
  assert.match(calls.comments[0], /worker\.testnet/);
  const idx = calls.fetch.find((f) => f.url.endsWith("/api/feed/index"));
  assert.ok(idx, "feed index push fired");
  assert.equal(idx.body.amount, "25");
  assert.equal(idx.body.spec, "fix the flaky test"); // claimant stripped
});

test("issue body grammar seeds on issues.opened", async () => {
  const ctx = issueCtx({ body: "@widespread $10 add dark mode" });
  ctx.payload.issue.pull_request = undefined;
  await handlers.get("issues.opened")(ctx);
  assert.ok(calls.labels.length >= 1);
});

test("already-funded issue is not re-seeded on edit", async () => {
  const ctx = issueCtx({
    body: "@widespread $99 more money",
    labels: [{ name: "wide:funded:$10" }, { name: "wide:funded" }],
  });
  await handlers.get("issues.edited")(ctx);
  assert.equal(calls.labels.length, 0);
});

test("merge of PR closing a funded issue triggers /review + receipt comment", async () => {
  fetchQueue.push({ status: "adjudicated" });
  const ctx = {
    octokit: makeOctokit({
      issueLabels: FUNDED,
      prBody: "implements the fix\n\ncloses #5",
      prTitle: "fix it",
    }),
    issue: () => ({ owner: "o", repo: "r" }),
    payload: {
      repository: { owner: { login: "o" }, name: "r" },
      pull_request: {
        number: 9, merged: true, merge_commit_sha: "deadbeef123",
        body: "implements the fix\n\ncloses #5", title: "fix it",
      },
    },
  };
  await handlers.get("pull_request.closed")(ctx);
  const rev = calls.fetch.find((f) => f.url.endsWith("/review"));
  assert.ok(rev, "bridge /review called");
  assert.equal(rev.body.accept, true);
  assert.equal(rev.body.merge_sha, "deadbeef123");
  assert.ok(calls.comments.some((c) => c.includes("merge = accept")));
});

test("merge of PR closing an UNFUNDED issue does nothing", async () => {
  const ctx = {
    octokit: makeOctokit({ issueLabels: [], prBody: "closes #5" }),
    issue: () => ({ owner: "o", repo: "r" }),
    payload: {
      repository: { owner: { login: "o" }, name: "r" },
      pull_request: { number: 9, merged: true, merge_commit_sha: "x",
                      body: "closes #5", title: "t" },
    },
  };
  await handlers.get("pull_request.closed")(ctx);
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.comments.length, 0);
});

test("unmerged PR close is ignored", async () => {
  const ctx = {
    octokit: makeOctokit({}),
    issue: () => ({ owner: "o", repo: "r" }),
    payload: {
      repository: { owner: { login: "o" }, name: "r" },
      pull_request: { number: 9, merged: false, body: "closes #5" },
    },
  };
  await handlers.get("pull_request.closed")(ctx);
  assert.equal(calls.issuesGet, 0);
});

test("coderabbit APPROVED-equivalent review on funded PR emits bot-verdict", async () => {
  fetchQueue.push({ status: "payout_sent", record: { oracle_verdict_sig: "ab".repeat(16) } });
  const ctx = {
    octokit: makeOctokit({
      issueLabels: FUNDED,
      prBody: "fix\ncloses #5",
      prTitle: "fix",
    }),
    issue: () => ({ owner: "o", repo: "r" }),
    payload: {
      repository: { owner: { login: "o" }, name: "r" },
      pull_request: { number: 9, body: "fix\ncloses #5", title: "fix",
                      head: { sha: "abc123" } },
      review: {
        user: { login: "coderabbitai[bot]" },
        body: "## Summary\nActionable comments posted: 0",
        state: "COMMENTED",
      },
    },
  };
  await handlers.get("pull_request_review.submitted")(ctx);
  const bv = calls.fetch.find((f) => f.url.endsWith("/api/bot-verdict"));
  assert.ok(bv, "bot-verdict posted");
  assert.equal(bv.body.verdict, "accept");
  assert.equal(bv.body.score, "5/5");
  assert.equal(bv.body.pr, 9);
  assert.equal(bv.body.issue, 5);
  assert.ok(calls.comments.some((c) => c.includes("coderabbitai") || c.includes("verdict")));
});

test("human review on funded PR emits nothing", async () => {
  const ctx = {
    octokit: makeOctokit({ issueLabels: FUNDED, prBody: "closes #5" }),
    issue: () => ({ owner: "o", repo: "r" }),
    payload: {
      repository: { owner: { login: "o" }, name: "r" },
      pull_request: { number: 9, body: "closes #5", title: "t", head: { sha: "s" } },
      review: { user: { login: "shredder" }, body: "lgtm", state: "APPROVED" },
    },
  };
  await handlers.get("pull_request_review.submitted")(ctx);
  assert.equal(calls.fetch.filter((f) => f.url.includes("bot-verdict")).length, 0);
});
