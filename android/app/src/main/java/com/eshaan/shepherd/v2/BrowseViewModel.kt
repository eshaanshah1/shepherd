package com.eshaan.shepherd.v2

import com.eshaan.shepherd.util.SLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

/**
 * Browsing the Mac: what views it offers, what rows they hold, and what a tap does.
 *
 * The whole file is domain-blind on purpose. It never says "task" — it lists
 * whatever views the Mac contributes and renders whatever rows they return, so
 * a `projects` extension nobody has written yet already works here.
 *
 * A tap is three steps and the middle one is the interesting one:
 *
 *   1. invoke the row's declared command (the extension's, not ours);
 *   2. read what came back for a `present` effect;
 *   3. if it names a session, open a terminal on it.
 *
 * Step 2 is what stops this from becoming "if the id looks like tasks.reveal,
 * attach" — which would be hardcoding `tasks` in the client after carefully not
 * hardcoding it anywhere else.
 */
class BrowseViewModel(
    private val link: HostLink,
    private val scope: CoroutineScope,
) {
    data class State(
        val views: List<ViewSummary> = emptyList(),
        val selected: String? = null,
        val rows: List<Row> = emptyList(),
        val loading: Boolean = false,
        /** Set when a tap asked for a terminal. The UI navigates and clears it. */
        val openSession: String? = null,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    private val json = Json { ignoreUnknownKeys = true }
    private val pending = ConcurrentHashMap<Int, (Result<JsonObject>) -> Unit>()

    init {
        scope.launch {
            link.frames.collect { frame ->
                when (frame.kind) {
                    Frames.CONTROL_RESULT -> complete(frame)
                    // The Mac says a view's rows changed. It sends the HINT and
                    // not the rows: pushing them would mean the host deciding
                    // what this client currently has on screen, which it cannot
                    // know and would be wrong about after any reconnect.
                    Frames.CONTROL_CHANGED -> {
                        val type = frame.text?.let {
                            json.parseToJsonElement(it).jsonObject["viewType"]?.jsonPrimitive?.content
                        }
                        if (type != null && type == _state.value.selected) refresh()
                    }
                }
            }
        }
    }

    private fun complete(frame: Frames.Frame) {
        val body = frame.text?.let { json.parseToJsonElement(it).jsonObject } ?: return
        val seq = body["seq"]?.jsonPrimitive?.content?.toIntOrNull() ?: return
        val waiter = pending.remove(seq) ?: return
        val ok = body["ok"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false
        if (ok) {
            waiter(Result.success(body))
        } else {
            val message = (body["error"] as? JsonObject)?.get("message")?.jsonPrimitive?.content
            waiter(Result.failure(IllegalStateException(message ?: "the Mac refused it")))
        }
    }

    private suspend fun invoke(command: String, args: JsonObject?): Result<JsonObject> =
        suspendCoroutine { continuation ->
            val seq = link.nextSeq()
            pending[seq] = { continuation.resume(it) }
            link.invoke(seq, command, args)
        }

    /** Everything the Mac offers that this phone can draw. */
    fun loadViews() {
        scope.launch {
            _state.value = _state.value.copy(loading = true, error = null)
            invoke("views.list", null)
                .onSuccess { body ->
                    val all = Views.parseSummaries(body["value"] as? JsonObject)
                    // A `component` view is React the desktop mounts in-proc.
                    // Listed by the Mac, filtered HERE, because the client is
                    // what knows what it can draw.
                    val drawable = all.filter { it.drawable }
                    _state.value = _state.value.copy(
                        views = drawable,
                        selected = _state.value.selected ?: drawable.firstOrNull()?.type,
                        loading = false,
                    )
                    SLog.i(SLog.VM, "views: ${all.size} offered, ${drawable.size} drawable here")
                    refresh()
                }
                .onFailure { _state.value = _state.value.copy(loading = false, error = it.message) }
        }
    }

    fun select(type: String) {
        _state.value = _state.value.copy(selected = type, rows = emptyList())
        refresh()
    }

    /** The rows of the selected view. */
    fun refresh() {
        val type = _state.value.selected ?: return
        scope.launch {
            invoke("views.children", buildJsonObject { put("type", type) })
                .onSuccess {
                    _state.value = _state.value.copy(rows = Views.parseRows(it["value"]), error = null)
                }
                .onFailure { _state.value = _state.value.copy(error = it.message) }
        }
    }

    /**
     * A row was tapped.
     *
     * The command is the EXTENSION's — this phone does not know or care what it
     * does. What it reads back is the `present` effect, which is the only thing
     * here that is about being a phone.
     */
    fun tap(row: Row) {
        val command = row.command ?: return
        scope.launch {
            invoke(command.id, command.args)
                .onSuccess { body ->
                    when (val present = Views.parsePresent(body["value"])) {
                        is Present.Session -> {
                            SLog.i(SLog.VM, "row ${row.id} -> session ${present.sessionId.take(8)}")
                            _state.value = _state.value.copy(openSession = present.sessionId)
                        }
                        is Present.View -> select(present.viewType)
                        // Nothing to show: the verb did something (archived,
                        // renamed) or the thing has no terminal. Refreshing is
                        // the honest response — something probably changed.
                        else -> refresh()
                    }
                }
                .onFailure { _state.value = _state.value.copy(error = it.message) }
        }
    }

    /** A long-press menu entry. Same path as a tap; it is a command either way. */
    fun run(action: Action) {
        scope.launch {
            invoke(action.id, action.args)
                .onSuccess { refresh() }
                .onFailure { _state.value = _state.value.copy(error = it.message) }
        }
    }

    fun openedSession() {
        _state.value = _state.value.copy(openSession = null)
    }
}
