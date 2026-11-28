#!/usr/bin/env node
// Trigger a Render deploy for one pinned commit and wait until that deploy is
// live. The deploy workflow used to POST to Render and return, so the smoke
// job probed whatever happened to be serving: a deploy that was still building
// read as the old build, and the storage gate named that as a permanent
// failure. The pin and the wait are what make the gate's verdict mean
// something.
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_API_BASE = 'https://api.render.com';
const DEFAULT_POLL_SEC = 20;
// Render's documented build timeout is 120 minutes and its start-command
// timeout is 15 minutes, so a deploy can legitimately take 135 minutes. The
// wait budget has to exceed the provider's own timeouts: a budget shorter than
// the build timeout turns a slow but healthy deploy into a red pipeline, which
// is the false red this script exists to remove.
const DEFAULT_TIMEOUT_SEC = 8400;

// The provider's deployStatus enum has eleven values. These are the terminal
// failures: the five its OpenAPI spec documents plus the one the scope
// contract names, so a status either of them calls is never waited out.
const TERMINAL_FAILURE_STATUSES = new Set([
  'build_failed',
  'update_failed',
  'deploy_failed',
  'pre_deploy_failed',
  'canceled',
  'deactivated',
]);

// GitHub's shortest short sha is seven characters, so a published identity of
// that length is still the same commit.
const MIN_SHORT_SHA_LEN = 7;

class DeployFailure extends Error {}

function parseArgs(argv) {
  const args = {
    serviceId: null,
    commit: null,
    apiBase: DEFAULT_API_BASE,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    pollSec: DEFAULT_POLL_SEC,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--service-id') {
      args.serviceId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--commit') {
      args.commit = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--api-base') {
      args.apiBase = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--timeout-sec') {
      args.timeoutSec = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--poll-sec') {
      args.pollSec = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    throw new DeployFailure(`unknown argument ${arg}`);
  }
  return args;
}

function readApiKey() {
  const key = process.env.RENDER_API_KEY;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

// Every message the script emits passes through here, so the API key cannot
// reach stdout, stderr or an error message even if the provider echoed it.
function redact(text, apiKey) {
  const value = String(text);
  if (!apiKey) return value;
  return value.split(apiKey).join('[redacted]');
}

function bodyExcerpt(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) return '';
  return ` (body: ${trimmed.slice(0, 200)})`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The deploy object is returned unwrapped by the provider's spec, with the
// commit published as an object whose id is the commit identity. A wrapped
// object is accepted as well, so the wait survives a shape change that still
// carries the same facts.
function extractDeploy(body) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.id === 'string' && body.id.length > 0) return body;
  if (body.deploy && typeof body.deploy === 'object' && typeof body.deploy.id === 'string' && body.deploy.id.length > 0) {
    return body.deploy;
  }
  return null;
}

function readCommitIdentity(deploy) {
  const commit = deploy.commit;
  if (typeof commit === 'string' && commit.length > 0) return commit;
  if (commit && typeof commit === 'object' && typeof commit.id === 'string' && commit.id.length > 0) return commit.id;
  return null;
}

// The identity the provider published has to be the commit that was pushed. It
// may be the full sha or a shortening of it, so a published value of at least
// seven characters that is a prefix of the pushed commit is the same commit.
// Anything else is a different commit.
function commitIdentityMatches(published, pushed) {
  if (published === pushed) return true;
  const shorter = published.length <= pushed.length ? published : pushed;
  const longer = published.length <= pushed.length ? pushed : published;
  if (shorter.length < MIN_SHORT_SHA_LEN) return false;
  return longer.startsWith(shorter);
}

function emitFacts(facts) {
  const lines = [];
  if (facts.deployId) lines.push(`DEPLOY_ID=${facts.deployId}`);
  if (facts.deployCommit) lines.push(`DEPLOY_COMMIT=${facts.deployCommit}`);
  if (facts.deployStatus) lines.push(`DEPLOY_STATUS=${facts.deployStatus}`);
  for (const line of lines) {
    console.log(line.replace(/[\r\n]+/g, ' '));
  }
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const outputs = [];
  if (facts.deployId) outputs.push(`deploy_id=${facts.deployId}`);
  if (facts.deployCommit) outputs.push(`deploy_commit=${facts.deployCommit}`);
  if (facts.deployStatus) outputs.push(`deploy_status=${facts.deployStatus}`);
  if (outputs.length === 0) return;
  try {
    appendFileSync(outputPath, `${outputs.join('\n')}\n`);
  } catch (err) {
    console.error(`render-deploy: the GitHub step output could not be written (${err.message})`);
  }
}

