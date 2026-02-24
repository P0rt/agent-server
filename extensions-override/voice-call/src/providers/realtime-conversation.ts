/**
 * OpenAI Realtime Conversation Provider
 *
 * Full speech-to-speech via OpenAI Realtime API:
 * - Sends g711_ulaw audio from Twilio to OpenAI
 * - Receives g711_ulaw response audio from OpenAI back to Twilio
 * - AI can end the call via end_call function tool
 * - Collects transcript for post-call report
 */

import WebSocket from "ws";

export interface RealtimeConversationConfig {
  apiKey: string;
  model?: string;
  voice?: string;
  instructions: string;
  silenceDurationMs?: number;
  vadThreshold?: number;
}

export interface ConversationTranscriptEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface RealtimeConversationSession {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  /** Trigger the initial assistant response (greeting) */
  triggerResponse(): void;
  onAudioDelta(callback: (base64Audio: string) => void): void;
  onSpeechStarted(callback: () => void): void;
  onTranscriptDelta(callback: (role: "user" | "assistant", text: string) => void): void;
  /** Called when the AI decides to end the call via end_call tool */
  onHangup(callback: () => void): void;
  getFullTranscript(): ConversationTranscriptEntry[];
  close(): void;
  isConnected(): boolean;
}

/**
 * Factory for OpenAI Realtime conversation sessions.
 */
export class RealtimeConversationProvider {
  private apiKey: string;
  private model: string;
  private voice: string;
  private silenceDurationMs: number;
  private vadThreshold: number;

  constructor(config: {
    apiKey: string;
    model?: string;
    voice?: string;
    silenceDurationMs?: number;
    vadThreshold?: number;
  }) {
    if (!config.apiKey) {
      throw new Error("OpenAI API key required for Realtime Conversation");
    }
    this.apiKey = config.apiKey;
    this.model = config.model || "gpt-realtime-mini";
    this.voice = config.voice || "coral";
    this.silenceDurationMs = config.silenceDurationMs || 600;
    this.vadThreshold = config.vadThreshold || 0.5;
  }

  createSession(instructions: string, voice?: string): RealtimeConversationSession {
    return new OpenAIRealtimeConversationSession({
      apiKey: this.apiKey,
      model: this.model,
      voice: voice || this.voice,
      instructions,
      silenceDurationMs: this.silenceDurationMs,
      vadThreshold: this.vadThreshold,
    });
  }
}

class OpenAIRealtimeConversationSession implements RealtimeConversationSession {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private hangingUp = false;
  private model: string;
  private voice: string;
  private apiKey: string;
  private instructions: string;
  private silenceDurationMs: number;
  private vadThreshold: number;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  private transcript: ConversationTranscriptEntry[] = [];

  private onAudioDeltaCallback: ((base64Audio: string) => void) | null = null;
  private onSpeechStartedCallback: (() => void) | null = null;
  private onTranscriptDeltaCallback:
    | ((role: "user" | "assistant", text: string) => void)
    | null = null;
  private onHangupCallback: (() => void) | null = null;

  /** Resolves when session.updated is received (voice/tools are applied) */
  private sessionReadyResolve: (() => void) | null = null;
  private sessionReadyReject: ((err: Error) => void) | null = null;

  constructor(config: RealtimeConversationConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || "gpt-realtime-mini";
    this.voice = config.voice || "coral";
    this.instructions = config.instructions;
    this.silenceDurationMs = config.silenceDurationMs || 600;
    this.vadThreshold = config.vadThreshold || 0.5;
  }

