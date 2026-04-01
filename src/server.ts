import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';

const PORT      = parseInt(process.env['PORT'] ?? '4873', 10);
const UPSTREAM  = 'https://registry.npmjs.org';
const CACHE_TTL = 5  * 60 * 1_000;   // 5 minutes
const MIN_AGE   = 24 * 60 * 60 * 1_000; // 24 hours

// ── Types ─────────────────────────────────────────────────────────────────

interface NpmMeta {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, unknown>;
  time?: Record<string, string>;
}

interface ParsedUrl {
  pkg: string;
  version: string | null;
  type: 'meta' | 'ver' | 'tarball';
}

// ── In-memory cache ───────────────────────────────────────────────────────

const cache = new Map<string, { val: NpmMeta; exp: number }>();

function getCache(key: string): NpmMeta | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { cache.delete(key); return null; }
  return entry.val;
}

function setCache(key: string, val: NpmMeta): void {
  cache.set(key, { val, exp: Date.now() + CACHE_TTL });
}

async function fetchMeta(pkg: string): Promise<NpmMeta | null> {
  const hit = getCache(pkg);
  if (hit) return hit;

  const res = await fetch(`${UPSTREAM}/${encodeURIComponent(pkg)}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return null;

  const data = (await res.json()) as NpmMeta;
  setCache(pkg, data);
  return data;
}

// ── URL parsing ───────────────────────────────────────────────────────────

function parseUrl(rawUrl: string): ParsedUrl | null {
  const path = rawUrl.split('?')[0]!.replace(/^\//, '');
  if (!path) return null;

  let pkg: string;
  let rest: string;

  if (path.startsWith('@')) {
    // Scoped: @scope/name[/rest]
    const m = path.match(/^(@[^/]+\/[^/]+)(\/(.*))?$/);
    if (!m) return null;
    pkg  = m[1]!;
    rest = m[3] ?? '';
  } else {
    const i = path.indexOf('/');
    pkg  = i < 0 ? path : path.slice(0, i);
    rest = i < 0 ? '' : path.slice(i + 1);
  }

  // Reject npm internal paths (/-/… /_/…)
  if (!pkg || pkg[0] === '-' || pkg[0] === '_') return null;

  if (!rest) return { pkg, version: null, type: 'meta' };

  if (rest.startsWith('-/')) {
    const ver = extractVersionFromFilename(rest.slice(2));
    return { pkg, version: ver, type: 'tarball' };
  }

  return { pkg, version: rest, type: 'ver' };
}

function extractVersionFromFilename(filename: string): string | null {
  const base = filename.replace(/\.tgz$/, '');
  return base.match(/^.+-(\d+\..+)$/)?.[1] ?? null;
}

// ── Upstream proxy ────────────────────────────────────────────────────────

async function proxyUpstream(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const headers: Record<string, string> = { host: 'registry.npmjs.org' };
  for (const [k, v] of Object.entries(req.headers)) {
    if (k !== 'connection' && k !== 'host' && typeof v === 'string') headers[k] = v;
  }

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body != null) {
    init.body = req.body as Buffer;
  }

  const upstream = await fetch(`${UPSTREAM}${req.url}`, init);

  reply.code(upstream.status);
  for (const [k, v] of upstream.headers.entries()) {
    if (k !== 'connection' && k !== 'transfer-encoding') reply.header(k, v);
  }

  if (!upstream.body) return reply.send('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return reply.send(Readable.fromWeb(upstream.body as any));
}

// ── App ───────────────────────────────────────────────────────────────────

const app = Fastify({
  logger:    { level: process.env['LOG_LEVEL'] ?? 'info' },
  bodyLimit: 100 * 1024 * 1024, // 100 MB — npm publish payloads can be large
});

// Accept every content type as a raw Buffer so non-GET requests
// (publish, unpublish) can be forwarded verbatim.
app.addContentTypeParser<Buffer>('*', { parseAs: 'buffer' }, (_req, body, done) => {
  done(null, body);
});

app.get('/health', async () => ({
  status: 'ok',
  uptime: Math.floor(process.uptime()),
  timestamp: new Date().toISOString(),
  cachedPackages: cache.size,
}));

app.all('/*', async (req, reply) => {
  if (req.method !== 'GET') return proxyUpstream(req, reply);

  const parsed = parseUrl(req.url);
  if (!parsed) return proxyUpstream(req, reply);

  const { pkg, version, type } = parsed;

  // ── Full metadata: serve from cache, populates it for tarball checks ──
  if (type === 'meta') {
    const meta = await fetchMeta(pkg);
    if (!meta) return proxyUpstream(req, reply);
    return reply.header('content-type', 'application/json; charset=utf-8').send(meta);
  }

  // ── Version / tarball: enforce the 24-hour quarantine ─────────────────
  const meta = await fetchMeta(pkg);
  if (!meta) return proxyUpstream(req, reply); // can't verify → allow

  // Resolve dist-tag (e.g. "latest" → "4.17.21")
  let resolvedVer = version;
  const distTags = meta['dist-tags'];
  if (resolvedVer && distTags[resolvedVer]) resolvedVer = distTags[resolvedVer]!;

  const timestamp = resolvedVer ? meta.time?.[resolvedVer] : undefined;
  if (timestamp) {
    const publishedAt = new Date(timestamp);
    const ageMs       = Date.now() - publishedAt.getTime();

    if (ageMs < MIN_AGE) {
      const availableAt = new Date(publishedAt.getTime() + MIN_AGE);
      reply.code(403);
      return {
        error:       'ERR_PACKAGE_TOO_NEW',
        message:
          `${pkg}@${resolvedVer} was published ${Math.floor(ageMs / 60_000)} minute(s) ago. ` +
          `Packages must be at least 24 hours old. ` +
          `Installation will be available at ${availableAt.toISOString()}.`,
        package:     pkg,
        version:     resolvedVer,
        publishedAt: publishedAt.toISOString(),
        availableAt: availableAt.toISOString(),
      };
    }
  }

  return proxyUpstream(req, reply);
});

app.setNotFoundHandler(async (req, reply) => proxyUpstream(req, reply));

// ── Start ─────────────────────────────────────────────────────────────────

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
  app.log.info(`npm-ripe-guard ready → http://0.0.0.0:${PORT}`);
  app.log.info(`Upstream: ${UPSTREAM} | Block: 24 h | Cache TTL: 5 min`);
});
