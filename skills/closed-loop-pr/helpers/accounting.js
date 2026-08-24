'use strict';

const { createResult, createError } = require('./protocol');

// Issue #50 (CL-D41). Per-PR accounting is derived from the target's own evidence at every
// snapshot and never stored, so a fresh run reconstructs it instead of inheriting a state file.
const CEILING = 10;
const OID = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[^\s/]+\/[^\s/]+$/;

function fail(message) { const error = new Error(message); error.code = 'invalid_accounting'; throw error; }

function deriveAccounting(data) {
  try {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) fail('accounting data must be an object');
    const { repository, number, base, commits } = data;
    if (typeof repository !== 'string' || !REPOSITORY.test(repository)) fail('repository must be owner/name');
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) fail('number must be a positive integer');
    if (typeof base !== 'string' || !OID.test(base)) fail('base must be a lowercase 40-character object ID');
    if (!Array.isArray(commits)) fail('commits must be an ordered array');
    const seen = new Set();
    for (const commit of commits) {
      if (commit === null || typeof commit !== 'object' || Array.isArray(commit)) fail('commit must be an object');
      if (typeof commit.oid !== 'string' || !OID.test(commit.oid)) fail('commit oid must be a lowercase 40-character object ID');
      // A commit reachable from the base is not a correction commit, and a repeated OID would
      // count one commit twice; either means the supplied list is not the branch since base.
      if (commit.oid === base) fail('commit oid must not equal the base object ID');
      if (seen.has(commit.oid)) fail('commit oids must be unique');
      seen.add(commit.oid);
    }
    const correctionCommits = commits.length;
    return createResult('pr_accounting', {
      accountingKey: `${repository}#${number}@${base}`,
      correctionCommits,
      ceiling: CEILING,
      ceilingReached: correctionCommits >= CEILING,
    });
  } catch (error) {
    return createError('pr_accounting', error.code || 'invalid_accounting', error.message, 'pr_accounting');
  }
}

module.exports = { deriveAccounting, ACCOUNTING_CEILING: CEILING };
