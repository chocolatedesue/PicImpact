# Paper OCR Import Pipeline

This workflow imports figures from a paper PDF into the existing online PicImpact
instance. It is designed for the current deployment at `https://pic.frrcsp.me`.

## What It Imports

The importer keeps only paper figure images from PaddleOCR markdown output:

- Included by default: `markdown.images`, such as `img_in_image_box_*` and `img_in_chart_box_*`.
- Excluded by default: header/logo boxes such as `img_in_header_image_box_*`.
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

## Pull Zotero PDFs

The SN paper collection can be pulled from the Zotero WebDAV attachment store
with rclone. Keep WebDAV credentials in the shell or a local rclone config, not
in source files.

```bash
export ZOTERO_WEBDAV_USER=...
export ZOTERO_WEBDAV_PASS=...

mkdir -p /tmp/picimpact-zotero-sn/zips /tmp/picimpact-zotero-sn/unpacked

rclone copy \
  --webdav-url "https://data.cstcloud.cn/dav/zotero/" \
  --webdav-vendor other \
  --webdav-user "$ZOTERO_WEBDAV_USER" \
  --webdav-pass "$(rclone obscure "$ZOTERO_WEBDAV_PASS")" \
  --user-agent "Zotero/7.0" \
  :webdav: /tmp/picimpact-zotero-sn/zips \
  --include "*.zip"

find /tmp/picimpact-zotero-sn/zips -name "*.zip" -print0 |
  while IFS= read -r -d "" zip; do
    key="$(basename "$zip" .zip)"
    mkdir -p "/tmp/picimpact-zotero-sn/unpacked/$key"
    unzip -o "$zip" -d "/tmp/picimpact-zotero-sn/unpacked/$key"
  done
```

The `Zotero/7.0` user agent matters for CSTCloud WebDAV; without it the server
can reject requests as a client type mismatch.

## Import Command

Dagstuhl URL import:

```bash
pnpm paper:import -- --pdf-url "https://drops.dagstuhl.de/storage/01oasics/oasics-vol139-nines2026/OASIcs.NINeS.2026.28/OASIcs.NINeS.2026.28.pdf"
```

Zotero/WebDAV local PDF import into the shared satellite-network album:

```bash
pnpm paper:import -- \
  --pdf-file "/tmp/picimpact-zotero-sn/unpacked/SBVL3QGX/paper.pdf" \
  --source-url "https://data.cstcloud.cn/dav/zotero/SBVL3QGX.zip" \
  --album-value /sn \
  --album-name "Satellite Network (SN) Figures" \
  --upload-concurrency 6 \
  --skip-preprocess
```

Useful options:

```bash
--dry-run                 # OCR/download only; do not upload to PicImpact
--refresh-ocr             # submit a new PaddleOCR job even if ocr.jsonl exists
--slug crowdlink          # override the generated local import slug
--upload-concurrency 4    # concurrent PicImpact object uploads, 1-8
--include-output-images   # also import PaddleOCR outputImages diagnostics
--source-url <url>        # store an original source URL for local PDFs
--skip-preprocess         # batch mode: upload now, run local backfill once later
```

The script writes local run artifacts to:

```text
data/paper-imports/<slug>/
```

That directory is ignored by git.

## Pipeline Stages

1. Resolve paper metadata.
   - Dagstuhl DOI pages are parsed directly for citation metadata.
   - Local PDF imports prefer `pdfinfo` title/DOI/year, because publisher
     PDFs often have reliable metadata while Crossref lookup can return bad
     issue-level records.
   - `paper-search-cli` is used as a fallback/enrichment source.

2. Submit PaddleOCR.
   - URL mode is tried first.
   - If PaddleOCR cannot pull the PDF URL and returns a timeout, the script downloads the PDF locally and retries with multipart file upload.

3. Save OCR output.
   - `ocr.jsonl`
   - per-page markdown files
   - downloaded figure images
   - `manifest.json`

4. Create or reuse the PicImpact album.
   - Shared satellite-network album route: `/sn`
   - Album title: `Satellite Network (SN) Figures`

5. Upload figure images.
   - Request PicImpact presigned object URLs.
   - Upload to storage.
   - Create PicImpact image records with paper metadata in title, labels, and detail.

6. Run PicImpact variant preprocessing.
   - For one-off imports, the script can trigger `/api/v1/preprocess-tasks`.
   - For Zotero/SN batch imports, use `--skip-preprocess` on each import, then
     run the official local backfill once. This avoids Vercel serverless task
     leases holding the PostgreSQL advisory lock without draining the batch.

```bash
set -a
source .env
set +a
pnpm run preprocess:backfill
```

## Verification

Database-level checks should show:

- album `/sn`
- live/public image count equals the intended figure count
- `0` live `output/layout_det_res` images
- `0` live `header_image_box` images
- all live images have `variants_ready=true`

Browser-level check:

```bash
chromium --headless --no-sandbox --disable-gpu --virtual-time-budget=20000 \
  --dump-dom https://pic.frrcsp.me/sn > /tmp/sn-dom.html
```

Expected result after JavaScript runs:

- visible `<img>` elements are present; the page uses lazy loading/pagination,
  so the DOM may contain fewer images than the database total.
- image sources should be under `https://pic.l3j.icu/variants/*.avif`, not raw
  `/sn/*.jpg` originals.

Do not treat `404: This page could not be found.` or translated empty-state strings in raw HTML as final page state; Next includes fallback boundary text in the streamed HTML. Use the executed browser DOM for final visibility checks.
