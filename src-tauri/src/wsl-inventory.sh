# Fixed read-only lookup; never launch a provider or inspect its credentials.
for provider in codex claude gemini; do
  binary="$provider"
  if [ "$provider" = gemini ]; then binary=agy; fi
  cli_path="$(type -P -- "$binary" 2>/dev/null || true)"
  if [ -n "$cli_path" ]; then cli_path="$(readlink -f -- "$cli_path" 2>/dev/null || true)"; fi
  printf 'agent-studio-cli\t%s\t%s\n' "$provider" "$cli_path"
done
