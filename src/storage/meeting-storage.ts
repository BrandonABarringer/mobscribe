import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	MeetingListFilter,
	MeetingMetadata,
	MeetingSearchResult,
	MeetingSummary,
	SaveMeetingOptions,
} from "./types.js";

const MEETINGS_DIR = join(homedir(), "meetings");

/**
 * Generate a meeting ID slug from name
 * Converts "Austin Dashboard Handoff" → "austin-dashboard-handoff"
 */
function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");
}

/**
 * Generate meeting ID with conflict resolution
 * Format: YYYY-MM-DD-slug or YYYY-MM-DD-slug-2 if conflict
 */
function generateMeetingId(name: string, date: Date): string {
	const dateStr = date.toISOString().split("T")[0];
	const slug = slugify(name);
	let id = `${dateStr}-${slug}`;
	let counter = 2;

	while (existsSync(join(MEETINGS_DIR, id))) {
		id = `${dateStr}-${slug}-${counter}`;
		counter++;
	}

	return id;
}

/**
 * Format timestamp from milliseconds to MM:SS
 */
function formatTimestamp(ms: number): string {
	const mins = Math.floor(ms / 60000);
	const secs = Math.floor((ms % 60000) / 1000);
	return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * Extract unique speakers from segments
 */
function extractSpeakers(segments: SaveMeetingOptions["segments"]): string[] {
	const speakers = new Set<string>();
	for (const seg of segments) {
		if (seg.speaker) speakers.add(seg.speaker);
	}
	return Array.from(speakers).sort();
}

/**
 * Generate summary using Claude CLI
 * Returns summary object or null if generation fails
 */
async function generateSummary(options: SaveMeetingOptions): Promise<MeetingSummary | null> {
	// Format transcript for Claude
	const transcript = options.segments
		.map((s) => {
			const ts = formatTimestamp(s.timestamp);
			const speaker = s.speaker ? ` [${s.speaker}]` : "";
			return `[${ts}]${speaker} ${s.text}`;
		})
		.join("\n\n");

	const prompt = `You are analyzing a meeting transcript. Generate a structured summary in valid JSON format.

Meeting context:
- Name: ${options.name}
${options.project ? `- Project: ${options.project}` : ""}
${options.context ? `- Context: ${options.context}` : ""}
- Duration: ${Math.round((options.endTime.getTime() - options.startTime.getTime()) / 1000 / 60)} minutes

Transcript:
${transcript}

Generate a JSON object with this exact structure:
{
  "overview": "1-2 sentence overview of the meeting",
  "topics": ["topic 1", "topic 2", "..."],
  "decisions": ["decision 1", "decision 2", "..."],
  "actionItems": ["action 1", "action 2", "..."],
  "keyMoments": [
    {"timestamp": "MM:SS", "speaker": "A", "topic": "brief description"},
    ...
  ]
}

Return ONLY the JSON object, no other text.`;

	try {
		const { spawn } = await import("node:child_process");
		const claude = spawn("claude", ["--model", "opus", "--output-format", "text", "-p", prompt]);

		// Close stdin immediately - we're not providing any input
		claude.stdin.end();

		let output = "";
		let errorOutput = "";

		claude.stdout.on("data", (data: Buffer) => {
			output += data.toString();
		});

		claude.stderr.on("data", (data: Buffer) => {
			errorOutput += data.toString();
		});

		return new Promise((resolve) => {
			// Set a timeout in case Claude hangs
			const timeout = setTimeout(() => {
				claude.kill();
				console.error("[meeting-storage] Claude CLI timed out after 60s");
				resolve(null);
			}, 60000);

			claude.on("close", (code) => {
				clearTimeout(timeout);

				if (code !== 0) {
					console.error(`[meeting-storage] Claude CLI failed: ${errorOutput}`);
					resolve(null);
					return;
				}

				try {
					// Extract JSON from output (in case there's extra text)
					const jsonMatch = output.match(/\{[\s\S]*\}/);
					if (!jsonMatch) {
						console.error("[meeting-storage] No JSON found in Claude output");
						console.error(`[meeting-storage] Output was: ${output.substring(0, 200)}`);
						resolve(null);
						return;
					}

					const summary = JSON.parse(jsonMatch[0]) as MeetingSummary;
					resolve(summary);
				} catch (error) {
					console.error("[meeting-storage] Failed to parse Claude output:", error);
					resolve(null);
				}
			});
		});
	} catch (error) {
		console.error("[meeting-storage] Failed to spawn Claude CLI:", error);
		return null;
	}
}

/**
 * Save a meeting with all its data
 */
export async function saveMeeting(options: SaveMeetingOptions): Promise<string> {
	// Ensure meetings directory exists
	if (!existsSync(MEETINGS_DIR)) {
		mkdirSync(MEETINGS_DIR, { recursive: true });
	}

	// Generate meeting ID and create directory
	const meetingId = generateMeetingId(options.name, options.startTime);
	const meetingDir = join(MEETINGS_DIR, meetingId);
	mkdirSync(meetingDir, { recursive: true });

	// Build metadata
	const metadata: MeetingMetadata = {
		id: meetingId,
		name: options.name,
		project: options.project,
		context: options.context,
		date: options.startTime.toISOString(),
		duration: Math.round((options.endTime.getTime() - options.startTime.getTime()) / 1000),
		speakers: extractSpeakers(options.segments),
		segmentCount: options.segments.length,
	};

	// Save metadata
	writeFileSync(join(meetingDir, "metadata.json"), JSON.stringify(metadata, null, 2));

	// Save transcript
	const transcriptLines = options.segments.map((s) => JSON.stringify(s)).join("\n");
	writeFileSync(join(meetingDir, "transcript.jsonl"), transcriptLines);

	// Generate and save summary
	console.error("[meeting-storage] Generating summary with Claude CLI...");
	const summary = await generateSummary(options);

	if (summary) {
		writeFileSync(join(meetingDir, "summary.json"), JSON.stringify(summary, null, 2));
		console.error("[meeting-storage] Summary generated successfully");
	} else {
		console.error("[meeting-storage] Failed to generate summary - saving meeting without it");
		// Save empty summary as placeholder
		const emptySummary: MeetingSummary = {
			overview: "Summary generation failed",
			topics: [],
			decisions: [],
			actionItems: [],
			keyMoments: [],
		};
		writeFileSync(join(meetingDir, "summary.json"), JSON.stringify(emptySummary, null, 2));
	}

	return meetingDir;
}

/**
 * List all meetings with optional filtering
 */
export function listMeetings(filter?: MeetingListFilter): MeetingMetadata[] {
	if (!existsSync(MEETINGS_DIR)) {
		return [];
	}

	const meetingDirs = readdirSync(MEETINGS_DIR, { withFileTypes: true })
		.filter((dirent) => dirent.isDirectory())
		.map((dirent) => dirent.name);

	const meetings: MeetingMetadata[] = [];

	for (const dirName of meetingDirs) {
		const metadataPath = join(MEETINGS_DIR, dirName, "metadata.json");
		if (!existsSync(metadataPath)) continue;

		try {
			const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as MeetingMetadata;

			// Apply filters
			if (filter) {
				if (filter.dateFrom && metadata.date < filter.dateFrom) continue;
				if (filter.dateTo && metadata.date > filter.dateTo) continue;
				if (filter.project && metadata.project !== filter.project) continue;
				if (filter.speaker && !metadata.speakers.includes(filter.speaker)) continue;
			}

			meetings.push(metadata);
		} catch (error) {
			console.error(`[meeting-storage] Failed to read metadata for ${dirName}:`, error);
		}
	}

	// Sort by date descending (most recent first)
	return meetings.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Search meetings by keyword
 * Searches through summaries and metadata
 */
export function searchMeetings(query: string): MeetingSearchResult[] {
	const meetings = listMeetings();
	const results: MeetingSearchResult[] = [];
	const queryLower = query.toLowerCase();

	for (const metadata of meetings) {
		const summaryPath = join(MEETINGS_DIR, metadata.id, "summary.json");
		if (!existsSync(summaryPath)) continue;

		try {
			const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as MeetingSummary;

			// Search individual fields to find the best match context
			const searchableFields = [
				metadata.name,
				metadata.project || "",
				metadata.context || "",
				summary.overview,
				...summary.topics,
				...summary.decisions,
				...summary.actionItems,
				...summary.keyMoments.map((km) => km.topic),
			];

			const matchingField = searchableFields.find((field) =>
				field.toLowerCase().includes(queryLower),
			);

			if (matchingField) {
				results.push({
					metadata,
					summary,
					matchContext: matchingField.substring(0, 200),
				});
			}
		} catch (error) {
			console.error(`[meeting-storage] Failed to search meeting ${metadata.id}:`, error);
		}
	}

	return results;
}

/**
 * Get complete meeting data (metadata + summary + transcript)
 */
export function getMeeting(meetingId: string): {
	metadata: MeetingMetadata;
	summary: MeetingSummary;
	transcript: string;
} | null {
	const meetingDir = join(MEETINGS_DIR, meetingId);
	if (!existsSync(meetingDir)) return null;

	try {
		const metadata = JSON.parse(
			readFileSync(join(meetingDir, "metadata.json"), "utf-8"),
		) as MeetingMetadata;

		const summary = JSON.parse(
			readFileSync(join(meetingDir, "summary.json"), "utf-8"),
		) as MeetingSummary;

		// Parse JSONL and format as readable transcript
		const rawTranscript = readFileSync(join(meetingDir, "transcript.jsonl"), "utf-8");
		const transcript = rawTranscript
			.trim()
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => {
				const seg = JSON.parse(line) as {
					text: string;
					timestamp: number;
					speaker?: string;
				};
				const ts = formatTimestamp(seg.timestamp);
				const speaker = seg.speaker ? ` [${seg.speaker}]` : "";
				return `[${ts}]${speaker} ${seg.text}`;
			})
			.join("\n\n");

		return { metadata, summary, transcript };
	} catch (error) {
		console.error(`[meeting-storage] Failed to load meeting ${meetingId}:`, error);
		return null;
	}
}

/**
 * Get meeting summary only (faster than full meeting)
 */
export function getMeetingSummary(meetingId: string): {
	metadata: MeetingMetadata;
	summary: MeetingSummary;
} | null {
	const meetingDir = join(MEETINGS_DIR, meetingId);
	if (!existsSync(meetingDir)) return null;

	try {
		const metadata = JSON.parse(
			readFileSync(join(meetingDir, "metadata.json"), "utf-8"),
		) as MeetingMetadata;

		const summary = JSON.parse(
			readFileSync(join(meetingDir, "summary.json"), "utf-8"),
		) as MeetingSummary;

		return { metadata, summary };
	} catch (error) {
		console.error(`[meeting-storage] Failed to load summary for ${meetingId}:`, error);
		return null;
	}
}
