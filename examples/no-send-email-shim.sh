#!/bin/bash
# gog-safe shim — shadows the real gog CLI on the agent's PATH.
# Blocks outbound-email verbs for the agent; everything else passes through.
# Put this first on the agent's PATH only; the principal's own shell still finds the real binary.

REAL="/opt/homebrew/bin/gog"

# gog's own no-send guard backs this shim up: the account has
# `gog config no-send set` (applies however gog is called, even by full path),
# and every call here also carries GOG_GMAIL_NO_SEND + --gmail-no-send, which
# closes the "flag before gmail" gap in the case match below.
export GOG_GMAIL_NO_SEND=1

# The agent may never switch the guard off.
for a in "$@"; do
  case "$a" in no-send|nosend) for b in "$@"; do case "$b" in remove|rm|del|delete|unset|disable)
    echo "BLOCKED by gog-safe shim: the no-send guard can't be removed by the agent." >&2
    exit 86;; esac; done;; esac
done

if [ "${1:-}" = "gmail" ] || [ "${1:-}" = "mail" ] || [ "${1:-}" = "email" ]; then
  # Drafts are allowed (staging only — a human presses send). Everything that
  # actually transmits is blocked.
  case "${2:-}" in
    send|reply|reply-all|replyall|forward|fwd|autoreply)
      echo "BLOCKED by gog-safe shim: 'gog gmail ${2}' transmits email." >&2
      echo "This agent may draft, never send (AGENTS.md Red Lines)." >&2
      echo "The principal presses send." >&2
      exit 86
      ;;
    drafts|draft)
      # allow drafts create/list; block 'drafts send'
      if [ "${3:-}" = "send" ]; then
        echo "BLOCKED by gog-safe shim: 'gog gmail drafts send' transmits email." >&2
        echo "Draft staged — the principal sends it." >&2
        exit 86
      fi
      ;;
  esac
fi

exec "$REAL" --gmail-no-send "$@"
