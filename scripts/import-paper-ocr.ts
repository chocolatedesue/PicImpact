import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import sharp from 'sharp'

const JOB_URL = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs'
const MODEL = 'PaddleOCR-VL-1.6'
const DEFAULT_BASE_URL = 'https://pic.frrcsp.me'
const DEFAULT_PAPER_TITLE = 'Satellite Network Routing Paper'
const DEFAULT_SLUG = 'satellite-network-routing'
const POLL_INTERVAL_MS = 5000
const MAX_POLL_ATTEMPTS = 360
const DEFAULT_UPLOAD_CONCURRENCY = 4

type Args = {
  pdfUrl?: string
  pdfFile?: string
  sourceUrl?: string
  dryRun: boolean
  refreshOcr: boolean
  includeOutputImages: boolean
  skipPreprocess: boolean
  slug?: string
  albumValue?: string
  albumName?: string
  uploadConcurrency: number
}

type Env = Record<string, string | undefined>

type PaperMetadata = {
  title: string
  authors: string[]
  year: string
  venue: string
  doi: string
  url: string
  abstract?: string
}

type ManifestImage = {
  hash: string
  page: number
  sourceType: 'markdown' | 'output'
  sourceKey: string
  sourceUrl: string
  localPath: string
  imageName: string
  uploaded?: {
    imageId: string
    url: string
    width: number
    height: number
    uploadedAt: string
  }
  error?: string
}

type Manifest = {
  pdfUrl: string
  createdAt: string
  updatedAt: string
  doiCandidate: string
  ocrJobId?: string
  ocrJsonUrl?: string
  paper: PaperMetadata
  album?: {
    name: string
    albumValue: string
    id?: string
  }
  images: ManifestImage[]
}

type OcrJobResponse = {
  data?: {
    jobId?: string
    state?: string
    errorMsg?: string
    extractProgress?: {
      totalPages?: number
      extractedPages?: number
      startTime?: string
      endTime?: string
    }
    resultUrl?: {
      jsonUrl?: string
    }
  }
}

type OcrLayoutResult = {
  markdown?: {
    text?: string
    images?: Record<string, string>
  }
  outputImages?: Record<string, string>
}

type ApiEnvelope<T> = {
  code?: number
  message?: string
  data?: T
}

type Album = {
  id?: string
  name: string
  album_value: string
}

type NormalizedImage = {
  buffer: Buffer
  contentType: string
  ext: string
  width: number
  height: number
}

type PreprocessRun = {
  id: string
  status: string
  totalCount: number
  processedCount: number
  successCount: number
  failedCount: number
}

const emptyExif = {
  make: '',
  model: '',
  bits: '',
  dateTime: '',
  exposure_time: '',
  f_number: '',
  exposure_program: '',
  iso_speed_rating: '',
  focal_length: '',
  lens_specification: '',
  lens_model: '',
  exposure_mode: '',
  cfa_pattern: '',
  color_space: '',
  white_balance: '',
}

function usage(): never {
  console.info(`Usage:
  pnpm paper:import -- --pdf-url <url>
  pnpm paper:import -- --pdf-file <path>

Options:
  [--dry-run] [--refresh-ocr] [--slug <slug>] [--album-value /sn]
  [--album-name "Satellite Network (SN) Figures"] [--upload-concurrency 4]
  [--include-output-images] [--skip-preprocess] [--source-url <url>]

Environment:
  PADDLEOCR_TOKEN
  PICIMPACT_BASE_URL      defaults to ${DEFAULT_BASE_URL}
  PICIMPACT_EMAIL         falls back to ADMIN_EMAIL
  PICIMPACT_PASSWORD      falls back to ADMIN_PASSWORD
  PICIMPACT_COOKIE        optional, skips password login
  PICIMPACT_STORAGE       optional, defaults to configured R2/S3 detection, then r2
`)
  process.exit(0)
}

