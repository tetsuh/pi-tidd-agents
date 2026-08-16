'use strict';

const crypto = require('node:crypto');
const { run } = require('./process');
const { createResult, createError } = require('./protocol');

const SAFE_RULE_TYPES = new Set(['deletion', 'non_fast_forward']);
const BLOCKING_RULE_TYPES = new Set(['pull_request', 'required_status_checks', 'required_signatures', 'required_linear_history', 'required_deployments', 'required_workflows', 'commit_author_email_pattern', 'commit_message_pattern', 'committer_email_pattern', 'branch_name_pattern', 'file_path_restriction', 'file_extension_restriction', 'max_file_path_length', 'max_file_size', 'update', 'code_scanning']);
function githubPattern(pattern, branch, defaultBranch) {
  if (typeof pattern !== 'string') return null;
  if (pattern === '~ALL') return true;
  if (pattern === '~DEFAULT_BRANCH') return typeof defaultBranch === 'string' ? branch === `refs/heads/${defaultBranch.replace(/^refs\/heads\//, '')}` : null;
  if (/[\[\]?+!{}]/.test(pattern) || /\*\*/.test(pattern) || (pattern.includes('*') && !pattern.endsWith('*'))) return null;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return branch.startsWith(prefix) && !branch.slice(prefix.length).includes('/');
  }
  return pattern === branch;
}
function refMatches(refName, branch, defaultBranch) {
  if (!refName || !Array.isArray(refName.include) || !Array.isArray(refName.exclude) || refName.include.length === 0) return null;
  const include = refName.include.map((pattern) => githubPattern(pattern, branch, defaultBranch));
  const exclude = refName.exclude.map((pattern) => githubPattern(pattern, branch, defaultBranch));
  if (include.includes(null) || exclude.includes(null)) return null;
  return include.some(Boolean) && !exclude.some(Boolean);
}
function repositoryPattern(pattern, name) {
  if (typeof pattern !== 'string') return null;
  if (pattern === '~ALL') return true;
  if (/^[^*?[\]{}!]+$/.test(pattern)) return pattern === name;
  if (/^[^*?[\]{}!]+\*$/.test(pattern)) return name.startsWith(pattern.slice(0, -1));
  return null;
}
function repositoryNameMatches(condition, name) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)
    || !Array.isArray(condition.include) || !Array.isArray(condition.exclude)
    || typeof condition.protected !== 'boolean' || condition.protected) return null;
  const include = condition.include.map((pattern) => repositoryPattern(pattern, name));
  const exclude = condition.exclude.map((pattern) => repositoryPattern(pattern, name));
  if (include.includes(null) || exclude.includes(null)) return null;
  return include.some(Boolean) && !exclude.some(Boolean);
}
function repositoryIdMatches(condition, id) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)
    || !Array.isArray(condition.repository_ids) || !Number.isSafeInteger(id)) return null;
  if (condition.repository_ids.some((value) => !Number.isSafeInteger(value))) return null;
  return condition.repository_ids.includes(id);
}
function selectorMatches(selector, repository) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) return null;
  const keys = ['repository_name', 'repository_id', 'repository_property'].filter((key) => selector[key] !== undefined);
  if (keys.length === 0) return true;
  if (keys.length !== 1) return null;
  if (keys[0] === 'repository_name') return repositoryNameMatches(selector.repository_name, repository.name);
  if (keys[0] === 'repository_id') return repositoryIdMatches(selector.repository_id, repository.id);
  return null;
}
function evaluateRulesets(payload, branch, defaultBranch) {
  if (!payload || !Array.isArray(payload.rulesets) || typeof branch !== 'string' || !branch.startsWith('refs/heads/')) return { ok: false, code: 'ambiguous_rulesets' };
  const repository = payload.repository;
  if (!repository || typeof repository !== 'object' || typeof repository.name !== 'string') return { ok: false, code: 'policy_collection_incomplete' };
  for (const ruleset of payload.rulesets) {
    if (!ruleset || !['active', 'evaluate', 'disabled'].includes(ruleset.enforcement)) return { ok: false, code: 'ambiguous_ruleset_enforcement', ruleset: ruleset?.name };
    if (ruleset.enforcement !== 'active') continue;
    if (typeof ruleset.target !== 'string' || !['branch', 'push', 'tag'].includes(ruleset.target)) return { ok: false, code: 'ambiguous_ruleset_target', ruleset: ruleset.name };
    if (ruleset.target === 'tag') continue;
    let applies = true;
    if (ruleset.conditions != null) {
      if (typeof ruleset.conditions !== 'object' || Array.isArray(ruleset.conditions)) return { ok: false, code: 'ambiguous_ruleset_conditions', ruleset: ruleset.name };
      applies = selectorMatches(ruleset.conditions, repository);
      if (applies === null) return { ok: false, code: 'ambiguous_ruleset_repository', ruleset: ruleset.name };
      if (applies && (ruleset.target !== 'push' || Object.hasOwn(ruleset.conditions, 'ref_name'))) {
        applies = refMatches(ruleset.conditions.ref_name, branch, defaultBranch);
        if (applies === null) return { ok: false, code: 'ambiguous_ruleset_ref', ruleset: ruleset.name };
      }
    }
    if (!applies) continue;
    if (!Array.isArray(ruleset.bypass_actors)) return { ok: false, code: 'ambiguous_ruleset_bypass', ruleset: ruleset.name };
    if (ruleset.bypass_actors.length) return { ok: false, code: 'bypass_dependency', ruleset: ruleset.name };
    if (!Array.isArray(ruleset.rules)) return { ok: false, code: 'ambiguous_ruleset_rules', ruleset: ruleset.name };
    for (const rule of ruleset.rules) {
      if (!rule || typeof rule.type !== 'string') return { ok: false, code: 'ambiguous_ruleset_rule', ruleset: ruleset.name };
      if (BLOCKING_RULE_TYPES.has(rule.type)) return { ok: false, code: 'normal_push_restricted', ruleset: ruleset.name, rule: rule.type };
      if (!SAFE_RULE_TYPES.has(rule.type)) return { ok: false, code: 'unknown_ruleset_rule', ruleset: ruleset.name, rule: rule.type };
    }
  }
  return { ok: true, code: 'normal_fast_forward_not_restricted_by_supplied_rulesets' };
}
function protectionAllowsNormalPush(protection) {
  if (protection === false || protection?.protected === false) return { ok: true };
  if (!protection || typeof protection !== 'object') return { ok: false, code: 'branch_protection_unknown' };
  const blockers = ['required_pull_request_reviews', 'required_status_checks', 'restrictions', 'required_signatures', 'required_linear_history', 'block_creations', 'lock_branch', 'allow_force_pushes', 'allow_deletions'];
  if (blockers.some((key) => protection[key] && protection[key].enabled !== false) || protection.enforce_admins?.enabled === true) return { ok: false, code: 'protected_branch' };
  return protection.protected === true ? { ok: false, code: 'branch_protection_unsupported' } : { ok: true };
}
function evaluateWritability(input) {
  if (!input || !['admin', 'maintain', 'write'].includes(String(input.actorPermission).toLowerCase())) return { ok: false, code: 'permission_unknown_or_insufficient' };
  if (input.complete !== true || input.organizationRulesetsComplete !== true || input.repositoryRulesetsComplete !== true || !Array.isArray(input.repositoryRulesets) || !Array.isArray(input.organizationRulesets) || typeof input.repository !== 'string' || typeof input.actor !== 'string' || typeof input.branchRef !== 'string' || typeof input.defaultBranch !== 'string' || typeof input.collectedAt !== 'string' || typeof input.sourceFingerprint !== 'string') return { ok: false, code: 'policy_collection_incomplete' };
  const protection = protectionAllowsNormalPush(input.branchProtection);
  if (!protection.ok) return protection;
  return evaluateRulesets({ repository: { name: input.repository.split('/').pop(), id: input.repositoryId }, rulesets: [...input.repositoryRulesets, ...input.organizationRulesets] }, input.branchRef, input.defaultBranch);
}
function parse(bytes, label) { try { return JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw Object.assign(new Error(`invalid JSON from ${label}`), { code: 'invalid_json', phase: 'writability_collect' }); } }
async function defaultTransport(command, args, options) { return run(command, args, options); }
async function read(transport, args, cwd, label) { return parse((await transport('gh', args, { cwd, phase: 'writability_collect', kind: 'gh' })).stdout, label); }
async function pages(transport, endpoint, cwd) {
  const result = [];
  for (let page = 1; page <= 100; page += 1) {
    const value = await read(transport, ['api', '--method', 'GET', '-f', 'per_page=100', '-f', `page=${page}`, endpoint], cwd, endpoint);
    if (!Array.isArray(value)) throw Object.assign(new Error(`${endpoint} is not an array`), { code: 'invalid_schema', phase: 'writability_collect' });
    result.push(...value); if (value.length < 100) return result;
  }
  throw Object.assign(new Error('policy pagination limit exceeded'), { code: 'pagination_incomplete', phase: 'writability_collect' });
}
function rulesetBracket(rulesets) {
  if (!Array.isArray(rulesets)) throw Object.assign(new Error('ruleset list is not an array'), { code: 'invalid_schema', phase: 'writability_collect' });
  const projected = rulesets.map((ruleset) => {
    if (!ruleset || !Number.isSafeInteger(ruleset.id) || ruleset.id <= 0 || typeof ruleset.updated_at !== 'string') throw Object.assign(new Error('ruleset summary lacks stable identity'), { code: 'invalid_schema', phase: 'writability_collect' });
    return { id: ruleset.id, updated_at: ruleset.updated_at, enforcement: ruleset.enforcement };
  }).sort((a, b) => a.id - b.id);
  if (new Set(projected.map(({ id }) => id)).size !== projected.length) throw Object.assign(new Error('duplicate ruleset identity'), { code: 'duplicate_identity', phase: 'writability_collect' });
  return JSON.stringify(projected);
}
async function detailedRulesets(transport, endpoint, cwd) {
  const before = await pages(transport, endpoint, cwd);
  const details = [];
  for (const summary of before) {
    const detail = await read(transport, ['api', '--method', 'GET', `${endpoint}/${summary.id}`], cwd, `${endpoint}/${summary.id}`);
    if (!detail || detail.id !== summary.id || !Array.isArray(detail.bypass_actors) || !Array.isArray(detail.rules)) throw Object.assign(new Error('ruleset detail is incomplete or mismatched'), { code: 'invalid_schema', phase: 'writability_collect' });
    details.push(detail);
  }
  const after = await pages(transport, endpoint, cwd);
  if (rulesetBracket(before) !== rulesetBracket(after)) throw Object.assign(new Error('ruleset policy changed during collection'), { code: 'stale_policy', phase: 'writability_collect' });
  return details;
}
async function collectWritability({ owner, repo, branchRef, cwd, enterprisePolicyComplete = false, enterpriseRulesets = [], transport = defaultTransport }) {
  try {
    if (![owner, repo, branchRef].every((value) => typeof value === 'string' && value.length)) throw Object.assign(new Error('owner, repo, and branchRef are required'), { code: 'invalid_request' });
    const repository = await read(transport, ['api', `repos/${owner}/${repo}`], cwd, 'repository');
    const actor = await read(transport, ['api', 'user'], cwd, 'actor');
    const permission = repository.permissions?.admin ? 'admin' : repository.permissions?.maintain ? 'maintain' : repository.permissions?.push ? 'write' : 'read';
    const branch = branchRef.replace(/^refs\/heads\//, '');
    let branchProtection;
    try { branchProtection = await read(transport, ['api', `repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`], cwd, 'branch protection'); }
    catch (error) { if (/HTTP 404/.test(error.stderr || '')) branchProtection = false; else throw error; }
    const repositoryRulesets = await detailedRulesets(transport, `repos/${owner}/${repo}/rulesets`, cwd);
    const ownerType = repository.owner?.type;
    if (!['User', 'Organization'].includes(ownerType)) throw Object.assign(new Error('repository owner type is unknown'), { code: 'policy_collection_incomplete', phase: 'writability_collect' });
    const organizationRulesets = ownerType === 'Organization' ? await detailedRulesets(transport, `orgs/${owner}/rulesets`, cwd) : [];
    if (enterprisePolicyComplete !== true || !Array.isArray(enterpriseRulesets)) throw Object.assign(new Error('enterprise policy completeness was not established'), { code: 'policy_collection_incomplete', phase: 'writability_collect' });
    const collectedAt = new Date().toISOString();
    const source = { repository: `${owner}/${repo}`, repositoryId: repository.id, actor: actor.login, actorPermission: permission, branchRef, defaultBranch: repository.default_branch, branchProtection, repositoryRulesets, organizationRulesets: [...organizationRulesets, ...enterpriseRulesets], complete: true, repositoryRulesetsComplete: true, organizationRulesetsComplete: true, collectedAt };
    source.sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
    const evaluation = evaluateWritability(source);
    return evaluation.ok ? createResult('writability', { source, evaluation }) : createError('writability', evaluation.code, 'normal non-force writability was not established', 'writability_evaluate', { evaluation });
  } catch (error) { return createError('writability', error.code || 'writability_collection_failed', error.message, error.phase || 'writability_collect'); }
}
module.exports = { evaluateRulesets, evaluateWritability, collectWritability, refMatches, githubPattern, pages, detailedRulesets, rulesetBracket };
