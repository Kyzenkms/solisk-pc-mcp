# Contributing

## Issues

- **Bug reports**: include app version, Windows version, and steps to
  reproduce. Attach relevant lines from
  `%APPDATA%\pc-control-mcp-desktop\main.log`.
- **Feature requests**: describe the use case, not just the solution.
- **Security issues**: use the [SECURITY.md](SECURITY.md) process — never a
  public issue.

## Pull requests

1. Fork and create a feature branch from `main`.
2. Run `node --check` on every touched JS file and `npm test` from the root.
   The runner isolates configuration, device records and metrics in temporary
   directories. `npm run test:stdio` exercises a real local MCP connection.
   `npm run test:package` checks an extracted tarball (requires `tar` on PATH),
   reusing the checkout's dependencies rather than downloading a fresh install.
   `node examples/first-win.js` is the safe, synthetic first-task demo.
3. Keep changes focused — one PR per feature/fix.
4. Update `CHANGELOG.md` for user-facing changes.
5. Never commit `config.json`, `oauth_tokens.json`, `rooms.json`, or build
   artifacts.

## Development setup

```bash
git clone https://github.com/Kyzenkms/solisk-pc-mcp.git
cd solisk-pc-mcp
npm ci
npm ci --prefix relay-server
npm ci --prefix desktop-app
npm test
npm run dev --prefix desktop-app
```

Headless server (no GUI):

```bash
node pc-control-headless/bin/pc-control.js --mode=http   # foreground server
# OR let a local MCP client start:
node pc-control-headless/bin/pc-control.js --mode=stdio
```

## Code style

- CommonJS (`require`/`module.exports`) — this codebase does not use ESM.
- `camelCase` for variables, `PascalCase` for classes.
- 2-space indentation, no trailing whitespace.
- `git diff --check` before push.

## Releasing

1. Choose a new, unpublished version. Synchronize the root and desktop
   `package.json` files and lockfiles, plus `server.json` and its npm package
   version. Update `CHANGELOG.md`. Do not overwrite an existing release or npm version.
2. Run `npm test` and test the packed npm artifact on a clean install. The registry
   entry must launch with `--mode stdio`, not the CLI's default HTTP mode.
3. Commit, tag `vX.Y.Z`, and push only when ready to publish. CI first runs the
   Windows regression suite and Linux/macOS stdio smoke tests. After they pass,
   it builds an installer and opens a **draft** release with `.exe` + `SHA256SUMS.txt`.
   The tag workflow does not currently build an MSI.
4. Test the installer on a fresh Windows profile, check its displayed version
   and packaged runtime dependencies, then publish the release and npm package.
5. Publish the matching MCP Registry entry only after that npm version is
   available. Updating local `server.json` alone does not update the registry.
6. Update the website's download/update metadata only after verifying the new
   asset URLs. Existing `1.0.0` installer filenames remain historical artifacts;
   do not rename them or fabricate download URLs in documentation.

## License

By contributing, you agree that your contributions will be licensed under the
MIT license.
