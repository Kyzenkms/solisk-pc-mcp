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
- `404.html`: branded not-found page (served by the static host)
- `sitemap.xml` / `robots.txt`: SEO for `https://solisk.org/`

## Deployment

Upload the contents of `website/` to any static host. Configure the public site to serve `index.html` at the root and HTTPS on every page. No build step, no JavaScript framework — content renders instantly with JS disabled.

Before production launch, have qualified counsel review `privacy.html` and `terms.html` for the operator's jurisdiction and actual infrastructure practices.
