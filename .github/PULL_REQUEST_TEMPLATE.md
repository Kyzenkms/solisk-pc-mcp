## Summary

<!-- What does this PR change and why? -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change
- [ ] Documentation
- [ ] Security-relevant (follow SECURITY.md if disclosure-sensitive)

## Checklist

- [ ] `node --check` passes on all touched JS files
- [ ] `node relay-server/test/oauth.test.js` passes (relay changes)
- [ ] No secrets, tokens, or personal paths committed (`config.json`,
      `oauth_tokens.json`, `rooms.json` stay untracked)
- [ ] `RELEASE_NOTES.md` / `CHANGELOG.md` updated for user-facing changes
- [ ] Tested on Windows 10/11 with a real MCP client
