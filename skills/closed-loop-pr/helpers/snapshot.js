'use strict';

const { run } = require('./process');
const { createResult, createError } = require('./protocol');

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const reviewThreadsQuery = `query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 100) {
            totalCount
            nodes { id databaseId url body createdAt updatedAt author { login __typename } }
            pageInfo { endCursor hasNextPage }
          }
        }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
}`;

function schemaError(message, code = 'invalid_schema') {
  const error = new Error(message);
  error.code = code;
  error.phase = 'github_snapshot';
  return error;
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function parseJson(bytes, label) {
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw schemaError(`invalid JSON from ${label}`, 'invalid_json'); }
}
function identity(value) {
  if (!object(value) || !object(value.base) || !object(value.head) || typeof value.base.sha !== 'string' || typeof value.base.ref !== 'string' || value.base.ref.length === 0 || typeof value.head.sha !== 'string') throw schemaError('invalid pull-request identity');
  if (value.state !== null && typeof value.state !== 'string') throw schemaError('invalid pull-request state');
  if (value.draft !== null && typeof value.draft !== 'boolean') throw schemaError('invalid pull-request draft state');
  return {
    base: value.base.sha,
    baseBranch: value.base.ref,
    head: value.head.sha,
    state: value.state ?? null,
    draft: value.draft ?? null,
    headRepository: value.head.repo?.full_name ?? null,
    headBranch: value.head.ref ?? null,
  };
}
function canonicalString(value, label, missing = null) {
  if (value === undefined || value === null) return missing;
  if (typeof value !== 'string') throw schemaError(`invalid pull-request ${label}`);
  return value;
}
function canonicalRepository(value) {
  if (value === undefined || value === null) return null;
  if (!object(value)) throw schemaError('invalid pull-request repository');
  return { full_name: canonicalString(value.full_name, 'repository identity') };
}
function canonicalPull(value, number) {
  if (!object(value) || value.number !== number) throw schemaError('invalid pull-request number');
  if (!object(value.base) || !object(value.head)) throw schemaError('invalid pull-request identity');
  const pull = {
    number,
    state: canonicalString(value.state, 'state'),
    draft: value.draft === undefined || value.draft === null ? null : value.draft,
    title: canonicalString(value.title, 'title'),
    body: canonicalString(value.body, 'body'),
    user: value.user === undefined || value.user === null ? null : {
      login: canonicalString(value.user.login, 'author login'),
      type: canonicalString(value.user.type, 'author type'),
    },
    author_association: canonicalString(value.author_association, 'author association'),
    base: {
      sha: canonicalString(value.base.sha, 'base identity'),
      ref: canonicalString(value.base.ref, 'base identity'),
      repo: canonicalRepository(value.base.repo),
    },
    head: {
      sha: canonicalString(value.head.sha, 'head identity'),
      ref: canonicalString(value.head.ref, 'head identity'),
      repo: canonicalRepository(value.head.repo),
    },
    mergeable: value.mergeable === undefined ? null : value.mergeable,
    mergeable_state: canonicalString(value.mergeable_state, 'mergeable state'),
  };
  if (typeof pull.draft !== 'boolean' && pull.draft !== null) throw schemaError('invalid pull-request draft state');
  if (typeof pull.mergeable !== 'boolean' && pull.mergeable !== null) throw schemaError('invalid pull-request mergeability');
  return pull;
}
function sameIdentity(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function defaultTransport(command, args, options) { return run(command, args, options); }
async function ghJson(transport, args, cwd, label) {
  const result = await transport('gh', args, { cwd, phase: 'github_snapshot', kind: 'gh' });
  return parseJson(result.stdout, label);
}
async function restPages(transport, endpoint, cwd, shape = 'array') {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const value = await ghJson(transport, ['api', '-H', 'Accept: application/vnd.github+json', '--method', 'GET', '-f', `per_page=${PAGE_SIZE}`, '-f', `page=${page}`, endpoint], cwd, endpoint);
    if (shape === 'array') {
      if (!Array.isArray(value)) throw schemaError(`${endpoint} page is not an array`);
      all.push(...value);
      if (value.length < PAGE_SIZE) return all;
    } else {
      if (!object(value) || !Array.isArray(value[shape])) throw schemaError(`${endpoint} page lacks ${shape}`);
      all.push(...value[shape]);
      if (value[shape].length < PAGE_SIZE) return all;
    }
  }
  throw schemaError(`${endpoint} pagination limit exceeded`, 'pagination_incomplete');
}
async function reviewThreads(transport, owner, repo, number, cwd) {
  const result = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const args = ['api', 'graphql', '-f', `query=${reviewThreadsQuery}`, '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `number=${number}`];
    if (cursor !== null) args.push('-F', `after=${cursor}`);
    const response = await ghJson(transport, args, cwd, 'reviewThreads');
    const connection = response?.data?.repository?.pullRequest?.reviewThreads;
    if (!object(connection) || !Array.isArray(connection.nodes) || !object(connection.pageInfo) || typeof connection.pageInfo.hasNextPage !== 'boolean') throw schemaError('invalid review-thread connection');
    for (const thread of connection.nodes) {
      if (!object(thread) || typeof thread.id !== 'string' || !object(thread.comments) || !Array.isArray(thread.comments.nodes) || !object(thread.comments.pageInfo)) throw schemaError('invalid review-thread node');
      if (thread.comments.pageInfo.hasNextPage === true || Number(thread.comments.totalCount) > thread.comments.nodes.length) throw schemaError('nested review-thread comments exceed packaged query page', 'pagination_incomplete');
      if (seen.has(thread.id)) throw schemaError('duplicate review-thread identity', 'duplicate_identity');
      seen.add(thread.id);
      result.push(thread);
    }
    if (!connection.pageInfo.hasNextPage) return result;
    if (typeof connection.pageInfo.endCursor !== 'string' || connection.pageInfo.endCursor.length === 0 || seen.has(`cursor:${connection.pageInfo.endCursor}`)) throw schemaError('invalid or repeated review-thread cursor', 'pagination_incomplete');
    seen.add(`cursor:${connection.pageInfo.endCursor}`);
    cursor = connection.pageInfo.endCursor;
  }
  throw schemaError('review-thread pagination limit exceeded', 'pagination_incomplete');
}
function policyIdentity(list) {
  return JSON.stringify(list.map((item) => ({ id: item.id, updated_at: item.updated_at, enforcement: item.enforcement })).sort((a, b) => a.id - b.id));
}
async function detailedRulesets(transport, endpoint, cwd, summaries = undefined) {
  const before = summaries === undefined ? await restPages(transport, endpoint, cwd) : summaries;
  if (!Array.isArray(before)) throw schemaError(`${endpoint} summaries are not an array`);
  const details = [];
  for (const summary of before) {
    if (!object(summary) || !Number.isSafeInteger(summary.id) || typeof summary.updated_at !== 'string') throw schemaError(`${endpoint} summary lacks stable identity`);
    const detail = await ghJson(transport, ['api', '--method', 'GET', `${endpoint}/${summary.id}`], cwd, `${endpoint}/${summary.id}`);
    if (!object(detail) || detail.id !== summary.id || !Array.isArray(detail.rules) || !Array.isArray(detail.bypass_actors)) throw schemaError(`${endpoint}/${summary.id} detail is incomplete`);
    details.push(detail);
  }
  const after = await restPages(transport, endpoint, cwd);
  if (policyIdentity(before) !== policyIdentity(after)) throw schemaError(`${endpoint} policy changed during collection`, 'stale_policy');
  return details;
}
function classifyChecks(checks = []) {
  if (!Array.isArray(checks)) throw schemaError('checks are not an array');
  return checks.map((check) => {
    if (!object(check) || typeof check.name !== 'string' || typeof check.status !== 'string' || (check.conclusion !== null && typeof check.conclusion !== 'string')) throw schemaError('check run lacks status classification');
    return { id: check.id, name: check.name, status: check.status, conclusion: check.conclusion, successful: check.status === 'completed' && check.conclusion === 'success', pending: check.status !== 'completed' || check.conclusion === null, failed: check.status === 'completed' && check.conclusion !== null && check.conclusion !== 'success' };
  });
}
async function collectAnnotations(transport, endpoint, checks, cwd) {
  const annotations = [];
  for (const check of checks) {
    if (!object(check) || (!Number.isSafeInteger(check.id) && typeof check.id !== 'number')) throw schemaError('check run lacks numeric identity');
    annotations.push(...await restPages(transport, `${endpoint}/check-runs/${check.id}/annotations`, cwd));
  }
  return annotations;
}
async function optionalPolicy(transport, args, cwd, label, missingValue) {
  try { return await ghJson(transport, args, cwd, label); }
  catch (error) {
    if (error.exitCode === 404 || /HTTP 404/.test(error.stderr || '')) return missingValue;
    throw error;
  }
}

