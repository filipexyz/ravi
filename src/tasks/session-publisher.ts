import { publishSessionPrompt } from "../omni/session-stream.js";

type TaskSessionPromptPublisher = (sessionName: string, payload: Record<string, unknown>) => Promise<void>;

let taskSessionPromptPublisher: TaskSessionPromptPublisher = publishSessionPrompt;

export async function publishTaskSessionPrompt(sessionName: string, payload: Record<string, unknown>): Promise<void> {
  await taskSessionPromptPublisher(sessionName, payload);
}

export function setTaskSessionPromptPublisherForTests(publisher?: TaskSessionPromptPublisher): void {
  taskSessionPromptPublisher = publisher ?? publishSessionPrompt;
}
