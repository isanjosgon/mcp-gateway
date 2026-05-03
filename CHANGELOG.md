# Changelog

All notable changes to this project will be documented in this file.

The format is based on **Keep a Changelog**, and this project adheres to **Semantic Versioning**.

## [Unreleased]

### Added
- API key authentication via `Bearer`, `Api-Key`, `X-API-Key`, and `Api-Key` headers.
- Redis-backed rate limiting selected with `REDIS_URL`, with in-memory fallback and configurable key prefixes.
- Audit logging controls by environment using `audit.enabled`, `audit.environments`, `MCP_GATEWAY_ENV`, and `NODE_ENV`.

### Security
- Gateway authentication headers are stripped before proxying requests upstream.
- Logger redaction is wired to `logging.redactKeys`.

### Changed
- CI now runs tests before config validation.

## [0.1.0] - 2026-01-11
### Added
- Initial public scaffolding (CLI, config, proxy, policy, rate limiting, audit logs)
- First MVP release.