async function collectSnapshot({ owner, repo, number, cwd, transport = defaultTransport }) {
  try {
    if (typeof owner !== 'string' || typeof repo !== 'string' || !Number.isSafeInteger(number) || number <= 0) throw schemaError('invalid snapshot target', 'invalid_request');
    const endpoint = `repos/${owner}/${repo}`;
    const pullBefore = canonicalPull(await ghJson(transport, ['api', `${endpoint}/pulls/${number}`], cwd, 'pull identity before'), number);
    const before = identity(pullBefore);
    const head = before.head;
    const [comments, reviews, inline, threads, checks, statuses, suites, branchProtection, rulesets, repository] = await Promise.all([
      restPages(transport, `${endpoint}/issues/${number}/comments`, cwd),
      restPages(transport, `${endpoint}/pulls/${number}/reviews`, cwd),
      restPages(transport, `${endpoint}/pulls/${number}/comments`, cwd),
      reviewThreads(transport, owner, repo, number, cwd),
      restPages(transport, `${endpoint}/commits/${head}/check-runs`, cwd, 'check_runs'),
      restPages(transport, `${endpoint}/commits/${head}/statuses`, cwd),
      restPages(transport, `${endpoint}/commits/${head}/check-suites`, cwd, 'check_suites'),
      optionalPolicy(transport, ['api', `${endpoint}/branches/${encodeURIComponent(before.baseBranch)}/protection`], cwd, 'branch protection', false),
      restPages(transport, `${endpoint}/rulesets`, cwd),
      ghJson(transport, ['api', endpoint], cwd, 'repository'),
    ]);
    const repositoryRulesets = await detailedRulesets(transport, `${endpoint}/rulesets`, cwd, rulesets);
    if (!repository.owner || !['User', 'Organization'].includes(repository.owner.type)) throw schemaError('repository owner type is unknown', 'policy_collection_incomplete');
    const organizationRulesets = repository.owner.type === 'Organization'
      ? await detailedRulesets(transport, `orgs/${owner}/rulesets`, cwd)
      : [];
    const annotations = await collectAnnotations(transport, endpoint, checks, cwd);
    const classifiedChecks = classifyChecks(checks);
    const pullAfter = canonicalPull(await ghJson(transport, ['api', `${endpoint}/pulls/${number}`], cwd, 'pull identity after'), number);
    const after = identity(pullAfter);
    if (!sameIdentity(before, after)) return createError('snapshot', 'stale_target', 'target identity changed during collection', 'github_snapshot');
    return createResult('snapshot', {
      before, after, pull: pullBefore, comments, reviews, inline, threads, checks, statuses,
      checkSuites: suites, annotations,
      policies: { branchProtection, rulesets: repositoryRulesets, organizationRulesets, defaultBranch: repository.default_branch, checks: classifiedChecks },
      completeness: { rest: true, reviewThreads: true, nestedThreadComments: true, rulesetDetails: true, organizationRulesets: repository.owner?.type !== 'Organization' || organizationRulesets.length >= 0, checks: true, brackets: true },
    });
  } catch (error) {
    return createError('snapshot', error.code || 'snapshot_failed', error.message, error.phase || 'github_snapshot');
  }
}

module.exports = { reviewThreadsQuery, collectSnapshot, restPages, reviewThreads, collectAnnotations, detailedRulesets, classifyChecks, identity, canonicalPull, MAX_PAGES };
