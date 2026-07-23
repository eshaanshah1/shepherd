package com.eshaan.shepherd.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.PromptQuestion
import com.eshaan.shepherd.terminal.PromptKeystrokes
import com.eshaan.shepherd.ui.components.OptionCard
import com.eshaan.shepherd.ui.components.PrimaryButton
import com.eshaan.shepherd.ui.theme.ShepherdPalette

/** Pure: turn per-question selected-option-index sets into per-question keystroke lists. */
fun answerSteps(questions: List<PromptQuestion>, selections: Map<Int, Set<Int>>): List<List<ByteArray>> =
    PromptKeystrokes.askUserQuestion(questions, questions.indices.map { (selections[it] ?: emptySet()).toList() })

/**
 * Tappable answers for a blocked agent, shown in place of the terminal. AskUserQuestion is fully
 * handled (single-select, multi-select, mixed multi-question); a lone single-select submits on one
 * tap. Permission/plan currently defer to the terminal (their keystrokes are pinned in a later
 * slice). A "Use terminal" button always drops to the raw terminal.
 *
 * After submitting, the answers are sent one question at a time (paced), so we show a "sending"
 * spinner until the agent advances and the panel is dismissed (the pane leaves the blocked state).
 */
@Composable
fun PromptPanel(prompt: ControlMessage.Prompt, onAnswer: (List<List<ByteArray>>) -> Unit, onUseTerminal: () -> Unit) {
    var submitting by remember(prompt) { mutableStateOf(false) }
    Column(
        Modifier.fillMaxSize().background(Color(ShepherdPalette.ground)).padding(16.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (submitting) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                .background(Color(ShepherdPalette.surface1)).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = Color(0xFF5B9DF8))
                    Text("Sending your answers…", color = Color(ShepherdPalette.textPrimary),
                        style = MaterialTheme.typography.titleMedium)
                }
                Text("Sent one question at a time — this takes a few seconds.",
                    color = Color(ShepherdPalette.textDim), style = MaterialTheme.typography.bodySmall)
            }
            TextButton(onClick = onUseTerminal) { Text("Use terminal instead") }
            return@Column
        }

        if (prompt.kind == "askUserQuestion") {
            val questions = prompt.questions ?: emptyList()
            val loneSingle = questions.size == 1 && !questions[0].multiSelect
            val selections = remember(prompt) { mutableStateMapOf<Int, Set<Int>>() }
            val submit = { sel: Map<Int, Set<Int>> -> submitting = true; onAnswer(answerSteps(questions, sel)) }

            questions.forEachIndexed { qi, q ->
                Text(q.prompt, style = MaterialTheme.typography.titleMedium, color = Color(ShepherdPalette.textPrimary))
                q.options.forEachIndexed { oi, label ->
                    val checked = selections[qi]?.contains(oi) == true
                    OptionCard(label, checked, q.multiSelect) {
                        if (loneSingle) submit(mapOf(qi to setOf(oi)))
                        else if (q.multiSelect) {
                            val cur = selections[qi] ?: emptySet()
                            selections[qi] = if (checked) cur - oi else cur + oi
                        } else selections[qi] = setOf(oi)
                    }
                }
                Spacer(Modifier.height(4.dp))
            }
            if (!loneSingle) PrimaryButton("Submit", { submit(selections.toMap()) }, Modifier.fillMaxWidth())
        } else {
            val title = if (prompt.kind == "permission") "Permission: ${prompt.detail ?: ""}" else "Plan approval"
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                .background(Color(ShepherdPalette.surface1)).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = Color(ShepherdPalette.textPrimary))
                Text("Answer in the terminal.", color = Color(ShepherdPalette.textDim),
                    style = MaterialTheme.typography.bodyMedium)
            }
        }
        TextButton(onClick = onUseTerminal) { Text("Use terminal instead") }
    }
}
