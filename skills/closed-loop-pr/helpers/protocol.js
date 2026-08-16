'use strict';

const VERSION = 1;
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function assertText(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}
function createResult(operation, data) {
  assertText(operation, 'operation');
  if (!plainObject(data)) throw new TypeError('data must be a plain object');
  return { version: VERSION, ok: true, operation, data };
}
function createError(operation, code, message, phase = 'unknown', details) {
  assertText(operation, 'operation'); assertText(code, 'code'); assertText(message, 'message'); assertText(phase, 'phase');
  const error = { code, message, phase };
  if (details !== undefined) { if (!plainObject(details)) throw new TypeError('details must be a plain object'); error.details = details; }
  return { version: VERSION, ok: false, operation, error };
}
function isResult(value) {
  return plainObject(value) && value.version === VERSION && typeof value.ok === 'boolean' && typeof value.operation === 'string';
}
module.exports = { VERSION, createResult, createError, isResult };
