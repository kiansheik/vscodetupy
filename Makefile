SHELL := /bin/zsh
NPM ?= npm
CODE ?= code

.PHONY: install build watch package dev clean

install:
	$(NPM) install

build:
	$(NPM) run compile

watch:
	$(NPM) run watch

package:
	$(NPM) run package

dev: build
	$(CODE) --extensionDevelopmentPath=$(CURDIR)

clean:
	rm -rf dist *.vsix

push:
	make clean
	git add .
	git commit
	git push origin HEAD