package com.eshaan.shepherd.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.PromptQuestion
import com.eshaan.shepherd.terminal.PromptKeystrokes

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
        Modifier.fillMaxSize().background(Color.Black).padding(16.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (submitting) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                CircularProgressIndicator(Modifier.size(22.dp))
                Text("Sending your answers…", color = Color.White, style = MaterialTheme.typography.titleMedium)
            }
            Text("Sent one question at a time — this takes a few seconds.", color = Color.Gray,
                style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = onUseTerminal) { Text("Use terminal instead") }
            return@Column
        }

        if (prompt.kind == "askUserQuestion") {
            val questions = prompt.questions ?: emptyList()
            val loneSingle = questions.size == 1 && !questions[0].multiSelect
            val selections = remember(prompt) { mutableStateMapOf<Int, Set<Int>>() }
            val submit = { sel: Map<Int, Set<Int>> -> submitting = true; onAnswer(answerSteps(questions, sel)) }

            questions.forEachIndexed { qi, q ->
                Text(q.prompt, style = MaterialTheme.typography.titleMedium, color = Color.White)
                q.options.forEachIndexed { oi, label ->
                    val checked = selections[qi]?.contains(oi) == true
                    if (loneSingle) {
                        Button(onClick = { submit(mapOf(qi to setOf(oi))) }, modifier = Modifier.fillMaxWidth()) { Text(label) }
                    } else {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            if (q.multiSelect) {
                                Checkbox(checked = checked, onCheckedChange = { on ->
                                    val cur = selections[qi] ?: emptySet()
                                    selections[qi] = if (on) cur + oi else cur - oi
                                })
                            } else {
                                RadioButton(selected = checked, onClick = { selections[qi] = setOf(oi) })
                            }
                            Text(label, color = Color.White)
                        }
                    }
                }
                Spacer(Modifier.height(4.dp))
            }
            if (!loneSingle) {
                Button(onClick = { submit(selections.toMap()) }, modifier = Modifier.fillMaxWidth()) { Text("Submit") }
            }
        } else {
            val title = if (prompt.kind == "permission") "Permission: ${prompt.detail ?: ""}" else "Plan approval"
            Text(title, style = MaterialTheme.typography.titleMedium, color = Color.White)
            Text("Answer in the terminal.", color = Color.Gray)
        }
        TextButton(onClick = onUseTerminal) { Text("Use terminal instead") }
    }
}
