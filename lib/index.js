import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * dsh-app-restart, Host half.
 *
 * The Desktop app can only be restarted from outside its own process tree:
 * Electron's main process exposes no relaunch channel to plugins, and killing
 * the Desktop Host alone only raises the fatal-recovery dialog. So this plugin
 * validates the launch target, then hands the kill-and-relaunch job to a
 * detached PowerShell helper that is re-parented away from this process (via a
 * WMI process creation), which means the helper survives the app going down.
 */
export const name = 'dsh-app-restart'
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-app-restart'
const STATE_DIRECTORY = join(tmpdir(), 'dsh-app-restart')
const STATE_PATH = join(STATE_DIRECTORY, 'last.json')
const LOG_PATH = join(STATE_DIRECTORY, 'helper.log')
const HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'restart-helper.ps1')
const LAUNCHER_PATH = join(STATE_DIRECTORY, 'helper-launch.vbs')
const MAX_BODY_BYTES = 4096
/** How long a scheduled restart blocks a second request. */
const IN_PROGRESS_MS = 30000

let inProgressUntil = 0

/** The Electron main process, as this Host process sees it. */
function restartTarget() {
	const executable = process.execPath
	const mainPid = process.ppid
	if (typeof process.versions.electron !== 'string') return { supported: false, reason: 'not-desktop', executable, mainPid }
	if (process.platform !== 'win32') return { supported: false, reason: 'unsupported-platform', executable, mainPid }
	if (!Number.isSafeInteger(mainPid) || mainPid <= 0) return { supported: false, reason: 'no-parent-process', executable, mainPid }
	if (typeof executable !== 'string' || !existsSync(executable)) return { supported: false, reason: 'missing-executable', executable, mainPid }
	if (!existsSync(HELPER_PATH)) return { supported: false, reason: 'missing-helper', executable, mainPid }
	return { supported: true, reason: null, executable, mainPid }
}

function powershellPath() {
	const root = process.env.SystemRoot ?? process.env.SystemDrive ?? 'C:\\Windows'
	const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
	return existsSync(candidate) ? candidate : 'powershell.exe'
}

/** PowerShell single-quoted literal. */
function psQuote(value) {
	return `'${String(value).replaceAll("'", "''")}'`
}

function readLastState() {
	try {
		// Tolerate a UTF-8 BOM: older helpers wrote one, and JSON.parse rejects it.
		const text = readFileSync(STATE_PATH, 'utf8').replace(/^\uFEFF/u, '')
		const parsed = JSON.parse(text)
		return typeof parsed === 'object' && parsed !== null ? parsed : null
	} catch {
		return null
	}
}

function helperCommandLine({ mainPid, executable, dryRun }) {
	const parts = [
		`"${powershellPath()}"`,
		'-NoProfile',
		'-NonInteractive',
		'-ExecutionPolicy Bypass',
		`-File "${HELPER_PATH}"`,
		`-MainPid ${String(mainPid)}`,
		`-Exe "${executable}"`,
		`-StateDir "${STATE_DIRECTORY}"`,
	]
	if (dryRun) parts.push('-DryRun')
	return parts.join(' ')
}

function wscriptPath() {
	const root = process.env.SystemRoot ?? process.env.SystemDrive ?? 'C:\\Windows'
	const candidate = join(root, 'System32', 'wscript.exe')
	return existsSync(candidate) ? candidate : 'wscript.exe'
}

/**
 * A console-subsystem program that WMI creates gets its own console window,
 * because WMI process creation implies CREATE_NEW_CONSOLE. That window is the
 * one whose close button used to take the whole app down: the relaunched app
 * inherited it, and closing it broadcast CTRL_CLOSE_EVENT to the app too.
 *
 * So the helper is not created directly. WMI creates a GUI-subsystem
 * `wscript.exe`, and the VBScript it runs starts the helper with window style
 * 0 (hidden) and no wait. Nothing on that path ever owns a console, which is
 * the same situation as a launch from a desktop shortcut.
 */
function launcherScript(commandLine) {
	const escaped = commandLine.replaceAll('"', '""')
	return [
		'Option Explicit',
		'Dim agent',
		'Set agent = CreateObject("WScript.Shell")',
		`agent.Run "${escaped}", 0, False`,
		'',
	].join('\r\n')
}

/**
 * First hop. This short-lived shell asks WMI to create the launcher, so the
 * helper is parented to WmiPrvSE instead of to this process tree and cannot be
 * taken down with it.
 */
