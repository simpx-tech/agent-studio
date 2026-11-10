# Fixed read-only lookup; never launch a provider or inspect its credentials.
elf="$(printf '\177ELF')"
for provider in codex claude gemini; do
  binary="$provider"
  if [ "$provider" = gemini ]; then binary=agy; fi
  cli_path="$(type -P -- "$binary" 2>/dev/null || true)"
  if [ -n "$cli_path" ]; then
    target="$(readlink -f -- "$cli_path" 2>/dev/null || true)"
    # npm links Claude Code 2.1.113 and later to its package's bin/claude.exe, a Linux program
    # despite the name: that one is reported by its link, a Windows program by its own path.
    case "$target" in
      *.[eE][xX][eE]) [ "$(head -c 4 -- "$target" 2>/dev/null)" = "$elf" ] || cli_path="$target" ;;
      *) cli_path="$target" ;;
    esac
  fi
  printf 'agent-studio-cli\t%s\t%s\n' "$provider" "$cli_path"
done
