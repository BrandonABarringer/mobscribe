export interface MeetingMetadata {
	id: string;
	name: string;
	project?: string;
	context?: string;
	date: string; // ISO 8601
	duration: number; // seconds
	speakers: string[];
	segmentCount: number;
}

export interface KeyMoment {
	timestamp: string; // MM:SS format
	speaker?: string;
	topic: string;
}

export interface MeetingSummary {
	overview: string;
	topics: string[];
	decisions: string[];
	actionItems: string[];
	keyMoments: KeyMoment[];
}

export interface SaveMeetingOptions {
	name: string;
	project?: string;
	context?: string;
	startTime: Date;
	endTime: Date;
	segments: Array<{
		text: string;
		timestamp: number;
		index: number;
		speaker?: string;
	}>;
}

export interface MeetingSearchResult {
	metadata: MeetingMetadata;
	summary: MeetingSummary;
	matchContext?: string;
}

export interface MeetingListFilter {
	dateFrom?: string; // ISO 8601 date
	dateTo?: string;
	project?: string;
	speaker?: string;
}
