# Build the voice input helper (Swift). bin/ is not committed
HELPER_SRC := extensions/voice/helper/main.swift
HELPER_BIN := extensions/voice/bin/pi-voice-helper
AGENT_DIR ?= $(HOME)/.pi/agent

.PHONY: all link clean

all: $(HELPER_BIN)

$(HELPER_BIN): $(HELPER_SRC)
	mkdir -p $(dir $@)
	swiftc -O -swift-version 5 -target arm64-apple-macos26.0 $< -o $@

# Link the system prompt addition into pi's agent directory
link:
	mkdir -p $(AGENT_DIR)
	ln -sf $(CURDIR)/agent/APPEND_SYSTEM.md $(AGENT_DIR)/APPEND_SYSTEM.md

clean:
	rm -rf $(dir $(HELPER_BIN))
