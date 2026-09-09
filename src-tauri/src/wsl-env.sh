# Fixed bootstrap shared by discovery and execution; no user text is shell source.
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.npm/bin:$HOME/.volta/bin:$HOME/.local/share/pnpm:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh" --no-use >/dev/null 2>&1
  nvm use --silent default >/dev/null 2>&1 || true
fi
unset CLAUDECODE CODEX_THREAD_ID CLAUDE_CODE_EFFORT_LEVEL
export NO_COLOR=1
