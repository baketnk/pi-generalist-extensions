import { DynamicBorder, type ExtensionAPI, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Editor, type EditorTheme, type Focusable, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export interface QuestionOption { label: string; description?: string }
export interface UserQuestion { id: string; title: string; options?: QuestionOption[] }
export interface QuestionAnswer { id: string; title: string; answer: string }
export interface QuestionBatch { id: number; questions: UserQuestion[] }
export interface QuestionQueueState { nextId: number; pending: QuestionBatch[] }

export const QUESTION_STATE_ENTRY = "generalist:questions:state-v1";
const MAX_QUESTIONS = 3;
const MAX_PENDING_BATCHES = 20;

const OptionSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 200, description: "Short suggested answer." }),
  description: Type.Optional(Type.String({ maxLength: 500, description: "Brief tradeoff or consequence." })),
}, { additionalProperties: false });

const QuestionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$", description: "Stable identifier used to map the answer." }),
  title: Type.String({ minLength: 1, maxLength: 1000, description: "Self-contained question shown to the user." }),
  options: Type.Optional(Type.Array(OptionSchema, { minItems: 1, maxItems: 5, description: "Suggested mutually exclusive answers. Free text is always available." })),
}, { additionalProperties: false });

const AskSchema = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS }),
}, { additionalProperties: false });

function copyQuestions(questions: UserQuestion[]): UserQuestion[] {
  return questions.map(question => ({
    id: question.id,
    title: question.title,
    options: question.options?.map(option => ({ ...option })),
  }));
}

function copyState(state: QuestionQueueState): QuestionQueueState {
  return { nextId: state.nextId, pending: state.pending.map(batch => ({ id: batch.id, questions: copyQuestions(batch.questions) })) };
}

export function validateQuestions(input: UserQuestion[]): UserQuestion[] {
  const seen = new Set<string>();
  return input.map(question => {
    const id = question.id.trim();
    const title = question.title.trim();
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Question IDs must contain only letters, numbers, _ or -.");
    if (seen.has(id)) throw new Error(`Duplicate question ID: ${id}`);
    if (!title) throw new Error(`Question ${id} has an empty title.`);
    seen.add(id);
    const options = question.options?.map(option => ({ label: option.label.trim(), description: option.description?.trim() || undefined }));
    if (options?.some(option => !option.label)) throw new Error(`Question ${id} has an empty option.`);
    return { id, title, options };
  });
}

function stateFromDetails(details: unknown): QuestionQueueState | undefined {
  if (!details || typeof details !== "object") return;
  const raw = (details as { state?: unknown }).state ?? details;
  if (!raw || typeof raw !== "object") return;
  const candidate = raw as QuestionQueueState;
  if (!Number.isInteger(candidate.nextId) || candidate.nextId < 1 || !Array.isArray(candidate.pending)) return;
  try {
    return {
      nextId: candidate.nextId,
      pending: candidate.pending.map(batch => {
        if (!Number.isInteger(batch.id) || batch.id < 1 || !Array.isArray(batch.questions)) throw new Error();
        return { id: batch.id, questions: validateQuestions(batch.questions) };
      }),
    };
  } catch { return; }
}

