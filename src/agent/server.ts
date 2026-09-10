/**
 * The control agent's HTTP surface.
 *
 * Bind is loopback-only and every mutating endpoint requires the shared
 * bearer token, because "restart the process that owns this machine's coding
 * agent" is not a capability to leave open on a LAN interface.
 * @module dsh-restart/agent/server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { AgentInfo, RestartRequest } from '../protocol.ts'
import { STATE_VERSION } from '../protocol.ts'
import type { Supervisor } from './supervisor.ts'

/** Largest accepted request body. */
const MAX_BODY_BYTES = 1 << 20

/** Addresses treated as loopback. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Whether an `Origin` header names a loopback page.
 *
 * Only these are granted CORS on `/health`: the local Web GUI is the one
 * caller that needs it, and a page on the public internet has no business
 * fingerprinting a developer's restart supervisor.
 * @param origin - the raw `Origin` header value.
 * @returns true when the origin is a loopback http(s) origin.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const host = parsed.hostname.replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

/** Server construction options. */
export interface AgentServerOptions {
  supervisor: Supervisor
  agentInfo: AgentInfo
  token: string
  log: (line: string) => void
  /** Called after a `POST /shutdown` response is flushed. */
  onShutdown: () => void
}

/** A running agent HTTP server. */
export interface AgentServer {
  server: Server
  close(): Promise<void>
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  response.end(text)
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/**
 * Start the control agent's HTTP server.
 * @param options - supervisor, identity, token, and lifecycle hooks.
 * @returns the server handle.
 */
export function createAgentServer(options: AgentServerOptions): AgentServer {
  const { supervisor, agentInfo, token, log } = options

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) {
        sendJson(response, 500, { accepted: false, error: 'internal error' })
      } else {
        response.end()
      }
    })
  })

  const authorized = (request: IncomingMessage): boolean => {
    const header = request.headers.authorization
    const bearer = typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : undefined
    const custom = request.headers['x-dsh-restart-token']
    const presented = bearer ?? (typeof custom === 'string' ? custom : undefined)
    return presented !== undefined && constantTimeEquals(presented, token)
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const remote = request.socket.remoteAddress ?? ''
    if (!LOOPBACK.has(remote)) {
      sendJson(response, 403, { accepted: false, error: 'the control agent only answers on loopback' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const route = `${request.method ?? 'GET'} ${url.pathname}`

    if (route === 'GET /health') {
      // The Web GUI's supervisor lamp probes this endpoint straight from the
      // browser, so it keeps reporting while the harness itself is down. That
      // read is cross-origin (a different port), so it needs CORS — granted
      // only to loopback pages, which is exactly the case that matters.
      const origin = request.headers.origin
      if (typeof origin === 'string' && isLoopbackOrigin(origin)) {
        response.setHeader('access-control-allow-origin', origin)
        response.setHeader('vary', 'origin')
      }
      sendJson(response, 200, {
        ok: true,
        version: STATE_VERSION,
        pid: agentInfo.pid,
        port: agentInfo.port,
        startedAt: agentInfo.startedAt,
        agentVersion: agentInfo.agentVersion,
        busy: supervisor.isBusy,
      })
      return
    }

    if (!authorized(request)) {
      sendJson(response, 401, { accepted: false, error: 'missing or invalid control token' })
      return
    }

    switch (route) {
      case 'GET /status': {
        sendJson(response, 200, supervisor.status())
        return
      }
      case 'POST /restart': {
        const body = await readBody(request) as Partial<RestartRequest> & { wait?: boolean }
        const restartRequest: RestartRequest = {
          reason: typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : 'unspecified',
          requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : 'unknown',
        }
        if (typeof body.pid === 'number') restartRequest.pid = body.pid
        if (typeof body.instance === 'string' && body.instance.length > 0) restartRequest.instance = body.instance
        if (body.rollbackNow === true) restartRequest.rollbackNow = true
        if (typeof body.rollbackOnFailure === 'boolean') restartRequest.rollbackOnFailure = body.rollbackOnFailure
        if (typeof body.readyTimeoutMs === 'number') restartRequest.readyTimeoutMs = body.readyTimeoutMs
        if (typeof body.stopGraceMs === 'number') restartRequest.stopGraceMs = body.stopGraceMs
        if (Array.isArray(body.appendArgs)) {
          const appendArgs = body.appendArgs.filter((value): value is string => typeof value === 'string')
          if (appendArgs.length > 0) restartRequest.appendArgs = appendArgs
        }

        if (supervisor.isBusy) {
          sendJson(response, 409, { accepted: false, error: 'a restart is already in progress' })
          return
        }
        if (body.wait === true) {
          // Manual/CLI callers want the outcome on the same connection.
          const outcome = await supervisor.restart(restartRequest)
          sendJson(response, outcome.ok ? 200 : 409, outcome.ok ? outcome.report : { accepted: false, error: outcome.error })
          return
        }
        // The requester is about to exit, so the acknowledgement must not wait
        // on the restart it just asked for.
        sendJson(response, 202, { accepted: true, id: 'pending', message: 'restart accepted; the control agent will relaunch dsh' })
        void supervisor.restart(restartRequest).then((outcome) => {
          if (!outcome.ok) log(`restart refused: ${outcome.error}`)
        })
        return
      }
      case 'POST /ready': {
        const body = await readBody(request) as { attempt?: unknown; url?: unknown }
        if (typeof body.attempt !== 'string') {
          sendJson(response, 400, { accepted: false, error: 'attempt is required' })
          return
        }
        const accepted = supervisor.markReady(body.attempt, typeof body.url === 'string' ? body.url : undefined)
        sendJson(response, accepted ? 200 : 409, {
          accepted,
          error: accepted ? undefined : 'that attempt is not being supervised',
        })
        return
      }
      case 'POST /shutdown': {
        sendJson(response, 200, { accepted: true, message: 'control agent stopping' })
        options.onShutdown()
        return
      }
      default: {
        sendJson(response, 404, { accepted: false, error: `no route for ${route}` })
      }
    }
  }

  return {
    server,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
      server.closeIdleConnections()
    }),
  }
}
