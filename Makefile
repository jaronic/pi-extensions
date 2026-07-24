.DEFAULT_GOAL := help

PI_LINKS := ./scripts/pi-global-links.sh
SCOPE ?= all

.PHONY: help pi-status pi-on pi-off pi-toggle \
	pi-extensions-status pi-extensions-on pi-extensions-off pi-extensions-toggle \
	pi-themes-status pi-themes-on pi-themes-off pi-themes-toggle pi-links-test

help:
	@printf '%s\n' \
		'Pi global link management:' \
		'  make pi-status             Show all managed links' \
		'  make pi-on                 Enable all managed links' \
		'  make pi-off                Disable all managed links' \
		'  make pi-toggle             Toggle all managed links' \
		'  make pi-extensions-on      Enable extension links only' \
		'  make pi-extensions-off     Disable extension links only' \
		'  make pi-themes-on          Enable theme links only' \
		'  make pi-themes-off         Disable theme links only' \
		'  make pi-links-test         Run link manager tests' \
		'' \
		'Use SCOPE=extensions or SCOPE=themes with pi-status/pi-on/pi-off/pi-toggle.' \
		'Theme-off targets require selecting a built-in theme through /settings first.'

pi-status:
	@$(PI_LINKS) status $(SCOPE)

pi-on:
	@$(PI_LINKS) on $(SCOPE)

pi-off:
	@$(PI_LINKS) off $(SCOPE)

pi-toggle:
	@$(PI_LINKS) toggle $(SCOPE)

pi-extensions-status:
	@$(PI_LINKS) status extensions

pi-extensions-on:
	@$(PI_LINKS) on extensions

pi-extensions-off:
	@$(PI_LINKS) off extensions

pi-extensions-toggle:
	@$(PI_LINKS) toggle extensions

pi-themes-status:
	@$(PI_LINKS) status themes

pi-themes-on:
	@$(PI_LINKS) on themes

pi-themes-off:
	@$(PI_LINKS) off themes

pi-themes-toggle:
	@$(PI_LINKS) toggle themes

pi-links-test:
	@node --test scripts/pi-global-links.test.mjs
