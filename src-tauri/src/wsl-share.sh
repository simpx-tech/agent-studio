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