async function triggerDeploy(args, apiKey, facts) {
  const url = `${args.apiBase}/v1/services/${encodeURIComponent(args.serviceId)}/deploys`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        connection: 'close',
      },
      body: JSON.stringify({ commitId: args.commit }),
    });
  } catch (err) {
    throw new DeployFailure(
      `the Render deploy trigger could not reach the API (${err.message}) - no deploy was created, so the pushed ` +
      `commit was never deployed.`
    );
  }
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new DeployFailure(
      `the Render deploy trigger was refused (HTTP ${response.status}) for service ${args.serviceId} - no deploy was ` +
      `created, so the pushed commit was never deployed.${bodyExcerpt(text)}`
    );
  }
  const body = parseJson(text);
  if (body === null) {
    throw new DeployFailure(
      `the Render deploy response is not JSON - the deploy may have been created, but the workflow cannot prove ` +
      `which commit it is for.${bodyExcerpt(text)}`
    );
  }
  const deploy = extractDeploy(body);
  if (deploy === null) {
    throw new DeployFailure(
      `the Render deploy response does not publish a deploy id (the API shape changed) - the workflow cannot wait ` +
      `for the deploy it created.${bodyExcerpt(text)}`
    );
  }
  facts.deployId = deploy.id;
  const published = readCommitIdentity(deploy);
  if (published === null) {
    throw new DeployFailure(
      `the Render deploy response does not publish the commit identity (the API shape changed) - the deploy that was ` +
      `created cannot be proved to be the pushed commit.${bodyExcerpt(text)}`
    );
  }
  facts.deployCommit = published;
  if (!commitIdentityMatches(published, args.commit)) {
    throw new DeployFailure(
      `the Render deploy is for a different commit than the one pushed (deployed=${published}, ` +
      `pushed=${args.commit}) - the deploy does not prove that the pushed commit went live.`
    );
  }
  return deploy;
}

async function waitForDeploy(args, apiKey, deployId, facts) {
  const url = `${args.apiBase}/v1/services/${encodeURIComponent(args.serviceId)}/deploys/${encodeURIComponent(deployId)}`;
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, args.timeoutSec) * 1000;
  let lastStatus = null;
  let lastError = null;
  for (;;) {
    let status = null;
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', connection: 'close' },
      });
      const text = await response.text();
      if (response.status === 200) {
        const body = parseJson(text);
        if (body && typeof body.status === 'string' && body.status.length > 0) {
          status = body.status;
        } else {
          lastError = 'the deploy response published no status';
        }
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (err) {
      lastError = err.message;
    }
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    if (status) {
      lastStatus = status;
      facts.deployStatus = status;
      if (status === 'live') {
        return;
      }
      if (TERMINAL_FAILURE_STATUSES.has(status)) {
        throw new DeployFailure(
          `the Render deploy reached a terminal failure (status=${status}, deploy=${deployId}) - the pushed commit did ` +
          `not go live.`
        );
      }
      console.error(`render-deploy: deploy ${deployId} status=${status} elapsed=${elapsedSec}s`);
    } else {
      console.error(`render-deploy: deploy ${deployId} status unknown (${lastError}) elapsed=${elapsedSec}s`);
    }
    if (Date.now() >= deadline) {
      throw new DeployFailure(
        `the Render deploy did not go live within ${args.timeoutSec}s (last status=${lastStatus ?? 'unknown'}, ` +
        `deploy=${deployId}${lastError ? `, last error=${lastError}` : ''}) - the pushed commit was not proved live.`
      );
    }
    await sleep(Math.max(0, args.pollSec) * 1000);
  }
}

async function main() {
  const facts = { deployId: null, deployCommit: null, deployStatus: null };
  const apiKey = readApiKey();
  let exitCode = 0;
  try {
    let args;
    try {
      args = parseArgs(process.argv.slice(2));
    } catch (err) {
      console.error(`::error::${redact(err.message, apiKey)}`);
      return 2;
    }
    if (!args.serviceId || !args.commit) {
      console.error(
        '::error::usage: node scripts/render-deploy.mjs --service-id <srv-id> --commit <sha> ' +
        '[--api-base https://api.render.com] [--timeout-sec 8400] [--poll-sec 20]'
      );
      return 2;
    }
    if (!apiKey) {
      console.error(
        '::error::RENDER_API_KEY is not set - the Render API key must come from the environment, never from an ' +
        'argument or a literal.'
      );
      return 2;
    }
    if (!Number.isFinite(args.timeoutSec) || args.timeoutSec < 0) {
      console.error('::error::--timeout-sec must be a non-negative number of seconds');
      return 2;
    }
    if (!Number.isFinite(args.pollSec) || args.pollSec < 0) {
      console.error('::error::--poll-sec must be a non-negative number of seconds');
      return 2;
    }
    await triggerDeploy(args, apiKey, facts);
    await waitForDeploy(args, apiKey, facts.deployId, facts);
    console.log(
      `Render deploy ${facts.deployId} reached live for commit ${facts.deployCommit}. The pushed commit is the ` +
      `deploy that was proved.`
    );
    exitCode = 0;
  } catch (err) {
    const message = err instanceof DeployFailure ? err.message : `the Render deploy wait failed (${err.message})`;
    console.error(`::error::${redact(message, apiKey)}`);
    exitCode = 1;
  } finally {
    emitFacts(facts);
  }
  return exitCode;
}

process.exitCode = await main();
