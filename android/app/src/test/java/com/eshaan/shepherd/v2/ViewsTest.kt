package com.eshaan.shepherd.v2

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parsing what the Mac sends.
 *
 * Every case here is a version-skew case, because that is what this parser is
 * for: the rows come from an extension this phone has never heard of, across a
 * wire, from a Mac that may be newer. A missing field is skew rather than a
 * fault, so the rule throughout is "render less, never refuse".
 */
class ViewsTest {
    private val json = Json { ignoreUnknownKeys = true }
    private fun obj(text: String): JsonObject = json.parseToJsonElement(text).jsonObject

    @Test
    fun `lists the views the Mac offers`() {
        val summaries = Views.parseSummaries(
            obj("""{"views":[{"type":"tasks.tree","title":"Tasks","kind":"tree"},
                             {"type":"tasks.composer","title":"New","kind":"component"}]}"""),
        )
        assertEquals(2, summaries.size)
        // The phone decides what it can draw; the Mac reports rather than filters.
        assertTrue(summaries[0].drawable)
        assertTrue(!summaries[1].drawable)
    }

    @Test
    fun `falls back to the type when a view has no title`() {
        val summaries = Views.parseSummaries(obj("""{"views":[{"type":"x.tree"}]}"""))
        assertEquals("x.tree", summaries[0].title)
        // An absent kind is a tree, because that is what every contributed view
        // was before `component` existed — an older Mac must still list.
        assertTrue(summaries[0].drawable)
    }

    @Test
    fun `parses a row with everything on it`() {
        val rows = Views.parseRows(
            json.parseToJsonElement(
                """[{"id":"t1","label":"Ship remote","description":"2 repos","tint":"accent",
                     "busy":true,"icon":"git-branch",
                     "command":{"id":"tasks.reveal","args":{"task":"t1"}},
                     "actions":[{"id":"tasks.archive","label":"Archive"}]}]""",
            ),
        )
        val row = rows.single()
        assertEquals("Ship remote", row.label)
        assertEquals("2 repos", row.description)
        // A token NAME and a glyph NAME — never a colour, never an SVG. This is
        // the property that let a desktop-shaped row type serve a phone at all.
        assertEquals("accent", row.tint)
        assertEquals("git-branch", row.icon)
        assertTrue(row.busy)
        assertEquals("tasks.reveal", row.command?.id)
        assertEquals("tasks.archive", row.actions.single().id)
    }

    @Test
    fun `renders a row that carries almost nothing`() {
        val rows = Views.parseRows(json.parseToJsonElement("""[{"id":"bare"}]"""))
        val row = rows.single()
        // Label falls back to the id rather than the row vanishing: a row you
        // cannot name is still a row you can see is there.
        assertEquals("bare", row.label)
        assertNull(row.command)
        assertTrue(row.actions.isEmpty())
    }

    @Test
    fun `keeps a heading as a heading`() {
        val rows = Views.parseRows(json.parseToJsonElement("""[{"id":"h","label":"ACTIVE","section":true}]"""))
        // Not tappable, and the phone must not draw it as a row that does nothing.
        assertTrue(rows.single().section)
    }

    @Test
    fun `drops separators rather than drawing dead menu entries`() {
        val rows = Views.parseRows(
            json.parseToJsonElement(
                """[{"id":"r","actions":[{"id":"a","label":"A"},{"separator":true},{"id":"b","label":"B"}]}]""",
            ),
        )
        assertEquals(listOf("a", "b"), rows.single().actions.map { it.id })
    }

    @Test
    fun `skips entries it cannot identify instead of failing the whole list`() {
        val rows = Views.parseRows(
            json.parseToJsonElement("""[{"label":"no id"},{"id":"good","label":"Good"},"nonsense",null]"""),
        )
        // One bad row must not cost the user the other nine.
        assertEquals(listOf("good"), rows.map { it.id })
    }

    @Test
    fun `reads the present effect a verb returned`() {
        val present = Views.parsePresent(
            json.parseToJsonElement("""{"id":"t1","present":{"kind":"session","sessionId":"abc"}}"""),
        )
        assertEquals(Present.Session("abc"), present)
    }

    @Test
    fun `has no effect when a verb presented nothing`() {
        assertNull(Views.parsePresent(json.parseToJsonElement("""{"id":"t1"}""")))
    }

    /**
     * A Mac newer than this phone can name an effect this build has never heard
     * of. Ignoring it and staying put is a worse experience than understanding
     * it and a much better one than a refusal.
     */
    @Test
    fun `tolerates an effect kind it does not know`() {
        val present = Views.parsePresent(json.parseToJsonElement("""{"present":{"kind":"hologram"}}"""))
        assertEquals(Present.Unknown, present)
    }

    @Test
    fun `ignores an unknown field rather than refusing the row`() {
        val rows = Views.parseRows(
            json.parseToJsonElement("""[{"id":"r","label":"R","somethingNewer":{"deep":1}}]"""),
        )
        assertEquals("R", rows.single().label)
    }
}
