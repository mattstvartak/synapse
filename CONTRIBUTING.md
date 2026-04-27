# Contributing to Synapse

Thanks for taking a look. Synapse is small and pre-1.0 — bug reports, doc fixes, and focused PRs are all welcome.

## Before larger changes

The roadmap and design rationale live in [`outputs/synapse-pr-readiness-proposal.md`](./outputs/synapse-pr-readiness-proposal.md). Skim it before proposing structural work so we're not duplicating something already planned. For anything beyond a small fix, open an issue first to sanity-check the approach — saves you rework if the direction doesn't fit.

## Dev setup

```bash
git clone https://github.com/mattstvartak/synapse.git
cd synapse
npm install
npm run build
npm run dev      # tsc --watch while iterating
```

Wire two MCP clients per the [Quickstart](./README.md#quickstart) and you'll have a real loop to test against.

## Tests

```bash
node --test tests/classifier.test.mjs tests/storage-pr-readiness.test.mjs
```

Smoke scripts (no `node:test` import) live alongside the unit tests — run those directly with `node tests/<file>` for integration checks like daemon-shim handshake and identity stickiness.

If your change touches storage, identity adoption, or the wire format, please add or extend a test. Hooks-only and doc-only changes don't need new tests.

## Pull requests

- Branch from `main`, name the branch descriptively (`fix/peer-input-count`, `feat/audit-export`).
- Keep PRs focused — one concern per PR, not a grab-bag.
- Run `npm run build` and the test commands above before pushing.
- In the PR description, link any related issue and include a short "test plan" (what you ran, what you saw).
- Don't bump the version in `package.json` — that happens at release time.

## Reporting bugs

Open an issue with:

- What you ran (config snippet, MCP client, label, OS).
- What you expected vs. what happened.
- Output of `synapse_diag` if the issue is identity / transport / peer-discovery related — that tool exists for exactly this.

## Code style

- TypeScript, strict mode. No `any` unless it's load-bearing and commented.
- Match the surrounding file — naming, error shape, log format. There's no formatter wired up; just be consistent with what's already there.
- Keep hooks (`hooks/*.mjs`) JS-only and dependency-light — they fan out across every Claude Code project, so import cost matters.

## License

By contributing you agree your contributions will be licensed under the [MIT License](./LICENSE).