  /**
   * Connect to OpenAI Realtime. Resolves only after session.updated
   * is received — voice and tools are confirmed active.
   */
  async connect(): Promise<void> {
    if (this.closed) throw new Error("Session is closed");

    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      // Store resolve/reject for session.updated
      this.sessionReadyResolve = resolve;
      this.sessionReadyReject = reject;

      this.ws.on("open", () => {
        console.log(`[RealtimeConversation] WebSocket connected (model: ${this.model}, voice: ${this.voice})`);
        this.connected = true;

        // Configure session — voice, audio format, VAD, tools
        // Append mandatory end_call instructions so the AI reliably hangs up
        const fullInstructions = this.instructions +
          "\n\nIMPORTANT: You have an end_call tool. You MUST call end_call after saying goodbye. " +
          "When the conversation goals are met or the user says goodbye, say a brief farewell and " +
          "immediately call end_call. Never leave the call hanging without calling end_call.";

        this.sendEvent({
          type: "session.update",
          session: {
            modalities: ["audio", "text"],
            instructions: fullInstructions,
            voice: this.voice,
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            input_audio_transcription: {
              model: "gpt-4o-mini-transcribe",
            },
            turn_detection: {
              type: "server_vad",
              threshold: this.vadThreshold,
              prefix_padding_ms: 300,
              silence_duration_ms: this.silenceDurationMs,
            },
            tools: [
              {
                type: "function",
                name: "end_call",
                description:
                  "End the phone call. Use when: the conversation is complete, the user says goodbye, or all goals are met. Always say goodbye before calling this.",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
        });

        // Don't resolve yet — wait for session.updated
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleEvent(event);
        } catch (e) {
          console.error("[RealtimeConversation] Failed to parse event:", e);
        }
      });

      this.ws.on("error", (error) => {
        console.error("[RealtimeConversation] WebSocket error:", error);
        if (!this.connected) {
          this.clearConnectTimer();
          reject(error);
        }
      });

      this.ws.on("close", (code, reason) => {
        console.log(
          `[RealtimeConversation] WebSocket closed (code: ${code}, reason: ${reason?.toString() || "none"})`,
        );
        this.connected = false;
      });

      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (this.sessionReadyResolve) {
          this.sessionReadyResolve = null;
          this.sessionReadyReject = null;
          reject(new Error("Realtime Conversation connection timeout"));
        }
      }, 10000);
    });
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  triggerResponse(): void {
    if (this.closed) return;
    this.sendEvent({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleEvent(event: any): void {
    switch (event.type) {
      case "session.created":
        console.log("[RealtimeConversation] session.created");
        break;

      case "session.updated":
        console.log("[RealtimeConversation] session.updated — voice and tools active");
        // NOW the session is fully configured — resolve connect()
        if (this.sessionReadyResolve) {
          this.clearConnectTimer();
          this.sessionReadyResolve();
          this.sessionReadyResolve = null;
          this.sessionReadyReject = null;
        }
        break;

      case "response.audio.delta":
        if (event.delta) {
          this.onAudioDeltaCallback?.(event.delta);
        }
        break;

      case "input_audio_buffer.speech_started":
        console.log("[RealtimeConversation] User speech started");
        this.onSpeechStartedCallback?.();
        break;

      case "input_audio_buffer.speech_stopped":
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          const text = event.transcript.trim();
          if (text) {
            console.log(`[RealtimeConversation] User: ${text}`);
            this.transcript.push({ role: "user", text, timestamp: Date.now() });
            this.onTranscriptDeltaCallback?.("user", text);
          }
        }
        break;

      case "conversation.item.input_audio_transcription.failed":
        console.warn("[RealtimeConversation] Transcription failed:", event.error);
        break;

      case "response.done": {
        const output = event.response?.output;
        if (Array.isArray(output)) {
          for (const item of output) {
            // Collect assistant speech transcript
            if (item.type === "message" && Array.isArray(item.content)) {
              for (const part of item.content) {
                if (part.type === "audio" && part.transcript) {
                  const text = part.transcript.trim();
                  if (text) {
                    console.log(`[RealtimeConversation] Assistant: ${text}`);
                    this.transcript.push({ role: "assistant", text, timestamp: Date.now() });
                    this.onTranscriptDeltaCallback?.("assistant", text);
                  }
                }
              }
            }

            // Handle end_call function call (deduplicate — only fire once)
            if (item.type === "function_call" && item.name === "end_call" && !this.hangingUp) {
              this.hangingUp = true;
              console.log("[RealtimeConversation] AI called end_call — hanging up");
              this.onHangupCallback?.();
            }
          }
        }
        break;
      }

      case "response.audio_transcript.delta":
        break;

      case "error":
        console.error("[RealtimeConversation] Error:", event.error);
        break;
    }
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  sendAudio(muLawData: Buffer): void {
    if (!this.connected || this.closed || this.hangingUp) return;
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: muLawData.toString("base64"),
    });
  }

  onAudioDelta(callback: (base64Audio: string) => void): void {
    this.onAudioDeltaCallback = callback;
  }

  onSpeechStarted(callback: () => void): void {
    this.onSpeechStartedCallback = callback;
  }

  onTranscriptDelta(callback: (role: "user" | "assistant", text: string) => void): void {
    this.onTranscriptDeltaCallback = callback;
  }

  onHangup(callback: () => void): void {
    this.onHangupCallback = callback;
  }

  getFullTranscript(): ConversationTranscriptEntry[] {
    return [...this.transcript];
  }

  close(): void {
    this.closed = true;
    this.clearConnectTimer();
    if (this.sessionReadyReject) {
      this.sessionReadyReject(new Error("Session closed during connection"));
      this.sessionReadyResolve = null;
      this.sessionReadyReject = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
