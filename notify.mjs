// release-notify (TECOP-543): post a production release to Slack in the standard Fullcast format.
// Plain Node 20 (global fetch), no dependencies, so the action needs no build step.
//
// A failed notification never fails the deploy: problems are reported as GitHub warnings and the script exits 0.

import { appendFileSync } from "node:fs";

const env = process.env;
const input = name => (env[`RN_${name}`] ?? "").trim();

const repo = env.GITHUB_REPOSITORY;
const serverUrl = env.GITHUB_SERVER_URL || "https://github.com";
const apiUrl = env.GITHUB_API_URL || "https://api.github.com";
const linearWorkspace = env.RN_LINEAR_WORKSPACE || "fullcast";
const MAX_CHANGES = 15;

const STATUS = {
  success: { emoji: ":white_check_mark:", word: "released" },
  failure: { emoji: ":x:", word: "FAILED" },
  cancelled: { emoji: ":black_square_for_stop:", word: "cancelled" },
};

const warn = message => console.log(`::warning title=release-notify::${message}`);

const escapeSlack = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function gh(path) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input("GITHUB_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub ${path} -> HTTP ${response.status}`);
  return response.json();
}

/** Head SHA of the last successful run of this workflow on this branch (the previous release). */
async function previousReleaseSha(currentSha) {
  const workflowFile = (env.GITHUB_WORKFLOW_REF || "").split("@")[0].split("/").pop();
  if (!workflowFile) return null;
  const branch = env.GITHUB_REF_NAME ? `&branch=${encodeURIComponent(env.GITHUB_REF_NAME)}` : "";
  const runs = await gh(`/repos/${repo}/actions/workflows/${workflowFile}/runs?status=success&per_page=30${branch}`);
  const previous = runs.workflow_runs.find(run => String(run.id) !== env.GITHUB_RUN_ID && run.head_sha !== currentSha);
  return previous?.head_sha ?? null;
}

