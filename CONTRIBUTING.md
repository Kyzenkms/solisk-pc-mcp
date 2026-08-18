# Contributing

## Issues

- **Bug reports**: include app version, OS, and steps to reproduce.
- **Feature requests**: describe use case, not just the solution.
- **Security issues**: use [SECURITY.md](SECURITY.md) process, not public issues.

## Pull requests

1.  Fork and create a feature branch from `main`.
2.  Run `npm test` and `node --check` before committing.
3.  Keep changes focused — one PR per feature/fix.
4.  Update `RELEASE_NOTES.md` for user-facing changes.
5.  Do not commit `config.json`, `oauth_tokens.json`, `rooms.json`, or build
    artifacts.

## Development setup

```bash
git clone https://github.com/Kyzenkms/solisk-mcp.git
cd pc-control-mcp/desktop-app
npm install
npm run dev
```

## Code style

- ES modules (`import`/`export`).
- `camelCase` for variables, `PascalCase` for classes.
- 2-space indentation.
- No trailing whitespace.
- `git diff --check` before push.

## License

By contributing, you agree that your contributions will be licensed under the
MIT license.
