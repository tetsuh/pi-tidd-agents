'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readJson, exists } = require('./helpers');

const manifest = readJson('test/contract-clauses.json');

test('the clause manifest is non-empty and internally consistent', () => {
  assert.ok(manifest.clauses.length > 0, 'manifest declares no clauses');
  const seen = new Set();
  for (const clause of manifest.clauses) {
    assert.ok(clause.id, 'every clause needs an id');
    assert.ok(!seen.has(clause.id), `duplicate clause id: ${clause.id}`);
    seen.add(clause.id);
    assert.ok(clause.files.length > 0, `${clause.id} lists no files`);
    assert.ok(clause.requires.length > 0, `${clause.id} lists no required text`);
  }
});

test('every file named by the clause manifest exists', () => {
  const files = new Set(manifest.clauses.flatMap((clause) => clause.files));
  for (const file of files) {
    assert.ok(exists(file), `contract file is missing: ${file}`);
  }
});

for (const clause of manifest.clauses) {
  // `"marker": null` opts out of the marker check, for user-facing files such as
  // README.md where a decision ID would be noise rather than a landmark.
  const marker = 'marker' in clause ? clause.marker : clause.id;

  for (const file of clause.files) {
    test(`${clause.id} — ${clause.title} — ${file}`, () => {
      assert.ok(exists(file), `contract file is missing: ${file}`);
      const text = readText(file);

      if (marker !== null) {
        assert.ok(
          text.includes(marker),
          `${file} does not carry the clause marker ${marker}`,
        );
      }

      for (const required of clause.requires) {
        assert.ok(
          text.includes(required),
          `${file} is missing required contract text for ${clause.id}: ${JSON.stringify(required)}`,
        );
      }
    });
  }
}