/** One change: its title and its line (title, PR link, author, Linear issues). Merge-branch noise is skipped. */
function describeCommit(commit) {
  const [firstLine, , ...rest] = commit.commit.message.split("\n");
  if (/^Merge (remote-tracking )?branch /.test(firstLine)) return null;

  let title = firstLine;
  let pr = firstLine.match(/\(#(\d+)\)\s*$/)?.[1];
  const mergePr = firstLine.match(/^Merge pull request #(\d+)/);
  if (mergePr) {
    pr = mergePr[1];
    title = rest.find(line => line.trim()) ?? firstLine;
  }
  title = title.replace(/\s*\(#\d+\)\s*$/, "");

  const author = commit.author?.login ?? commit.commit.author?.name ?? "unknown";
  // Uppercase IDs anywhere, plus a lowercase one in a conventional-commit scope, e.g. "fix(ebs-607): ...".
  const scoped = title.match(/^\w+\(([a-z][a-z0-9]{1,9}-\d+)\)!?:/)?.[1]?.toUpperCase();
  const ids = title.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? [];
  const linear = [...new Set(scoped ? [scoped, ...ids] : ids)];

  let line = `• ${escapeSlack(title)}`;
  if (pr) line += ` (<${serverUrl}/${repo}/pull/${pr}|#${pr}>)`;
  line += ` · ${escapeSlack(author)}`;
  if (linear.length) {
    line += ` · ${linear.map(id => `<https://linear.app/${linearWorkspace}/issue/${id}|${id}>`).join(", ")}`;
  }
  return { title, pr, line };
}

/** Lines for the changes, newest first. A merged PR's own commit with the same title is dropped in favour of the PR. */
function changeLines(commits) {
  const changes = commits.map(describeCommit).filter(Boolean);
  const titlesWithPr = new Set(changes.filter(change => change.pr).map(change => change.title));
  return changes.filter(change => change.pr || !titlesWithPr.has(change.title)).map(change => change.line);
}

/** Commits reachable from `ref` that touched `path` since `since`, as a sha -> commit map. */
async function pathHistory(ref, path, since) {
  const commits = new Map();
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(
      `/repos/${repo}/commits?sha=${ref}&path=${encodeURIComponent(path)}&since=${since}&per_page=100&page=${page}`,
    );
    for (const commit of batch) commits.set(commit.sha, commit);
    if (batch.length < 100) break;
  }
  return commits;
}

/**
 * Commits in `base..head` that touched any of `paths`, newest first, so a monorepo release only shows its own
 * service's changes. It's the path history of `head` minus the path history of `base`. Branches merged after the
 * previous release can carry older commits, so both histories reach back 90 days before the previous release.
 */
async function commitsTouching(paths, base, head) {
  const baseDate = new Date((await gh(`/repos/${repo}/commits/${base}`)).commit.committer.date);
  const since = new Date(baseDate.getTime() - 90 * 24 * 3600 * 1000).toISOString();
  const commits = new Map();
  for (const path of paths) {
    const released = await pathHistory(base, path, since);
    for (const [sha, commit] of await pathHistory(head, path, since)) {
      if (!released.has(sha)) commits.set(sha, commit);
    }
  }
  return [...commits.values()].sort((a, b) => b.commit.committer.date.localeCompare(a.commit.committer.date));
}

async function changesSection(currentSha) {
  let previous = input("PREVIOUS_REF");
  const paths = input("PATHS").split(/[\n,]/).map(path => path.trim()).filter(Boolean);
  try {
    if (!previous) previous = await previousReleaseSha(currentSha);
    if (!previous) return { text: "_No previous release found to compare against._", compareUrl: null };

    // Resolve tags/branches to a commit so the diff link is always valid.
    const base = (await gh(`/repos/${repo}/commits/${encodeURIComponent(previous)}`)).sha;
    const compareUrl = `${serverUrl}/${repo}/compare/${base.slice(0, 12)}...${currentSha.slice(0, 12)}`;

    let commits;
    let total;
    if (paths.length) {
      commits = await commitsTouching(paths, base, currentSha);
      total = commits.length;
    } else {
      const compare = await gh(`/repos/${repo}/compare/${base}...${currentSha}`);
      commits = compare.commits.slice().reverse();
      total = compare.total_commits;
    }
    const lines = changeLines(commits);
    // Count changes, not commits: merge noise and duplicates aren't listed. The compare API lists at most 250
    // commits, so beyond that the dropped share is estimated from the listed ones.
    total = Math.max(lines.length, total - (commits.length - lines.length));
    if (!lines.length) return { text: "_No code changes since the previous release (redeploy)._", compareUrl };

    // Whole lines only, so a Slack link is never cut in half (section text limit is 3000 chars).
    let text = `*Changes since the previous release* (${total} change${total === 1 ? "" : "s"}):`;
    let shown = 0;
    for (const line of lines.slice(0, MAX_CHANGES)) {
      if (text.length + line.length > 2800) break;
      text += `\n${line}`;
      shown++;
    }
    if (lines.length > shown) text += `\n…and ${lines.length - shown} more (<${compareUrl}|full diff>)`;
    return { text, compareUrl };
  } catch (error) {
    warn(`could not list changes: ${error.message}`);
    return { text: "_Could not list the changes for this release._", compareUrl: null };
  }
}

async function main() {
  const product = input("PRODUCT");
  const environment = input("ENVIRONMENT") || "production";
  const status = STATUS[input("STATUS")] ?? { emoji: ":grey_question:", word: input("STATUS") || "unknown" };
  const sha = input("SHA") || env.GITHUB_SHA;
  const version = input("VERSION") || sha.slice(0, 7);
  const runUrl = `${serverUrl}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;

  const changes = await changesSection(sha);

  const fields = [
    `*Version*\n<${serverUrl}/${repo}/commit/${sha}|${escapeSlack(version)}>`,
    `*Deployed by*\n${escapeSlack(input("DEPLOYED_BY") || env.GITHUB_ACTOR || "unknown")}`,
  ];
  if (input("APPROVED_BY")) fields.push(`*Approved by*\n${escapeSlack(input("APPROVED_BY"))}`);
  if (input("DETAILS")) fields.push(`*Details*\n${escapeSlack(input("DETAILS"))}`);

  const links = [`<${runUrl}|Pipeline run>`, `<${serverUrl}/${repo}|${repo}>`];
  if (changes.compareUrl) links.splice(1, 0, `<${changes.compareUrl}|Full diff>`);

  const headline = `${status.emoji} ${product} ${status.word} to ${environment}`;
  const payload = {
    channel: input("SLACK_CHANNEL"),
    text: `${headline}: ${version}`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${escapeSlack(headline)}*` } },
      { type: "section", fields: fields.map(text => ({ type: "mrkdwn", text })) },
      { type: "section", text: { type: "mrkdwn", text: changes.text } },
      { type: "context", elements: [{ type: "mrkdwn", text: links.join(" · ") }] },
    ],
  };

  if (input("DRY_RUN") === "true") {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (!input("SLACK_TOKEN") || !payload.channel) {
    warn("slack-bot-token or slack-channel is empty; release not posted");
    return;
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${input("SLACK_TOKEN")}` },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!result.ok) {
    let hint = "";
    if (result.error === "not_in_channel" || result.error === "channel_not_found") {
      // Name the bot the token belongs to, so it's clear which app to invite to the channel.
      const identity = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${input("SLACK_TOKEN")}` },
      }).then(r => r.json()).catch(() => ({}));
      if (identity.ok) hint = ` (the token belongs to bot @${identity.user} in ${identity.team}; invite it to the channel)`;
    }
    warn(`Slack rejected the release message: ${result.error}${hint}`);
    return;
  }
  console.log(`Posted release to ${payload.channel} (ts ${result.ts})`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `message-ts=${result.ts}\n`);
}

main().catch(error => warn(`unexpected error: ${error.message}`));
