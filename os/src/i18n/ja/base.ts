// Japanese for the base part of the OS (English text -> Japanese).
// Shared models and words: purposes, "/", fetching, repos, and the words
// several pages use alike.
export default {
  // purposes.ts: the rail's places (labels other than New repo stay as names)
  'Profile': 'プロフィール',
  'A page that reads the same to you and to anyone else, with your repos and servers.': '自分にも他人にも同じ形で見えるページ。repo とサーバーが並ぶ。',
  'Your workshop': '自分の作業場',
  'Edit the files of the repos in the band as one continuous page, with Reference and Prompt on the right.': '帯に出した repo の file を、一続きのページで編集する。右に参照と Prompt。',
  'The tree of /': '/ の tree',
  'Opens the whole system\'s / over the current page. Choosing something inside a repo opens it there in Forge.': 'システム全体の / を、今のページに重ねて開く。repo の中を選ぶと Forge でそこを開く。',
  'Issues and commits': 'Issue とコミット',
  'Work Issue by Issue: commit, push, and hand it to main as a Change. Changes that come in are settled with Merge or Reject.': 'Issue ごとに Commit・Push し、Change として main に渡す。届いた Change は Merge か Reject で決める。',
  'This device and its environments': 'この端末と環境',
  'What this device holds, largest first. What can be freed is freed right there. The active environments too.': 'この端末が持っているものを容量順に。空けられるものはその場で空ける。有効な環境も。',
  'Where your repos are kept': 'repo を置く場所',
  'Where your repos are kept. What you change is sent at once, and committing makes it history. Devices and passkeys are here too.': 'repo を置く場所。変えたものはすぐ送られ、Commit すると履歴になる。端末とパスキーもここで。',
  'Messages to you': '自分に届くメッセージ',
  'Review requests, changes, questions and more, each with what it is about and what to do.': 'レビュー依頼・Change・質問などを、対象と対応操作つきで受け取る。',
  'New repo': '新しい repo',
  'Make a repo': 'repo の作成',
  'Choose a standard repo template and make it as an independent repo.': '標準的な repo テンプレートを選び、独立した repo として作る。',

  // system.ts: where each top-level directory of "/" comes from
  'distribution': '配布',
  'kernel': 'カーネル',
  'repo': 'repo',
  'repos': 'repo',
  'server': 'サーバー',
  'servers': 'サーバー',
  'empty': '空',
  'The distribution has not been fetched': '配布物を取得していません',

  // fetch.ts: why a download is being taken up again
  'Could not receive the rest': '続きを受け取れませんでした',
  'The size does not match': '大きさが合いません',
  'The contents do not match': '中身が合いません',
  'The connection stalled': '回線が止まりました',
  'The connection broke': '回線が切れました',
  'Could not load': '読み込めませんでした',

  // repos.ts
  '{path}: a file is in the way': '{path}: 途中がファイルです',
  '{path}: a folder is there': '{path}: フォルダーがあります',

  // repo templates (shared/templates.json labels)
  'Standard': '標準',
  'Minimal': '最小',

  // Words several pages share
  'Commit': 'Commit',
  'Name': '名前',
  'Save': '保存する',
  'Cancel': 'キャンセル',
  'Create': '作る',
  'Detail': '詳細',
  'Binary': 'バイナリ',
  'Open in Forge': 'Forge で開く',
  'Could not save: {message}': '保存できませんでした：{message}',
  '{n} file': '{n}ファイル',
  '{n} files': '{n}ファイル',
  '{n} line': '{n}行',
  '{n} lines': '{n}行',
  '{n} more line': 'ほか {n}行',
  '{n} more lines': 'ほか {n}行',
} as Record<string, string>;
