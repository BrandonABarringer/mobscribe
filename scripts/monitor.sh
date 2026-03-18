#!/bin/bash
# MobScribe Monitor — reads transcript file and feeds new content to Claude for analysis
# Usage: bash scripts/monitor.sh [interval_seconds]

INTERVAL=${1:-30}
TRANSCRIPT_FILE="/tmp/mobscribe-transcript.jsonl"
LAST_LINE_COUNT=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/../logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/monitor-$(date +%Y%m%d-%H%M%S).log"

log() {
  echo "[$(date +%H:%M:%S)] $1" | tee -a "$LOG_FILE"
}

approve() {
  bash "$SCRIPT_DIR/approve.sh" "$1" 60
  return $?
}

log "Monitor started. Polling every ${INTERVAL}s. Log: $LOG_FILE"
log "Watching: $TRANSCRIPT_FILE"

while true; do
  if [ ! -f "$TRANSCRIPT_FILE" ]; then
    sleep "$INTERVAL"
    continue
  fi

  CURRENT_LINE_COUNT=$(wc -l < "$TRANSCRIPT_FILE" | tr -d ' ')

  if [ "$CURRENT_LINE_COUNT" -le "$LAST_LINE_COUNT" ]; then
    sleep "$INTERVAL"
    continue
  fi

  NEW_LINES=$(tail -n +$((LAST_LINE_COUNT + 1)) "$TRANSCRIPT_FILE")
  LAST_LINE_COUNT=$CURRENT_LINE_COUNT

  FORMATTED=$(echo "$NEW_LINES" | while IFS= read -r line; do
    if [ -z "$line" ]; then continue; fi
    TEXT=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); ts=d['timestamp']; m=int(ts/60000); s=int((ts%60000)/1000); sp=f' [{d[\"speaker\"]}]' if d.get('speaker') else ''; print(f'[{m:02d}:{s:02d}]{sp} {d[\"text\"]}')" 2>/dev/null)
    if [ -n "$TEXT" ]; then
      echo "$TEXT"
    fi
  done)

  if [ -z "$FORMATTED" ]; then
    sleep "$INTERVAL"
    continue
  fi

  log "New transcript segments:"
  log "$FORMATTED"

  # Pass 1: Claude proposes an action (or NOTHING_TO_DO)
  PROPOSAL=$(claude --permission-mode auto -p "You are monitoring a live meeting. Your role is to observe, capture important information, and defer actions for later.

New transcript:

$FORMATTED

If you identify something actionable, respond in this exact format:
ACTION: [one-line description of what you want to do]
DETAIL: [brief context for why]

Things worth capturing:
- Someone asks a question that could be researched (research it now, report findings)
- A decision is made that should be logged (create a Teamwork task to document it)
- An action item is assigned to someone (create a Teamwork task to track it)
- Someone directly asks Claude to do something
- A topic comes up that could benefit from quick research

IMPORTANT: You are in observation mode. You may ONLY:
- Research/look up information (web search, read Teamwork tasks, read Slack channels)
- Create Teamwork tasks (to capture action items, decisions, or follow-ups for after the meeting)
- Add comments to existing Teamwork tasks (to log context from the meeting)

You must NEVER:
- Send Slack messages or emails
- Modify, update, close, or delete anything
- Make code changes or deployments
- Take any action that is visible to other people

When in doubt, create a Teamwork task to defer the action for after the meeting.

If nothing is actionable, respond with exactly: NOTHING_TO_DO

Only propose ONE action per response. Be selective — routine discussion is not actionable." 2>/dev/null)

  # Skip if nothing to do
  if [ "$PROPOSAL" = "NOTHING_TO_DO" ] || [ -z "$PROPOSAL" ]; then
    sleep "$INTERVAL"
    continue
  fi

  # Skip API errors — don't surface these as proposals
  if echo "$PROPOSAL" | grep -qi "API Error\|api_error\|Internal server error\|overloaded\|rate_limit"; then
    log "Claude API error (skipping): $(echo "$PROPOSAL" | head -1)"
    sleep "$INTERVAL"
    continue
  fi

  log "Proposed: $PROPOSAL"

  # Extract the action line for the dialog
  ACTION_LINE=$(echo "$PROPOSAL" | grep "^ACTION:" | sed 's/^ACTION: //')
  if [ -z "$ACTION_LINE" ]; then
    ACTION_LINE="$PROPOSAL"
  fi

  # Pass 2: Ask for approval via macOS dialog
  if approve "$ACTION_LINE"; then
    log "APPROVED: $ACTION_LINE"

    # Pass 3: Execute the approved action
    RESULT=$(claude --permission-mode auto -p "You previously proposed this action based on a meeting transcript:

$PROPOSAL

The user approved this action. Now execute it.

You may ONLY:
- Research/look up information (web search, read Teamwork tasks, read Slack channels)
- Create Teamwork tasks (to capture action items, decisions, or follow-ups)
- Add comments to existing Teamwork tasks

You must NEVER send messages, modify existing data, make code changes, or take any action visible to others.

Do it now and report what you did." 2>/dev/null)

    # Check if execution hit an API error
    if echo "$RESULT" | grep -qi "API Error\|api_error\|Internal server error\|overloaded\|rate_limit"; then
      log "Execution failed (API error): $(echo "$RESULT" | head -1)"
      osascript -e "display notification \"Action failed — API error. Will retry next cycle.\" with title \"MobScribe\"" 2>/dev/null
    else
      log "EXECUTED: $RESULT"

      # Write finding to transcript JSONL so the main Claude session can read it
      if [ -f "$TRANSCRIPT_FILE" ]; then
        TIMESTAMP=$(python3 -c "import time; print(int(time.time() * 1000))")
        ESCAPED_RESULT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))")
        echo "{\"text\":$ESCAPED_RESULT,\"timestamp\":$TIMESTAMP,\"index\":-1,\"speaker\":\"CLAUDE\",\"type\":\"finding\"}" >> "$TRANSCRIPT_FILE"
      fi

      # Truncate result for notification (macOS has char limits)
      SHORT_RESULT=$(echo "$RESULT" | head -3 | cut -c1-150)
      osascript -e "display notification \"$SHORT_RESULT\" with title \"MobScribe\" subtitle \"$ACTION_LINE\"" 2>/dev/null
    fi
  else
    log "DENIED: $ACTION_LINE"
  fi

  sleep "$INTERVAL"
done