function bootstrapScript(launcherCommandLine) {
	return [
		"$ErrorActionPreference = 'Stop'",
		`$logPath = ${psQuote(LOG_PATH)}`,
		'function Note([string]$text) {',
		'  try { Add-Content -LiteralPath $logPath -Value ((Get-Date).ToString("o") + " bootstrap " + $text) -Encoding UTF8 } catch {}',
		'}',
		'try {',
		'  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{',
		`    CommandLine = ${psQuote(launcherCommandLine)}`,
		`    CurrentDirectory = ${psQuote(STATE_DIRECTORY)}`,
		'  }',
		'  Note ("created=" + [string]$created.ProcessId + " returnValue=" + [string]$created.ReturnValue)',
		'  if ([int]$created.ReturnValue -ne 0) { exit 3 }',
		'} catch {',
		'  Note ("failed: " + $_.Exception.Message)',
		'  exit 4',
		'}',
	].join('\n')
}

/**
 * Schedule one restart.
 *
 * Only the short bootstrap runs as this process's child; it hands the real
 * helper to WMI, which re-parents it out of this process tree. `detached` is
 * deliberately false: on Windows a detached child of an ELECTRON_RUN_AS_NODE
 * process starts but never runs its script body, and the bootstrap does not
 * need to outlive us anyway — the WMI-created helper does.
 */
async function scheduleRestart({ dryRun }) {
	const target = restartTarget()
	if (!target.supported) return { ok: false, reason: target.reason, status: 501 }

	const now = Date.now()
	if (now < inProgressUntil) return { ok: false, reason: 'already-scheduled', status: 409 }

	try {
		mkdirSync(STATE_DIRECTORY, { recursive: true })
	} catch {
		// A state directory we cannot create only costs the diagnostic log.
	}

	const commandLine = helperCommandLine({ mainPid: target.mainPid, executable: target.executable, dryRun })
	try {
		writeFileSync(LAUNCHER_PATH, launcherScript(commandLine), 'utf8')
	} catch (error) {
		return { ok: false, reason: 'launcher-failed', message: error instanceof Error ? error.message : String(error), status: 500 }
	}
	const encoded = Buffer.from(bootstrapScript(`"${wscriptPath()}" //nologo "${LAUNCHER_PATH}"`), 'utf16le').toString('base64')
	const spawned = await new Promise((resolve) => {
		let settled = false
		const finish = (outcome) => {
			if (settled) return
			settled = true
			resolve(outcome)
		}
		let child
		try {
			child = spawn(
				powershellPath(),
				['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
				{ cwd: STATE_DIRECTORY, stdio: 'ignore', windowsHide: true },
			)
		} catch (error) {
			finish({ ok: false, message: error instanceof Error ? error.message : String(error) })
			return
		}
		child.once('error', (error) => finish({ ok: false, message: error.message }))
		child.once('spawn', () => {
			try {
				child.unref()
			} catch {}
			finish({ ok: true })
		})
	})
	if (!spawned.ok) return { ok: false, reason: 'spawn-failed', message: spawned.message, status: 500 }

	inProgressUntil = now + IN_PROGRESS_MS
	return {
		ok: true,
		scheduled: true,
		dryRun,
		executable: target.executable,
		mainPid: target.mainPid,
		statePath: STATE_PATH,
		logPath: LOG_PATH,
	}
}

function isLoopback(address) {
	if (typeof address !== 'string') return false
	return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address === '::ffff:127.0.0.1'
}

function loopbackHostname(value) {
	if (typeof value !== 'string' || value.length === 0) return undefined
	let parsed
	try {
		parsed = new URL(`http://${value}`)
	} catch {
		return undefined
	}
	const hostname = parsed.hostname.replace(/^\[|\]$/gu, '')
	return hostname === 'localhost' || hostname === '::1' || hostname === '127.0.0.1' ? parsed : undefined
}

/**
 * Only the app's own page or a local client may restart it.
 *
 * Two doors, and a browser page can neither pick nor forge either one:
 *
 * - The web UI reaches this route directly and sends an Origin naming this
 *   origin, so that Origin must match the Host header exactly.
 * - The desktop window does not: its requests are forwarded by the Electron
 *   protocol handler, which strips `origin`, `sec-fetch-site`, `host` and
 *   `cookie` before the Host sees them. A request with no Origin therefore
 *   cannot come from a browser, because browsers always attach one to a POST.
 *   It can only be that forward, or a local program -- and a local program that
 *   wanted this app gone would just kill the process, so it gains no privilege
 *   here. The forward branch still demands our custom header: a custom header
 *   forces a CORS preflight, and this route answers no preflight, so a
 *   cross-origin page can never send it.
 */
const DESKTOP_HEADER = 'x-dsh-app-restart'
const DESKTOP_HEADER_VALUE = 'dsh-app://app'

function assertLocalCaller(request, { write }) {
	if (!isLoopback(request.socket.remoteAddress ?? undefined)) return 'peer'
	const authority = loopbackHostname(request.headers.host)
	if (authority === undefined) return 'host'
	const site = request.headers['sec-fetch-site']
	if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'site'
	const origin = request.headers.origin
	if (write) {
		// Our custom header is itself the proof: a cross-origin page that tried to
		// send it would need a preflight, and this route answers none.
		if (request.headers[DESKTOP_HEADER] === DESKTOP_HEADER_VALUE) return null
		if (origin === undefined) return 'origin'
		let parsed
		try {
			parsed = new URL(origin)
		} catch {
			return 'origin'
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'origin'
		if (parsed.host.toLowerCase() !== authority.host.toLowerCase()) return 'origin'
		return null
	}
	if (origin !== undefined) {
		try {
			const parsed = new URL(origin)
			if (parsed.host.toLowerCase() !== authority.host.toLowerCase()) return 'origin'
		} catch {
			return 'origin'
		}
	}
	return null
}

async function readJsonBody(request) {
	const declared = request.headers['content-length']
	if (declared !== undefined) {
		if (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES) throw new Error('payload')
	}
	const chunks = []
	let total = 0
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		total += buffer.length
		if (total > MAX_BODY_BYTES) throw new Error('payload')
		chunks.push(buffer)
	}
	if (total === 0) return {}
	const text = Buffer.concat(chunks).toString('utf8')
	let parsed
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new Error('json')
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('json')
	return parsed
}

function sendJson(response, status, payload) {
	if (response.headersSent || response.destroyed) return
	const body = `${JSON.stringify(payload)}\n`
	response.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(body),
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
	})
	response.end(body)
}

