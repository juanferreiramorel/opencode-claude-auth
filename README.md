# opencode-claude-auth

OpenCode plugin for Anthropic Claude Pro/Max — uses your Claude CLI OAuth tokens with dynamic header matching.

Fork of [cemalturkcan/opencode-anthropic-login-via-cli](https://github.com/cemalturkcan/opencode-anthropic-login-via-cli) with:

- **Dynamic CLI version detection** — reads `claude --version` instead of hardcoding
- **Header matching** — User-Agent and headers match your installed Claude CLI
- **Windows support** — correct credential and auth paths for Windows

## How it works

```
Claude CLI (OAuth token)  →  Plugin  →  OpenCode
  ~/.claude/.credentials.json     x-api-key header
  or macOS Keychain               + matched headers
```

1. Reads your Claude CLI OAuth token on startup
2. Detects your installed Claude CLI version
3. Injects the token and matching headers into every Anthropic API call
4. Auto-refreshes when the token is about to expire

## Prerequisites

- [OpenCode](https://github.com/sst/opencode)
- [Claude CLI](https://github.com/anthropics/claude-code) logged in (`claude auth status`)
- Claude Pro or Max subscription

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-claude-auth"]
}
```

OpenCode installs npm plugins automatically on startup.

## Platform support

| Platform | Credential source |
|---|---|
| macOS | Keychain (`Claude Code-credentials`) → fallback to file |
| Linux | `~/.claude/.credentials.json` |
| Windows | `~/.claude/.credentials.json` |

## Disclaimer

This plugin reads tokens from Claude CLI for use in OpenCode. Anthropic's Terms of Service state that Claude Pro/Max tokens should only be used with official clients. Use at your own discretion.

## License

MIT
