'use strict';

const crypto = require('node:crypto');

function normalizeText(value) {
  if (typeof value !== 'string') throw new TypeError('text fingerprint input must be a string');
  return value.replace(/\r\n?/g, '\n');
}
function textBytes(value) { return Buffer.from(normalizeText(value), 'utf8'); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function serializeRecords(records) {
  if (!Array.isArray(records) || records.some((record) => typeof record !== 'string')) throw new TypeError('records must be strings');
  return records.map(normalizeText).join('\n');
}
function fingerprintText(value) { return digest(textBytes(value)); }
function fingerprintRecords(records) { return digest(Buffer.from(serializeRecords(records), 'utf8')); }
function fingerprintBinary(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new TypeError('binary fingerprint input must be bytes');
  return digest(Buffer.from(value));
}
function decimalCompare(a, b) {
  const aa = String(a).replace(/^0+(?=\d)/, '');
  const bb = String(b).replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(aa) || !/^\d+$/.test(bb)) throw new TypeError('IDs must be decimal strings');
  return aa.length - bb.length || Buffer.from(aa).compare(Buffer.from(bb));
}
function authoritative(comment) {
  if (!comment || !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association)) return false;
  const type = comment.user?.type;
  if (typeof type !== 'string' || type.trim() === '') {
    const error = new Error('qualifying comment author type is required');
    error.code = 'invalid_author_type';
    error.phase = 'fingerprint_issue_spec';
    throw error;
  }
  return type !== 'Bot';
}
function canonicalCommentRecords(comments = []) {
  if (!Array.isArray(comments)) throw new TypeError('comments must be an array');
  return comments.filter(authoritative).slice().sort((a, b) => decimalCompare(a.id, b.id))
    .map((comment) => `${comment.id}:${normalizeText(String(comment.updated_at || comment.updatedAt || ''))}:${normalizeText(String(comment.body || ''))}`);
}
function issueSpecFingerprint({ body, comments = [] }) {
  return fingerprintRecords([normalizeText(body), ...canonicalCommentRecords(comments)]);
}
function oid(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)) throw new TypeError(`${name} must be a 40- or 64-hex OID`);
  return value;
}
function prBaseFingerprint(baseOid) { return oid(baseOid, 'base OID'); }
function prTreeFingerprint(treeOid) { return oid(treeOid, 'tree OID'); }
function prHeadFingerprint(headOid) { return oid(headOid, 'head OID'); }
function prDiffFingerprint(diff) { return fingerprintBinary(diff); }
function framedTextFields(fields) {
  const parts = [];
  for (const field of fields) {
    const bytes = textBytes(field);
    parts.push(Buffer.from(`${bytes.length}:`, 'ascii'), bytes);
  }
  return Buffer.concat(parts);
}
function prCommitsFingerprint(commits = []) {
  if (!Array.isArray(commits)) throw new TypeError('commits must be an ordered array');
  const records = commits.map((commit) => {
    if (!commit || typeof commit !== 'object') throw new TypeError('commit must be an object');
    const message = normalizeText(String(commit.message ?? commit.commit?.message ?? ''));
    const split = message.indexOf('\n');
    const subject = normalizeText(String(commit.subject ?? (split < 0 ? message : message.slice(0, split))));
    const body = normalizeText(String(commit.body ?? (split < 0 ? '' : message.slice(split + 1).replace(/^\n+/, ''))));
    return `${subject}\n${body}`;
  });
  return fingerprintRecords(records);
}
function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return normalizeText(value);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort((a, b) => Buffer.from(a).compare(Buffer.from(b))).map((key) => [key, canonicalize(value[key])]));
  }
  throw new TypeError('snapshot contains unsupported value');
}
function snapshotFingerprint(snapshot) { return digest(Buffer.from(JSON.stringify(canonicalize(snapshot)), 'utf8')); }

module.exports = {
  normalizeText, textBytes, serializeRecords, fingerprintText, fingerprintRecords, fingerprintBinary,
  canonicalCommentRecords, issueSpecFingerprint, prBaseFingerprint, prTreeFingerprint, prHeadFingerprint,
  prDiffFingerprint, prCommitsFingerprint, snapshotFingerprint, decimalCompare, canonicalize, framedTextFields,
};