function parseArgs(argv: string[]): Args {
  if (argv[0] === '--') argv = argv.slice(1)
  const args: Args = {
    dryRun: false,
    refreshOcr: false,
    includeOutputImages: false,
    skipPreprocess: false,
    uploadConcurrency: DEFAULT_UPLOAD_CONCURRENCY,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') usage()
    if (arg === '--dry-run') {
      args.dryRun = true
      continue
    }
    if (arg === '--refresh-ocr') {
      args.refreshOcr = true
      continue
    }
    if (arg === '--include-output-images') {
      args.includeOutputImages = true
      continue
    }
    if (arg === '--skip-preprocess') {
      args.skipPreprocess = true
      continue
    }
    if (arg === '--pdf-url') {
      args.pdfUrl = argv[i + 1] ?? undefined
      i += 1
      continue
    }
    if (arg === '--pdf-file') {
      args.pdfFile = argv[i + 1] ?? undefined
      i += 1
      continue
    }
    if (arg === '--source-url') {
      args.sourceUrl = argv[i + 1] ?? undefined
      i += 1
      continue
    }
    if (arg === '--slug') {
      args.slug = argv[i + 1] ?? ''
      i += 1
      continue
    }
    if (arg === '--album-value') {
      args.albumValue = argv[i + 1] ?? ''
      i += 1
      continue
    }
    if (arg === '--album-name') {
      args.albumName = argv[i + 1] ?? ''
      i += 1
      continue
    }
    if (arg === '--upload-concurrency') {
      args.uploadConcurrency = Number(argv[i + 1] ?? DEFAULT_UPLOAD_CONCURRENCY)
      i += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!args.pdfUrl && !args.pdfFile) {
    throw new Error('Missing required --pdf-url or --pdf-file')
  }
  if (args.pdfUrl && !args.pdfUrl.startsWith('http')) {
    throw new Error('--pdf-url must be an http(s) URL for PaddleOCR fileUrl mode')
  }
  if (args.pdfFile && !existsSync(args.pdfFile)) {
    throw new Error(`PDF file not found: ${args.pdfFile}`)
  }
  if (args.albumValue && !args.albumValue.startsWith('/')) {
    throw new Error('--album-value must start with /')
  }
  if (!Number.isInteger(args.uploadConcurrency) || args.uploadConcurrency < 1 || args.uploadConcurrency > 8) {
    throw new Error('--upload-concurrency must be an integer from 1 to 8')
  }
  return args
}

async function loadEnvFiles(): Promise<Env> {
  const env: Env = { ...process.env }
  for (const file of ['.env', '.env.local']) {
    if (!existsSync(file)) continue
    const text = await fs.readFile(file, 'utf8')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const index = line.indexOf('=')
      if (index <= 0) continue
      const key = line.slice(0, index).trim()
      let value = line.slice(index + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith('\'') && value.endsWith('\''))
      ) {
        value = value.slice(1, -1)
      }
      if (env[key] == null) env[key] = value
    }
  }
  return env
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
  return slug || DEFAULT_SLUG
}

function sanitizeFilename(input: string, fallback: string): string {
  const ext = path.extname(input).toLowerCase()
  const stem = path.basename(input, ext)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${stem || fallback}${ext || ''}`
}

function shouldImportMarkdownImage(sourceKey: string): boolean {
  const normalized = sourceKey.toLowerCase()
  if (normalized.includes('header_image_box')) return false
  if (normalized.includes('logo')) return false
  return true
}

function extractDoiCandidate(input: string): string {
  const decoded = decodeURIComponent(input)
  const dagstuhlMatch = decoded.match(/\/((?:OASIcs|LIPIcs|DagRep)\.[A-Za-z0-9.-]+)\.pdf(?:$|\?)/)
  if (dagstuhlMatch?.[1]) {
    return `10.4230/${dagstuhlMatch[1]}`
  }
  const genericMatch = decoded.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)
  return genericMatch?.[0]?.replace(/\.pdf$/i, '') ?? ''
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return asString(value[0])
  if (value == null) return ''
  return String(value)
}

function asAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((author) => {
      if (typeof author === 'string') return author
      if (author && typeof author === 'object') {
        const item = author as Record<string, unknown>
        const given = asString(item.given)
        const family = asString(item.family)
        const name = asString(item.name)
        return name || [given, family].filter(Boolean).join(' ')
      }
      return ''
    })
    .filter(Boolean)
}

function firstCandidate(parsed: unknown): Record<string, unknown> {
  const queue: unknown[] = [parsed]
  const visited = new Set<unknown>()

  while (queue.length > 0) {
    const item = queue.shift()
    if (!item || visited.has(item)) continue
    visited.add(item)

    if (Array.isArray(item)) {
      if (item.length > 0 && item[0] && typeof item[0] === 'object') {
        return item[0] as Record<string, unknown>
      }
      continue
    }

    if (typeof item === 'object') {
      const record = item as Record<string, unknown>
      if (record.title || record.doi || record.DOI) return record
      for (const key of ['data', 'results', 'items', 'papers', 'records']) {
        if (record[key]) queue.push(record[key])
      }
    }
  }

  return {}
}

function runPaperSearch(doi: string): Partial<PaperMetadata> {
  if (!doi) return {}
  const result = spawnSync(
    'pnpm',
    ['dlx', 'paper-search-cli', 'search', doi, '--platform', 'crossref', '--max-results', '1', '--pretty'],
    {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
    },
  )
  if (result.status !== 0 || !result.stdout.trim()) {
    console.warn('paper-search metadata lookup failed; falling back to URL-derived metadata.')
    return {}
  }

  try {
    const parsed = JSON.parse(result.stdout)
    const candidate = firstCandidate(parsed)
    return {
      title: asString(candidate.title) || asString(candidate.name),
      authors: asAuthors(candidate.authors ?? candidate.author),
      year: asString(candidate.year ?? candidate.publishedYear ?? candidate.publicationYear),
      venue: asString(candidate.venue ?? candidate.containerTitle ?? candidate.journal ?? candidate.publisher),
      doi: asString(candidate.doi ?? candidate.DOI) || doi,
      url: asString(candidate.url ?? candidate.URL),
      abstract: asString(candidate.abstract),
    }
  } catch {
    console.warn('paper-search returned non-JSON output; falling back to URL-derived metadata.')
    return {}
  }
}

function metaValues(html: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)`, 'gi')
  const values: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html))) {
    values.push(match[1].replace(/&amp;/g, '&').trim())
  }
  return values.filter(Boolean)
}