export class QuestionOverlay implements Focusable {
  private container = new Container();
  private editor: Editor;
  private list?: SelectList;
  private index = 0;
  private answers: QuestionAnswer[] = [];
  private textMode = false;
  private _focused = false;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private keys: KeybindingsManager,
    private questions: UserQuestion[],
    private done: (answers: QuestionAnswer[] | undefined) => void,
    private batchId?: number,
  ) {
    const editorTheme: EditorTheme = {
      borderColor: text => theme.fg("borderAccent", text),
      selectList: {
        selectedPrefix: text => theme.fg("accent", text),
        selectedText: text => theme.fg("accent", text),
        description: text => theme.fg("muted", text),
        scrollInfo: text => theme.fg("dim", text),
        noMatch: text => theme.fg("warning", text),
      },
    };
    this.editor = new Editor(tui, editorTheme, { paddingX: 1 });
    this.editor.onSubmit = value => {
      const answer = value.trim();
      if (answer) this.accept(answer);
    };
    this.prepareQuestion();
  }

  get focused() { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value && this.textMode;
  }

  private current() { return this.questions[this.index]!; }

  private accept(answer: string) {
    const question = this.current();
    this.answers.push({ id: question.id, title: question.title, answer });
    if (++this.index >= this.questions.length) {
      this.done(this.answers);
      return;
    }
    this.prepareQuestion();
    this.tui.requestRender();
  }

  private enterTextMode() {
    this.textMode = true;
    this.editor.focused = this._focused;
    this.rebuild();
    this.tui.requestRender();
  }

  private prepareQuestion() {
    const question = this.current();
    this.editor.setText("");
    this.textMode = !question.options?.length;
    this.editor.focused = this._focused && this.textMode;
    if (question.options?.length) {
      const items: SelectItem[] = question.options.map((option, index) => ({
        value: String(index), label: option.label, description: option.description,
      }));
      items.push({ value: "other", label: "Write another answer…" });
      this.list = new SelectList(items, items.length, {
        selectedPrefix: text => this.theme.fg("accent", text),
        selectedText: text => this.theme.fg("accent", text),
        description: text => this.theme.fg("muted", text),
        scrollInfo: text => this.theme.fg("dim", text),
        noMatch: text => this.theme.fg("warning", text),
      });
      this.list.onSelect = item => {
        if (item.value === "other") this.enterTextMode();
        else this.accept(question.options![Number(item.value)]!.label);
      };
      this.list.onCancel = () => this.done(undefined);
    } else this.list = undefined;
    this.rebuild();
  }

  private rebuild() {
    const question = this.current();
    this.container.clear();
    this.container.addChild(new DynamicBorder((text: string) => this.theme.fg("borderMuted", text)));
    const batch = this.batchId === undefined ? "Questions" : `Questions · batch ${this.batchId}`;
    this.container.addChild(new Text(
      `${this.theme.fg("accent", this.theme.bold(batch))}${this.theme.fg("dim", `  ${this.index + 1}/${this.questions.length}`)}`,
      1, 0,
    ));
    this.container.addChild(new Text(this.theme.fg("text", question.title), 1, 1));
    if (this.textMode) this.container.addChild(this.editor);
    else if (this.list) this.container.addChild(this.list);
    const hint = this.textMode && question.options?.length
      ? "Enter submit · Esc choices"
      : this.textMode ? "Enter submit · Esc keep pending" : "↑↓ choose · Enter select · Esc keep pending";
    this.container.addChild(new Text(this.theme.fg("dim", hint), 1, 0));
    this.container.addChild(new DynamicBorder((text: string) => this.theme.fg("borderMuted", text)));
  }

  handleInput(data: string) {
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.textMode && this.current().options?.length) {
        this.textMode = false;
        this.editor.focused = false;
        this.rebuild();
        this.tui.requestRender();
      } else this.done(undefined);
      return;
    }
    if (!this.textMode && /^[1-6]$/.test(data)) {
      const requested = Number(data) - 1;
      const count = (this.current().options?.length ?? 0) + 1;
      if (requested < count) {
        this.list?.setSelectedIndex(requested);
        const selected = this.list?.getSelectedItem();
        if (selected) this.list?.onSelect?.(selected);
      }
      return;
    }
    if (this.textMode) this.editor.handleInput(data);
    else this.list?.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number) { return this.container.render(Math.max(1, width)); }
  invalidate() { this.container.invalidate(); }
}

