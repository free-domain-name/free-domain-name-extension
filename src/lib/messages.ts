import { api } from "./api";
import type { RequestMessage } from "./types";

export async function sendRuntimeMessage<T>(message: RequestMessage): Promise<T> {
  try {
    return (await api.runtime.sendMessage(message)) as T;
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "The extension background worker is unavailable.",
    );
  }
}
