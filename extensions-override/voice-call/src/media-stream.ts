/**
 * Media Stream Handler
 *
 * Handles bidirectional audio streaming between Twilio and the AI services.
 * Two modes:
 * 1. STT mode: Twilio audio → OpenAI STT → transcript → Claude → TTS → Twilio
 * 2. Conversation mode: Twilio audio ↔ OpenAI Realtime (speech-to-speech) → transcript
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type {
  ConversationTranscriptEntry,
  RealtimeConversationProvider,
  RealtimeConversationSession,
} from "./providers/realtime-conversation.js";
import type {
  OpenAIRealtimeSTTProvider,
  RealtimeSTTSession,
} from "./providers/stt-openai-realtime.js";

/**
 * Configuration for the media stream handler.
 */
export interface MediaStreamConfig {
  /** STT provider for transcription (used when no conversation instructions) */
  sttProvider: OpenAIRealtimeSTTProvider;
  /** Conversation provider for speech-to-speech (used when instructions present) */
  conversationProvider?: RealtimeConversationProvider;
  /** Look up realtime instructions for a call (by provider callId / callSid) */
  getRealtimeInstructions?: (callId: string) => { instructions: string; voice?: string } | null;
  /** Validate whether to accept a media stream for the given call ID */
  shouldAcceptStream?: (params: { callId: string; streamSid: string; token?: string }) => boolean;
  /** Callback when transcript is received (STT mode only) */
  onTranscript?: (callId: string, transcript: string) => void;
  /** Callback for partial transcripts (STT mode only) */
  onPartialTranscript?: (callId: string, partial: string) => void;
  /** Callback when stream connects */
  onConnect?: (callId: string, streamSid: string) => void;
  /** Callback when speech starts (barge-in) */
  onSpeechStart?: (callId: string) => void;
  /** Callback when stream disconnects */
  onDisconnect?: (callId: string) => void;
  /** Callback when a conversation-mode call ends with full transcript */
  onCallComplete?: (callId: string, transcript: ConversationTranscriptEntry[]) => void;
}

/**
 * Active media stream session.
 */
interface StreamSession {
  callId: string;
  streamSid: string;
  ws: WebSocket;
  sttSession?: RealtimeSTTSession;
  conversationSession?: RealtimeConversationSession;
  stopped?: boolean;
}

