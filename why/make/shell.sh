# why's shell extension, installed only by why/make/root.sh.
[ "$LENGTH3_LANG" != ja ] || export LANGUAGE=ja
# The repo's history is the Remote's: git has nothing to say inside it, so it says where to go (unless a repository
# of git's own is there: a .git in this folder or one above it in the repo, or GIT_DIR).
git() {
  case $PWD/ in
    "/root/$LENGTH3_REPO"/*)
      if [ -z "${GIT_DIR:-}" ] && ! __ricebox_above .git "/root/$LENGTH3_REPO"; then
        if [ "$LENGTH3_LANG" = ja ]; then
          echo "git: $LENGTH3_REPO の履歴は Remote にあります。Commit・Push・Change はアプリの Git から（why git $LENGTH3_REPO で Issue を見られます）" >&2
        else
          echo "git: $LENGTH3_REPO's history is kept on the Remote. Commit, Push and Change it from the app's Git page (why git $LENGTH3_REPO lists its issues)." >&2
        fi
        return 1
      fi ;;
  esac
  command git "$@"
}

if [ "$TERM" = dumb ]; then
  __ricebox_screen() {
    if [ "$LENGTH3_LANG" = ja ]; then
      echo "$1 は画面に描くプログラムで、アプリの Prompt は出力を見せるだけです。ファイルは Forge で編集でき、自分の端末からは SSH でこの Prompt に入れます（why address）" >&2
    else
      echo "$1 draws on a screen, and the app's Prompt shows output only: edit files in Forge, or reach this Prompt from a terminal of your own over SSH (why address)." >&2
    fi
    return 1
  }
fi
