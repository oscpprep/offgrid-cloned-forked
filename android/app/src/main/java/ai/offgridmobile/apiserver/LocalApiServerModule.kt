package ai.offgridmobile.apiserver

import ai.offgridmobile.SafePromise
import android.content.Intent
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import fi.iki.elonen.NanoHTTPD
import java.io.IOException
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

class LocalApiServerModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "LocalApiServerModule"
        private const val MODULE_NAME = "LocalApiServerModule"
        private const val EVENT_REQUEST = "LocalApiServerRequest"
        private const val DEFAULT_PORT = 3333
        private const val RESPONSE_TIMEOUT_SECONDS = 600L
        private const val STREAM_BUFFER_BYTES = 64 * 1024
        private const val MAX_PENDING_REQUESTS = 16
    }

    private data class PendingRequest(
        val requestId: String,
        val future: CompletableFuture<NanoHTTPD.Response>,
    )

    private data class StreamState(
        val input: PipedInputStream,
        val output: PipedOutputStream,
    )

    private var lanServer: BridgeHttpServer? = null
    private var localhostServer: BridgeHttpServer? = null
    private var configuredPort: Int = DEFAULT_PORT
    private var configuredApiKey: String = ""
    private val listenerCount = AtomicInteger(0)
    private val serverStartedAtMs = AtomicLong(0)
    private val lastRequestAtMs = AtomicLong(0)
    private val pendingRequests = ConcurrentHashMap<String, PendingRequest>()
    private val streamStates = ConcurrentHashMap<String, StreamState>()

    override fun getName(): String = MODULE_NAME

    @ReactMethod
    fun startServer(config: ReadableMap, promise: Promise) {
        val safePromise = SafePromise(promise, TAG)
        try {
            val port = if (config.hasKey("port")) config.getInt("port") else DEFAULT_PORT
            val apiKey = if (config.hasKey("apiKey")) config.getString("apiKey") ?: "" else ""

            configuredPort = port
            configuredApiKey = apiKey

            if (lanServer != null && lanServer?.isAlive == true && lanServer?.listeningPort == port) {
                safePromise.resolve(buildStatusMap())
                return
            }

            stopServerInternal()

            lanServer = BridgeHttpServer("0.0.0.0", port)
            lanServer?.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            serverStartedAtMs.set(System.currentTimeMillis())

            try {
                localhostServer = BridgeHttpServer("::1", port)
                localhostServer?.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            } catch (e: Exception) {
                localhostServer = null
                Log.w(TAG, "Failed to start IPv6 localhost API server alias", e)
            }

            startKeepAliveService(port)
            Log.i(TAG, "Started LAN API server on port $port")
            safePromise.resolve(buildStatusMap())
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start LAN API server", e)
            safePromise.reject("API_SERVER_START_FAILED", e.message ?: "Failed to start server", e)
        }
    }

    @ReactMethod
    fun stopServer(promise: Promise) {
        stopServerInternal()
        SafePromise(promise, TAG).resolve(buildStatusMap())
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        SafePromise(promise, TAG).resolve(buildStatusMap())
    }

    @ReactMethod
    fun respondJson(requestId: String, statusCode: Int, body: String, headers: ReadableMap?, promise: Promise) {
        val pending = pendingRequests.remove(requestId)
        if (pending == null) {
            SafePromise(promise, TAG).resolve(false)
            return
        }

        val response = NanoHTTPD.newFixedLengthResponse(
            toStatus(statusCode),
            "application/json; charset=utf-8",
            body,
        )
        addCommonHeaders(response)
        addHeaders(response, headers)
        pending.future.complete(response)
        SafePromise(promise, TAG).resolve(true)
    }

    @ReactMethod
    fun startStream(requestId: String, statusCode: Int, headers: ReadableMap?, promise: Promise) {
        val pending = pendingRequests.remove(requestId)
        if (pending == null) {
            SafePromise(promise, TAG).resolve(false)
            return
        }

        try {
            val input = PipedInputStream(STREAM_BUFFER_BYTES)
            val output = PipedOutputStream(input)
            val response = NanoHTTPD.newChunkedResponse(
                toStatus(statusCode),
                "text/event-stream; charset=utf-8",
                input,
            )
            addCommonHeaders(response)
            response.addHeader("Cache-Control", "no-cache")
            response.addHeader("Connection", "keep-alive")
            addHeaders(response, headers)
            streamStates[requestId] = StreamState(input, output)
            pending.future.complete(response)
            SafePromise(promise, TAG).resolve(true)
        } catch (e: IOException) {
            pending.future.complete(buildJsonResponse(500, """{"error":{"message":"${escapeJson(e.message ?: "Failed to open stream")}"}}"""))
            SafePromise(promise, TAG).reject("API_SERVER_STREAM_FAILED", e.message ?: "Failed to open stream", e)
        }
    }

    @ReactMethod
    fun streamChunk(requestId: String, chunk: String, promise: Promise) {
        val stream = streamStates[requestId]
        if (stream == null) {
            SafePromise(promise, TAG).resolve(false)
            return
        }

        try {
            stream.output.write(chunk.toByteArray(StandardCharsets.UTF_8))
            stream.output.flush()
            SafePromise(promise, TAG).resolve(true)
        } catch (e: IOException) {
            closeStream(requestId)
            SafePromise(promise, TAG).reject("API_SERVER_STREAM_WRITE_FAILED", e.message ?: "Failed to write stream chunk", e)
        }
    }

    @ReactMethod
    fun finishStream(requestId: String, promise: Promise) {
        closeStream(requestId)
        SafePromise(promise, TAG).resolve(true)
    }

    @ReactMethod
    fun failRequest(requestId: String, statusCode: Int, message: String, promise: Promise) {
        val body = """{"error":{"message":"${escapeJson(message)}"}}"""
        respondJson(requestId, statusCode, body, null, promise)
    }

    @ReactMethod
    fun addListener(eventName: String) {
        listenerCount.incrementAndGet()
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        listenerCount.set((listenerCount.get() - count).coerceAtLeast(0))
    }

    override fun invalidate() {
        super.invalidate()
        stopServerInternal()
    }

    private fun stopServerInternal() {
        try {
            lanServer?.stop()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to stop LAN API server cleanly", e)
        } finally {
            lanServer = null
        }

        try {
            localhostServer?.stop()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to stop localhost API server cleanly", e)
        } finally {
            localhostServer = null
        }

        pendingRequests.values.forEach { pending ->
            pending.future.complete(buildJsonResponse(503, """{"error":{"message":"Server stopped"}}"""))
        }
        pendingRequests.clear()

        streamStates.keys.forEach(::closeStream)
        streamStates.clear()
        serverStartedAtMs.set(0)
        stopKeepAliveService()
    }

    private fun closeStream(requestId: String) {
        val stream = streamStates.remove(requestId) ?: return
        try {
            stream.output.close()
        } catch (_: IOException) {
        }
        try {
            stream.input.close()
        } catch (_: IOException) {
        }
    }

    private fun buildStatusMap(): WritableMap {
        return Arguments.createMap().apply {
            putBoolean("isRunning", lanServer?.isAlive == true)
            putInt("port", configuredPort)
            putBoolean("listenerReady", listenerCount.get() > 0)
            putInt("pendingRequests", pendingRequests.size)
            putInt("activeStreams", streamStates.size)
            putDouble("uptimeMs", getUptimeMs().toDouble())
            putDouble("lastRequestAt", lastRequestAtMs.get().toDouble())
        }
    }

    private fun getUptimeMs(): Long {
        val started = serverStartedAtMs.get()
        if (started <= 0) return 0
        return System.currentTimeMillis() - started
    }

    private fun startKeepAliveService(port: Int) {
        try {
            val intent = Intent(reactContext, LocalApiServerForegroundService::class.java).apply {
                putExtra(LocalApiServerForegroundService.EXTRA_PORT, port)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactContext.startForegroundService(intent)
            } else {
                reactContext.startService(intent)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to start local API keepalive service", e)
        }
    }

    private fun stopKeepAliveService() {
        try {
            reactContext.stopService(Intent(reactContext, LocalApiServerForegroundService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "Failed to stop local API keepalive service", e)
        }
    }

    private fun emitRequestEvent(
        requestId: String,
        session: NanoHTTPD.IHTTPSession,
        body: String,
    ) {
        val payload = Arguments.createMap().apply {
            putString("requestId", requestId)
            putString("method", session.method.toString())
            putString("path", session.uri)
            putString("body", body)
            putMap("headers", mapToWritable(session.headers))
            putMap("query", listMapToWritable(session.parameters))
        }

        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_REQUEST, payload)
    }

    private fun mapToWritable(source: Map<String, String>): WritableMap {
        val map = Arguments.createMap()
        source.forEach { (key, value) -> map.putString(key, value) }
        return map
    }

    private fun listMapToWritable(source: Map<String, MutableList<String>>): WritableMap {
        val map = Arguments.createMap()
        source.forEach { (key, values) ->
            val array = Arguments.createArray()
            values.forEach { array.pushString(it) }
            map.putArray(key, array)
        }
        return map
    }

    private fun addCommonHeaders(response: NanoHTTPD.Response) {
        response.addHeader("Access-Control-Allow-Origin", "*")
        response.addHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key")
        response.addHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        response.addHeader("X-Offgrid-Api", "local")
    }

    private fun addHeaders(response: NanoHTTPD.Response, headers: ReadableMap?) {
        if (headers == null) return
        val iterator = headers.keySetIterator()
        while (iterator.hasNextKey()) {
            val key = iterator.nextKey()
            val value = headers.getString(key) ?: continue
            response.addHeader(key, value)
        }
    }

    private fun buildJsonResponse(statusCode: Int, body: String): NanoHTTPD.Response {
        val response = NanoHTTPD.newFixedLengthResponse(
            toStatus(statusCode),
            "application/json; charset=utf-8",
            body,
        )
        addCommonHeaders(response)
        return response
    }

    private fun escapeJson(value: String): String {
        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
    }

    private fun toStatus(statusCode: Int): NanoHTTPD.Response.Status {
        return when (statusCode) {
            200 -> NanoHTTPD.Response.Status.OK
            201 -> NanoHTTPD.Response.Status.CREATED
            202 -> NanoHTTPD.Response.Status.ACCEPTED
            204 -> NanoHTTPD.Response.Status.NO_CONTENT
            400 -> NanoHTTPD.Response.Status.BAD_REQUEST
            401 -> NanoHTTPD.Response.Status.UNAUTHORIZED
            403 -> NanoHTTPD.Response.Status.FORBIDDEN
            404 -> NanoHTTPD.Response.Status.NOT_FOUND
            405 -> NanoHTTPD.Response.Status.METHOD_NOT_ALLOWED
            409 -> NanoHTTPD.Response.Status.CONFLICT
            422 -> NanoHTTPD.Response.Status.BAD_REQUEST
            429 -> NanoHTTPD.Response.Status.SERVICE_UNAVAILABLE
            500 -> NanoHTTPD.Response.Status.INTERNAL_ERROR
            501 -> NanoHTTPD.Response.Status.NOT_IMPLEMENTED
            503 -> NanoHTTPD.Response.Status.SERVICE_UNAVAILABLE
            504 -> NanoHTTPD.Response.Status.SERVICE_UNAVAILABLE
            else -> NanoHTTPD.Response.Status.INTERNAL_ERROR
        }
    }

    private inner class BridgeHttpServer(hostname: String, port: Int) : NanoHTTPD(hostname, port) {
        override fun serve(session: IHTTPSession): Response {
            lastRequestAtMs.set(System.currentTimeMillis())

            if (session.method == Method.OPTIONS) {
                return NanoHTTPD.newFixedLengthResponse(toStatus(204), "text/plain", "").also {
                    addCommonHeaders(it)
                }
            }

            if (session.uri == "/health") {
                return buildJsonResponse(
                    200,
                    """{"ok":true,"port":$configuredPort,"listenerReady":${listenerCount.get() > 0},"jsReady":${reactContext.hasActiveCatalystInstance()},"pendingRequests":${pendingRequests.size},"maxPendingRequests":$MAX_PENDING_REQUESTS,"activeStreams":${streamStates.size},"apiKeyConfigured":${configuredApiKey.isNotBlank()},"uptimeMs":${getUptimeMs()},"lastRequestAt":${lastRequestAtMs.get()}}""",
                )
            }

            if (!isAuthorized(session)) {
                return buildJsonResponse(401, """{"error":{"message":"Missing or invalid API key"}}""")
            }

            if (!reactContext.hasActiveCatalystInstance() || listenerCount.get() <= 0) {
                return buildJsonResponse(503, """{"error":{"message":"JS bridge is not ready"}}""")
            }

            if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
                return buildJsonResponse(
                    429,
                    """{"error":{"message":"Local API server is overloaded","status":429},"pendingRequests":${pendingRequests.size},"maxPendingRequests":$MAX_PENDING_REQUESTS}""",
                ).also {
                    it.addHeader("Retry-After", "5")
                }
            }

            val body = readBody(session) ?: return buildJsonResponse(
                400,
                """{"error":{"message":"Failed to parse request body"}}""",
            )

            val requestId = UUID.randomUUID().toString()
            val pending = PendingRequest(requestId, CompletableFuture())
            pendingRequests[requestId] = pending

            return try {
                emitRequestEvent(requestId, session, body)
                pending.future.get(RESPONSE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            } catch (_: TimeoutException) {
                pendingRequests.remove(requestId)
                buildJsonResponse(504, """{"error":{"message":"Timed out waiting for JS handler"}}""")
            } catch (e: Exception) {
                pendingRequests.remove(requestId)
                Log.e(TAG, "Failed to dispatch request to JS", e)
                buildJsonResponse(500, """{"error":{"message":"${escapeJson(e.message ?: "Internal bridge error")}"}}""")
            }
        }

        private fun readBody(session: IHTTPSession): String? {
            if (session.method != Method.POST && session.method != Method.PUT && session.method != Method.PATCH) {
                return ""
            }

            return try {
                val files = HashMap<String, String>()
                session.parseBody(files)
                files["postData"] ?: ""
            } catch (e: Exception) {
                Log.w(TAG, "Failed to parse request body", e)
                null
            }
        }

        private fun isAuthorized(session: IHTTPSession): Boolean {
            if (configuredApiKey.isBlank()) return true

            val authHeader = session.headers["authorization"]?.trim()
            val xApiKey = session.headers["x-api-key"]?.trim()
            return authHeader == "Bearer $configuredApiKey" || xApiKey == configuredApiKey
        }
    }
}