function dagstuhlDocumentUrl(doi: string): string {
  return doi ? `https://drops.dagstuhl.de/entities/document/${doi}` : ''
}

async function fetchDagstuhlMetadata(doi: string, pdfUrl: string): Promise<Partial<PaperMetadata>> {
  if (!doi.startsWith('10.4230/')) return {}
  const url = dagstuhlDocumentUrl(doi)
  if (!url) return {}
  try {
    const response = await fetch(url)
    if (!response.ok) return {}
    const html = await response.text()
    const title = metaValues(html, 'citation_title')[0] || metaValues(html, 'DC.Title')[0]
    const authors = metaValues(html, 'citation_author').length > 0
      ? metaValues(html, 'citation_author')
      : metaValues(html, 'DC.Creator.PersonalName')
    const venue = metaValues(html, 'citation_conference_title')[0] || '1st New Ideas in Networked Systems (NINeS 2026)'
    const resolvedDoi = metaValues(html, 'citation_doi')[0] || doi
    const year = (venue.match(/\b(20\d{2})\b/)?.[1]) || '2026'
    if (!title) return {}
    return {
      title,
      authors,
      year,
      venue,
      doi: resolvedDoi,
      url: url || pdfUrl,
    }
  } catch {
    return {}
  }
}

function resolveLocalPdfMetadata(pdfFile: string): Partial<PaperMetadata> {
  const result = spawnSync('pdfinfo', [pdfFile], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) return {}
  const rows = new Map<string, string>()
  for (const line of result.stdout.split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    rows.set(line.slice(0, index).trim(), line.slice(index + 1).trim())
  }
  const subject = rows.get('Subject') ?? ''
  const doi = extractDoiCandidate(subject)
  const year = (subject.match(/\b(20\d{2})\b/) ?? rows.get('Title')?.match(/\b(20\d{2})\b/))?.[1] ?? ''
  return {
    title: rows.get('Title') || path.basename(pdfFile, path.extname(pdfFile)),
    authors: rows.get('Author')?.split(';').map((author) => author.trim()).filter(Boolean) ?? [],
    year,
    venue: subject.split(';')[0]?.replace(/\s+/g, ' ').trim() ?? '',
    doi,
    url: pdfFile,
  }
}

