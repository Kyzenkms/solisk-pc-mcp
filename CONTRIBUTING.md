# Contributing

## Issues

- **Bug reports**: include app version, Windows version, and steps to
  reproduce. Attach relevant lines from
  `%APPDATA%\pc-control-mcp-desktop\main.log`.
- **Feature requests**: describe the use case, not just the solution.
- **Security issues**: use the [SECURITY.md](SECURITY.md) process — never a
  public issue.

## Pull requests

1. Fork and create a feature branch from `master`.
2. Run `node --check` on every touched JS file and
   `node relay-server/test/oauth.test.js` for relay changes.
3. Keep changes focused — one PR per feature/fix.
4. Update `CHANGELOG.md` for user-facing changes.
5. Never commit `config.json`, `oauth_tokens.json`, `rooms.json`, or build
   artifacts.

## Development setup

```bash
git clone https://github.com/kyzenkms/pc-control-mcp.git
cd pc-control-mcp/desktop-app
npm install
npm run dev
```

Headless server (no GUI):

```bash
npm install
npm run http    # StreamableHTTP on :3000
npm run stdio   # stdio mode for CLI integrations
```

## Code style

- CommonJS (`require`/`module.exports`) — this codebase does not use ESM.
- `camelCase` for variables, `PascalCase` for classes.
- 2-space indentation, no trailing whitespace.
- `git diff --check` before push.

## Releasing

1. Update `CHANGELOG.md` + `desktop-app/package.json` version.
2. Commit, tag `vX.Y.Z`, push the tag — CI builds the installer and opens a
   **draft** GitHub Release with the `.exe` and `SHA256SUMS.txt`.
3. Verify the draft, publish it.

## License

By contributing, you agree that your contributions will be licensed under the
MIT license.
