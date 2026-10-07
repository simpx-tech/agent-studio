# Links a separate Claude profile to the distribution's own Claude directory, as linking.rs
# links one on Windows: everything but the account's login and state. What the profile kept
# before moves into that directory first and never replaces anything there; an identical copy is
# dropped, and one that differs stays in the profile's before-sharing folder.
share_aside() {
  local from=$1 aside=$2 dest n=0
  mkdir -p -- "${aside%/*}" || return 1
  dest=$aside
  while [ -e "$dest" ] || [ -L "$dest" ]; do
    n=$((n + 1))
    dest="$aside.$n"
  done
  mv -T -- "$from" "$dest"
}
share_adopt() {
  local from=$1 to=$2 aside=$3 child
  if [ -d "$from" ] && [ ! -L "$from" ]; then
    if [ ! -e "$to" ] && [ ! -L "$to" ]; then
      mv -n -T -- "$from" "$to" 2>/dev/null || true
      if [ ! -e "$from" ] && [ ! -L "$from" ]; then return 0; fi
      if [ ! -e "$to" ] && [ ! -L "$to" ]; then return 1; fi
    fi
    if [ -d "$to" ] && [ ! -L "$to" ]; then
      for child in "$from"/* "$from"/.[!.]* "$from"/..?*; do
        if [ -e "$child" ] || [ -L "$child" ]; then
          share_adopt "$child" "$to/${child##*/}" "$aside/${child##*/}" || return 1
        fi
      done
      rmdir -- "$from"
      return
    fi
    share_aside "$from" "$aside"
    return
  fi
  if [ ! -e "$to" ] && [ ! -L "$to" ]; then
    mkdir -p -- "${to%/*}" || return 1
    # A hard link fails when the name exists, so nothing is replaced even if it appears meanwhile.
    if [ -f "$from" ] && [ ! -L "$from" ] && ln -- "$from" "$to" 2>/dev/null; then
      rm -f -- "$from"
      return
    fi
    mv -n -T -- "$from" "$to" 2>/dev/null || true
    if [ ! -e "$from" ] && [ ! -L "$from" ]; then return 0; fi
  fi
  if [ -f "$from" ] && [ ! -L "$from" ] && [ -f "$to" ] && cmp -s -- "$from" "$to"; then
    rm -f -- "$from"
    return
  fi
  share_aside "$from" "$aside"
}
share_link() {
  local config=$1 source=$2 name entry target
  mkdir -p -- "$source" || return 1
  for name in projects file-history tasks plans todos plugins skills agents commands output-styles rules settings.json CLAUDE.md; do
    entry=$config/$name
    target=$source/$name
    case $name in
      *.*) ;;
      *) mkdir -p -- "$target" || return 1 ;;
    esac
    if [ -L "$entry" ]; then
      [ "$(readlink -- "$entry")" = "$target" ] && continue
      rm -f -- "$entry" || return 1
    elif [ -e "$entry" ]; then
      share_adopt "$entry" "$target" "$config/before-sharing/$name" || return 1
    fi
    ln -s -- "$target" "$entry" || return 1
  done
}
# Keeps the transcripts of a Claude directory this distribution's Claude app and terminal share
# with Agent Studio, as retention.rs does on Windows: a settings.json that sets no
# cleanupPeriodDays gets it right after its opening brace, the rest of the file as it was, and a
# directory without one gets one. A file that is a link, read-only, names the key anywhere or does
# not start with an object is left alone.
share_retain() {
  local directory=$1 file text rest after separator tmp
  file=$directory/settings.json
  [ -d "$directory" ] || return 0
  if [ ! -e "$file" ] && [ ! -L "$file" ]; then
    # noclobber creates the file only if nothing else did meanwhile.
    (set -C; printf '{\n  "cleanupPeriodDays": 3650\n}\n' > "$file") 2>/dev/null || true
    return 0
  fi
  if [ ! -f "$file" ] || [ -L "$file" ] || [ ! -w "$file" ]; then return 0; fi
  text=$(cat -- "$file" && printf x) || return 0
  text=${text%x}
  case $text in *'"cleanupPeriodDays"'*) return 0 ;; esac
  rest=${text#"${text%%[![:space:]]*}"}
  case $rest in '{'*) ;; *) return 0 ;; esac
  after=${rest#'{'}
  after=${after#"${after%%[![:space:]]*}"}
  case $after in
    '"'*) separator=',' ;;
    '}'*) separator='' ;;
    *) return 0 ;;
  esac
  tmp=$(mktemp "$directory/.settings.json.XXXXXX") || return 0
  if printf '%s{\n  "cleanupPeriodDays": 3650%s%s' "${text%%'{'*}" "$separator" "${text#*'{'}" > "$tmp" \
    && chmod --reference="$file" -- "$tmp" && mv -f -- "$tmp" "$file"; then
    return 0
  fi
  rm -f -- "$tmp"
}