function statusPayload() {
	const target = restartTarget()
	return {
		ok: true,
		supported: target.supported,
		reason: target.reason,
		executable: target.executable,
		mainPid: target.mainPid,
		platform: process.platform,
		inProgress: Date.now() < inProgressUntil,
		last: readLastState(),
	}
}

async function handleRequest(request, response) {
	let target
	try {
		target = new URL(request.url ?? '/', 'http://localhost')
	} catch {
		sendJson(response, 400, { ok: false, reason: 'bad-request' })
		return
	}
	const route = target.pathname.slice(ROUTE_PREFIX.length) || '/'
	const normalized = route.endsWith('/') && route.length > 1 ? route.slice(0, -1) : route

	if (normalized === '/status') {
		const problem = assertLocalCaller(request, { write: false })
		if (problem !== null) {
			sendJson(response, 403, { ok: false, reason: 'forbidden', detail: problem })
			return
		}
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			response.setHeader('Allow', 'GET, HEAD')
			sendJson(response, 405, { ok: false, reason: 'method-not-allowed' })
			return
		}
		sendJson(response, 200, statusPayload())
		return
	}

	if (normalized === '/restart') {
		if (request.method !== 'POST') {
			response.setHeader('Allow', 'POST')
			sendJson(response, 405, { ok: false, reason: 'method-not-allowed' })
			return
		}
		const problem = assertLocalCaller(request, { write: true })
		if (problem !== null) {
			sendJson(response, 403, { ok: false, reason: 'forbidden', detail: problem })
			return
		}
		let body
		try {
			body = await readJsonBody(request)
		} catch {
			sendJson(response, 400, { ok: false, reason: 'bad-request' })
			return
		}
		const result = await scheduleRestart({ dryRun: body.dryRun === true })
		sendJson(response, result.ok ? 202 : result.status ?? 500, result)
		return
	}

	sendJson(response, 404, { ok: false, reason: 'not-found' })
}

/** Register the restart surface. */
export function apply(ctx) {
	ctx.effect(() => {
		const unregister = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handleRequest })
		return () => unregister()
	}, 'dsh-app-restart: desktop restart route')
}
