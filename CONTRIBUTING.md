# Contributing

Thanks for taking the time to contribute!

## Requirements

- Node.js >= 20
- npm

## Setup

```bash
npm install
```

## Run locally

```bash
npm run dev
```

## Validate config

```bash
npm run validate
```

## CLI quick checks

```bash
node src/cli.js health
node src/cli.js routes -c config.example.yml
```

## Coding guidelines

- Keep changes small and focused.
- Prefer backwards-compatible config changes when possible.
- Add/update docs when behavior changes.
- Add tests when you introduce logic that can break (policy/routing/rate-limit).

## Commit messages

Use clear messages. If you follow Conventional Commits, even better (optional):
- `feat: ...`
- `fix: ...`
- `docs: ...`
- `chore: ...`

## Pull Requests

- Describe the problem and the solution.
- Include steps to reproduce / validate.
- Update the README or docs if needed.
- Be explicit about any breaking changes.

## Releases

Merging to `main` triggers the release workflow:

1. Install dependencies with `npm ci`.
2. Run `npm test`, `npm run validate`, and `npm run routes`.
3. Bump `gateway/package.json` and `package-lock.json` with a patch version by default.
4. Commit `chore: release vX.Y.Z`, create tag `vX.Y.Z`, and push both to `main`.
5. Publish `@isanjosgon/mcp-gateway` to npm.
6. Create a GitHub Release with generated notes.

For a `minor` or `major` bump, run the `Release Gateway to NPM` workflow manually from GitHub Actions and choose the desired release type. The workflow requires the `NPM_TOKEN` Actions secret and repository Actions permission to write contents.