async function collectAnswers(ctx: ExtensionContext, questions: UserQuestion[], batchId?: number): Promise<QuestionAnswer[] | undefined> {
  if (!ctx.hasUI) return;
  if (ctx.mode === "tui") {
    return ctx.ui.custom<QuestionAnswer[] | undefined>(
      (tui, theme, keys, done) => new QuestionOverlay(tui, theme, keys, questions, done, batchId),
      { overlay: true, overlayOptions: { anchor: "right-center", width: "72%", minWidth: 36, maxHeight: "75%", margin: 2 } },
    );
  }
  const answers: QuestionAnswer[] = [];
  for (const question of questions) {
    let answer: string | undefined;
    if (question.options?.length) {
      const choices = question.options.map((option, index) => {
        const description = option.description ? ` — ${option.description}` : "";
        return `${index + 1}. ${option.label}${description}`;
      });
      const custom = "Write another answer…";
      const selected = await ctx.ui.select(question.title, [...choices, custom]);
      if (selected === undefined) return;
      if (selected === custom) answer = await ctx.ui.input(question.title, "Type your answer");
      else answer = question.options[choices.indexOf(selected)]?.label;
    } else answer = await ctx.ui.input(question.title, "Type your answer");
    if (answer === undefined) return;
    answers.push({ id: question.id, title: question.title, answer: answer.trim() || "(no response)" });
  }
  return answers;
}

function answerText(answers: QuestionAnswer[], batchId?: number): string {
  const heading = batchId === undefined ? "User answers:" : `Answers to queued questions (batch ${batchId}):`;
  return `${heading}\n${answers.map(answer => `- [${answer.id}] ${answer.title}\n  Answer: ${answer.answer}`).join("\n")}`;
}

