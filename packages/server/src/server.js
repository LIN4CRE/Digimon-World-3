/**
 * PSXpress server.
 *
 * A zero-dependency Node HTTP server that does three things:
 *   1. serves the browser shell (static files),
 *   2. serves the disc manifest produced by the analyser,
 *   3. serves the user's own disc image as *content-addressed chunks* and byte
 *      ranges, so the client can hydrate it progressively, verify every byte
 *      against a SHA-256, and cache what it has already downloaded.
 *
 * The disc image is never served as a downloadable file: it is only reachable
 * through the chunk and range endpoints, which keeps progress reporting and
 * cache validation honest.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_ROOT = path.resolve(__dirname, '../../../web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

/** 1 MiB chunks keep range requests few and hashes cheap. */
export const CHUNK_SIZE = 1024 * 1024;

/** Stable id for a disc: size + the hash of its first 64 KiB. */
export async function discIdFor(image) {
  const head = await image.readRawAt(0, Math.ceil(65536 / image.sectorSize));
  const hash = crypto.createHash('sha256').update(head).digest('hex').slice(0, 16);
  return `${image.sectorCount}-${hash}`;
}

/**
 * @param {object} opts
 * @param {import('../../disc/src/cue.js').DiscImage} opts.image
 * @param {object} opts.manifest
 * @param {string} [opts.webRoot]
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {boolean} [opts.dev] disable client caching hints
 */
export function createServer({ image, manifest, webRoot = DEFAULT_WEB_ROOT, dev = false }) {
  const imageBytes = image.byteLength;
  const hashCache = new Map();

  const chunkHash = async (index) => {
    if (hashCache.has(index)) return hashCache.get(index);
    const start = index * CHUNK_SIZE;
    const length = Math.min(CHUNK_SIZE, imageBytes - start);
    if (length <= 0) throw Object.assign(new Error('Chunk past the end of the image'), { status: 416 });
    const lba = Math.floor(start / image.sectorSize);
    const sectors = Math.ceil((length + (start % image.sectorSize)) / image.sectorSize);
    const raw = await image.readRawAt(lba, sectors);
    const offset = start - lba * image.sectorSize;
    const bytes = raw.subarray(offset, offset + length);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    hashCache.set(index, { hash, bytes: length });
    return { hash, bytes: length };
  };

  const sendJson = (res, body, extraHeaders = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': dev ? 'no-store' : 'no-cache',
      ...extraHeaders,
    });
    res.end(text);
  };

  const sendError = (res, status, message) => {
    const body = JSON.stringify({ error: message, status });
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const serveStatic = async (req, res, pathname) => {
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const resolved = path.resolve(webRoot, relative);
    if (!resolved.startsWith(webRoot + path.sep) && resolved !== path.join(webRoot, 'index.html')) {
      return sendError(res, 403, 'Outside the web root');
    }
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      return sendError(res, 404, `Not found: ${relative}`);
    }
    if (stat.isDirectory()) return serveStatic(req, res, path.posix.join(pathname, 'index.html'));
    const ext = path.extname(resolved).toLowerCase();
    const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      return res.end();
    }
    const headers = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': stat.size,
      etag,
      // The shell must be revalidated every launch so an update lands; the
      // heavy, content-addressed assets carry their own immutable headers.
      'cache-control': dev ? 'no-store' : 'no-cache',
      'x-content-type-options': 'nosniff',
    };
    if (ext === '.wasm') headers['cache-control'] = 'public, max-age=31536000, immutable';
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      return res.end();
    }
    res.writeHead(200, headers);
    createReadStream(resolved).pipe(res);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const { pathname, searchParams } = url;
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Only GET and HEAD are served');

      if (pathname === '/api/health') {
        return sendJson(res, {
          ok: true,
          service: 'psxpress',
          chunkSize: CHUNK_SIZE,
          imageBytes,
          discId: manifest.discId,
          node: process.version,
        });
      }

      if (pathname === '/api/manifest') {
        return sendJson(res, { ...manifest, chunkSize: CHUNK_SIZE, imageBytes });
      }

      if (pathname === '/api/disc/chunks') {
        const count = Math.ceil(imageBytes / CHUNK_SIZE);
        const hashes = [];
        for (let i = 0; i < count; i++) hashes.push(await chunkHash(i));
        return sendJson(res, { chunkSize: CHUNK_SIZE, imageBytes, count, chunks: hashes });
      }

      if (pathname === '/api/disc/chunk') {
        const index = Number(searchParams.get('index'));
        if (!Number.isInteger(index) || index < 0) return sendError(res, 400, 'index must be a non-negative integer');
        const start = index * CHUNK_SIZE;
        if (start >= imageBytes) return sendError(res, 416, 'Chunk past the end of the image');
        const length = Math.min(CHUNK_SIZE, imageBytes - start);
        const lba = Math.floor(start / image.sectorSize);
        const sectors = Math.ceil((start - lba * image.sectorSize + length) / image.sectorSize);
        const raw = await image.readRawAt(lba, sectors);
        const offset = start - lba * image.sectorSize;
        const body = Buffer.from(raw.subarray(offset, offset + length));
        const hash = crypto.createHash('sha256').update(body).digest('hex');
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': body.length,
          'cache-control': 'public, max-age=31536000, immutable',
          'x-chunk-hash': hash,
          'x-chunk-index': String(index),
          'x-image-bytes': String(imageBytes),
          etag: `"${hash}"`,
        });
        return res.end(body);
      }

      if (pathname === '/api/disc/range') {
        const start = Number(searchParams.get('start') ?? 0);
        const end = Number(searchParams.get('end') ?? Math.min(start + CHUNK_SIZE, imageBytes));
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > imageBytes) {
          return sendError(res, 400, 'start/end must be byte offsets inside the image');
        }
        const lba = Math.floor(start / image.sectorSize);
        const sectors = Math.ceil((start - lba * image.sectorSize + (end - start)) / image.sectorSize);
        const raw = await image.readRawAt(lba, sectors);
        const offset = start - lba * image.sectorSize;
        const body = Buffer.from(raw.subarray(offset, offset + (end - start)));
        res.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-length': body.length,
          'content-range': `bytes ${start}-${end - 1}/${imageBytes}`,
          'accept-ranges': 'bytes',
          'cache-control': 'public, max-age=31536000, immutable',
        });
        return res.end(body);
      }

      return serveStatic(req, res, pathname);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error('[psxpress]', error);
      sendError(res, status, error.message ?? 'Server error');
    }
  });

  return server;
}

/**
 * Starts the server and resolves once it is listening.
 * @returns {Promise<{ server: http.Server, url: string, port: number }>}
 */
export async function startServer({ port = 8080, host = '0.0.0.0', ...rest }) {
  const server = createServer(rest);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const { port: actualPort } = server.address();
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  return { server, url: `http://${displayHost}:${actualPort}`, port: actualPort };
}
