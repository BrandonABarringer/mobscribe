import { AssemblyAI, type StreamingTranscriber } from "assemblyai";

export interface TranscriptSegment {
	text: string;
	/** Milliseconds from session start */
	timestamp: number;
	isFinal: boolean;
	turnOrder: number;
	speaker?: string;
	words: Array<{
		text: string;
		start: number;
		end: number;
		confidence: number;
	}>;
}

export interface StreamingClientOptions {
	apiKey: string;
	sampleRate?: number;
	onSegment: (segment: TranscriptSegment) => void;
	onError: (error: Error) => void;
	onOpen?: () => void;
	onClose?: () => void;
}

/**
 * Streams audio to AssemblyAI v3 Streaming API and emits transcript segments.
 * Uses the StreamingTranscriber (v3) which provides Turn-based events
 * with punctuation, casing, and end-of-turn detection.
 */
export class StreamingClient {
	private transcriber: StreamingTranscriber | null = null;
	private readonly client: AssemblyAI;
	private readonly sampleRate: number;
	private readonly onSegment: StreamingClientOptions["onSegment"];
	private readonly onError: StreamingClientOptions["onError"];
	private readonly onOpen: StreamingClientOptions["onOpen"];
	private readonly onClose: StreamingClientOptions["onClose"];

	constructor(options: StreamingClientOptions) {
		this.client = new AssemblyAI({ apiKey: options.apiKey });
		this.sampleRate = options.sampleRate ?? 16000;
		this.onSegment = options.onSegment;
		this.onError = options.onError;
		this.onOpen = options.onOpen;
		this.onClose = options.onClose;
	}

	get isConnected(): boolean {
		return this.transcriber !== null;
	}

	async connect(): Promise<void> {
		if (this.transcriber) {
			throw new Error("Already connected");
		}

		this.transcriber = this.client.streaming.transcriber({
			sampleRate: this.sampleRate,
			speechModel: "u3-rt-pro",
			formatTurns: true,
			speakerLabels: true,
		});

		this.transcriber.on("open", ({ id }) => {
			process.stderr.write(`[mobscribe] Transcription connected: session ${id}\n`);
			this.onOpen?.();
		});

		this.transcriber.on("turn", (turn) => {
			if (!turn.transcript) return;

			const segment: TranscriptSegment = {
				text: turn.transcript,
				timestamp: turn.words.length > 0 ? turn.words[0].start : 0,
				isFinal: turn.turn_is_formatted && turn.end_of_turn,
				turnOrder: turn.turn_order,
				speaker: turn.speaker_label,
				words: turn.words.map((w) => ({
					text: w.text,
					start: w.start,
					end: w.end,
					confidence: w.confidence,
				})),
			};

			this.onSegment(segment);
		});

		this.transcriber.on("error", (error) => {
			this.onError(new Error(`AssemblyAI: ${error.message ?? String(error)}`));
		});

		this.transcriber.on("close", (_code, _reason) => {
			process.stderr.write("[mobscribe] Transcription disconnected\n");
			this.transcriber = null;
			this.onClose?.();
		});

		await this.transcriber.connect();
	}

	sendAudio(chunk: Buffer): void {
		if (!this.transcriber) {
			return;
		}
		// AssemblyAI expects ArrayBufferLike; extract the underlying ArrayBuffer
		this.transcriber.sendAudio(
			chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
		);
	}

	async disconnect(): Promise<void> {
		if (!this.transcriber) {
			return;
		}

		await this.transcriber.close(true);
		this.transcriber = null;
	}
}
