SHELL := /bin/zsh
NPM ?= npm
CODE ?= code

.PHONY: help install build watch package dev clean push

help: ## Show available Makefile commands
	@echo "Available commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

install: ## Install dependencies
	$(NPM) install

build: ## Compile extension sources
	$(NPM) run compile

watch: ## Run TypeScript compiler in watch mode
	$(NPM) run watch

package: ## Create VSIX package
	$(NPM) run package

dev: build ## Build and launch extension development host
	$(CODE) --extensionDevelopmentPath=$(CURDIR)

clean: ## Remove build artifacts
	rm -rf dist
	setopt nullglob; rm -f *.vsix

push: ## Clean, commit, and push current branch
	make clean
	git add .
	git commit
	git push origin HEAD