export default function questions(pi: ExtensionAPI) {
  let state: QuestionQueueState = { nextId: 1, pending: [] };
  let answering = false;

  const updateUi = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const questionCount = state.pending.reduce((sum, batch) => sum + batch.questions.length, 0);
    ctx.ui.setStatus("generalist-questions", questionCount ? `questions: ${questionCount}` : undefined);
    if (!questionCount) {
      ctx.ui.setWidget("generalist-questions", undefined);
      return;
    }
    const first = state.pending[0]!;
    const suffix = questionCount > 1 ? ` (+${questionCount - 1} more)` : "";
    ctx.ui.setWidget("generalist-questions", [
      ctx.ui.theme.fg("warning", `? ${first.questions[0]!.title}${suffix}`),
      ctx.ui.theme.fg("dim", "Ctrl+Shift+Q or /questions to answer"),
    ]);
  };

  const restore = (ctx: ExtensionContext) => {
    state = { nextId: 1, pending: [] };
    for (const entry of ctx.sessionManager.getBranch()) {
      let restored: QuestionQueueState | undefined;
      if (entry.type === "custom" && entry.customType === QUESTION_STATE_ENTRY) restored = stateFromDetails(entry.data);
      else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "queue_questions") restored = stateFromDetails(entry.message.details);
      if (restored) state = restored;
    }
    updateUi(ctx);
  };

  const saveCommandState = (ctx: ExtensionContext) => {
    pi.appendEntry(QUESTION_STATE_ENTRY, copyState(state));
    updateUi(ctx);
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  const answerQueued = async (ctx: ExtensionContext, chooseBatch: boolean) => {
    if (answering) {
      ctx.ui.notify("The question panel is already open.", "info");
      return;
    }
    if (!state.pending.length) {
      if (ctx.hasUI) ctx.ui.notify("No queued questions.", "info");
      return;
    }
    if (!ctx.hasUI) return;
    answering = true;
    try {
      let batch = state.pending[0]!;
      if (chooseBatch && state.pending.length > 1) {
        const labels = state.pending.map(item => `Batch ${item.id} · ${item.questions[0]!.title}`);
        const selected = await ctx.ui.select("Choose a queued question batch", labels);
        if (selected === undefined) return;
        const index = labels.indexOf(selected);
        if (index < 0) return;
        batch = state.pending[index]!;
      }
      const answers = await collectAnswers(ctx, batch.questions, batch.id);
      if (!answers) {
        ctx.ui.notify("Questions left in the queue.", "info");
        return;
      }
      const previous = copyState(state);
      state.pending = state.pending.filter(item => item.id !== batch.id);
      saveCommandState(ctx);
      try {
        const message = answerText(answers, batch.id);
        if (ctx.isIdle()) pi.sendUserMessage(message);
        else pi.sendUserMessage(message, { deliverAs: "steer" });
      } catch (error) {
        state = previous;
        saveCommandState(ctx);
        throw error;
      }
    } finally {
      answering = false;
    }
  };

  pi.registerShortcut("ctrl+shift+q", {
    description: "Answer the oldest queued user questions",
    handler: ctx => answerQueued(ctx, false),
  });

  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description: "Ask one to three blocking questions and wait for the user's answers. Each question may offer suggested answers; free text is always available. Use only when the answer is needed before work can continue.",
    promptSnippet: "Ask the user blocking clarification questions with choices or free text.",
    promptGuidelines: ["Use ask_user only when work cannot proceed responsibly without an immediate answer; prefer queue_questions when useful work can continue."],
    parameters: AskSchema,
    executionMode: "sequential",
    async execute(_call, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (!ctx.hasUI) throw new Error("ask_user requires interactive or RPC UI mode.");
      const normalized = validateQuestions(params.questions as UserQuestion[]);
      const answers = await collectAnswers(ctx, normalized);
      if (!answers) return { content: [{ type: "text", text: "User cancelled the questions." }], details: { cancelled: true, questions: normalized, answers: [] } };
      return { content: [{ type: "text", text: answerText(answers) }], details: { cancelled: false, questions: normalized, answers } };
    },
    renderCall(args, theme) {
      const count = Array.isArray(args.questions) ? args.questions.length : 0;
      return new Text(theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as { cancelled?: boolean; answers?: QuestionAnswer[] } | undefined;
      if (details?.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      const answers = details?.answers ?? [];
      return new Text(answers.map(answer => `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${answer.answer}`).join("\n"), 0, 0);
    },
  });

  pi.registerTool({
    name: "queue_questions",
    label: "Queue questions",
    description: `Queue one to three questions without waiting for answers, allowing work to continue. The user sees a pending indicator and answers later with /questions; answers arrive as a new user message that steers an active turn or starts a turn when idle. At most ${MAX_PENDING_BATCHES} unanswered batches may be queued.`,
    promptSnippet: "Queue non-blocking user questions whose answers can arrive in a later turn.",
    promptGuidelines: ["Use queue_questions for preferences, clarification, or approval that can be answered while other useful work continues; make every question self-contained."],
    parameters: AskSchema,
    executionMode: "sequential",
    async execute(_call, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (state.pending.length >= MAX_PENDING_BATCHES) throw new Error(`Question queue is full (${MAX_PENDING_BATCHES} batches).`);
      const batch: QuestionBatch = { id: state.nextId++, questions: validateQuestions(params.questions as UserQuestion[]) };
      state.pending.push(batch);
      updateUi(ctx);
      return {
        content: [{ type: "text", text: `Queued question batch ${batch.id} (${batch.questions.length} question${batch.questions.length === 1 ? "" : "s"}). Continue useful work; the answers will arrive as a user message when submitted.` }],
        details: { queuedBatchId: batch.id, state: copyState(state) },
      };
    },
    renderCall(args, theme) {
      const count = Array.isArray(args.questions) ? args.questions.length : 0;
      return new Text(theme.fg("toolTitle", theme.bold("queue_questions ")) + theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const id = (result.details as { queuedBatchId?: number } | undefined)?.queuedBatchId;
      return new Text(theme.fg("success", `✓ Queued${id ? ` batch ${id}` : ""}`), 0, 0);
    },
  });

  pi.registerCommand("questions", {
    description: "Answer queued questions, inspect them with /questions list, or discard them with /questions clear",
    getArgumentCompletions: prefix => ["list", "clear"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!["", "list", "clear"].includes(action)) {
        ctx.ui.notify("Usage: /questions [list|clear]", "warning");
        return;
      }
      if (action === "clear") {
        const count = state.pending.length;
        state.pending = [];
        saveCommandState(ctx);
        ctx.ui.notify(`Discarded ${count} question batch${count === 1 ? "" : "es"}.`, "info");
        return;
      }
      if (action === "list") {
        if (!state.pending.length) {
          if (ctx.hasUI) ctx.ui.notify("No queued questions.", "info");
          return;
        }
        const summary = state.pending.map(batch => `Batch ${batch.id}: ${batch.questions.map(question => question.title).join("; ")}`).join("\n");
        if (ctx.hasUI) ctx.ui.notify(summary, "info");
        return;
      }
      await answerQueued(ctx, true);
    },
  });
}
