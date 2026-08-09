package com.eshaan.shepherd.v2

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * What the Mac shows, as this phone understands it.
 *
 * **There is no task in here, and that is the whole design.** `tasks` is only one
 * way sessions get organized; somebody could write `projects`, or
 * `pull-requests`, and a phone that hardcoded "list tasks" would need a release
 * for each. So the phone renders *contributed views* — the same ones the Mac's
 * sidebar draws — and a new extension appears here with no phone change at all.
 *
 * The row vocabulary is the host's `TreeItem`, and it was already renderer-
 * agnostic before this client existed: `tint` is a design-token NAME and never a
 * colour, `icon` is a glyph NAME and never an SVG, and a row's verbs are
 * declared by the extension because "the shell cannot know the verbs". A phone
 * is another shell. Every one of those decisions is what lets this file be short.
 *
 * Parsing is defensive throughout: this arrives from an extension the phone has
 * never heard of, across a wire, and a missing field is a version skew rather
 * than a fault. Unknown fields are ignored and absent ones get defaults, so an
 * older phone renders a newer Mac's rows with less detail instead of refusing.
 */

/** One contributed view the Mac offers. */
data class ViewSummary(
    val type: String,
    val title: String,
    /**
     * `tree` rows this phone can draw; `component` is React the desktop mounts
     * in-proc and the phone cannot run.
     *
     * Reported by the host rather than filtered there, so the CLIENT decides
     * what it can draw. The alternative — a `remoteCapable` flag on the host —
     * would be an extension point invented before anything misbehaved.
     */
    val kind: String,
) {
    val drawable: Boolean get() = kind == "tree"
}

/** One row. Mirrors the host's `TreeItem`, minus what a phone cannot use. */
data class Row(
    val id: String,
    val label: String,
    val description: String? = null,
    /** A heading rather than a row: not tappable, drawn as a micro-label. */
    val section: Boolean = false,
    /** A design-token name. The phone maps it to its own palette. */
    val tint: String? = null,
    /** Something is happening to this row's subject right now. */
    val busy: Boolean = false,
    val icon: String? = null,
    /** What tapping it runs, if anything. */
    val command: Command? = null,
    /** Its long-press menu, declared by the extension that drew it. */
    val actions: List<Action> = emptyList(),
)

data class Command(val id: String, val args: JsonObject? = null)
data class Action(val id: String, val label: String, val args: JsonObject? = null)

/**
 * What a verb asked to be SHOWN.
 *
 * The piece without which none of this works. A row's command runs host-side,
 * and on the Mac it opens a layout pane — a gesture that means nothing here. A
 * phone that recovered the intent by matching command ids (`if id ==
 * "tasks.reveal"`) would have hardcoded `tasks` after all, through the client
 * instead of the shell. So the verb NAMES what it wanted presented, and this
 * phone decides that "a session" means "push a terminal and attach".
 *
 * Unknown kinds are ignored rather than refused: the Mac may be newer than the
 * phone, and showing what you already had beats an error.
 */
sealed interface Present {
    data class Session(val sessionId: String) : Present
    data class View(val viewType: String) : Present
    data object Unknown : Present
}

object Views {
    private val json = Json { ignoreUnknownKeys = true }

    fun parseSummaries(value: JsonObject?): List<ViewSummary> {
        val list = value?.get("views") as? JsonArray ?: return emptyList()
        return list.mapNotNull { entry ->
            val obj = entry as? JsonObject ?: return@mapNotNull null
            val type = obj["type"]?.jsonPrimitive?.contentOrNull() ?: return@mapNotNull null
            ViewSummary(
                type = type,
                title = obj["title"]?.jsonPrimitive?.contentOrNull() ?: type,
                kind = obj["kind"]?.jsonPrimitive?.contentOrNull() ?: "tree",
            )
        }
    }

    fun parseRows(value: kotlinx.serialization.json.JsonElement?): List<Row> {
        val list = value as? JsonArray ?: return emptyList()
        return list.mapNotNull { entry ->
            val obj = entry as? JsonObject ?: return@mapNotNull null
            val id = obj["id"]?.jsonPrimitive?.contentOrNull() ?: return@mapNotNull null
            Row(
                id = id,
                label = obj["label"]?.jsonPrimitive?.contentOrNull() ?: id,
                description = obj["description"]?.jsonPrimitive?.contentOrNull(),
                section = obj["section"]?.jsonPrimitive?.booleanOrNull() ?: false,
                tint = obj["tint"]?.jsonPrimitive?.contentOrNull(),
                busy = obj["busy"]?.jsonPrimitive?.booleanOrNull() ?: false,
                icon = obj["icon"]?.jsonPrimitive?.contentOrNull(),
                command = (obj["command"] as? JsonObject)?.let { command ->
                    command["id"]?.jsonPrimitive?.contentOrNull()?.let { id ->
                        Command(id, command["args"] as? JsonObject)
                    }
                },
                actions = (obj["actions"] as? JsonArray).orEmptyList().mapNotNull { action ->
                    val a = action as? JsonObject ?: return@mapNotNull null
                    // A separator is a drawing instruction, not a verb; skipped
                    // rather than rendered as a menu entry that does nothing.
                    if (a["separator"]?.jsonPrimitive?.booleanOrNull() == true) return@mapNotNull null
                    val actionId = a["id"]?.jsonPrimitive?.contentOrNull() ?: return@mapNotNull null
                    Action(
                        id = actionId,
                        label = a["label"]?.jsonPrimitive?.contentOrNull() ?: actionId,
                        args = a["args"] as? JsonObject,
                    )
                },
            )
        }
    }

    fun parsePresent(value: kotlinx.serialization.json.JsonElement?): Present? {
        val present = (value as? JsonObject)?.get("present") as? JsonObject ?: return null
        return when (present["kind"]?.jsonPrimitive?.contentOrNull()) {
            "session" -> present["sessionId"]?.jsonPrimitive?.contentOrNull()?.let { Present.Session(it) }
            "view" -> present["viewType"]?.jsonPrimitive?.contentOrNull()?.let { Present.View(it) }
            else -> Present.Unknown
        }
    }

    private fun JsonArray?.orEmptyList(): List<kotlinx.serialization.json.JsonElement> = this ?: emptyList()

    private fun kotlinx.serialization.json.JsonPrimitive.contentOrNull(): String? =
        runCatching { content }.getOrNull()?.takeIf { it.isNotEmpty() && it != "null" }

    private fun kotlinx.serialization.json.JsonPrimitive.booleanOrNull(): Boolean? =
        runCatching { content.toBooleanStrictOrNull() }.getOrNull()
}
