# Tab Tonic

Chromium Manifest V3 extension for organizing tabs into native Chrome tab groups with an OpenRouter-backed LLM. The extension uses a React + TypeScript side panel, supports preview-before-apply, remembers protected group titles, and stores one undo snapshot for restoring the previous layout.

## What is included

- React + TypeScript side panel UI for settings, run controls, protected groups, preview, apply, and undo
- Background service worker for Chrome tab APIs, OpenRouter requests, and last-run snapshot storage
- Shared message/type contracts between the panel and background worker
- Vitest coverage for protected-group resolution, prompt/plan validation, and restore-plan building

## Local setup

1. Install dependencies with `npm install`.
2. Build the extension with `npm run build`.
3. Open `chrome://extensions`.
4. Enable `Developer mode`.
5. Click `Load unpacked` and select [`dist`](/Users/matthewgold/code/LLM Browser Extension/dist) after the build completes.

## Usage

1. Open the side panel from the extension action.
2. Add your OpenRouter API key and model ID, then save settings.
3. Optionally define default categories and protected group titles.
4. Refresh the current tab inventory, adjust per-run protected groups, and click `Generate preview`.
5. Review the proposed groups, click `Apply preview`, or use `Undo` to restore the last applied run.

## Validation commands

- `npm run build`
- `npm run typecheck`
- `npm run test`
