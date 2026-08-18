# PC Control MCP Website

Static product website for PC Control MCP. No build step is required.

## Preview

```sh
npx http-server website -p 4173 -c-1
```

Then open `http://localhost:4173`.

## Pages

- `index.html`: product landing page
- `docs.html`: installation, connection, permissions, and self-hosting guide
- `security.html`: security model and vulnerability reporting
- `privacy.html`: public-beta privacy policy
- `terms.html`: public-beta terms of use

## Deployment

Upload the contents of `website/` to any static host. Configure the public site to serve `index.html` at the root and HTTPS on every page.

The landing page uses a structural skeleton loader with a CSS scan effect. Core content remains visible if JavaScript is disabled or reduced motion is enabled.

Before production launch, have qualified counsel review `privacy.html` and `terms.html` for the operator's jurisdiction and actual infrastructure practices.
