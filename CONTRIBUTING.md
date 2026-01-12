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