async function resolvePaperMetadata(input: string, pdfFile?: string): Promise<PaperMetadata> {
  const doi = extractDoiCandidate(input)
  const local = pdfFile ? resolveLocalPdfMetadata(pdfFile) : {}
  const effectiveDoi = local.doi || doi
  const dagstuhl = await fetchDagstuhlMetadata(effectiveDoi, input)
  if (dagstuhl.title) {
    return {
      title: dagstuhl.title,
      authors: dagstuhl.authors ?? [],
      year: dagstuhl.year || '2026',
      venue: dagstuhl.venue || '1st New Ideas in Networked Systems (NINeS 2026)',
      doi: dagstuhl.doi || effectiveDoi,
      url: dagstuhl.url || input,
      abstract: dagstuhl.abstract,
    }
  }
  const lookedUp = runPaperSearch(effectiveDoi)
  const preferLocal = Boolean(pdfFile && local.title)
  return {
    title: (preferLocal ? local.title : lookedUp.title) || lookedUp.title || local.title || DEFAULT_PAPER_TITLE,
    authors: lookedUp.authors ?? local.authors ?? [],
    year: local.year || lookedUp.year || '',
    venue: local.venue || lookedUp.venue || '',
    doi: local.doi || lookedUp.doi || effectiveDoi,
    url: input || lookedUp.url || local.url || '',
    abstract: lookedUp.abstract,
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 500)}`)
  }
  return JSON.parse(text) as T
}

async function fetchBuffer(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type') ?? '',
  }
}

async function submitOcrJobFromUrl(pdfUrl: string, token: string): Promise<string> {
  const payload = {
    fileUrl: pdfUrl,
    model: MODEL,
    optionalPayload: {
      useDocOrientationClassify: false,
      useDocUnwarping: false,
      useChartRecognition: false,
    },
  }
  const response = await fetchJson<OcrJobResponse>(JOB_URL, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const jobId = response.data?.jobId
  if (!jobId) throw new Error('PaddleOCR did not return a jobId')
  return jobId
}

async function submitOcrJobFromFile(pdfFile: string, token: string): Promise<string> {
  const buffer = await fs.readFile(pdfFile)
  const form = new FormData()
  form.append('model', MODEL)
  form.append('optionalPayload', JSON.stringify({
    useDocOrientationClassify: false,
    useDocUnwarping: false,
    useChartRecognition: false,
  }))
  form.append(
    'file',
    new Blob([buffer as unknown as BlobPart], { type: 'application/pdf' }),
    path.basename(pdfFile),
  )

  const response = await fetchJson<OcrJobResponse>(JOB_URL, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
    },
    body: form,
  })
  const jobId = response.data?.jobId
  if (!jobId) throw new Error('PaddleOCR did not return a jobId')
  return jobId
}

async function downloadPdf(pdfUrl: string, outputFile: string): Promise<void> {
  const response = await fetch(pdfUrl)
  if (!response.ok) {
    throw new Error(`Failed to download PDF: HTTP ${response.status}`)
  }
  await fs.writeFile(outputFile, Buffer.from(await response.arrayBuffer()))
}

async function submitOcrJob(pdfUrl: string | undefined, pdfFile: string | undefined, token: string, importDir: string): Promise<string> {
  if (pdfFile) {
    return await submitOcrJobFromFile(pdfFile, token)
  }
  if (!pdfUrl) throw new Error('Missing PDF URL')
  try {
    return await submitOcrJobFromUrl(pdfUrl, token)
  } catch (error) {
    console.warn(`PaddleOCR URL mode failed; retrying with local file upload. ${error instanceof Error ? error.message : error}`)
    const pdfFile = path.join(importDir, 'source.pdf')
    if (!existsSync(pdfFile)) {
      await downloadPdf(pdfUrl, pdfFile)
    }
    return await submitOcrJobFromFile(pdfFile, token)
  }
}

async function pollOcrJob(jobId: string, token: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchJson<OcrJobResponse>(`${JOB_URL}/${jobId}`, {
      headers: { Authorization: `bearer ${token}` },
    })
    const state = response.data?.state
    if (state === 'done') {
      const jsonUrl = response.data?.resultUrl?.jsonUrl
      if (!jsonUrl) throw new Error('PaddleOCR job completed without jsonUrl')
      const progress = response.data?.extractProgress
      console.info(`OCR completed: ${progress?.extractedPages ?? 'unknown'} page(s) extracted.`)
      return jsonUrl
    }
    if (state === 'failed') {
      throw new Error(`PaddleOCR job failed: ${response.data?.errorMsg ?? 'unknown error'}`)
    }

    const progress = response.data?.extractProgress
    if (progress?.totalPages) {
      console.info(`OCR ${state ?? 'pending'}: ${progress.extractedPages ?? 0}/${progress.totalPages} page(s).`)
    } else {
      console.info(`OCR ${state ?? 'pending'}...`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error('PaddleOCR polling timed out')
}

async function downloadOcrJsonl(jsonUrl: string, outputFile: string): Promise<void> {
  const response = await fetch(jsonUrl)
  if (!response.ok) {
    throw new Error(`Failed to download OCR JSONL: HTTP ${response.status}`)
  }
  await fs.writeFile(outputFile, await response.text(), 'utf8')
}

function extensionFromContentType(contentType: string, fallbackName: string): string {
  if (contentType.includes('png')) return 'png'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg'
  if (contentType.includes('webp')) return 'webp'
  if (contentType.includes('avif')) return 'avif'
  if (contentType.includes('gif')) return 'gif'
  const ext = path.extname(fallbackName).replace('.', '').toLowerCase()
  return ext || 'jpg'
}

async function parseOcrAssets(
  jsonlFile: string,
  importDir: string,
  manifest: Manifest,
  includeOutputImages: boolean,
): Promise<void> {
  const pagesDir = path.join(importDir, 'pages')
  const imagesDir = path.join(importDir, 'images')
  await ensureDir(pagesDir)
  await ensureDir(imagesDir)

  const byHash = new Map(manifest.images.map((image) => [image.hash, image]))
  const text = await fs.readFile(jsonlFile, 'utf8')
  let page = 0

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parsed = JSON.parse(line) as { result?: { layoutParsingResults?: OcrLayoutResult[] } }
    for (const layout of parsed.result?.layoutParsingResults ?? []) {
      page += 1
      const pagePrefix = String(page).padStart(3, '0')
      await fs.writeFile(path.join(pagesDir, `page-${pagePrefix}.md`), layout.markdown?.text ?? '', 'utf8')

      const downloadEntries: Array<{
        sourceType: 'markdown' | 'output'
        key: string
        url: string
      }> = []
      for (const [key, url] of Object.entries(layout.markdown?.images ?? {})) {
        if (!shouldImportMarkdownImage(key)) continue
        downloadEntries.push({ sourceType: 'markdown', key, url })
      }
      if (includeOutputImages) {
        for (const [key, url] of Object.entries(layout.outputImages ?? {})) {
          downloadEntries.push({ sourceType: 'output', key, url })
        }
      }

      let imageIndex = 0
      for (const entry of downloadEntries) {
        imageIndex += 1
        const { buffer, contentType } = await fetchBuffer(entry.url)
        const hash = hashBuffer(buffer)
        if (byHash.has(hash)) continue

        const ext = extensionFromContentType(contentType, entry.key)
        const safeKey = sanitizeFilename(entry.key, `${entry.sourceType}-${imageIndex}`)
        const fileName = `${pagePrefix}-${entry.sourceType}-${imageIndex}-${hash.slice(0, 12)}.${ext}`
        const localPath = path.join('images', fileName)
        await fs.writeFile(path.join(imagesDir, fileName), buffer)

        const manifestImage: ManifestImage = {
          hash,
          page,
          sourceType: entry.sourceType,
          sourceKey: entry.key,
          sourceUrl: entry.url,
          localPath,
          imageName: safeKey,
        }
        manifest.images.push(manifestImage)
        byHash.set(hash, manifestImage)
      }
    }
  }
}

function getSetCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] }
  if (typeof withGetSetCookie.getSetCookie === 'function') return withGetSetCookie.getSetCookie()
  const value = headers.get('set-cookie')
  return value ? [value] : []
}

function cookieHeaderFromSetCookie(setCookies: string[]): string {
  return setCookies
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ')
}

async function login(baseUrl: string, env: Env): Promise<string> {
  if (env.PICIMPACT_COOKIE) return env.PICIMPACT_COOKIE

  const email = env.PICIMPACT_EMAIL || env.ADMIN_EMAIL
  const password = env.PICIMPACT_PASSWORD || env.ADMIN_PASSWORD
  if (!email || !password) {
    throw new Error('Missing PICIMPACT_EMAIL/PICIMPACT_PASSWORD or ADMIN_EMAIL/ADMIN_PASSWORD')
  }

  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
      Referer: `${baseUrl}/login`,
    },
    body: JSON.stringify({ email, password, callbackURL: '/' }),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`PicImpact login failed: HTTP ${response.status} ${body.slice(0, 500)}`)
  }
  const parsed = body ? JSON.parse(body) as { twoFactorRedirect?: boolean } : {}
  if (parsed.twoFactorRedirect) {
    throw new Error('PicImpact login requires 2FA. Set PICIMPACT_COOKIE from an authenticated browser session.')
  }
  const cookie = cookieHeaderFromSetCookie(getSetCookies(response.headers))
  if (!cookie) throw new Error('PicImpact login succeeded but no session cookie was returned')
  return cookie
}

async function apiRequest<T>(
  baseUrl: string,
  cookie: string,
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Cookie: cookie,
      Origin: baseUrl,
      Referer: `${baseUrl}/admin`,
    },
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`PicImpact API ${pathname} failed: HTTP ${response.status} ${text.slice(0, 500)}`)
  }
  const envelope = JSON.parse(text) as ApiEnvelope<T>
  if (envelope.code !== 200) {
    throw new Error(`PicImpact API ${pathname} failed: ${envelope.message ?? text.slice(0, 500)}`)
  }
  return envelope.data as T
}

async function detectStorage(baseUrl: string, cookie: string, env: Env): Promise<string> {
  if (env.PICIMPACT_STORAGE) return env.PICIMPACT_STORAGE
  try {
    const r2 = await apiRequest<Record<string, string>>(baseUrl, cookie, '/api/v1/settings/r2-info')
    if (r2.r2Bucket && r2.r2PublicDomain) return 'r2'
  } catch {
    // Fall through to S3 detection/default.
  }
  try {
    const s3 = await apiRequest<Record<string, string>>(baseUrl, cookie, '/api/v1/settings/s3-info')
    if (s3.bucket && s3.endpoint) return 's3'
  } catch {
    // Fall through to default.
  }
  return 'r2'
}

async function ensureAlbum(
  baseUrl: string,
  cookie: string,
  manifest: Manifest,
  albumValue: string,
  albumName?: string,
): Promise<void> {
  const albums = await apiRequest<Album[]>(baseUrl, cookie, '/api/v1/albums')
  const existing = albums.find((album) => album.album_value === albumValue)
  if (existing) {
    manifest.album = {
      name: existing.name,
      albumValue: existing.album_value,
      id: existing.id,
    }
    return
  }

  const paper = manifest.paper
  const detail = buildPaperDetail(paper, manifest.pdfUrl, 'Imported OCR figures from paper PDF.')
  await apiRequest<void>(baseUrl, cookie, '/api/v1/albums', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: albumName || paper.title || DEFAULT_PAPER_TITLE,
      album_value: albumValue,
      detail,
      sort: 0,
      theme: '0',
      show: 0,
      license: '',
      image_sorting: 1,
      random_show: 1,
    }),
  })

  const refreshed = await apiRequest<Album[]>(baseUrl, cookie, '/api/v1/albums')
  const created = refreshed.find((album) => album.album_value === albumValue)
  manifest.album = {
    name: created?.name ?? albumName ?? paper.title,
    albumValue,
    id: created?.id,
  }
}

function buildLabels(paper: PaperMetadata): string[] {
  return [
    'paper',
    'satellite-network-routing',
    paper.year,
    paper.venue,
    paper.doi,
  ].filter(Boolean)
}

function buildPaperDetail(paper: PaperMetadata, pdfUrl: string, prefix: string): string {
  const lines = [
    prefix,
    `Title: ${paper.title}`,
    paper.authors.length > 0 ? `Authors: ${paper.authors.join(', ')}` : '',
    paper.venue ? `Venue: ${paper.venue}` : '',
    paper.year ? `Year: ${paper.year}` : '',
    paper.doi ? `DOI: ${paper.doi}` : '',
    `PDF: ${pdfUrl}`,
  ].filter(Boolean)
  return lines.join('\n')
}

async function normalizeImage(file: string): Promise<NormalizedImage> {
  const input = await fs.readFile(file)
  const metadata = await sharp(input, { failOn: 'none' }).metadata()
  const format = metadata.format ?? ''
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width <= 0 || height <= 0) {
    throw new Error('Image has invalid dimensions')
  }

  if (format === 'jpeg' || format === 'png' || format === 'webp' || format === 'avif') {
    const ext = format === 'jpeg' ? 'jpg' : format
    const contentType = format === 'jpeg' ? 'image/jpeg' : `image/${format}`
    return { buffer: input, contentType, ext, width, height }
  }

  const png = await sharp(input, { failOn: 'none' }).png().toBuffer()
  return { buffer: png, contentType: 'image/png', ext: 'png', width, height }
}

async function uploadObject(
  baseUrl: string,
  cookie: string,
  storage: string,
  albumValue: string,
  image: NormalizedImage,
  imageId: string,
): Promise<string> {
  const filename = `${imageId}.${image.ext}`
  const presigned = await apiRequest<{ presignedUrl: string; key: string }>(baseUrl, cookie, '/api/v1/file/presigned-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename,
      contentType: image.contentType,
      type: albumValue,
      storage,
    }),
  })

  const putResponse = await fetch(presigned.presignedUrl, {
    method: 'PUT',
    body: image.buffer as unknown as BodyInit,
    headers: { 'Content-Type': image.contentType },
  })
  if (!putResponse.ok) {
    throw new Error(`Object upload failed: HTTP ${putResponse.status}`)
  }

  return apiRequest<string>(baseUrl, cookie, '/api/v1/file/object-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: presigned.key, storage }),
  })
}

async function createImageRecord(
  baseUrl: string,
  cookie: string,
  manifest: Manifest,
  albumValue: string,
  item: ManifestImage,
  uploaded: NormalizedImage,
  imageId: string,
  url: string,
  figureNumber: number,
): Promise<void> {
  const paper = manifest.paper
  const detail = buildPaperDetail(
    paper,
    manifest.pdfUrl,
    `OCR figure ${figureNumber} from page ${item.page}. Source: ${item.sourceType}/${item.sourceKey}`,
  )

  await apiRequest<void>(baseUrl, cookie, '/api/v1/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: imageId,
      album: albumValue,
      url,
      image_name: item.imageName,
      title: `Figure ${figureNumber} - ${paper.title}`,
      preview_url: url,
      video_url: '',
      blurhash: '',
      exif: emptyExif,
      labels: buildLabels(paper),
      detail,
      width: uploaded.width,
      height: uploaded.height,
      type: 1,
      lat: '',
      lon: '',
      sort: 0,
      show_on_mainpage: 1,
    }),
  })

  await apiRequest<void>(baseUrl, cookie, '/api/v1/images/update-show', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: imageId, show: 0 }),
  })
}

async function uploadImages(
  baseUrl: string,
  cookie: string,
  storage: string,
  importDir: string,
  manifestFile: string,
  manifest: Manifest,
  concurrency: number,
): Promise<void> {
  const albumValue = manifest.album?.albumValue
  if (!albumValue) throw new Error('Manifest has no album value')

  let cursor = 0
  let completed = 0
  const uploadOne = async (item: ManifestImage, figureNumber: number) => {
    if (item.uploaded) return

    try {
      const localFile = path.join(importDir, item.localPath)
      const normalized = await normalizeImage(localFile)
      const imageId = createId()
      const url = await uploadObject(baseUrl, cookie, storage, albumValue, normalized, imageId)
      await createImageRecord(baseUrl, cookie, manifest, albumValue, item, normalized, imageId, url, figureNumber)
      item.uploaded = {
        imageId,
        url,
        width: normalized.width,
        height: normalized.height,
        uploadedAt: nowIso(),
      }
      item.error = undefined
      manifest.updatedAt = nowIso()
      await writeJsonFile(manifestFile, manifest)
      console.info(`Uploaded figure ${figureNumber}/${manifest.images.length}: ${item.imageName}`)
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error)
      manifest.updatedAt = nowIso()
      await writeJsonFile(manifestFile, manifest)
      console.warn(`Skipped figure ${figureNumber}: ${item.error}`)
    }
  }

  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= manifest.images.length) return
      await uploadOne(manifest.images[index], index + 1)
      completed += 1
      if (completed % 10 === 0) {
        console.info(`Upload progress: ${completed}/${manifest.images.length} checked.`)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, manifest.images.length) }, () => worker()),
  )
}

async function runPreprocessTask(baseUrl: string, cookie: string): Promise<void> {
  const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled'])
  let activeRun: PreprocessRun | null = null

  try {
    activeRun = await apiRequest<PreprocessRun>(baseUrl, cookie, '/api/v1/preprocess-tasks/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskKey: 'preprocess-images',
        scope: { force: false },
      }),
    })
    console.info(`Created preprocess run ${activeRun.id} for ${activeRun.totalCount} image(s).`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('No images matched')) {
      console.info('Preprocess skipped: no images need variant generation.')
      return
    }
    if (message.includes('Variant storage backend is not configured')) {
      console.warn('Preprocess skipped: variant storage backend is not configured.')
      return
    }
    if (!message.includes('Another preprocess task is already active') && !message.includes('409')) {
      throw error
    }
    const runs = await apiRequest<{ activeRun: PreprocessRun | null }>(baseUrl, cookie, '/api/v1/preprocess-tasks/runs')
    activeRun = runs.activeRun
    if (activeRun) {
      console.info(`Using active preprocess run ${activeRun.id}.`)
    }
  }

  for (;;) {
    const tick = await apiRequest<{ activeRun: PreprocessRun | null }>(baseUrl, cookie, '/api/v1/preprocess-tasks/tick', {
      method: 'POST',
    })
    activeRun = tick.activeRun
    if (!activeRun) {
      console.info('Preprocess complete: no active run.')
      return
    }
    console.info(
      `Preprocess ${activeRun.status}: ${activeRun.processedCount}/${activeRun.totalCount} `
      + `(${activeRun.successCount} ok, ${activeRun.failedCount} failed).`,
    )
    if (terminalStatuses.has(activeRun.status)) {
      if (activeRun.status === 'failed') {
        throw new Error(`Preprocess failed: ${activeRun.failedCount} failed`)
      }
      return
    }
  }
}

function resolveImportRoot(): string {
  const scriptFile = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(scriptFile), '..', 'data', 'paper-imports')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const env = await loadEnvFiles()
  const token = env.PADDLEOCR_TOKEN
  if (!token) throw new Error('Missing PADDLEOCR_TOKEN')

  const baseUrl = (env.PICIMPACT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const pdfFile = args.pdfFile ? path.resolve(args.pdfFile) : undefined
  const pdfInput = args.sourceUrl ?? args.pdfUrl ?? path.resolve(args.pdfFile ?? '')
  const paper = await resolvePaperMetadata(pdfInput, pdfFile)
  const slug = slugify(args.slug || paper.title || DEFAULT_SLUG)
  const albumValue = args.albumValue || `/papers/${slug}`
  const importDir = path.join(resolveImportRoot(), slug)
  const ocrJsonlFile = path.join(importDir, 'ocr.jsonl')
  const manifestFile = path.join(importDir, 'manifest.json')

  await ensureDir(importDir)
  const existingManifest = await readJsonFile<Manifest>(manifestFile)
  const manifest: Manifest = existingManifest ?? {
    pdfUrl: pdfInput,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    doiCandidate: extractDoiCandidate(pdfInput),
    paper,
    images: [],
  }
  manifest.pdfUrl = pdfInput
  manifest.paper = { ...manifest.paper, ...paper }
  manifest.updatedAt = nowIso()

  if (args.refreshOcr || !existsSync(ocrJsonlFile)) {
    console.info('Submitting PaddleOCR job...')
    const jobId = await submitOcrJob(args.pdfUrl, pdfFile, token, importDir)
    manifest.ocrJobId = jobId
    manifest.updatedAt = nowIso()
    await writeJsonFile(manifestFile, manifest)
    console.info(`OCR job submitted: ${jobId}`)
    const jsonUrl = await pollOcrJob(jobId, token)
    manifest.ocrJsonUrl = jsonUrl
    await downloadOcrJsonl(jsonUrl, ocrJsonlFile)
  } else {
    console.info(`Reusing existing OCR JSONL: ${ocrJsonlFile}`)
  }

  await parseOcrAssets(ocrJsonlFile, importDir, manifest, args.includeOutputImages)
  manifest.album = manifest.album ?? {
    name: manifest.paper.title || DEFAULT_PAPER_TITLE,
    albumValue,
  }
  manifest.updatedAt = nowIso()
  await writeJsonFile(manifestFile, manifest)

  console.info(`OCR assets ready: ${manifest.images.length} unique image(s).`)
  if (args.dryRun) {
    console.info(`Dry run complete. Manifest: ${manifestFile}`)
    return
  }

  const cookie = await login(baseUrl, env)
  const storage = await detectStorage(baseUrl, cookie, env)
  await ensureAlbum(baseUrl, cookie, manifest, albumValue, args.albumName)
  manifest.updatedAt = nowIso()
  await writeJsonFile(manifestFile, manifest)
  console.info(`Using album ${manifest.album?.albumValue} and storage ${storage}.`)

  await uploadImages(baseUrl, cookie, storage, importDir, manifestFile, manifest, args.uploadConcurrency)
  if (args.skipPreprocess) {
    console.info('Skipping preprocess task; run pnpm run preprocess:backfill after batch imports.')
  } else {
    await runPreprocessTask(baseUrl, cookie)
  }
  const uploadedCount = manifest.images.filter((image) => image.uploaded).length
  const failedCount = manifest.images.filter((image) => image.error && !image.uploaded).length
  console.info(`Import complete: ${uploadedCount}/${manifest.images.length} uploaded, ${failedCount} failed.`)
  console.info(`Manifest: ${manifestFile}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
