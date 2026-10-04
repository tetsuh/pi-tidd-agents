## CL-D21 — Test seam, tooling and CI
**Clauses:** none — structural

Tests run under `node:test` with zero `devDependencies`, because pi runs `npm install` when installing a package and any devDependency would be installed for every user. A minimal GitHub Actions workflow runs them on push to `main` and on pull requests.

Enforced by `test/package.test.js`, which asserts the test script exists and that there are no `devDependencies`.
