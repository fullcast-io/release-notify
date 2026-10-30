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

/** One line per change: title, PR link, author and Linear issues. Merge-branch noise is skipped. */
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
  const linear = [...new Set(title.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? [])];

  let line = `• ${escapeSlack(title)}`;
  if (pr) line += ` (<${serverUrl}/${repo}/pull/${pr}|#${pr}>)`;
  line += ` · ${escapeSlack(author)}`;
  if (linear.length) {
    line += ` · ${linear.map(id => `<https://linear.app/${linearWorkspace}/issue/${id}|${id}>`).join(", ")}`;
  }
  return line;
}

async function changesSection(currentSha) {
  let previous = input("PREVIOUS_REF");
  try {
    if (!previous) previous = await previousReleaseSha(currentSha);
    if (!previous) return { text: "_No previous release found to compare against._", compareUrl: null };

    const compare = await gh(`/repos/${repo}/compare/${previous}...${currentSha}`);
    const compareUrl = `${serverUrl}/${repo}/compare/${previous.slice(0, 12)}...${currentSha.slice(0, 12)}`;
    const lines = compare.commits.slice().reverse().map(describeCommit).filter(Boolean);
    if (!lines.length) return { text: "_No code changes since the previous release (redeploy)._", compareUrl };

    let text = `*Changes since the previous release* (${compare.total_commits} commit${compare.total_commits === 1 ? "" : "s"}):\n`;
    text += lines.slice(0, MAX_CHANGES).join("\n");
    if (lines.length > MAX_CHANGES) text += `\n…and ${lines.length - MAX_CHANGES} more (<${compareUrl}|full diff>)`;
    return { text: text.slice(0, 2900), compareUrl };
  } catch (error) {
    warn(`could not list changes: ${error.message}`);
    return { text: "_Could not list the changes for this release._", compareUrl: null };
  }
}

async function main() {
  const product = input("PRODUCT");
  const environment = input("ENVIRONMENT") || "production";
  const status = STATUS[input("STATUS")] ?? { emoji: ":grey_question:", word: input("STATUS") || "unknown" };
  const sha = env.GITHUB_SHA;
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
    warn(`Slack rejected the release message: ${result.error}`);
    return;
  }
  console.log(`Posted release to ${payload.channel} (ts ${result.ts})`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `message-ts=${result.ts}\n`);
}

main().catch(error => warn(`unexpected error: ${error.message}`));
