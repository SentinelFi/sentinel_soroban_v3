# Deploying the Docs with a Custom Domain

The site deploys to GitHub Pages via the `Deploy Docs` workflow (`.github/workflows/deploy-docs.yml`). No local build or install is needed: GitHub runs `npm install` and `npm run build` in the cloud on every push to `main` that touches `docs/`.

## 1. Enable GitHub Pages

1. Open the repository on GitHub: Settings, then Pages.
2. Under "Build and deployment", set **Source** to **GitHub Actions**.
3. Push to `main` (or run the `Deploy Docs` workflow manually from the Actions tab). The site goes live at `https://sentinelfi.github.io/sentinel_soroban_v3/`.

Note: for the github.io URL to render correctly, `baseUrl` in `docs/docusaurus.config.ts` must be `'/sentinel_soroban_v3/'`. With a custom domain (below) it must be `'/'`, which is the current setting.

## 2. Point your domain at GitHub Pages

At your DNS provider, add one of the following:

- **Subdomain** (recommended, e.g. `docs.yourdomain.com`):
  - CNAME record: `docs` pointing to `sentinelfi.github.io`
- **Apex domain** (e.g. `yourdomain.com`):
  - A records for `@` pointing to `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`

DNS changes can take up to an hour to propagate.

## 3. Configure the custom domain on GitHub

1. Settings, then Pages, then **Custom domain**: enter your domain (e.g. `docs.yourdomain.com`) and save.
2. Wait for the DNS check to pass, then enable **Enforce HTTPS**.

## 4. Update the site config

In `docs/docusaurus.config.ts` set:

```ts
url: 'https://docs.yourdomain.com',  // your real domain
baseUrl: '/',
```

Commit and push. The workflow redeploys automatically.

## Troubleshooting

- Build errors appear in the Actions tab under the failed `Deploy Docs` run.
- A 404 on CSS and images usually means `baseUrl` does not match how the site is served (see step 1 note).
- If the custom domain resets after a deploy, re-save it in Settings, then Pages. GitHub stores it server-side for the Actions deployment flow, so this normally sticks.
