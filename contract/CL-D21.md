## CL-D21 — Test seam, tooling and CI
**Clauses:** none — structural

Tests run under `node:test` with zero `devDependencies`, because pi runs `npm install` when installing a package and any devDependency would be installed for every user. A minimal GitHub Actions workflow runs them on push to `main` and on pull requests.

Enforced by `test/package.test.js`, which asserts the test script exists and that there are no `devDependencies`.

The separate compatibility job installs pinned Pi and pi-subagents packages, then runs `npm run test:compat`. Its preflight refuses missing runtimes and a version that differs from either CI pin; ordinary `npm test` retains its optional installed-runtime checks. These are receiver and package integration checks, not live-model end-to-end runs. The development-only command is not shipped in the package payload and adds no package dependency.
