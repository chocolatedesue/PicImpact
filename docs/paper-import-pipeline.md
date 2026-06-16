# Paper OCR Import Pipeline

This workflow imports figures from a paper PDF into the existing online PicImpact
instance. It is designed for the current deployment at `https://pic.frrcsp.me`.

## What It Imports

The importer keeps only paper figure images from PaddleOCR markdown output:

- Included by default: `markdown.images`, such as `img_in_image_box_*` and `img_in_chart_box_*`.
- Excluded by default: `outputImages`, such as `layout_det_res`, because these are OCR page/layout renderings rather than paper figures.
- Optional: pass `--include-output-images` only when those OCR diagnostic/page images are explicitly wanted.

## Environment

Put secrets in local `.env`; do not commit them.

Required:

```bash
PADDLEOCR_TOKEN=...
PICIMPACT_BASE_URL=https://pic.frrcsp.me
PICIMPACT_EMAIL=...
PICIMPACT_PASSWORD=...
PICIMPACT_STORAGE=r2
```

Notes:

- `PICIMPACT_EMAIL` / `PICIMPACT_PASSWORD` are used for Better Auth login.
- If the account requires 2FA or Passkey, set `PICIMPACT_COOKIE` from an authenticated browser session instead.
- `PICIMPACT_STORAGE` should match the configured PicImpact storage backend, normally `r2`.

## Import Command

```bash
pnpm paper:import -- --pdf-url "https://drops.dagstuhl.de/storage/01oasics/oasics-vol139-nines2026/OASIcs.NINeS.2026.28/OASIcs.NINeS.2026.28.pdf"
```

Useful options:

```bash
--dry-run                 # OCR/download only; do not upload to PicImpact
--refresh-ocr             # submit a new PaddleOCR job even if ocr.jsonl exists
--slug crowdlink          # override the generated local import slug
--upload-concurrency 4    # concurrent PicImpact object uploads, 1-8
--include-output-images   # also import PaddleOCR outputImages diagnostics
```

The script writes local run artifacts to:

```text
data/paper-imports/<slug>/
```

That directory is ignored by git.

## Pipeline Stages

1. Resolve paper metadata.
   - Dagstuhl DOI pages are parsed directly for citation metadata.
   - `paper-search-cli` is used as a fallback.

2. Submit PaddleOCR.
   - URL mode is tried first.
   - If PaddleOCR cannot pull the PDF URL and returns a timeout, the script downloads the PDF locally and retries with multipart file upload.

3. Save OCR output.
   - `ocr.jsonl`
   - per-page markdown files
   - downloaded figure images
   - `manifest.json`

4. Create or reuse the PicImpact album.
   - Current CrowdLink album route: `/crowdlink`
   - Album title: `CrowdLink: Unlocking Idle LEO Network Capacity with User Terminals`

5. Upload figure images.
   - Request PicImpact presigned object URLs.
   - Upload to storage.
   - Create PicImpact image records with paper metadata in title, labels, and detail.

6. Run PicImpact variant preprocessing.
   - The script triggers `/api/v1/preprocess-tasks`.
   - If a Vercel task lease is active, wait for the lease to expire or run the official local backfill:

```bash
set -a
source .env
set +a
pnpm run preprocess:backfill
```

## Verification

Database-level checks should show:

- album `/crowdlink`
- `34` live public images
- `0` live `output/layout_det_res` images
- `34/34` `variants_ready=true`

Browser-level check:

```bash
chromium --headless --no-sandbox --disable-gpu --virtual-time-budget=20000 \
  --dump-dom https://pic.frrcsp.me/crowdlink > /tmp/crowdlink-dom.html
```

Expected result after JavaScript runs:

- `34` `<img>` elements
- image sources under `https://pic.l3j.icu/variants/*.avif`

Do not treat `404: This page could not be found.` or translated empty-state strings in raw HTML as final page state; Next includes fallback boundary text in the streamed HTML. Use the executed browser DOM for final visibility checks.
