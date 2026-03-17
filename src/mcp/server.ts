import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TranscriptBuffer } from "../context/transcript-buffer.js";
import {
	getMeeting,
	getMeetingSummary,
	listMeetings,
	searchMeetings,
} from "../storage/meeting-storage.js";

export interface MobScribeMcpOptions {
	buffer: TranscriptBuffer;
	onStartSession?: (name: string, project?: string, context?: string) => Promise<void>;
	onStopSession?: () => Promise<string | undefined>;
}

export function createMcpServer(options: MobScribeMcpOptions): McpServer {
	const { buffer } = options;

	const server = new McpServer({
		name: "mobscribe",
		version: "2.0.0",
		description:
			"Meeting recorder and transcription service. Records meetings via microphone, transcribes in real-time with speaker labels, auto-generates summaries, and lets you search and query past meetings.",
	});

	server.tool(
		"transcript_get_new",
		"Get new transcript text from the current meeting since the last read. Returns only segments added after the given cursor. Use cursor -1 on first call to get everything.",
		{
			cursor: z.coerce
				.number()
				.default(-1)
				.describe("Cursor from previous call. Use -1 to get all segments."),
		},
		async ({ cursor }) => {
			const { segments, cursor: newCursor } = buffer.getSegmentsSince(cursor);

			if (segments.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No new segments since cursor ${cursor}. Current cursor: ${newCursor}. Total segments: ${buffer.length}.`,
						},
					],
				};
			}

			const text = segments
				.map((s) => {
					const mins = Math.floor(s.timestamp / 60000);
					const secs = Math.floor((s.timestamp % 60000) / 1000);
					const ts = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
					const speaker = s.speaker ? ` [${s.speaker}]` : "";
					return `[${ts}]${speaker} ${s.text}`;
				})
				.join("\n\n");

			return {
				content: [
					{
						type: "text",
						text: `${segments.length} new segment(s) (cursor: ${newCursor}, total: ${buffer.length}):\n\n${text}`,
					},
				],
			};
		},
	);

	server.tool(
		"transcript_get_full",
		"Get the complete transcript from the meeting currently being recorded. Use sparingly — prefer transcript_get_new for incremental reads.",
		{},
		async () => {
			const transcript = buffer.getFullTranscriptWithTimestamps();

			if (!transcript) {
				return {
					content: [{ type: "text", text: "No transcript yet. Session may not be recording." }],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Full transcript (${buffer.length} segments):\n\n${transcript}`,
					},
				],
			};
		},
	);

	server.tool(
		"transcript_get_recent",
		"Get the most recent transcript segments from the meeting being recorded. Useful for quick context without reading the full transcript.",
		{
			count: z.coerce.number().default(10).describe("Number of recent segments to return"),
		},
		async ({ count }) => {
			const text = buffer.getRecentText(count);

			if (!text) {
				return {
					content: [{ type: "text", text: "No transcript yet." }],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Last ${Math.min(count, buffer.length)} of ${buffer.length} segments:\n\n${text}`,
					},
				],
			};
		},
	);

	server.tool(
		"transcript_status",
		"Check if a meeting is currently being recorded and how many transcript segments have been captured.",
		{},
		async () => {
			return {
				content: [
					{
						type: "text",
						text: `Segments: ${buffer.length}\nLatest cursor: ${buffer.latestCursor}`,
					},
				],
			};
		},
	);

	server.tool(
		"session_start",
		"Start recording a meeting. Captures audio from the microphone, transcribes speech in real-time with speaker labels, and saves everything when stopped. Use this when the user wants to record, transcribe, or capture a meeting or conversation.",
		{
			name: z
				.string()
				.default("Session")
				.describe("Meeting or session name (e.g. 'Sprint Planning', 'Client Check-in')"),
			project: z
				.string()
				.optional()
				.describe("Project or client name for organization (e.g. 'Clearwater', 'Gaming Builder')"),
			context: z
				.string()
				.optional()
				.describe(
					"Additional context about the meeting (e.g. attendees, topics to watch for, goals)",
				),
		},
		async ({ name, project, context: meetingContext }) => {
			if (options.onStartSession) {
				await options.onStartSession(name, project, meetingContext);
				return {
					content: [
						{
							type: "text",
							text: `Session "${name}" started${project ? ` (project: ${project})` : ""}. Use transcript_get_new to read incoming text.`,
						},
					],
				};
			}
			return {
				content: [{ type: "text", text: "Session start not configured." }],
				isError: true,
			};
		},
	);

	server.tool(
		"session_stop",
		"Stop recording the current meeting. Saves the transcript and generates an AI summary with topics, decisions, and action items to ~/meetings/.",
		{},
		async () => {
			if (options.onStopSession) {
				const savedPath = await options.onStopSession();
				const saveMsg = savedPath ? ` Meeting saved to ${savedPath}` : "";
				return {
					content: [
						{
							type: "text",
							text: `Session stopped. Final transcript has ${buffer.length} segments.${saveMsg}`,
						},
					],
				};
			}
			return {
				content: [{ type: "text", text: "Session stop not configured." }],
				isError: true,
			};
		},
	);

	// Meeting query tools
	server.tool(
		"meeting_list",
		"List previously recorded meetings. Returns meetings sorted by date (most recent first). Use this when the user asks about past meetings, what was discussed recently, or wants to find a specific meeting.",
		{
			dateFrom: z
				.string()
				.optional()
				.describe("Filter by start date (ISO 8601, e.g. '2026-03-17')"),
			dateTo: z.string().optional().describe("Filter by end date (ISO 8601)"),
			project: z.string().optional().describe("Filter by project name"),
			speaker: z.string().optional().describe("Filter by speaker ID (e.g. 'A', 'B')"),
		},
		async ({ dateFrom, dateTo, project, speaker }) => {
			const filter = {
				dateFrom,
				dateTo,
				project,
				speaker,
			};

			const meetings = listMeetings(filter);

			if (meetings.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No meetings found matching the filter criteria.",
						},
					],
				};
			}

			const text = meetings
				.map((m) => {
					const date = new Date(m.date).toLocaleString();
					const duration = Math.round(m.duration / 60);
					const projectStr = m.project ? ` [${m.project}]` : "";
					return `• ${m.id}\n  Name: ${m.name}${projectStr}\n  Date: ${date}\n  Duration: ${duration} min\n  Segments: ${m.segmentCount}\n  Speakers: ${m.speakers.join(", ")}`;
				})
				.join("\n\n");

			return {
				content: [
					{
						type: "text",
						text: `Found ${meetings.length} meeting(s):\n\n${text}`,
					},
				],
			};
		},
	);

	server.tool(
		"meeting_search",
		"Search across all previously recorded meetings by keyword. Searches summaries, topics, decisions, and action items. Use this when the user asks things like 'what did we discuss about X' or 'find meetings about Y'.",
		{
			query: z.string().describe("Search query (keyword or phrase)"),
		},
		async ({ query }) => {
			const results = searchMeetings(query);

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No meetings found matching "${query}".`,
						},
					],
				};
			}

			const text = results
				.map((r) => {
					const date = new Date(r.metadata.date).toLocaleString();
					const projectStr = r.metadata.project ? ` [${r.metadata.project}]` : "";
					return `• ${r.metadata.id}\n  Name: ${r.metadata.name}${projectStr}\n  Date: ${date}\n  Overview: ${r.summary.overview}\n  Topics: ${r.summary.topics.join(", ")}`;
				})
				.join("\n\n");

			return {
				content: [
					{
						type: "text",
						text: `Found ${results.length} meeting(s) matching "${query}":\n\n${text}`,
					},
				],
			};
		},
	);

	server.tool(
		"meeting_get",
		"Get a past meeting's full data: metadata, summary, and complete transcript. Use this when you need to read what was actually said.",
		{
			meetingId: z.string().describe("Meeting ID (e.g. '2026-03-17-austin-dashboard-handoff')"),
		},
		async ({ meetingId }) => {
			const meeting = getMeeting(meetingId);

			if (!meeting) {
				return {
					content: [
						{
							type: "text",
							text: `Meeting "${meetingId}" not found.`,
						},
					],
					isError: true,
				};
			}

			const date = new Date(meeting.metadata.date).toLocaleString();
			const duration = Math.round(meeting.metadata.duration / 60);

			const text = `# ${meeting.metadata.name}

**Project:** ${meeting.metadata.project || "N/A"}
**Date:** ${date}
**Duration:** ${duration} minutes
**Speakers:** ${meeting.metadata.speakers.join(", ")}
**Segments:** ${meeting.metadata.segmentCount}

## Summary

**Overview:** ${meeting.summary.overview}

**Topics:**
${meeting.summary.topics.map((t) => `• ${t}`).join("\n")}

**Decisions:**
${meeting.summary.decisions.map((d) => `• ${d}`).join("\n")}

**Action Items:**
${meeting.summary.actionItems.map((a) => `• ${a}`).join("\n")}

**Key Moments:**
${meeting.summary.keyMoments.map((km) => `• [${km.timestamp}] ${km.speaker ? `[${km.speaker}] ` : ""}${km.topic}`).join("\n")}

## Full Transcript

${meeting.transcript}`;

			return {
				content: [
					{
						type: "text",
						text,
					},
				],
			};
		},
	);

	server.tool(
		"meeting_summary",
		"Get a past meeting's metadata and auto-generated summary (topics, decisions, action items) without the full transcript.",
		{
			meetingId: z.string().describe("Meeting ID (e.g. '2026-03-17-austin-dashboard-handoff')"),
		},
		async ({ meetingId }) => {
			const meeting = getMeetingSummary(meetingId);

			if (!meeting) {
				return {
					content: [
						{
							type: "text",
							text: `Meeting "${meetingId}" not found.`,
						},
					],
					isError: true,
				};
			}

			const date = new Date(meeting.metadata.date).toLocaleString();
			const duration = Math.round(meeting.metadata.duration / 60);

			const text = `# ${meeting.metadata.name}

**Project:** ${meeting.metadata.project || "N/A"}
**Date:** ${date}
**Duration:** ${duration} minutes
**Speakers:** ${meeting.metadata.speakers.join(", ")}
**Segments:** ${meeting.metadata.segmentCount}

## Summary

**Overview:** ${meeting.summary.overview}

**Topics:**
${meeting.summary.topics.map((t) => `• ${t}`).join("\n")}

**Decisions:**
${meeting.summary.decisions.map((d) => `• ${d}`).join("\n")}

**Action Items:**
${meeting.summary.actionItems.map((a) => `• ${a}`).join("\n")}

**Key Moments:**
${meeting.summary.keyMoments.map((km) => `• [${km.timestamp}] ${km.speaker ? `[${km.speaker}] ` : ""}${km.topic}`).join("\n")}`;

			return {
				content: [
					{
						type: "text",
						text,
					},
				],
			};
		},
	);

	return server;
}
