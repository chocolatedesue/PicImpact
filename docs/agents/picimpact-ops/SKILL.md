---
name: picimpact-ops
description: Operate the PicImpact photography portfolio at /home/cnic/work/PicImpact. Use when deploying, troubleshooting CORS/storage/admin issues, batching image uploads to Cloudflare R2, generating responsive variants, or anything involving pic.frrcsp.me, R2 bucket `picimpact`, or Azure PostgreSQL `codex2api`. Loads deployment context, runbook commands, and known traps (e.g. s3.cstcloud.cn presigned URL incompatibility, hardcoded `show=1` on insertImage, Vercel serverless cron gap).
---

# PicImpact Operations

> Project: `besscroft/PicImpact` (Next.js 16 + Hono + PostgreSQL)
> Domain: `https://pic.frrcsp.me`
> Storage: Cloudflare R2 bucket `picimpact`, public domain `pic.l3j.icu`
> Database: Azure PostgreSQL `psgfr.postgres.database.azure.com:5432/codex2api`
> Admin: `ccds@ccds.me` / `M,ymZW1TQD1PD85W`

## Always-Read References (in this repo)

- `.agent/DEPLOYMENT.md` — full deployment topology, API paths, CORS, variant specs
- `.agent/OPERATIONS.md` — login / upload / preprocess / debug recipes (curl one-liners)
- `.agent/INCIDENTS.md` — historical decisions, e.g. s3.cstcloud.cn trap

These files are git-ignored (local ops notes). Read them first if you need context.

## Core Workflows

### 1. Login (cookie jar)

```bash
COOKIES=/tmp/opencode/picimpact/cookies.txt
curl -s -X POST https://pic.frrcsp.me/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"ccds@ccds.me","password":"M,ymZW1TQD1PD85W"}' \
  -c $COOKIES -o /dev/null
```

The auth endpoint is `sign-in/email`, **not** `login/email` (latter is 404).
Cookies are `__Secure-pic-impact.session_token` + `__Secure-pic-impact.session_data`, 7-day expiry.

### 2. Image Upload (4-step HTTP chain)

```text
POST /api/v1/file/presigned-url  →  presigned PUT URL + key
PUT  <presignedUrl>              →  binary upload to R2
POST /api/v1/file/object-url     →  public URL (https://pic.l3j.icu/<key>)
POST /api/v1/images              →  write DB row, variants_ready=false
```

`insertImage()` **hardcodes `show: 1`** (hidden). After uploading, you MUST run:

```sql
UPDATE images SET show = 0, show_on_mainpage = 0 WHERE image_name LIKE 'fig%';
UPDATE albums SET show = 0 WHERE album_value = '/dmrouting';
```

Or via Prisma:
```js
await p.images.updateMany({ where: { image_name: { startsWith: 'fig' } }, data: { show: 0, show_on_mainpage: 0 } })
```

### 3. Variant Generation (responsive images)

Variants are AVIF + WebP at 7 widths (320, 480, 640, 800, 1080, 1280, 1920) = 14 files per image, stored at `variants/<sha256>_<width>.{avif,webp}` on R2.

**On Vercel (serverless), use the CLI** — HTTP `/tick` times out before a batch finishes:

```bash
cd /home/cnic/work/PicImpact
export $(grep -v '^#' .env | xargs)
pnpm run preprocess:backfill            # only images missing variants
pnpm run preprocess:backfill -- --force # regenerate everything
```

Requires:
- `variant_storage=r2` in DB (set via `PUT /api/v1/settings/variant-storage`)
- `DATABASE_URL` in `.env`

### 4. CORS for R2 public domain

S3 API is the cleanest way (no Cloudflare token needed):
```js
new PutBucketCorsCommand({
  Bucket: 'picimpact',
  CORSConfiguration: { CORSRules: [{
    AllowedOrigins: ['http://localhost:3000', 'https://pic.frrcsp.me'],
    AllowedMethods: ['GET'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'],
    MaxAgeSeconds: 3000,
  }]}
})
```

`AllowedOrigins` does NOT support wildcards. Always list each origin explicitly.
After editing, Cloudflare edge may cache old CORS headers — purge cache in dashboard.

## Known Traps

1. **S3-compatible ≠ presigned-URL-compatible.** `s3.cstcloud.cn` accepts direct SDK PUT/GET but rejects AWS SDK v3 presigned URLs (always 401). Always POC presigned URL before configuring a new S3 backend.

2. **Vercel functions timeout:** 10s free / 60s pro. `preprocess-tasks/tick` processes 10 images per batch (~200s) — **will not finish in one HTTP call**. Use CLI for batch backfill.

3. **`instrumentation.ts` ticker does NOT run on Vercel** (no long-lived process). For ongoing variant generation, you need external cron → POST `/preprocess-tasks/tick` every 6+ minutes (lease is 5min).

4. **Vercel Deployment Protection** blocks direct `curl https://picimpact-<sha>.vercel.app/...` with 401. Use `npx vercel curl` (bypasses via OAuth) or hit the custom domain `pic.frrcsp.me` which has CORS/Cloudflare in front.

5. **Image upload presigned URL succeeds but image is still hidden** because `insertImage` hardcodes `show: 1`. Always follow up with the UPDATE.

6. **`sign-in/email` not `login/email`.** better-auth convention.

7. **`prisma:seed` reads `ADMIN_EMAIL`/`ADMIN_PASSWORD` from env.** But `.env` value `ccds` is invalid (need full email `ccds@ccds.me`). The actual admin was created via the better-auth `sign-up/email` flow.

8. **Hono `forcePathStyle: true` is required for R2** (path-style addressing, since R2 doesn't support virtual-hosted subdomains per bucket).

9. **CLAUDE.md § "Known Deviations"** — be aware: snake_case leak in API responses, dual-return-type `/api/public/download/:id`, missing defense-in-depth on `/api/v1/*` auth.

## When Asked To "Deploy" or "Push Code"

1. `git status` — review what's modified. Don't blindly commit upstream changes (e.g. `prisma/seed.ts`, `package.json`) that you didn't author.
2. If there are upstream changes (like `prisma/seed.ts` ADMIN seeding), they're PicImpact project improvements and **should** be committed.
3. Vercel auto-deploys on push to `main`. No manual deploy step.

## When Asked To "Add a New Album"

```bash
curl -s -b $COOKIES -X POST https://pic.frrcsp.me/api/v1/albums \
  -H "Content-Type: application/json" \
  -d '{"name":"MyAlbum","album_value":"/myalbum","detail":"...","sort":0,"theme":"0","show":0,"license":"","image_sorting":1,"random_show":1}'
```

`album_value` must start with `/`.

## When Asked To Debug "Images Not Loading"

1. Check R2 directly: `curl -I https://pic.l3j.icu/<key>` — should return 200 with `access-control-allow-origin` header.
2. Check DB: is the image `show=0` and the album `show=0`?
3. Check variants: `variants_ready=true`? List R2 `variants/` prefix for the image_key.
4. Check Cloudflare cache: `dash.cloudflare.com → l3j.icu → Caching → Purge Cache` if CORS headers stale.
5. Check browser DevTools Network: actual URL being requested. If it's `pic.frrcsp.me/_next/...` that's a static asset, not R2.