type TtsQueueEntry = {
  playFn: (signal: AbortSignal) => Promise<void>;
  controller: AbortController;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/**
 * Manages WebSocket connections for Twilio media streams.
 */
export class MediaStreamHandler {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, StreamSession>();
  private config: MediaStreamConfig;
  /** TTS playback queues per stream (serialize audio to prevent overlap) */
  private ttsQueues = new Map<string, TtsQueueEntry[]>();
  /** Whether TTS is currently playing per stream */
  private ttsPlaying = new Map<string, boolean>();
  /** Active TTS playback controllers per stream */
  private ttsActiveControllers = new Map<string, AbortController>();

  constructor(config: MediaStreamConfig) {
    this.config = config;
  }

  /**
   * Handle WebSocket upgrade for media stream connections.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss) {
      this.wss = new WebSocketServer({ noServer: true });
      this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss?.emit("connection", ws, request);
    });
  }

  /**
   * Handle new WebSocket connection from Twilio.
   */
  private async handleConnection(ws: WebSocket, _request: IncomingMessage): Promise<void> {
    let session: StreamSession | null = null;
    const streamToken = this.getStreamToken(_request);

    ws.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as TwilioMediaMessage;

        switch (message.event) {
          case "connected":
            console.log("[MediaStream] Twilio connected");
            break;

          case "start":
            session = await this.handleStart(ws, message, streamToken);
            break;

          case "media":
            if (session && message.media?.payload) {
              const audioBuffer = Buffer.from(message.media.payload, "base64");
              if (session.conversationSession) {
                // Conversation mode: forward to OpenAI Realtime
                session.conversationSession.sendAudio(audioBuffer);
              } else if (session.sttSession) {
                // STT mode: forward to STT
                session.sttSession.sendAudio(audioBuffer);
              }
            }
            break;

          case "stop":
            if (session) {
              this.handleStop(session);
              session = null;
            }
            break;
        }
      } catch (error) {
        console.error("[MediaStream] Error processing message:", error);
      }
    });

    ws.on("close", () => {
      if (session) {
        this.handleStop(session);
      }
    });

    ws.on("error", (error) => {
      console.error("[MediaStream] WebSocket error:", error);
    });
  }

  /**
   * Handle stream start event.
   */
  private async handleStart(
    ws: WebSocket,
    message: TwilioMediaMessage,
    streamToken?: string,
  ): Promise<StreamSession | null> {
    const streamSid = message.streamSid || "";
    const callSid = message.start?.callSid || "";

    const effectiveToken = message.start?.customParameters?.token ?? streamToken;

    console.log(`[MediaStream] Stream started: ${streamSid} (call: ${callSid})`);
    if (!callSid) {
      console.warn("[MediaStream] Missing callSid; closing stream");
      ws.close(1008, "Missing callSid");
      return null;
    }
    if (
      this.config.shouldAcceptStream &&
      !this.config.shouldAcceptStream({ callId: callSid, streamSid, token: effectiveToken })
    ) {
      console.warn(`[MediaStream] Rejecting stream for unknown call: ${callSid}`);
      ws.close(1008, "Unknown call");
      return null;
    }

    // Check if this call has realtime conversation instructions
    const realtimeInstructions = this.config.getRealtimeInstructions?.(callSid);

    if (realtimeInstructions && this.config.conversationProvider) {
      // Conversation mode: OpenAI Realtime handles the full conversation
      return this.handleStartConversation(ws, callSid, streamSid, realtimeInstructions);
    }

    // STT mode: transcription only (existing behavior)
    return this.handleStartSTT(ws, callSid, streamSid);
  }

  /**
   * Start a conversation-mode session with OpenAI Realtime speech-to-speech.
   */
  private async handleStartConversation(
    ws: WebSocket,
    callSid: string,
    streamSid: string,
    realtimeInstructions: { instructions: string; voice?: string },
  ): Promise<StreamSession | null> {
    console.log(`[MediaStream] Starting conversation mode for ${callSid}`);

    const conversationSession = this.config.conversationProvider!.createSession(
      realtimeInstructions.instructions,
      realtimeInstructions.voice,
    );

    // Wire up response audio → Twilio
    conversationSession.onAudioDelta((base64Audio) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: base64Audio },
          }),
        );
      }
    });

    // Wire up barge-in: when user starts speaking, clear Twilio audio buffer
    conversationSession.onSpeechStarted(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: "clear", streamSid }));
      }
      this.config.onSpeechStart?.(callSid);
    });

    // Log transcript deltas
    conversationSession.onTranscriptDelta((role, text) => {
      console.log(`[MediaStream] [${callSid}] ${role}: ${text}`);
    });

    // AI-initiated hangup: close the Twilio WS → triggers handleStop → onCallComplete
    conversationSession.onHangup(() => {
      console.log(`[MediaStream] AI-initiated hangup for ${callSid}`);
      // Wait for goodbye audio to finish playing before closing.
      // The AI typically says a goodbye phrase (~3-4s of audio) before end_call.
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, "AI ended call");
        }
      }, 5000);
    });

    const session: StreamSession = {
      callId: callSid,
      streamSid,
      ws,
      conversationSession,
    };

    this.sessions.set(streamSid, session);

    // Notify connection
    this.config.onConnect?.(callSid, streamSid);

    // Connect to OpenAI Realtime and trigger initial greeting
    conversationSession
      .connect()
      .then(() => {
        console.log(`[MediaStream] Conversation session connected for ${callSid}`);
        // Trigger the initial assistant response (greeting)
        conversationSession.triggerResponse();
      })
      .catch((err) => {
        console.error(`[MediaStream] Conversation session failed for ${callSid}:`, err.message);
      });

    return session;
  }

  /**
   * Start an STT-mode session (existing behavior).
   */
  private async handleStartSTT(
    ws: WebSocket,
    callSid: string,
    streamSid: string,
  ): Promise<StreamSession> {
    const sttSession = this.config.sttProvider.createSession();

    sttSession.onPartial((partial) => {
      this.config.onPartialTranscript?.(callSid, partial);
    });

    sttSession.onTranscript((transcript) => {
      this.config.onTranscript?.(callSid, transcript);
    });

    sttSession.onSpeechStart(() => {
      this.config.onSpeechStart?.(callSid);
    });

    const session: StreamSession = {
      callId: callSid,
      streamSid,
      ws,
      sttSession,
    };

    this.sessions.set(streamSid, session);

    // Notify connection BEFORE STT connect so TTS can work even if STT fails
    this.config.onConnect?.(callSid, streamSid);

    // Connect to OpenAI STT (non-blocking)
    sttSession.connect().catch((err) => {
      console.warn(`[MediaStream] STT connection failed (TTS still works):`, err.message);
    });

    return session;
  }

  /**
   * Handle stream stop event.
   */
  private handleStop(session: StreamSession): void {
    if (session.stopped) return;
    session.stopped = true;
    console.log(`[MediaStream] Stream stopped: ${session.streamSid}`);

    this.clearTtsState(session.streamSid);

    if (session.conversationSession) {
      // Collect transcript before closing
      const transcript = session.conversationSession.getFullTranscript();
      session.conversationSession.close();

      console.log(
        `[MediaStream] Conversation transcript for ${session.callId}: ${transcript.length} entries`,
      );
      // Always fire onCallComplete — even with empty transcript — to resolve waiters
      this.config.onCallComplete?.(session.callId, transcript);
    }

    if (session.sttSession) {
      session.sttSession.close();
    }

    this.sessions.delete(session.streamSid);
    this.config.onDisconnect?.(session.callId);
  }

  private getStreamToken(request: IncomingMessage): string | undefined {
    if (!request.url || !request.headers.host) {
      return undefined;
    }
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      return url.searchParams.get("token") ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get an active session with an open WebSocket, or undefined if unavailable.
   */
  private getOpenSession(streamSid: string): StreamSession | undefined {
    const session = this.sessions.get(streamSid);
    return session?.ws.readyState === WebSocket.OPEN ? session : undefined;
  }

  /**
   * Send a message to a stream's WebSocket if available.
   */
  private sendToStream(streamSid: string, message: unknown): void {
    const session = this.getOpenSession(streamSid);
    session?.ws.send(JSON.stringify(message));
  }

  /**
   * Send audio to a specific stream (for TTS playback).
   * Audio should be mu-law encoded at 8kHz mono.
   */
  sendAudio(streamSid: string, muLawAudio: Buffer): void {
    this.sendToStream(streamSid, {
      event: "media",
      streamSid,
      media: { payload: muLawAudio.toString("base64") },
    });
  }

  /**
   * Send a mark event to track audio playback position.
   */
  sendMark(streamSid: string, name: string): void {
    this.sendToStream(streamSid, {
      event: "mark",
      streamSid,
      mark: { name },
    });
  }

  /**
   * Clear audio buffer (interrupt playback).
   */
  clearAudio(streamSid: string): void {
    this.sendToStream(streamSid, { event: "clear", streamSid });
  }

  /**
   * Queue a TTS operation for sequential playback.
   * Only one TTS operation plays at a time per stream to prevent overlap.
   */
  async queueTts(streamSid: string, playFn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const queue = this.getTtsQueue(streamSid);
    let resolveEntry: () => void;
    let rejectEntry: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });

    queue.push({
      playFn,
      controller: new AbortController(),
      resolve: resolveEntry!,
      reject: rejectEntry!,
    });

    if (!this.ttsPlaying.get(streamSid)) {
      void this.processQueue(streamSid);
    }

    return promise;
  }

  /**
   * Clear TTS queue and interrupt current playback (barge-in).
   */
  clearTtsQueue(streamSid: string): void {
    const queue = this.getTtsQueue(streamSid);
    queue.length = 0;
    this.ttsActiveControllers.get(streamSid)?.abort();
    this.clearAudio(streamSid);
  }

  /**
   * Get active session by call ID.
   */
  getSessionByCallId(callId: string): StreamSession | undefined {
    return [...this.sessions.values()].find((session) => session.callId === callId);
  }

  /**
   * Close all sessions.
   */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      this.clearTtsState(session.streamSid);
      session.conversationSession?.close();
      session.sttSession?.close();
      session.ws.close();
    }
    this.sessions.clear();
  }

  private getTtsQueue(streamSid: string): TtsQueueEntry[] {
    const existing = this.ttsQueues.get(streamSid);
    if (existing) {
      return existing;
    }
    const queue: TtsQueueEntry[] = [];
    this.ttsQueues.set(streamSid, queue);
    return queue;
  }

  /**
   * Process the TTS queue for a stream.
   * Uses iterative approach to avoid stack accumulation from recursion.
   */
  private async processQueue(streamSid: string): Promise<void> {
    this.ttsPlaying.set(streamSid, true);

    while (true) {
      const queue = this.ttsQueues.get(streamSid);
      if (!queue || queue.length === 0) {
        this.ttsPlaying.set(streamSid, false);
        this.ttsActiveControllers.delete(streamSid);
        return;
      }

      const entry = queue.shift()!;
      this.ttsActiveControllers.set(streamSid, entry.controller);

      try {
        await entry.playFn(entry.controller.signal);
        entry.resolve();
      } catch (error) {
        if (entry.controller.signal.aborted) {
          entry.resolve();
        } else {
          console.error("[MediaStream] TTS playback error:", error);
          entry.reject(error);
        }
      } finally {
        if (this.ttsActiveControllers.get(streamSid) === entry.controller) {
          this.ttsActiveControllers.delete(streamSid);
        }
      }
    }
  }

  private clearTtsState(streamSid: string): void {
    const queue = this.ttsQueues.get(streamSid);
    if (queue) {
      queue.length = 0;
    }
    this.ttsActiveControllers.get(streamSid)?.abort();
    this.ttsActiveControllers.delete(streamSid);
    this.ttsPlaying.delete(streamSid);
    this.ttsQueues.delete(streamSid);
  }
}

/**
 * Twilio Media Stream message format.
 */
interface TwilioMediaMessage {
  event: "connected" | "start" | "media" | "stop" | "mark" | "clear";
  sequenceNumber?: string;
  streamSid?: string;
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    customParameters?: Record<string, string>;
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
  };
  media?: {
    track?: string;
    chunk?: string;
    timestamp?: string;
    payload?: string;
  };
  mark?: {
    name: string;
  };
}
