# Build the voice input helper (Swift). bin/ is not committed
HELPER_SRC := extensions/voice/helper/main.swift
HELPER_BIN := extensions/voice/bin/pi-voice-helper
AGENT_DIR ?= $(HOME)/.pi/agent

.PHONY: all link test friction schedule-friction unschedule-friction clean

all: $(HELPER_BIN)

$(HELPER_BIN): $(HELPER_SRC)
	mkdir -p $(dir $@)
	swiftc -O -swift-version 5 -target arm64-apple-macos26.0 $< -o $@

# Link the system prompt addition into pi's agent directory
link:
	mkdir -p $(AGENT_DIR)
	ln -sf $(CURDIR)/agent/APPEND_SYSTEM.md $(AGENT_DIR)/APPEND_SYSTEM.md

# Extension and tool tests. Node strips the TypeScript types; index tests load extensions through pi's own loader
test:
	node --test 'extensions/**/*.test.ts' 'tools/**/*.test.ts'

# Report where pi sessions went wrong between the user and the agent (written to $(AGENT_DIR)/friction)
FRICTION_LABEL := local.pi-harness.friction
FRICTION_PLIST := $(HOME)/Library/LaunchAgents/$(FRICTION_LABEL).plist

friction:
	node tools/friction/main.ts

# Run the report every morning at 9:00 with launchd; a Mac that was asleep runs it on waking
schedule-friction:
	mkdir -p $(AGENT_DIR)/friction $(dir $(FRICTION_PLIST))
	sed -e 's|@LABEL@|$(FRICTION_LABEL)|' -e 's|@SCRIPT@|$(CURDIR)/tools/friction/main.ts|' -e 's|@LOG@|$(AGENT_DIR)/friction/launchd.log|' tools/friction/launchd.plist > $(FRICTION_PLIST)
	launchctl bootout gui/$$(id -u)/$(FRICTION_LABEL) 2>/dev/null || true
	launchctl bootstrap gui/$$(id -u) $(FRICTION_PLIST)

unschedule-friction:
	launchctl bootout gui/$$(id -u)/$(FRICTION_LABEL) 2>/dev/null || true
	rm -f $(FRICTION_PLIST)

clean:
	rm -rf $(dir $(HELPER_BIN))
