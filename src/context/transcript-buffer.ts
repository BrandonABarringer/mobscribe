import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { TranscriptSegment } from "../transcription/streaming-client.js";

export interface BufferedSegment {
	text: string;
	timestamp: number;
	index: number;
	speaker?: string;
}

const DEFAULT_BUFFER_PATH = "/tmp/mobscribe-transcript.jsonl";

/**
 * Accumulates final transcript segments and provides incremental read access.
 * Persists segments to a JSONL file so external processes can read them.
 */
export class TranscriptBuffer {
	private segments: BufferedSegment[] = [];
	private nextIndex = 0;
	private readonly filePath: string;

	constructor(filePath?: string) {
		this.filePath = filePath ?? DEFAULT_BUFFER_PATH;
	}

	/** Add a final transcript segment to the buffer and persist to disk */
	addSegment(segment: TranscriptSegment): void {
		if (!segment.isFinal || !segment.text.trim()) return;

		const buffered: BufferedSegment = {
			text: segment.text.trim(),
			timestamp: segment.timestamp,
			index: this.nextIndex++,
			speaker: segment.speaker,
		};

		this.segments.push(buffered);

		// Append to JSONL file for external readers
		try {
			appendFileSync(this.filePath, `${JSON.stringify(buffered)}\n`);
		} catch {
			// Non-fatal — in-memory buffer still works
		}
	}

	/** Get all segments since the given index (exclusive). Returns segments and the new cursor. */
	getSegmentsSince(afterIndex: number): { segments: BufferedSegment[]; cursor: number } {
		const newSegments = this.segments.filter((s) => s.index > afterIndex);
		const cursor =
			this.segments.length > 0 ? this.segments[this.segments.length - 1].index : afterIndex;

		return { segments: newSegments, cursor };
	}

	/** Get the full transcript as a single string */
	getFullTranscript(): string {
		return this.segments.map((s) => s.text).join("\n\n");
	}

	/** Get the full transcript with timestamps */
	getFullTranscriptWithTimestamps(): string {
		return this.segments
			.map((s) => {
				const mins = Math.floor(s.timestamp / 60000);
				const secs = Math.floor((s.timestamp % 60000) / 1000);
				const ts = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
				return `[${ts}] ${s.text}`;
			})
			.join("\n\n");
	}

	/** Get text from the most recent N segments */
	getRecentText(count: number): string {
		const recent = this.segments.slice(-count);
		return recent.map((s) => s.text).join("\n\n");
	}

	/** Total number of segments */
	get length(): number {
		return this.segments.length;
	}

	/** Latest cursor position */
	get latestCursor(): number {
		return this.segments.length > 0 ? this.segments[this.segments.length - 1].index : -1;
	}

	/** Clear all segments and reset the file */
	clear(): void {
		this.segments = [];
		this.nextIndex = 0;
		try {
			writeFileSync(this.filePath, "");
		} catch {
			// Non-fatal
		}
	}

	/** Load segments from the JSONL file (for external processes joining mid-session) */
	loadFromDisk(): void {
		try {
			const content = readFileSync(this.filePath, "utf-8").trim();
			if (!content) return;

			const lines = content.split("\n");
			this.segments = [];
			let maxIndex = -1;

			for (const line of lines) {
				if (!line.trim()) continue;
				const seg = JSON.parse(line) as BufferedSegment;
				this.segments.push(seg);
				if (seg.index > maxIndex) maxIndex = seg.index;
			}

			this.nextIndex = maxIndex + 1;
		} catch {
			// File doesn't exist or is corrupt — start fresh
		}
	}
}
