#!/bin/bash
# Prompt user for approval via macOS dialog
# Usage: bash approve.sh "description of action"
# Returns: exit 0 if approved, exit 1 if denied/timeout

RAW_ACTION="$1"
TIMEOUT="${2:-60}"

# Sanitize for AppleScript: escape quotes/backslashes, strip markdown, truncate
ACTION=$(echo "$RAW_ACTION" | head -3 | sed 's/\\/\\\\/g' | sed 's/"/\\"/g' | sed 's/\*//g' | cut -c1-300)

RESULT=$(osascript -e "display dialog \"$ACTION\" with title \"MobScribe Agent\" buttons {\"Deny\", \"Approve\"} default button \"Approve\" giving up after $TIMEOUT" 2>&1)

if echo "$RESULT" | grep -q "Approve"; then
  exit 0
else
  exit 1
fi
